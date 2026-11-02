-- OpenBeat ECG: cloud sync of ECG history, sleep history and D2 Link nights.
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. Safe to run again.
--
-- What it creates:
--   • table public.ecg_sessions  – one row per ECG recording: details plus a SUMMARY (results, heart-rate trend,
--                                  average beat, first 30 s and up to 50 event strips). The whole ECG is not uploaded.
--   • table public.sleep_nights  – one row per night: the sleep report's numbers and graph data (no raw data)
--   • table public.d2_nights     – one row per night downloaded from a Watch D2 (D2 Link)
--   • access rules               – every account can only read, add, change and delete its OWN data

-- ---------- ECG recordings ----------
create table if not exists public.ecg_sessions (
  owner          uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id             text        not null,
  user_no        smallint    not null default 1 check (user_no between 1 and 9),
  started_at     bigint      not null,                  -- milliseconds since 1970 (as in the app)
  duration_s     real        not null check (duration_s > 0),
  fs             real        not null check (fs > 0),  -- samples per second
  alias          text        not null default '',
  source         text        not null check (source in ('polar', 'demo', 'import')),
  user_events    jsonb       not null default '[]'::jsonb,
  summary        jsonb,                                 -- results, trend, average beat and strips
  created_at     timestamptz not null default now(),
  primary key (owner, id)
);
-- upgrades a table created by an earlier version of this script (which stored the whole ECG)
alter table public.ecg_sessions add column if not exists summary jsonb;
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'ecg_sessions' and column_name = 'signal_bytes') then
    alter table public.ecg_sessions alter column signal_bytes set default 0;
  end if;
end $$;

alter table public.ecg_sessions enable row level security;
-- signed-in users may use the table (the policies below still limit them to their own rows); signed-out visitors may not
grant select, insert, update, delete on public.ecg_sessions to authenticated;
revoke all on public.ecg_sessions from anon;

drop policy if exists "ecg_sessions: read own"   on public.ecg_sessions;
drop policy if exists "ecg_sessions: add own"    on public.ecg_sessions;
drop policy if exists "ecg_sessions: change own" on public.ecg_sessions;
drop policy if exists "ecg_sessions: delete own" on public.ecg_sessions;

create policy "ecg_sessions: read own"   on public.ecg_sessions for select to authenticated using (owner = (select auth.uid()));
create policy "ecg_sessions: add own"    on public.ecg_sessions for insert to authenticated with check (owner = (select auth.uid()));
create policy "ecg_sessions: change own" on public.ecg_sessions for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "ecg_sessions: delete own" on public.ecg_sessions for delete to authenticated using (owner = (select auth.uid()));

-- ---------- sleep nights (report outputs only) ----------
create table if not exists public.sleep_nights (
  owner      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  user_no    smallint    not null default 1 check (user_no between 1 and 9),
  started_at bigint      not null,
  duration_s real        not null check (duration_s > 0),
  source     text        not null check (source in ('polar', 'demo')),
  report     jsonb       not null,                      -- numbers, stages, heart rate and breathing per 30 s
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

alter table public.sleep_nights enable row level security;
grant select, insert, update, delete on public.sleep_nights to authenticated;
revoke all on public.sleep_nights from anon;

drop policy if exists "sleep_nights: read own"   on public.sleep_nights;
drop policy if exists "sleep_nights: add own"    on public.sleep_nights;
drop policy if exists "sleep_nights: change own" on public.sleep_nights;
drop policy if exists "sleep_nights: delete own" on public.sleep_nights;

create policy "sleep_nights: read own"   on public.sleep_nights for select to authenticated using (owner = (select auth.uid()));
create policy "sleep_nights: add own"    on public.sleep_nights for insert to authenticated with check (owner = (select auth.uid()));
create policy "sleep_nights: change own" on public.sleep_nights for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "sleep_nights: delete own" on public.sleep_nights for delete to authenticated using (owner = (select auth.uid()));

-- ---------- D2 Link: nights downloaded from a Watch D2 (the watch's own sleep results) ----------
create table if not exists public.d2_nights (
  owner      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  user_no    smallint    not null default 1 check (user_no between 1 and 9),
  started_at bigint      not null,                      -- milliseconds since 1970
  night      jsonb       not null,                      -- stages per minute and the watch's summary
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

alter table public.d2_nights enable row level security;
grant select, insert, update, delete on public.d2_nights to authenticated;
revoke all on public.d2_nights from anon;

drop policy if exists "d2_nights: read own"   on public.d2_nights;
drop policy if exists "d2_nights: add own"    on public.d2_nights;
drop policy if exists "d2_nights: change own" on public.d2_nights;
drop policy if exists "d2_nights: delete own" on public.d2_nights;

create policy "d2_nights: read own"   on public.d2_nights for select to authenticated using (owner = (select auth.uid()));
create policy "d2_nights: add own"    on public.d2_nights for insert to authenticated with check (owner = (select auth.uid()));
create policy "d2_nights: change own" on public.d2_nights for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "d2_nights: delete own" on public.d2_nights for delete to authenticated using (owner = (select auth.uid()));
