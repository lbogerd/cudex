CREATE TABLE thread_deletion_outbox (
    root_thread_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    lease_id TEXT,
    expected_revision INTEGER,
    created_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    PRIMARY KEY (root_thread_id, thread_id),
    CHECK (length(root_thread_id) > 0),
    CHECK (length(thread_id) > 0),
    CHECK ((lease_id IS NULL AND expected_revision IS NULL) OR
           (length(lease_id) > 0 AND expected_revision > 0))
);

CREATE INDEX thread_deletion_outbox_thread_idx
    ON thread_deletion_outbox (thread_id);

CREATE INDEX thread_deletion_outbox_retry_idx
    ON thread_deletion_outbox (last_attempt_at, created_at, root_thread_id);
