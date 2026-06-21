-- Idempotent seed for the sample-stack DB.
-- Safe to run multiple times (ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS users (
  id   SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

INSERT INTO users (email, name)
VALUES ('user@example.com', 'Test User')
ON CONFLICT (email) DO NOTHING;
