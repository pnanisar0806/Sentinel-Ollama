-- Phase 2.5 Task 3: the model's reading of each material filing.
--
-- Append-only and versioned: a reclassification is a new row, and readers take the latest
-- row classified BY THEIR CUTOFF, never the latest now (so a replay cannot see the future).
-- An event the model has not classified has NO row — pending is not neutral. Nothing here
-- is a number an engine score reads; it can only defer or flag (src/advisor, Task 6).

create table event_sentiment (
  id              bigserial primary key,
  event_id        bigint not null references news_events(id),
  polarity        text not null check (polarity in ('POSITIVE','NEGATIVE','NEUTRAL','UNKNOWN')),
  materiality     text not null check (materiality in ('HIGH','MEDIUM','LOW','UNKNOWN')),
  summary         text not null,
  model           text not null,
  prompt_version  text not null,
  schema_version  text not null,
  classified_at   timestamptz not null,
  as_of           timestamptz not null,
  source          text not null default 'openrouter'
);
create index event_sentiment_event_idx on event_sentiment (event_id, classified_at desc);

create trigger event_sentiment_append_only before update or delete on event_sentiment
  for each statement execute function sentinel_append_only();
create trigger event_sentiment_truncate_only before truncate on event_sentiment
  for each statement execute function sentinel_append_only();
alter table event_sentiment enable row level security;
create policy event_sentiment_owner on event_sentiment using (true) with check (true);
