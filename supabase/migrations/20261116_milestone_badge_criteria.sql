-- ============================================================================
-- Captain LMS — Milestone & Badge Criteria Configuration
-- Migration: 20261116_milestone_badge_criteria.sql
-- Establishes configurable badge eligibility rules based on:
--   1. Course completion duration (minutes of completed course curriculum)
--   2. Number of courses completed
--   3. Certificates earned (course completion + milestone quiz certificates)
-- Safe to re-run (idempotent).
-- ============================================================================

create table if not exists public.badge_criteria (
  id bigint generated always as identity primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  icon text not null default '🏅',
  tier_order int not null default 1,
  match_mode text not null default 'all' check (match_mode in ('all', 'any')),
  min_course_duration_minutes int not null default 0 check (min_course_duration_minutes >= 0),
  min_courses_completed int not null default 0 check (min_courses_completed >= 0),
  min_certificates_earned int not null default 0 check (min_certificates_earned >= 0),
  is_active boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_badge_criteria_order
  on public.badge_criteria (is_active, tier_order, id);

alter table public.badge_criteria enable row level security;

drop policy if exists "authenticated users read badge_criteria" on public.badge_criteria;
create policy "authenticated users read badge_criteria" on public.badge_criteria
  for select using (auth.role() = 'authenticated');

drop policy if exists "admins manage badge_criteria" on public.badge_criteria;
create policy "admins manage badge_criteria" on public.badge_criteria
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Seed starter progressive milestone badge rules
insert into public.badge_criteria (
  slug,
  name,
  description,
  icon,
  tier_order,
  match_mode,
  min_course_duration_minutes,
  min_courses_completed,
  min_certificates_earned,
  is_active
)
values
  (
    'first-milestone',
    'Pathfinder',
    'Complete your first full course and earn your inaugural completion certificate.',
    '🌱',
    1,
    'all',
    15,
    1,
    1,
    true
  ),
  (
    'bronze-scholar',
    'Bronze Scholar',
    'Finish at least 2 courses totaling 1 hour of curriculum with 2 earned certificates.',
    '🥉',
    2,
    'all',
    60,
    2,
    2,
    true
  ),
  (
    'silver-achiever',
    'Silver Achiever',
    'Accumulate 3 hours of completed coursework across 3 courses and 4 earned certificates.',
    '🥈',
    3,
    'all',
    180,
    3,
    4,
    true
  ),
  (
    'gold-specialist',
    'Gold Specialist',
    'Demonstrate sustained mastery with 5 completed courses, 5 hours of learning, and 6 certificates.',
    '🥇',
    4,
    'all',
    300,
    5,
    6,
    true
  ),
  (
    'captain-distinction',
    'Captain Distinction',
    'Highest recognition for completing 8+ courses, 10+ curriculum hours, and 10+ total certificates.',
    '🏆',
    5,
    'all',
    600,
    8,
    10,
    true
  )
on conflict (slug) do nothing;
