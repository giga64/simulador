-- Notificações push, links curtos de cenário e limites de tamanho/quantidade.

-- Inscrições de notificação push (uma por navegador). Cada usuário gerencia as
-- próprias; o servidor lê com a chave service_role para enviar as notificações.
create table if not exists public.push_subscriptions (
  endpoint text primary key
    check (char_length(endpoint) between 20 and 1000 and endpoint like 'https://%'),
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{20,200}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{8,100}$'),
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, public;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

create policy "Users can manage their own push subscriptions"
  on public.push_subscriptions
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Cenários compartilhados por link curto. Sem políticas: só o servidor
-- (service_role) lê e grava; o navegador passa sempre pelo servidor.
create table if not exists public.shared_scenarios (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{10}$'),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 32768),
  created_at timestamptz not null default now()
);

alter table public.shared_scenarios enable row level security;
revoke all on public.shared_scenarios from anon, authenticated, public;

-- Limites de tamanho nos campos JSON gravados pelo navegador.
alter table public.prediction_snapshots
  add constraint prediction_snapshots_model_snapshot_size
    check (model_snapshot is null or pg_column_size(model_snapshot) <= 4096),
  add constraint prediction_snapshots_result_source_size
    check (result_source is null or pg_column_size(result_source) <= 2048);

alter table public.saved_scenarios
  add constraint saved_scenarios_scenario_size check (pg_column_size(scenario) <= 32768);

-- Quantidade máxima de registros por usuário.
create or replace function public.enforce_user_row_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_count integer;
  maximum integer := tg_argv[0]::integer;
begin
  execute format('select count(*) from public.%I where user_id = $1', tg_table_name)
    into current_count
    using new.user_id;
  if current_count >= maximum then
    raise exception 'Limite de % registros por conta atingido.', maximum
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_user_row_limit() from public, anon, authenticated;

drop trigger if exists saved_scenarios_limit on public.saved_scenarios;
create trigger saved_scenarios_limit
  before insert on public.saved_scenarios
  for each row execute function public.enforce_user_row_limit('50');

drop trigger if exists prediction_snapshots_limit on public.prediction_snapshots;
create trigger prediction_snapshots_limit
  before insert on public.prediction_snapshots
  for each row execute function public.enforce_user_row_limit('400');

drop trigger if exists push_subscriptions_limit on public.push_subscriptions;
create trigger push_subscriptions_limit
  before insert on public.push_subscriptions
  for each row execute function public.enforce_user_row_limit('10');
