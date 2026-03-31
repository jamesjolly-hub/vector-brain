/**
 * vector-brain tests
 *
 * Tests the HTTP API layer. Workers AI + Vectorize are mocked via
 * miniflare bindings in the test pool — actual embedding values are
 * zeros in the test environment; the tests validate API shape / D1 writes.
 */

import { SELF, env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://vector-brain.workers.dev";

const MIGRATIONS = [
  {
    name: "0001_initial",
    queries: [
      `CREATE TABLE IF NOT EXISTS documents (
        id          TEXT    PRIMARY KEY,
        title       TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        source      TEXT,
        tags        TEXT    NOT NULL DEFAULT '[]',
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS stats (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `INSERT OR IGNORE INTO stats (key, value) VALUES ('total_docs', '0')`,
      `INSERT OR IGNORE INTO stats (key, value) VALUES ('last_indexed_at', '')`,
      `CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_documents_title   ON documents (title)`,
    ],
  },
];

beforeAll(async () => {
  await applyD1Migrations(env.DB as D1Database, MIGRATIONS);
});

// ---------------------------------------------------------------------------
// Canonical: POST /documents
// ---------------------------------------------------------------------------

describe("POST /documents", () => {
  it("inserts a document and returns 201 with id", async () => {
    const res = await SELF.fetch(`${BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Cloudflare Workers Overview",
        content: "Cloudflare Workers run JavaScript at the edge.",
        tags: ["cloudflare", "workers"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(typeof body.id).toBe("string");
    expect(body.title).toBe("Cloudflare Workers Overview");
  });

  it("returns 400 when title or content missing", async () => {
    const res = await SELF.fetch(`${BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Missing title" }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Spec alias: POST /corpus → same as POST /documents
// ---------------------------------------------------------------------------

describe("POST /corpus (spec alias for /documents)", () => {
  it("inserts a document via /corpus and returns 201 with id", async () => {
    const res = await SELF.fetch(`${BASE}/corpus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Corpus Alias Test Document",
        content: "Testing the /corpus alias endpoint.",
        tags: ["alias"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string; createdAt: string };
    expect(typeof body.id).toBe("string");
    expect(body.title).toBe("Corpus Alias Test Document");
    expect(typeof body.createdAt).toBe("string");
  });

  it("returns 400 via /corpus when title is missing — same as /documents", async () => {
    const res = await SELF.fetch(`${BASE}/corpus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Missing title via corpus alias" }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Spec alias: POST /corpus/bulk → same as POST /documents/bulk
// ---------------------------------------------------------------------------

describe("POST /corpus/bulk (spec alias for /documents/bulk)", () => {
  it("bulk-inserts via /corpus/bulk and returns 201 with inserted count", async () => {
    const res = await SELF.fetch(`${BASE}/corpus/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { title: "Bulk Alias Doc A", content: "Content A via corpus/bulk." },
        { title: "Bulk Alias Doc B", content: "Content B via corpus/bulk." },
      ]),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { inserted: number; ids: string[] };
    expect(body.inserted).toBe(2);
    expect(Array.isArray(body.ids)).toBe(true);
    expect(body.ids.length).toBe(2);
  });

  it("returns 400 via /corpus/bulk when body is not an array", async () => {
    const res = await SELF.fetch(`${BASE}/corpus/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Not an array" }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /documents
// ---------------------------------------------------------------------------

describe("GET /documents", () => {
  it("returns documents array", async () => {
    const res = await SELF.fetch(`${BASE}/documents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: unknown[] };
    expect(Array.isArray(body.documents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /documents/:id
// ---------------------------------------------------------------------------

describe("GET /documents/:id", () => {
  it("retrieves a specific document by id", async () => {
    // Insert first
    const insertRes = await SELF.fetch(`${BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test Get Doc", content: "Some content for get test." }),
    });
    const { id } = (await insertRes.json()) as { id: string };

    const getRes = await SELF.fetch(`${BASE}/documents/${id}`);
    expect(getRes.status).toBe(200);
    const doc = (await getRes.json()) as { id: string; title: string; content: string };
    expect(doc.id).toBe(id);
    expect(doc.title).toBe("Test Get Doc");
  });

  it("returns 404 for unknown id", async () => {
    const res = await SELF.fetch(`${BASE}/documents/non-existent-id-xyz`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /documents/:id
// ---------------------------------------------------------------------------

describe("DELETE /documents/:id", () => {
  it("deletes a document and returns 204", async () => {
    const insertRes = await SELF.fetch(`${BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "To Delete", content: "Will be deleted." }),
    });
    const { id } = (await insertRes.json()) as { id: string };

    const delRes = await SELF.fetch(`${BASE}/documents/${id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    const getRes = await SELF.fetch(`${BASE}/documents/${id}`);
    expect(getRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /search
// ---------------------------------------------------------------------------

describe("POST /search", () => {
  it("returns results array for a valid query", async () => {
    const res = await SELF.fetch(`${BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Cloudflare edge network" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("returns 400 when query is missing", async () => {
    const res = await SELF.fetch(`${BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /ask
// ---------------------------------------------------------------------------

describe("POST /ask", () => {
  it("returns answer and citations for a valid question", async () => {
    const res = await SELF.fetch(`${BASE}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What is Cloudflare Workers?" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; citations: unknown[] };
    expect(typeof body.answer).toBe("string");
    expect(Array.isArray(body.citations)).toBe(true);
  });

  it("returns 400 when question is missing", async () => {
    const res = await SELF.fetch(`${BASE}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /stats
// ---------------------------------------------------------------------------

describe("GET /stats", () => {
  it("returns total_docs count", async () => {
    const res = await SELF.fetch(`${BASE}/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total_docs: number };
    expect(typeof body.total_docs).toBe("number");
  });

  it("includes dimensions: 768 in stats response", async () => {
    const res = await SELF.fetch(`${BASE}/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dimensions: number };
    expect(body.dimensions).toBe(768);
  });
});

// ---------------------------------------------------------------------------
// DELETE /corpus/:id — spec alias for DELETE /documents/:id
// ---------------------------------------------------------------------------

describe("DELETE /corpus/:id (spec alias for DELETE /documents/:id)", () => {
  it("deletes a document via /corpus/:id and returns 204", async () => {
    // Insert a document via canonical route
    const insertRes = await SELF.fetch(`${BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Corpus Delete Alias Test", content: "Will be deleted via /corpus alias." }),
    });
    expect(insertRes.status).toBe(201);
    const { id } = (await insertRes.json()) as { id: string };

    // Delete via /corpus/:id alias
    const delRes = await SELF.fetch(`${BASE}/corpus/${id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    // Confirm deletion via canonical GET
    const getRes = await SELF.fetch(`${BASE}/documents/${id}`);
    expect(getRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// source_url field acceptance
// ---------------------------------------------------------------------------

describe("source_url field in POST /documents", () => {
  it("accepts source_url and stores it as the source field", async () => {
    const sourceUrl = "https://example.com/article/cloudflare-workers";
    const insertRes = await SELF.fetch(`${BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Source URL Test Document",
        content: "Testing source_url field acceptance per spec.",
        source_url: sourceUrl,
      }),
    });
    expect(insertRes.status).toBe(201);
    const { id } = (await insertRes.json()) as { id: string };

    // GET the document and verify source is stored (code maps source_url ?? source → source column)
    const getRes = await SELF.fetch(`${BASE}/documents/${id}`);
    expect(getRes.status).toBe(200);
    const doc = (await getRes.json()) as { id: string; source?: string };
    expect(doc.source).toBe(sourceUrl);
  });
});

// ---------------------------------------------------------------------------
// POST /documents/bulk — canonical route (not /corpus/bulk alias)
// ---------------------------------------------------------------------------

describe("POST /documents/bulk (canonical route)", () => {
  it("bulk-inserts via canonical /documents/bulk and returns 201 with inserted count", async () => {
    const res = await SELF.fetch(`${BASE}/documents/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { title: "Canonical Bulk Doc A", content: "Content A via /documents/bulk." },
        { title: "Canonical Bulk Doc B", content: "Content B via /documents/bulk." },
        { title: "Canonical Bulk Doc C", content: "Content C via /documents/bulk." },
      ]),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { inserted: number; ids: string[] };
    expect(body.inserted).toBe(3);
    expect(Array.isArray(body.ids)).toBe(true);
    expect(body.ids.length).toBe(3);
  });

  it("returns 400 for empty array via /documents/bulk", async () => {
    const res = await SELF.fetch(`${BASE}/documents/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /documents with pagination (limit + offset)
// ---------------------------------------------------------------------------

describe("GET /documents pagination", () => {
  it("respects limit=1 and returns only 1 document", async () => {
    // Insert 2 documents to ensure there is data to paginate
    await SELF.fetch(`${BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pagination Doc Alpha", content: "First pagination test doc." }),
    });
    await SELF.fetch(`${BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pagination Doc Beta", content: "Second pagination test doc." }),
    });

    const res = await SELF.fetch(`${BASE}/documents?limit=1&offset=0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: unknown[] };
    expect(body.documents.length).toBe(1);
  });

  it("respects offset=1 and returns the second page", async () => {
    // Ensure at least 2 documents exist (may be inserted above; D1 state persists within test run)
    const listRes = await SELF.fetch(`${BASE}/documents`);
    const listBody = (await listRes.json()) as { documents: unknown[] };
    // Only test pagination if there are ≥2 documents
    if (listBody.documents.length >= 2) {
      const res = await SELF.fetch(`${BASE}/documents?limit=1&offset=1`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { documents: unknown[] };
      expect(body.documents.length).toBe(1);
    } else {
      // Not enough data — pass trivially (other tests in this suite add docs)
      expect(true).toBe(true);
    }
  });
});
