-- ============================================================================
-- Captain LMS — Automated Course Monitoring & Email Notification System
-- Migration: 20261112_course_monitoring_notifications.sql
-- Safe to re-run (idempotent). Run in Supabase SQL Editor or via Supabase CLI.
-- ============================================================================

-- 1. Helper functions for safe RLS checks (avoids recursion and keeps policies concise)
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_user_department()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select department from public.profiles where id = auth.uid();
$$;

-- 2. Extend profiles with email, reporting manager, HR representative, and activity timestamp
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists manager_id uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists manager_email text;
alter table public.profiles add column if not exists hr_email text;
alter table public.profiles add column if not exists last_activity_at timestamptz;

-- Backfill profile emails from auth.users where missing
update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id
  and (p.email is null or p.email = '');

-- Keep handle_new_user in sync so new signups/invites populate profiles.email
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role, department)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.email,
    'employee',
    coalesce(new.raw_user_meta_data->>'department', 'General')
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name);
  return new;
end;
$$;

-- 3. course_enrolments — tracks assigned courses, deadlines, HR/manager CC overrides,
--    progress, inactivity anchor, and reminder lifecycle control
create table if not exists public.course_enrolments (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id bigint not null references public.courses(id) on delete cascade,
  assigned_by uuid references public.profiles(id) on delete set null,
  hr_email text,
  manager_email text,
  deadline_date date,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'completed', 'overdue')),
  progress_pct int not null default 0 check (progress_pct between 0 and 100),
  enrolled_at timestamptz not null default now(),
  started_at timestamptz,
  last_activity_at timestamptz,
  completed_at timestamptz,
  course_start_notified_at timestamptz,
  last_inactivity_notified_at timestamptz,
  reminders_stopped boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, course_id)
);

create index if not exists idx_course_enrolments_user on public.course_enrolments (user_id);
create index if not exists idx_course_enrolments_course on public.course_enrolments (course_id);
create index if not exists idx_course_enrolments_active_monitor
  on public.course_enrolments (status, reminders_stopped, deadline_date, last_activity_at)
  where reminders_stopped = false and completed_at is null;

-- 4. learning_activity_logs — granular telemetry for lesson views, progress updates, quiz attempts, completions
create table if not exists public.learning_activity_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id bigint references public.courses(id) on delete cascade,
  module_id bigint references public.modules(id) on delete cascade,
  event_type text not null
    check (event_type in ('lesson_view', 'progress_update', 'quiz_attempt', 'lesson_completed', 'course_completed')),
  progress_pct int check (progress_pct between 0 and 100),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_learning_activity_user_created
  on public.learning_activity_logs (user_id, created_at desc);
create index if not exists idx_learning_activity_course_created
  on public.learning_activity_logs (course_id, created_at desc);

-- 5. notification_settings — singleton admin configuration (NO secrets stored here)
create table if not exists public.notification_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  inactivity_days int not null default 7 check (inactivity_days between 1 and 90),
  reminder_days int[] not null default '{7,3,1}',
  send_course_start boolean not null default true,
  send_inactivity boolean not null default true,
  send_deadline_reminders boolean not null default true,
  send_overdue boolean not null default true,
  sender_name text not null default 'Captain LMS Notifications',
  sender_email text not null default 'lms@captainandcompany.com',
  default_hr_email text,
  email_provider text not null default 'resend'
    check (email_provider in ('resend', 'smtp', 'm365', 'google_workspace')),
  lms_base_url text not null default '',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.notification_settings (id)
values (1)
on conflict (id) do nothing;

-- 6. email_notification_logs — delivery history, CC recipients, status & idempotency enforcement
create table if not exists public.email_notification_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id bigint references public.courses(id) on delete set null,
  enrolment_id bigint references public.course_enrolments(id) on delete set null,
  notification_type text not null
    check (notification_type in ('course_start', 'inactivity_7d', 'deadline_reminder', 'course_overdue', 'manual_test')),
  idempotency_key text not null unique,
  to_email text not null,
  cc_emails text[] not null default '{}',
  subject text not null,
  html_body text,
  provider text,
  provider_message_id text,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_logs_user_created
  on public.email_notification_logs (user_id, created_at desc);
