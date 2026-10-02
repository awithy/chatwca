-- The administrator provisions pgvector separately. Application startup never
-- applies DDL. No ANN index until filtered recall/latency justify one.
CREATE TABLE search_workspaces (
    workspace_id text PRIMARY KEY,
    source_revision text NOT NULL,
    display_name text NOT NULL,
    canonical_path text NOT NULL,
    session_directory text NOT NULL,
    last_scan_started_at timestamptz,
    last_scan_succeeded_at timestamptz,
    scan_id uuid,
    scan_state text NOT NULL DEFAULT 'pending'
        CHECK (scan_state IN ('pending', 'scanning', 'ready', 'unavailable', 'error')),
    error_code text,
    document_count integer NOT NULL DEFAULT 0 CHECK (document_count >= 0),
    chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0)
);

CREATE TABLE search_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id text NOT NULL REFERENCES search_workspaces(workspace_id) ON DELETE CASCADE,
    session_id text NOT NULL,
    source_revision text NOT NULL,
    source_path text NOT NULL,
    source_device text NOT NULL,
    source_inode text NOT NULL,
    source_size bigint NOT NULL CHECK (source_size >= 0),
    source_mtime_ns numeric(30, 0) NOT NULL,
    source_ctime_ns numeric(30, 0) NOT NULL,
    title text NOT NULL,
    created_at timestamptz NOT NULL,
    modified_at timestamptz NOT NULL,
    saved_leaf_id text NOT NULL,
    snapshot_hash text NOT NULL,
    extracted_content_hash text NOT NULL,
    processing_signature text NOT NULL,
    embedding_space_signature text NOT NULL,
    indexed_at timestamptz NOT NULL DEFAULT now(),
    last_seen_scan_id uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    UNIQUE (workspace_id, session_id)
);
CREATE INDEX search_documents_scope_idx ON search_documents (workspace_id, source_revision);

CREATE TABLE search_chunks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES search_documents(id) ON DELETE CASCADE,
    stable_key text NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    entry_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    entry_timestamp timestamptz NOT NULL,
    source_byte_start integer NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end integer NOT NULL CHECK (source_byte_end > source_byte_start),
    original_text text NOT NULL,
    text_hash text NOT NULL,
    embedding_input_hash text NOT NULL,
    embedding vector(1024) NOT NULL,
    embedding_space_signature text NOT NULL,
    -- Copied lexical metadata must be updated with its document in the same
    -- transaction. It is deliberately excluded from the embedding input.
    lexical_title text NOT NULL,
    lexical_workspace_name text NOT NULL,
    search_english tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english'::regconfig, lexical_title), 'A') ||
        setweight(to_tsvector('english'::regconfig, lexical_workspace_name), 'B') ||
        setweight(to_tsvector('english'::regconfig, original_text), 'C')
    ) STORED,
    search_simple tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, lexical_title), 'A') ||
        setweight(to_tsvector('simple'::regconfig, lexical_workspace_name), 'B') ||
        setweight(to_tsvector('simple'::regconfig, original_text), 'C')
    ) STORED,
    UNIQUE (document_id, stable_key)
);
CREATE INDEX search_chunks_entry_idx ON search_chunks (document_id, entry_id);
CREATE INDEX search_chunks_space_idx ON search_chunks (embedding_space_signature);
CREATE INDEX search_chunks_input_idx ON search_chunks (document_id, embedding_space_signature, embedding_input_hash);
CREATE INDEX search_chunks_english_idx ON search_chunks USING gin (search_english);
CREATE INDEX search_chunks_simple_idx ON search_chunks USING gin (search_simple);

CREATE TABLE search_index_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reason text NOT NULL CHECK (reason IN ('startup', 'scheduled', 'manual', 'rebuild')),
    workspace_id text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'interrupted')),
    documents_seen integer NOT NULL DEFAULT 0 CHECK (documents_seen >= 0),
    documents_indexed integer NOT NULL DEFAULT 0 CHECK (documents_indexed >= 0),
    documents_skipped integer NOT NULL DEFAULT 0 CHECK (documents_skipped >= 0),
    documents_deleted integer NOT NULL DEFAULT 0 CHECK (documents_deleted >= 0),
    documents_failed integer NOT NULL DEFAULT 0 CHECK (documents_failed >= 0),
    chunks_embedded integer NOT NULL DEFAULT 0 CHECK (chunks_embedded >= 0),
    error_code text
);
CREATE INDEX search_index_runs_started_idx ON search_index_runs (started_at);
