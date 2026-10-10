create table if not exists public.prediction_snapshots (
  user_id uuid not null references auth.users (id) on delete cascade,
  fixture_id text not null check (char_length(fixture_id) between 1 and 80),
  round smallint not null check (round between 1 and 38),
  home_team text not null check (char_length(home_team) between 2 and 8),
  away_team text not null check (char_length(away_team) between 2 and 8),
  prediction jsonb not null
    check (jsonb_typeof(prediction) = 'object')
    check ((prediction->>'home') ~ '^(0|[1-9]|1[0-9]|20)$')
    check ((prediction->>'away') ~ '^(0|[1-9]|1[0-9]|20)$')
    check (prediction->>'type' in ('a', 'u')),
  model_snapshot jsonb
    check (model_snapshot is null or jsonb_typeof(model_snapshot) = 'object'),
  actual jsonb
    check (actual is null or (
      jsonb_typeof(actual) = 'object'
      and (actual->>'home') ~ '^(0|[1-9]|1[0-9]|20)$'
      and (actual->>'away') ~ '^(0|[1-9]|1[0-9]|20)$'
    )),
  result_source jsonb,
  recorded_at timestamptz not null,
  primary key (user_id, fixture_id)
);

alter table public.prediction_snapshots enable row level security;

revoke all on public.prediction_snapshots from anon, public;
grant select, insert, update, delete on public.prediction_snapshots to authenticated;

create policy "Users can view their own prediction snapshots"
  on public.prediction_snapshots
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own prediction snapshots"
  on public.prediction_snapshots
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own prediction snapshots"
  on public.prediction_snapshots
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own prediction snapshots"
  on public.prediction_snapshots
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
