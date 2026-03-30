-- ─── access_control_jobs ──────────────────────────────────────────────────────
-- Run this in your Supabase SQL editor to create the jobs queue table.

create table if not exists public.access_control_jobs (
  id          uuid        primary key default gen_random_uuid(),
  type        text        not null,
  -- Job types:
  --   'unlock_door'  - payload: { doorNo? }
  --   'add_user'     - payload: { employeeNo, name, beginTime, endTime }
  --   'delete_user'  - payload: { employeeNo }
  --   'get_user'     - payload: { employeeNo }
  --   'add_card'     - payload: { employeeNo, cardNo }
  --   'revoke_card'  - payload: { employeeNo, cardNo }
  --   'get_card'     - payload: { employeeNo }
  --   'list_available_cards' - payload: {}

  payload     jsonb       not null default '{}',
  status      text        not null default 'pending',
  -- Status values: 'pending' | 'processing' | 'done' | 'failed'

  result      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Index so the bridge can quickly find pending jobs
create index if not exists idx_acj_status
  on public.access_control_jobs (status, created_at);

-- Enable Realtime on this table (bridge uses Supabase Realtime to detect new jobs)
alter publication supabase_realtime add table public.access_control_jobs;

-- ─── Row Level Security ────────────────────────────────────────────────────────
-- The bridge uses the service role key (bypasses RLS).
-- The PWA uses the anon key, so we set up RLS to allow inserts only.

alter table public.access_control_jobs enable row level security;

-- PWA (anon/authenticated users) can insert jobs
create policy "Anyone can create jobs"
  on public.access_control_jobs
  for insert
  to authenticated, anon
  with check (true);

-- Only service role can read/update jobs (the bridge)
create policy "Service role can manage jobs"
  on public.access_control_jobs
  for all
  to service_role
  using (true);