create index if not exists idx_email_logs_status_type
  on public.email_notification_logs (status, notification_type, created_at desc);

-- ============================================================================
-- Row Level Security (RLS)
-- ============================================================================
alter table public.course_enrolments enable row level security;
alter table public.learning_activity_logs enable row level security;
alter table public.notification_settings enable row level security;
alter table public.email_notification_logs enable row level security;

-- course_enrolments policies
drop policy if exists "employees read own enrolments" on public.course_enrolments;
create policy "employees read own enrolments" on public.course_enrolments
  for select using (auth.uid() = user_id);

drop policy if exists "managers read department enrolments" on public.course_enrolments;
create policy "managers read department enrolments" on public.course_enrolments
  for select using (
    public.current_user_role() = 'manager'
    and exists (
      select 1 from public.profiles p
      where p.id = course_enrolments.user_id
        and (p.department = public.current_user_department() or p.manager_id = auth.uid())
    )
  );

drop policy if exists "admins manage all enrolments" on public.course_enrolments;
create policy "admins manage all enrolments" on public.course_enrolments
  for all using (public.current_user_role() = 'admin');

-- learning_activity_logs policies
drop policy if exists "users read own activity logs" on public.learning_activity_logs;
create policy "users read own activity logs" on public.learning_activity_logs
  for select using (auth.uid() = user_id);

drop policy if exists "users insert own activity logs" on public.learning_activity_logs;
create policy "users insert own activity logs" on public.learning_activity_logs
  for insert with check (auth.uid() = user_id);

drop policy if exists "managers read team activity logs" on public.learning_activity_logs;
create policy "managers read team activity logs" on public.learning_activity_logs
  for select using (
    public.current_user_role() = 'manager'
    and exists (
      select 1 from public.profiles p
      where p.id = learning_activity_logs.user_id
        and (p.department = public.current_user_department() or p.manager_id = auth.uid())
    )
  );

drop policy if exists "admins read all activity logs" on public.learning_activity_logs;
create policy "admins read all activity logs" on public.learning_activity_logs
  for select using (public.current_user_role() = 'admin');

-- notification_settings policies (no secrets stored; readable by authenticated, editable by admin)
drop policy if exists "authenticated users read notification settings" on public.notification_settings;
create policy "authenticated users read notification settings" on public.notification_settings
  for select using (auth.role() = 'authenticated');

drop policy if exists "admins update notification settings" on public.notification_settings;
create policy "admins update notification settings" on public.notification_settings
  for all using (public.current_user_role() = 'admin');

-- email_notification_logs policies (server service_role writes; admins read all; managers read dept; employees read own)
drop policy if exists "users read own email notification logs" on public.email_notification_logs;
create policy "users read own email notification logs" on public.email_notification_logs
  for select using (auth.uid() = user_id);

drop policy if exists "managers read team email notification logs" on public.email_notification_logs;
create policy "managers read team email notification logs" on public.email_notification_logs
  for select using (
    public.current_user_role() = 'manager'
    and exists (
      select 1 from public.profiles p
      where p.id = email_notification_logs.user_id
        and (p.department = public.current_user_department() or p.manager_id = auth.uid())
    )
  );

drop policy if exists "admins manage email notification logs" on public.email_notification_logs;
create policy "admins manage email notification logs" on public.email_notification_logs
  for all using (public.current_user_role() = 'admin');

-- ============================================================================
-- Secure RPCs & Automatic Activity Sync Triggers
-- ============================================================================

