-- Поиск дублей и похожих заявок по триграммам текста.
-- pg_trgm входит в стандартную поставку Postgres (в том числе на Railway), в отличие от pgvector.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requests_raw_text_trgm_idx" ON "requests" USING gin ("raw_text" gin_trgm_ops);
