-- Widen screener_uploads.source to allow 'screener-screen' (HTML scrape path)
-- alongside the existing 'screener-in' (CSV path).

alter table screener_uploads
  drop constraint screener_uploads_source_check;

alter table screener_uploads
  add constraint screener_uploads_source_check
    check (source in ('screener-in', 'screener-screen'));
