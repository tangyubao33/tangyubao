-- Portfolio analytics v1.1 — coarse visitor geography.
-- No raw IP is stored: these values come from Cloudflare's edge
-- (`request.cf.country/region/city/continent`) at ingest time.
ALTER TABLE events ADD COLUMN region TEXT;
ALTER TABLE events ADD COLUMN city TEXT;
ALTER TABLE events ADD COLUMN continent TEXT;
