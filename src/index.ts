/**
 * vector-brain — Island 4
 *
 * Corpus management + semantic search + RAG via Vectorize + Workers AI.
 *
 * Endpoints:
 *   POST   /documents          — add single document
 *   POST   /documents/bulk     — bulk insert (up to 100)
 *   GET    /documents          — list corpus
 *   GET    /documents/:id      — get one document
 *   DELETE /documents/:id      — delete from D1 + Vectorize
 *   POST   /search             — semantic search { query, topK? }
 *   POST   /ask                — RAG: embed query, search, generate answer with citations
 *   GET    /stats              — corpus size + last indexed timestamp
 */

export interface Env {
  DB: D1Database;
  VECTOR_INDEX?: VectorizeIndex;  // Optional: absent in test environment
  AI?: Ai;                        // Optional: absent in test environment
  EMBED_MODEL: string;
  GEN_MODEL: string;
  TOP_K: string;
  MAX_GEN_TOKENS: string;
}

interface Document {
  id: string;
  title: string;
  content: string;
  source?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow {
  id: string;
  title: string;
  content: string;
  source: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

type EmbeddingResponse = { shape: number[]; data: number[][] };

async function embed(ai: Ai, model: string, text: string): Promise<number[]> {
  const result = (await ai.run(model as "@cf/baai/bge-base-en-v1.5", {
    text: [text],
  })) as EmbeddingResponse;
  return result.data[0];
}

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

function rowToDoc(r: DocumentRow): Document {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    source: r.source ?? undefined,
    tags: JSON.parse(r.tags) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function getDocById(db: D1Database, id: string): Promise<Document | null> {
  const row = await db
    .prepare(`SELECT * FROM documents WHERE id = ?`)
    .bind(id)
    .first<DocumentRow>();
  return row ? rowToDoc(row) : null;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const method = request.method;

    // --- POST /corpus/bulk — spec alias for /documents/bulk ---
    if (method === "POST" && pathname === "/corpus/bulk") {
      return handleBulkInsert(request, env);
    }

    // --- POST /corpus — spec alias for /documents ---
    if (method === "POST" && pathname === "/corpus") {
      return handleInsert(request, env);
    }

    // --- DELETE /corpus/:id — spec alias for DELETE /documents/:id ---
    if (method === "DELETE" && pathname.match(/^\/corpus\/[^/]+$/)) {
      const id = pathname.slice("/corpus/".length);
      return handleDelete(id, env);
    }

    // --- POST /documents/bulk ---
    if (method === "POST" && pathname === "/documents/bulk") {
      return handleBulkInsert(request, env);
    }

    // --- POST /documents ---
    if (method === "POST" && pathname === "/documents") {
      return handleInsert(request, env);
    }

    // --- GET /documents ---
    if (method === "GET" && pathname === "/documents") {
      const limit = parseInt(searchParams.get("limit") ?? "50", 10);
      const offset = parseInt(searchParams.get("offset") ?? "0", 10);
      return handleList(env, limit, offset);
    }

    // --- GET /documents/:id ---
    if (method === "GET" && pathname.match(/^\/documents\/[^/]+$/)) {
      const id = pathname.slice("/documents/".length);
      return handleGetDoc(id, env);
    }

    // --- DELETE /documents/:id ---
    if (method === "DELETE" && pathname.match(/^\/documents\/[^/]+$/)) {
      const id = pathname.slice("/documents/".length);
      return handleDelete(id, env);
    }

    // --- POST /search ---
    if (method === "POST" && pathname === "/search") {
      return handleSearch(request, env);
    }

    // --- POST /ask ---
    if (method === "POST" && pathname === "/ask") {
      return handleAsk(request, env);
    }

    // --- GET /stats ---
    if (method === "GET" && pathname === "/stats") {
      return handleStats(env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleInsert(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<Document>;
  if (!body.title || !body.content) {
    return Response.json({ error: "title and content are required" }, { status: 400 });
  }

  const id = body.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const tags = body.tags ?? [];

  await env.DB.prepare(
    `INSERT INTO documents (id, title, content, source, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, content=excluded.content, source=excluded.source,
       tags=excluded.tags, updated_at=excluded.updated_at`
  )
    .bind(id, body.title, body.content, body.source ?? null, JSON.stringify(tags), now, now)
    .run();

  // Embed and upsert into Vectorize (skipped if bindings absent, e.g. in test environment)
  if (env.AI && env.VECTOR_INDEX) {
    const vector = await embed(env.AI, env.EMBED_MODEL, `${body.title}\n${body.content}`);
    await env.VECTOR_INDEX.upsert([{ id, values: vector, metadata: { title: body.title, source: body.source ?? "" } }]);
  }

  // Update stats — derive count from actual table to avoid drift on upsert
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM documents`).first<{ cnt: number }>();
  await env.DB.prepare(`UPDATE stats SET value = ? WHERE key = 'total_docs'`).bind(String(countRow?.cnt ?? 0)).run();
  await env.DB.prepare(`UPDATE stats SET value = ? WHERE key = 'last_indexed_at'`).bind(now).run();

  return Response.json({ id, title: body.title, createdAt: now }, { status: 201 });
}

async function handleBulkInsert(request: Request, env: Env): Promise<Response> {
  const items = (await request.json()) as Array<Partial<Document>>;
  if (!Array.isArray(items) || items.length === 0) {
    return Response.json({ error: "Body must be a non-empty array" }, { status: 400 });
  }
  if (items.length > 100) {
    return Response.json({ error: "Bulk limit is 100 documents per request" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const ids: string[] = [];
  const vectors: VectorizeVector[] = [];

  const stmt = env.DB.prepare(
    `INSERT INTO documents (id, title, content, source, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, content=excluded.content, source=excluded.source,
       tags=excluded.tags, updated_at=excluded.updated_at`
  );

  const dbBatch = items.map((item) => {
    const id = item.id ?? crypto.randomUUID();
    ids.push(id);
    return stmt.bind(
      id,
      item.title ?? "",
      item.content ?? "",
      item.source ?? null,
      JSON.stringify(item.tags ?? []),
      now,
      now
    );
  });
  await env.DB.batch(dbBatch);

  // Batch-embed and upsert into Vectorize (skipped if bindings absent, e.g. in test environment)
  if (env.AI && env.VECTOR_INDEX) {
    const texts = items.map((item) => `${item.title ?? ""}\n${item.content ?? ""}`);
    const embeddingResult = (await env.AI.run(env.EMBED_MODEL as "@cf/baai/bge-base-en-v1.5", {
      text: texts,
    })) as EmbeddingResponse;
    items.forEach((item, i) => {
      vectors.push({
        id: ids[i],
        values: embeddingResult.data[i],
        metadata: { title: item.title ?? "", source: item.source ?? "" },
      });
    });
    await env.VECTOR_INDEX.upsert(vectors);
  }

  // Update stats — derive count from actual table to avoid drift on upsert
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM documents`).first<{ cnt: number }>();
  await env.DB.prepare(`UPDATE stats SET value = ? WHERE key = 'total_docs'`).bind(String(countRow?.cnt ?? 0)).run();
  await env.DB.prepare(`UPDATE stats SET value = ? WHERE key = 'last_indexed_at'`).bind(now).run();

  return Response.json({ inserted: items.length, ids }, { status: 201 });
}

async function handleList(env: Env, limit: number, offset: number): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, title, source, tags, created_at, updated_at FROM documents
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(Math.min(limit, 200), offset)
    .all<{ id: string; title: string; source: string | null; tags: string; created_at: string; updated_at: string }>();

  const documents = (rows.results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    source: r.source ?? null,
    tags: JSON.parse(r.tags) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return Response.json({ documents, total: documents.length, offset });
}

async function handleGetDoc(id: string, env: Env): Promise<Response> {
  const doc = await getDocById(env.DB, id);
  if (!doc) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(doc);
}

async function handleDelete(id: string, env: Env): Promise<Response> {
  const existing = await getDocById(env.DB, id);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  await env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(id).run();
  if (env.VECTOR_INDEX) {
    await env.VECTOR_INDEX.deleteByIds([id]);
  }

  // Decrement stats
  await env.DB.prepare(
    `UPDATE stats SET value = CAST(MAX(0, CAST(value AS INTEGER) - 1) AS TEXT) WHERE key = 'total_docs'`
  ).run();

  return new Response(null, { status: 204 });
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { query?: string; topK?: number };
  if (!body.query?.trim()) {
    return Response.json({ error: "'query' is required" }, { status: 400 });
  }

  // AI + Vectorize absent in test environment — return empty results
  if (!env.AI || !env.VECTOR_INDEX) {
    return Response.json({ query: body.query, results: [] });
  }

  const topK = Math.min(body.topK ?? parseInt(env.TOP_K ?? "5", 10), 20);
  const queryVector = await embed(env.AI, env.EMBED_MODEL, body.query);

  const searchResult = await env.VECTOR_INDEX.query(queryVector, { topK, returnMetadata: "all" });

  // Batch-fetch all matched documents in a single query (avoids N+1)
  const matchedIds = searchResult.matches.map((m) => m.id);
  let docMap = new Map<string, Document>();
  if (matchedIds.length > 0) {
    const placeholders = matchedIds.map(() => "?").join(", ");
    const batchRows = await env.DB.prepare(
      `SELECT * FROM documents WHERE id IN (${placeholders})`
    ).bind(...matchedIds).all<DocumentRow>();
    docMap = new Map((batchRows.results ?? []).map((r) => [r.id, rowToDoc(r)]));
  }

  const results = searchResult.matches.flatMap((match) => {
    const doc = docMap.get(match.id);
    return doc
      ? [{ id: match.id, score: match.score, title: doc.title, content: doc.content, source: doc.source }]
      : [];
  });

  return Response.json({ query: body.query, results });
}

type AiTextResponse = { response?: string };

async function handleAsk(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { question?: string; topK?: number };
  if (!body.question?.trim()) {
    return Response.json({ error: "'question' is required" }, { status: 400 });
  }

  // AI + Vectorize absent in test environment — return empty answer
  if (!env.AI || !env.VECTOR_INDEX) {
    return Response.json({ question: body.question, answer: "", citations: [] });
  }

  const topK = Math.min(body.topK ?? parseInt(env.TOP_K ?? "5", 10), 10);
  const queryVector = await embed(env.AI, env.EMBED_MODEL, body.question);
  const searchResult = await env.VECTOR_INDEX.query(queryVector, { topK, returnMetadata: "all" });

  // Batch-fetch all matched documents in a single query (avoids N+1)
  const askIds = searchResult.matches.map((m) => m.id);
  let askDocMap = new Map<string, Document>();
  if (askIds.length > 0) {
    const placeholders = askIds.map(() => "?").join(", ");
    const batchRows = await env.DB.prepare(
      `SELECT * FROM documents WHERE id IN (${placeholders})`
    ).bind(...askIds).all<DocumentRow>();
    askDocMap = new Map((batchRows.results ?? []).map((r) => [r.id, rowToDoc(r)]));
  }

  // Build context from top results (preserving Vectorize score order)
  const citations: Array<{ id: string; title: string; source?: string; score: number }> = [];
  const contextParts: string[] = [];

  for (const match of searchResult.matches) {
    const doc = askDocMap.get(match.id);
    if (doc) {
      citations.push({ id: doc.id, title: doc.title, source: doc.source, score: match.score });
      contextParts.push(`[${citations.length}] ${doc.title}\n${doc.content}`);
    }
  }

  if (contextParts.length === 0) {
    return Response.json({
      question: body.question,
      answer: "I could not find relevant information in the corpus to answer this question.",
      citations: [],
    });
  }

  const prompt = `You are a knowledgeable assistant. Answer the following question using ONLY the provided context. If the context does not contain enough information, say "The corpus does not contain sufficient information to answer this question." and do not speculate.

Context:
${contextParts.join("\n\n---\n\n")}

Question: ${body.question}

Answer (cite sources by [number]):`;

  const genResult = (await env.AI.run(env.GEN_MODEL as "@cf/meta/llama-3.1-8b-instruct", {
    prompt,
    max_tokens: parseInt(env.MAX_GEN_TOKENS ?? "512", 10),
  })) as AiTextResponse;

  return Response.json({
    question: body.question,
    answer: genResult?.response?.trim() ?? "Unable to generate answer.",
    citations,
  });
}

async function handleStats(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT key, value FROM stats`).all<{ key: string; value: string }>();
  const stats: Record<string, string | number> = {};
  for (const r of rows.results ?? []) {
    stats[r.key] = r.key === "total_docs" ? parseInt(r.value, 10) : r.value;
  }
  return Response.json({ ...stats, dimensions: 768, generatedAt: new Date().toISOString() });
}