-- Sync department-assigned published courses into course_enrolments for active employees.
-- Safe and idempotent: preserves explicit deadlines/HR/manager overrides if already set.
create or replace function public.sync_course_enrolments(p_user_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_role text;
  v_affected int := 0;
begin
  -- Allow service_role (auth.uid() is null), admin, or the user syncing their own enrolments
  if auth.uid() is not null then
    v_caller_role := public.current_user_role();
    if v_caller_role <> 'admin' and p_user_id is distinct from auth.uid() then
      raise exception 'Not authorized to sync enrolments for other users';
    end if;
  end if;

  with eligible as (
    select distinct
      p.id as user_id,
      c.id as course_id,
      p.due_date as profile_due_date,
      p.hr_email as profile_hr_email,
      coalesce(p.manager_email, mgr.email) as resolved_manager_email,
      count(m.id) as total_lessons,
      count(vc.id) filter (where vc.completed = true) as done_lessons,
      bool_or(vc.watched_seconds > 0 or vc.completed) as has_started,
      min(vc.last_watched_at) filter (where vc.watched_seconds > 0 or vc.completed) as first_watch_at,
      max(greatest(coalesce(vc.last_watched_at, '-infinity'::timestamptz), coalesce(vc.completed_at, '-infinity'::timestamptz))) as last_watch_at,
      max(vc.completed_at) filter (where vc.completed = true) as last_completed_at
    from public.profiles p
    join public.courses c on c.is_published = true
    join public.modules m
      on m.course_id = c.id
     and m.is_draft = false
     and m.is_archived = false
     and (m.department = 'General' or m.department = p.department)
    left join public.profiles mgr on mgr.id = p.manager_id
    left join public.video_completions vc on vc.user_id = p.id and vc.module_id = m.id
    where p.role = 'employee'
      and coalesce(p.is_active, true) = true
      and (p_user_id is null or p.id = p_user_id)
    group by p.id, c.id, p.due_date, p.hr_email, p.manager_email, mgr.email
  ),
  computed as (
    select
      e.*,
      case when e.total_lessons > 0 then round((e.done_lessons::numeric / e.total_lessons::numeric) * 100)::int else 0 end as pct,
      (e.total_lessons > 0 and e.done_lessons >= e.total_lessons) as is_done
    from eligible e
  )
  insert into public.course_enrolments (
    user_id, course_id, hr_email, manager_email, deadline_date,
    status, progress_pct, started_at, last_activity_at, completed_at, reminders_stopped, updated_at
  )
  select
    c.user_id,
    c.course_id,
    c.profile_hr_email,
    c.resolved_manager_email,
    c.profile_due_date,
    case
      when c.is_done then 'completed'
      when c.profile_due_date is not null and c.profile_due_date < current_date then 'overdue'
      when c.has_started then 'in_progress'
      else 'not_started'
    end,
    c.pct,
    case when c.has_started then coalesce(nullif(c.first_watch_at, '-infinity'::timestamptz), now()) else null end,
    nullif(c.last_watch_at, '-infinity'::timestamptz),
    case when c.is_done then coalesce(c.last_completed_at, now()) else null end,
    c.is_done,
    now()
  from computed c
  on conflict (user_id, course_id) do update
  set
    hr_email = coalesce(public.course_enrolments.hr_email, excluded.hr_email),
    manager_email = coalesce(public.course_enrolments.manager_email, excluded.manager_email),
    deadline_date = coalesce(public.course_enrolments.deadline_date, excluded.deadline_date),
    progress_pct = greatest(public.course_enrolments.progress_pct, excluded.progress_pct),
    started_at = coalesce(public.course_enrolments.started_at, excluded.started_at),
    last_activity_at = case
      when excluded.last_activity_at is not null and (public.course_enrolments.last_activity_at is null or excluded.last_activity_at > public.course_enrolments.last_activity_at)
      then excluded.last_activity_at
      else public.course_enrolments.last_activity_at
    end,
    completed_at = coalesce(public.course_enrolments.completed_at, excluded.completed_at),
    reminders_stopped = public.course_enrolments.reminders_stopped or excluded.reminders_stopped,
    status = case
      when public.course_enrolments.completed_at is not null or excluded.completed_at is not null then 'completed'
      when coalesce(public.course_enrolments.deadline_date, excluded.deadline_date) is not null
           and coalesce(public.course_enrolments.deadline_date, excluded.deadline_date) < current_date then 'overdue'
      when public.course_enrolments.started_at is not null or excluded.started_at is not null then 'in_progress'
      else 'not_started'
    end,
    updated_at = now();

  get diagnostics v_affected = row_count;
  return v_affected;
end;
$$;

grant execute on function public.sync_course_enrolments(uuid) to authenticated;

-- Record an authenticated employee's learning activity, detect first course start,
-- reset the inactivity clock, and automatically stop reminders on 100% completion.
create or replace function public.record_learning_activity(
  p_course_id bigint,
  p_module_id bigint default null,
  p_event_type text default 'lesson_view',
  p_progress_pct int default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_enrolment public.course_enrolments%rowtype;
  v_total_lessons int := 0;
  v_done_lessons int := 0;
  v_pct int := 0;
  v_is_first_start boolean := false;
  v_is_completed boolean := false;
  v_now timestamptz := now();
  v_mgr_email text;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    raise exception 'Profile not found';
  end if;

  -- Log granular learning activity
  insert into public.learning_activity_logs (user_id, course_id, module_id, event_type, progress_pct, metadata, created_at)
  values (v_uid, p_course_id, p_module_id, p_event_type, p_progress_pct, coalesce(p_metadata, '{}'::jsonb), v_now);

  -- Update profile-level last activity
  update public.profiles set last_activity_at = v_now where id = v_uid;

  if p_course_id is null then
    return jsonb_build_object('ok', true, 'is_first_start', false, 'is_completed', false);
  end if;

  -- Calculate accurate course progress from published modules & completions
  select
    count(m.id),
    count(vc.id) filter (where vc.completed = true)
  into v_total_lessons, v_done_lessons
  from public.modules m
  left join public.video_completions vc on vc.module_id = m.id and vc.user_id = v_uid
  where m.course_id = p_course_id
    and m.is_draft = false
    and m.is_archived = false
    and (m.department = 'General' or m.department = v_profile.department);

  if v_total_lessons > 0 then
    v_pct := least(100, greatest(coalesce(p_progress_pct, 0), round((v_done_lessons::numeric / v_total_lessons::numeric) * 100)::int));
    v_is_completed := (v_done_lessons >= v_total_lessons);
  else
    v_pct := coalesce(p_progress_pct, 0);
    v_is_completed := (p_event_type = 'course_completed' or v_pct >= 100);
  end if;

  select email into v_mgr_email from public.profiles where id = v_profile.manager_id;

  -- Ensure enrolment exists
  insert into public.course_enrolments (
    user_id, course_id, hr_email, manager_email, deadline_date,
    status, progress_pct, started_at, last_activity_at, completed_at, reminders_stopped, updated_at
  )
  values (
    v_uid,
    p_course_id,
    v_profile.hr_email,
    coalesce(v_profile.manager_email, v_mgr_email),
    v_profile.due_date,
    case when v_is_completed then 'completed' else 'in_progress' end,
    v_pct,
    v_now,
    v_now,
    case when v_is_completed then v_now else null end,
    v_is_completed,
    v_now
  )
  on conflict (user_id, course_id) do nothing;

  select * into v_enrolment from public.course_enrolments
  where user_id = v_uid and course_id = p_course_id
  for update;

  v_is_first_start := (v_enrolment.course_start_notified_at is null);

  update public.course_enrolments
  set
    started_at = coalesce(started_at, v_now),
    last_activity_at = v_now,
    progress_pct = greatest(progress_pct, v_pct),
    completed_at = case when v_is_completed then coalesce(completed_at, v_now) else completed_at end,
    reminders_stopped = case when v_is_completed then true else reminders_stopped end,
    status = case
      when v_is_completed or completed_at is not null then 'completed'
      when deadline_date is not null and deadline_date < current_date then 'overdue'
      else 'in_progress'
    end,
    updated_at = v_now
  where id = v_enrolment.id;

  return jsonb_build_object(
    'ok', true,
    'enrolment_id', v_enrolment.id,
    'progress_pct', greatest(v_enrolment.progress_pct, v_pct),
    'is_first_start', v_is_first_start,
    'is_completed', v_is_completed
  );
end;
$$;

grant execute on function public.record_learning_activity(bigint, bigint, text, int, jsonb) to authenticated;

-- Trigger: keep last_activity_at & quiz activity logs synced automatically when quiz_attempts are inserted
create or replace function public.on_quiz_attempt_logged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set last_activity_at = coalesce(new.created_at, now()) where id = new.user_id;
  update public.course_enrolments
    set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), coalesce(new.created_at, now())),
        updated_at = now()
  where user_id = new.user_id and completed_at is null;

  insert into public.learning_activity_logs (user_id, event_type, metadata, created_at)
  values (
    new.user_id,
    'quiz_attempt',
    jsonb_build_object('milestone', new.milestone, 'score', new.score, 'total', new.total, 'passed', new.passed),
    coalesce(new.created_at, now())
  );
  return new;
