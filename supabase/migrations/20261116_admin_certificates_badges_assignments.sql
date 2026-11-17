-- ============================================================================
-- Captain LMS — Admin-Created Certificates, Custom Badges & Direct Awards
-- Migration: 20261116_admin_certificates_badges_assignments.sql
-- Safe to re-run (idempotent). Run in Supabase SQL Editor or via Supabase CLI.
-- ============================================================================

-- 1. issued_certificates — custom/manual certificates created and issued by admins
create table if not exists public.issued_certificates (
  id bigint generated always as identity primary key,
  certificate_code text not null unique,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  category text not null default 'Special Recognition',
  description text not null default '',
  issued_date date not null default current_date,
  total_hours numeric(6, 1) not null default 0 check (total_hours >= 0),
  total_lessons int not null default 0 check (total_lessons >= 0),
  course_id bigint references public.courses(id) on delete set null,
  issued_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_issued_certificates_user on public.issued_certificates (user_id, issued_date desc);
create index if not exists idx_issued_certificates_created on public.issued_certificates (created_at desc);

alter table public.issued_certificates enable row level security;

drop policy if exists "users read own issued certificates" on public.issued_certificates;
create policy "users read own issued certificates" on public.issued_certificates
  for select using (auth.uid() = user_id);

drop policy if exists "staff read all issued certificates" on public.issued_certificates;
create policy "staff read all issued certificates" on public.issued_certificates
  for select using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('admin', 'hr', 'manager')
    )
  );

drop policy if exists "admins manage issued certificates" on public.issued_certificates;
create policy "admins manage issued certificates" on public.issued_certificates
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- 2. custom_badges — admin-defined recognition & achievement badges
create table if not exists public.custom_badges (
  id bigint generated always as identity primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  icon text not null default '🏅',
  category text not null default 'Recognition',
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_custom_badges_active on public.custom_badges (is_active, id);

alter table public.custom_badges enable row level security;

drop policy if exists "authenticated users read custom badges" on public.custom_badges;
create policy "authenticated users read custom badges" on public.custom_badges
  for select using (auth.role() = 'authenticated');

drop policy if exists "admins manage custom badges" on public.custom_badges;
create policy "admins manage custom badges" on public.custom_badges
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- 3. employee_badge_awards — direct awards of custom badges to employees
create table if not exists public.employee_badge_awards (
  id bigint generated always as identity primary key,
  badge_id bigint not null references public.custom_badges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null default '',
  awarded_by uuid references public.profiles(id) on delete set null,
  awarded_at timestamptz not null default now(),
  unique (badge_id, user_id)
);

create index if not exists idx_employee_badge_awards_user on public.employee_badge_awards (user_id, awarded_at desc);
create index if not exists idx_employee_badge_awards_badge on public.employee_badge_awards (badge_id);

alter table public.employee_badge_awards enable row level security;

drop policy if exists "users read own badge awards" on public.employee_badge_awards;
create policy "users read own badge awards" on public.employee_badge_awards
  for select using (auth.uid() = user_id);

drop policy if exists "staff read all badge awards" on public.employee_badge_awards;
create policy "staff read all badge awards" on public.employee_badge_awards
  for select using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('admin', 'hr', 'manager')
    )
  );

drop policy if exists "admins manage employee badge awards" on public.employee_badge_awards;
create policy "admins manage employee badge awards" on public.employee_badge_awards
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );
