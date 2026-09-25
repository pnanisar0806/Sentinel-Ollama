// Tests must never reach a real database. `openDb()` with no argument reads
// DATABASE_URL, so a shell that had sourced .env ran the whole suite against
// production on 2026-09-25 and wrote fixtures into it. Tests that need a URL set
// their own; everything else gets PGlite.
delete process.env.DATABASE_URL;