end;
$$;

drop trigger if exists trg_quiz_attempt_activity on public.quiz_attempts;
create trigger trg_quiz_attempt_activity
  after insert on public.quiz_attempts
  for each row execute procedure public.on_quiz_attempt_logged();

-- Trigger: whenever any lesson is completed (via video watch or manual document review),
-- immediately stop all pending reminders if the course reaches 100% completion.
create or replace function public.on_video_completion_sync_enrolment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_course_id bigint;
  v_dept text;
  v_total int := 0;
  v_done int := 0;
  v_pct int := 0;
  v_is_done boolean := false;
  v_now timestamptz := now();
begin
  select m.course_id into v_course_id from public.modules m where m.id = new.module_id;
  if v_course_id is null then
    return new;
  end if;

  select p.department into v_dept from public.profiles p where p.id = new.user_id;
  if not found then
    return new;
  end if;

  select
    count(m.id),
    count(vc.id) filter (where vc.completed = true)
  into v_total, v_done
  from public.modules m
  left join public.video_completions vc on vc.module_id = m.id and vc.user_id = new.user_id
  where m.course_id = v_course_id
    and m.is_draft = false
    and m.is_archived = false
    and (m.department = 'General' or m.department = v_dept);

  if v_total > 0 then
    v_pct := least(100, round((v_done::numeric / v_total::numeric) * 100)::int);
    v_is_done := (v_done >= v_total);
  end if;

  if v_is_done then
    update public.course_enrolments
    set
      progress_pct = 100,
      status = 'completed',
      completed_at = coalesce(completed_at, new.completed_at, v_now),
      last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), coalesce(new.completed_at, new.last_watched_at, v_now)),
      reminders_stopped = true,
      updated_at = v_now
    where user_id = new.user_id
      and course_id = v_course_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_video_completion_stop_reminders on public.video_completions;
create trigger trg_video_completion_stop_reminders
  after insert or update of completed on public.video_completions
  for each row
  when (new.completed = true)
  execute procedure public.on_video_completion_sync_enrolment();

-- ============================================================================
-- Supabase Scheduled Cron (pg_cron + pg_net)
-- ============================================================================
-- Prerequisites in Supabase Dashboard → Database → Extensions: enable pg_cron and pg_net.
-- Store your project URL and CRON_SECRET in Supabase Vault or replace placeholders below.
--
-- Example daily run at 08:00 UTC:
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.unschedule('course-notification-monitor-daily')
-- where exists (select 1 from cron.job where jobname = 'course-notification-monitor-daily');
--
-- select cron.schedule(
--   'course-notification-monitor-daily',
--   '0 8 * * *',
--   $$
--   select net.http_post(
--     url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/course-notification-monitor',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-cron-secret', '<YOUR_CRON_SECRET>'
--     ),
--     body := jsonb_build_object('action', 'run_monitor', 'source', 'pg_cron')
--   ) as request_id;
--   $$
-- );
