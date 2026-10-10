create table if not exists public.saved_scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  scenario jsonb not null check (jsonb_typeof(scenario) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_scenarios_user_updated_idx
  on public.saved_scenarios (user_id, updated_at desc);

alter table public.saved_scenarios enable row level security;
revoke all on public.saved_scenarios from anon, public;
grant select, insert, update, delete on public.saved_scenarios to authenticated;

create policy "Users can manage their own saved scenarios"
  on public.saved_scenarios
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  favorite_teams text[] not null default '{}',
  in_site_reminders boolean not null default false,
  reminder_minutes smallint not null default 30
    check (reminder_minutes between 5 and 120),
  updated_at timestamptz not null default now(),
  check (cardinality(favorite_teams) <= 20),
  check (favorite_teams <@ array[
    'FLA', 'PAL', 'FLU', 'CAP', 'CRU', 'BAH', 'CAM', 'SAN', 'CFC', 'BRA',
    'SAO', 'VIT', 'BOT', 'VAS', 'MIR', 'COR', 'INT', 'GRE', 'REM', 'CHA'
  ]::text[])
);

alter table public.user_preferences enable row level security;
revoke all on public.user_preferences from anon, public;
grant select, insert, update, delete on public.user_preferences to authenticated;

create policy "Users can manage their own preferences"
  on public.user_preferences
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
