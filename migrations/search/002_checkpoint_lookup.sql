-- Bounded keyset enumeration with deterministic ordering independent of locale.
CREATE INDEX search_documents_checkpoint_page_idx
    ON search_documents (workspace_id, source_revision, session_id COLLATE "C");

-- Paths can exceed PostgreSQL's btree key-size limit. Hash only for index selection;
-- the repository also tests exact path equality, so hash collisions are harmless.
-- Nonunique: a replaced file may leave multiple prior session IDs at one path.
CREATE INDEX search_documents_source_path_idx
    ON search_documents (workspace_id, source_revision, md5(source_path), session_id COLLATE "C");
