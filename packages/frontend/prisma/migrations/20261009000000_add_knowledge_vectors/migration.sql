-- Additive: existing customers, contacts and recordings are untouched.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TYPE "KnowledgeDocumentKind" AS ENUM ('CATALOG', 'COMPANY');
CREATE TABLE "KnowledgeDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "kind" "KnowledgeDocumentKind" NOT NULL,
  "version" TEXT NOT NULL,
  "sourceUri" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "embeddingModelId" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL DEFAULT 768 CHECK ("dimensions" = 768),
  "chunkCount" INTEGER NOT NULL CHECK ("chunkCount" > 0),
  "active" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeDocument_version_key"
    UNIQUE ("sourceKey", "version", "contentHash", "embeddingModelId")
);
CREATE INDEX "KnowledgeDocument_active_embeddingModelId_idx" ON "KnowledgeDocument" ("active", "embeddingModelId");
CREATE UNIQUE INDEX "KnowledgeDocument_active_sourceKey_key" ON "KnowledgeDocument" ("sourceKey") WHERE "active";
CREATE TABLE "KnowledgeChunk" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "documentId" TEXT NOT NULL REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "page" INTEGER CHECK ("page" > 0),
  "text" TEXT NOT NULL CHECK (length("text") > 0),
  "embedding" vector(768) NOT NULL,
  "searchText" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, "text")) STORED,
  CONSTRAINT "KnowledgeChunk_documentId_ordinal_key" UNIQUE ("documentId", "ordinal")
);
CREATE INDEX "KnowledgeChunk_embedding_hnsw_idx" ON "KnowledgeChunk" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "KnowledgeChunk_searchText_gin_idx" ON "KnowledgeChunk" USING gin ("searchText");
