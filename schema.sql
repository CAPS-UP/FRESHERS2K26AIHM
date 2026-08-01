-- Freshers 2K26 — database
--
-- Create it once:
--   npx wrangler d1 create freshers2k26
--   npx wrangler d1 execute freshers2k26 --remote --file=./schema.sql
--
-- Then bind it in the Pages project: Settings -> Bindings -> D1
--   Variable name: DB      Database: freshers2k26

CREATE TABLE IF NOT EXISTS registrations (
  ticket      TEXT PRIMARY KEY,          -- F26-1234-5678
  name        TEXT NOT NULL,
  year        TEXT,                      -- "1st Year"
  kind        TEXT,                      -- 'A' alcoholic | 'N' non-alcoholic
  email       TEXT,
  phone       TEXT,
  reference   TEXT,
  utr         TEXT,
  amount      INTEGER,                   -- rupees
  order_json  TEXT,                      -- what they bought
  photo       TEXT,                      -- ~400px data URL, goes on the pass
  thumb       TEXT,                      -- ~110px data URL, goes to the door
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | issued | rejected
  signature   TEXT,                      -- filled in when issued
  note        TEXT,
  created_at  TEXT NOT NULL,
  issued_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_reg_status ON registrations(status);
CREATE INDEX IF NOT EXISTS idx_reg_utr    ON registrations(utr);
CREATE INDEX IF NOT EXISTS idx_reg_phone  ON registrations(phone);

-- One row per person through the door. Ticket is the primary key, so a second
-- insert for the same ticket fails — that is how duplicates get caught even
-- when two phones were offline at the same time.
CREATE TABLE IF NOT EXISTS checkins (
  ticket    TEXT PRIMARY KEY,
  at        TEXT NOT NULL,               -- ISO timestamp
  device    TEXT,                        -- which phone let them in
  verified  INTEGER NOT NULL DEFAULT 1,  -- 0 = typed by hand, no QR
  FOREIGN KEY (ticket) REFERENCES registrations(ticket)
);

-- Every rejected or duplicate scan, so you can see what happened at the gate.
CREATE TABLE IF NOT EXISTS door_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  ticket  TEXT,
  verdict TEXT NOT NULL,                 -- admitted | duplicate | forged | unknown
  device  TEXT,
  raw     TEXT
);

CREATE INDEX IF NOT EXISTS idx_log_at ON door_log(at);
