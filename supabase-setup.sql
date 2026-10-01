-- Run this once in Supabase Dashboard → SQL Editor for your project.
-- Every user-owned row is restricted by auth.uid() through row-level security.

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  reference text not null unique default ('CB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  issue_type text not null check (issue_type in ('Litter on the street', 'Overflowing bin', 'Illegal dumping', 'Other')),
  location text not null check (char_length(location) between 2 and 180),
  note text not null default '' check (char_length(note) <= 1000),
  status text not null default 'Received' check (status in ('Received', 'In progress', 'Resolved')),
  created_at timestamptz not null default now()
);

create table if not exists public.pickup_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  waste_type text not null check (waste_type in ('Dry recyclables', 'E-waste', 'Garden waste', 'Other')),
  location text not null check (char_length(location) between 2 and 180),
  preferred_date date,
  status text not null default 'Requested' check (status in ('Requested', 'Scheduled', 'Completed', 'Cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rating text not null check (rating in ('Great', 'Good', 'Could be better')),
  message text not null check (char_length(message) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table if not exists public.reminders (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  remind_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.reports enable row level security;
alter table public.pickup_requests enable row level security;
alter table public.feedback enable row level security;
alter table public.reminders enable row level security;

revoke all on public.reports, public.pickup_requests, public.feedback, public.reminders from anon, authenticated;
grant select, insert on public.reports to authenticated;
grant select, insert on public.pickup_requests to authenticated;
grant select on public.feedback to authenticated;
grant insert on public.feedback to authenticated;
grant select, insert, update, delete on public.reminders to authenticated;
grant usage, select on all sequences in schema public to authenticated;

drop policy if exists "Users read their reports" on public.reports;
create policy "Users read their reports" on public.reports for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users create their reports" on public.reports;
create policy "Users create their reports" on public.reports for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Admins read all reports" on public.reports;
create policy "Admins read all reports" on public.reports for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "Users read their pickup requests" on public.pickup_requests;
create policy "Users read their pickup requests" on public.pickup_requests for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users create their pickup requests" on public.pickup_requests;
create policy "Users create their pickup requests" on public.pickup_requests for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Admins read all pickup requests" on public.pickup_requests;
create policy "Admins read all pickup requests" on public.pickup_requests for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "Users submit their feedback" on public.feedback;
create policy "Users submit their feedback" on public.feedback for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Admins read all feedback" on public.feedback;
create policy "Admins read all feedback" on public.feedback for select to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "Users manage their reminders" on public.reminders;
create policy "Users manage their reminders" on public.reminders for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Only aggregated place/count data is exposed; notes and reporter identities stay private.
create or replace view public.hotspots as
select location, count(*)::integer as report_count
from public.reports
where created_at >= now() - interval '30 days'
group by location
having count(*) >= 2;
revoke all on public.hotspots from anon;
grant select on public.hotspots to authenticated;
