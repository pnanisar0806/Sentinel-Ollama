-- §13 scoring: a benchmark row is created once and then accrues its 3/6/12-month
-- evaluations. The creation snapshot must stay immutable — it is the point of comparison
-- the whole post-hoc evaluation rests on — but the eval columns have to be writable, so
-- blanket append-only is wrong here. Same shape as `sentinel_lots_immutable`: UPDATE is
-- allowed only when nothing but the eval columns moved.

drop trigger if exists benchmarks_append_only on benchmarks;

create or replace function sentinel_benchmarks_immutable() returns trigger as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'benchmarks immutable: rows may not be %d', tg_op;
  end if;
  if new.id is distinct from old.id
     or new.recommendation_id is distinct from old.recommendation_id
     or new.benchmark_as_of is distinct from old.benchmark_as_of
     or new.benchmark_jsonb is distinct from old.benchmark_jsonb then
    raise exception 'benchmarks immutable: the creation snapshot may not be rewritten';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger benchmarks_immutable before update on benchmarks
  for each row execute function sentinel_benchmarks_immutable();

create trigger benchmarks_no_delete before delete on benchmarks
  for each statement execute function sentinel_append_only();
