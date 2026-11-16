-- Portfolio analytics v1 — raw events.
-- Applied with: npx wrangler d1 migrations apply tangyubao-analytics --remote
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,          -- client event id (dedupe on retries)
  ts          INTEGER NOT NULL,          -- client timestamp (epoch ms)
  received_at INTEGER NOT NULL,          -- server timestamp (retention + ordering)
  site        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  sid         TEXT    NOT NULL,          -- 30-minute session id
  vid         TEXT    NOT NULL,          -- anonymous visitor id
  pid         TEXT    NOT NULL,          -- page instance id
  screen      TEXT    NOT NULL DEFAULT '',
  props       TEXT    NOT NULL DEFAULT '{}',
  country     TEXT,                      -- ISO country from the edge, no IP
  day         TEXT    NOT NULL           -- UTC day, for cheap retention scans
);

CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events (site, ts);
CREATE INDEX IF NOT EXISTS idx_events_sid ON events (sid);
CREATE INDEX IF NOT EXISTS idx_events_day ON events (day);
CREATE INDEX IF NOT EXISTS idx_events_received ON events (received_at);
