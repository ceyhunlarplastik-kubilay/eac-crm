import { randomUUID } from "node:crypto";
import { database, transaction } from "./database";
import type { CatalogSource } from "./contracts";

export const EMBEDDING_DIMENSIONS = 768;
export type KnowledgePage = { page: number | null; text: string };
export type KnowledgePiece = KnowledgePage & { ordinal: number };
export type KnowledgeInput = {
  sourceKey: string; title: string; kind: "CATALOG" | "COMPANY"; version: string;
  sourceUri: string; contentHash: string; embeddingModelId: string;
};

export function normalizeVector(values: number[]) {
  if (values.length !== EMBEDDING_DIMENSIONS || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding 768 sonlu sayı içermeli; model ve indeks boyutları eşleşmiyor.");
  }
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding boş veya geçersiz.");
  return values.map((value) => value / norm);
}
export function vectorSql(values: number[]) { return `[${normalizeVector(values).join(",")}]`; }

// Conservative character bounds, overlap and page provenance; never silently truncate at the API.
export function chunkPages(pages: KnowledgePage[]): KnowledgePiece[] {
  const pieces: KnowledgePiece[] = [];
  let characters = 0;
  for (const page of pages) {
    const text = page.text.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").trim();
    characters += text.length;
    if (characters > 2_000_000) throw new Error("Doküman en fazla 2 milyon metin karakteri içerebilir.");
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + 1200, text.length);
      if (end < text.length) {
        const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
        if (boundary > start + 600) end = boundary;
      }
      const part = text.slice(start, end).trim();
      if (part) pieces.push({ ordinal: pieces.length, page: page.page, text: part });
      if (pieces.length > 2500) throw new Error("Doküman en fazla 2500 parçaya ayrılabilir.");
      if (end === text.length) break;
      start = end - 180;
    }
  }
  if (!pieces.length) throw new Error("Dokümanda okunabilir metin bulunamadı. Taranmış PDF için önce OCR gerekiyor.");
  return pieces;
}

export async function existingDocument(input: KnowledgeInput) {
  const { rows: [document] } = await database().query<{ id: string; chunkCount: number; active: boolean }>(`
    SELECT "id", "chunkCount", "active" FROM "KnowledgeDocument"
    WHERE "sourceKey"=$1 AND "version"=$2 AND "contentHash"=$3 AND "embeddingModelId"=$4`,
  [input.sourceKey, input.version, input.contentHash, input.embeddingModelId]);
  return document;
}

export async function publishDocument(input: KnowledgeInput, pieces: KnowledgePiece[], embeddings: number[][]) {
  if (!pieces.length || pieces.length !== embeddings.length) throw new Error("Eksik embedding ile doküman yayımlanamaz.");
  const vectors = embeddings.map(vectorSql); // Validate every vector before beginning a transaction.
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(610092026, hashtext($1))", [input.sourceKey]);
    const { rows: [existing] } = await client.query<{ id: string }>(`
      SELECT "id" FROM "KnowledgeDocument" WHERE "sourceKey"=$1 AND "version"=$2
      AND "contentHash"=$3 AND "embeddingModelId"=$4`, [input.sourceKey, input.version, input.contentHash, input.embeddingModelId]);
    await client.query(`UPDATE "KnowledgeDocument" SET "active"=false, "updatedAt"=now() WHERE "sourceKey"=$1 AND "active"`, [input.sourceKey]);
    if (existing) {
      await client.query(`UPDATE "KnowledgeDocument" SET "active"=true, "updatedAt"=now() WHERE "id"=$1`, [existing.id]);
      return existing.id;
    }
    const id = randomUUID();
    await client.query(`INSERT INTO "KnowledgeDocument"
      ("id","sourceKey","title","kind","version","sourceUri","contentHash","embeddingModelId","chunkCount","active","updatedAt")
      VALUES ($1,$2,$3,$4::"KnowledgeDocumentKind",$5,$6,$7,$8,$9,true,now())`,
    [id, input.sourceKey, input.title, input.kind, input.version, input.sourceUri, input.contentHash, input.embeddingModelId, pieces.length]);
    for (let i = 0; i < pieces.length; i++) {
      await client.query(`INSERT INTO "KnowledgeChunk" ("id","documentId","ordinal","page","text","embedding")
        VALUES ($1,$2,$3,$4,$5,$6::vector)`, [randomUUID(), id, pieces[i].ordinal, pieces[i].page, pieces[i].text, vectors[i]]);
    }
    return id;
  });
}

export async function searchKnowledge(query: string, embedding: number[], modelId: string): Promise<CatalogSource[]> {
  // Reciprocal rank fusion keeps exact product names/codes useful alongside semantic matches.
  const { rows } = await database().query<{ uri: string; page: number | null; text: string; version: string; score: number; title: string; kind: "CATALOG" | "COMPANY" }>(`
    WITH eligible AS MATERIALIZED (
      SELECT "id" FROM "KnowledgeDocument" WHERE "active" AND "embeddingModelId"=$3 AND "dimensions"=768
    ), nearest AS MATERIALIZED (
      SELECT c."id", (c."embedding" <=> $2::vector) AS distance
      FROM "KnowledgeChunk" c JOIN eligible d ON d."id"=c."documentId"
      ORDER BY c."embedding" <=> $2::vector LIMIT 24
    ), semantic AS (
      SELECT "id", row_number() OVER (ORDER BY distance,"id") AS rank FROM nearest
    ), lexical AS (
      SELECT c."id", row_number() OVER (ORDER BY ts_rank_cd(c."searchText", plainto_tsquery('simple',$1)) DESC) AS rank
      FROM "KnowledgeChunk" c JOIN eligible d ON d."id"=c."documentId"
      WHERE c."searchText" @@ plainto_tsquery('simple',$1)
      ORDER BY ts_rank_cd(c."searchText", plainto_tsquery('simple',$1)) DESC LIMIT 24
    ), fused AS (
      SELECT COALESCE(s."id",l."id") AS id,
        COALESCE(1.0/(60+s.rank),0)+COALESCE(1.0/(60+l.rank),0) AS rank
      FROM semantic s FULL OUTER JOIN lexical l ON s."id"=l."id"
    ) SELECT d."sourceUri" AS uri,c."page",c."text",d."version",d."title",d."kind",
      (1-(c."embedding" <=> $2::vector))::float AS score
    FROM fused f JOIN "KnowledgeChunk" c ON c."id"=f.id JOIN "KnowledgeDocument" d ON d."id"=c."documentId"
    ORDER BY f.rank DESC, c."id" LIMIT 4`, [query, vectorSql(embedding), modelId]);
  return rows.map((row, index) => ({ ...row, id: `K${index + 1}` }));
}
