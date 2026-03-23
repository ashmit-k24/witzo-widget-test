ALTER TABLE rag_source_pages
ADD COLUMN IF NOT EXISTS page_content TEXT;
