CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  title TEXT,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notes_created_at_idx
  ON notes (created_at DESC);
