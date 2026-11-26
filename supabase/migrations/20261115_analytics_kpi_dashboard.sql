-- ============================================================================
-- Captain LMS — Comprehensive Analytics & KPI Dashboard Schema
-- Migration: 20261115_analytics_kpi_dashboard.sql
-- Safe to re-run (idempotent). Inspects existing schema and adds:
--   1. 'hr' role support + RLS policies (HR read-only company analytics; Manager dept/team scoped; Employee self scoped)
--   2. Performance indexes for real-time KPI aggregation
--   3. training_kpi_targets & kpi_report_exports tables with RLS
--   4. Optimized SQL views (v_kpi_employee_metrics, v_kpi_department_metrics,
--      v_kpi_course_metrics, v_kpi_monthly_trends, v_kpi_company_summary)
-- ============================================================================

-- 1. Ensure role helpers exist (safe if monitoring migration was not run yet)
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

create or replace function public.is_hr_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'hr')
  );
$$;

-- 2. Safely allow 'hr' role on profiles without disturbing existing accounts
do $$
declare
  c_name text;
begin
  for c_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'profiles'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint if exists %I', c_name);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('employee', 'hr', 'manager', 'admin'));

-- 3. Optional columns guard (if previous migrations weren't applied yet)
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists manager_id uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists is_active boolean not null default true;
alter table public.profiles add column if not exists last_activity_at timestamptz;
alter table public.video_completions add column if not exists last_watched_at timestamptz;

-- 4. Performance indexes for KPI aggregation queries
create index if not exists idx_profiles_role_active_dept
  on public.profiles (role, is_active, department);

create index if not exists idx_video_completions_user_completed
  on public.video_completions (user_id, completed, completed_at, last_watched_at);

create index if not exists idx_quiz_attempts_user_created
  on public.quiz_attempts (user_id, passed, created_at desc);

create index if not exists idx_study_log_day_user
  on public.study_log (day, user_id);

-- 5. HR read-only RLS policies across analytics source tables
drop policy if exists "hr reads video completions" on public.video_completions;
create policy "hr reads video completions" on public.video_completions
  for select using (public.current_user_role() = 'hr');

drop policy if exists "hr reads quiz attempts" on public.quiz_attempts;
create policy "hr reads quiz attempts" on public.quiz_attempts
  for select using (public.current_user_role() = 'hr');

drop policy if exists "hr reads study log" on public.study_log;
create policy "hr reads study log" on public.study_log
  for select using (public.current_user_role() = 'hr');

drop policy if exists "hr reads activity log" on public.activity_log;
create policy "hr reads activity log" on public.activity_log
  for select using (public.current_user_role() = 'hr');

do $$
begin
  if to_regclass('public.course_enrolments') is not null then
    execute 'drop policy if exists "hr reads all enrolments" on public.course_enrolments';
    execute 'create policy "hr reads all enrolments" on public.course_enrolments for select using (public.current_user_role() = ''hr'')';
  end if;
  if to_regclass('public.learning_activity_logs') is not null then
    execute 'drop policy if exists "hr reads all learning activity logs" on public.learning_activity_logs';
    execute 'create policy "hr reads all learning activity logs" on public.learning_activity_logs for select using (public.current_user_role() = ''hr'')';
  end if;
  if to_regclass('public.email_notification_logs') is not null then
    execute 'drop policy if exists "hr reads email notification logs" on public.email_notification_logs';
    execute 'create policy "hr reads email notification logs" on public.email_notification_logs for select using (public.current_user_role() = ''hr'')';
  end if;
end $$;

-- 6. KPI Benchmark Targets table (company & department benchmarks)
create table if not exists public.training_kpi_targets (
  id bigint generated always as identity primary key,
  scope text not null unique, -- 'company' or 'dept:<DepartmentName>'
  target_completion_pct numeric(5,2) not null default 85 check (target_completion_pct between 0 and 100),
  target_pass_rate_pct numeric(5,2) not null default 80 check (target_pass_rate_pct between 0 and 100),
  target_compliance_pct numeric(5,2) not null default 95 check (target_compliance_pct between 0 and 100),
  target_learning_hours_monthly numeric(6,2) not null default 4.0 check (target_learning_hours_monthly >= 0),
  pass_threshold_pct numeric(5,2) not null default 70 check (pass_threshold_pct between 0 and 100),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.training_kpi_targets (scope)
values ('company')
on conflict (scope) do nothing;

alter table public.training_kpi_targets enable row level security;

drop policy if exists "authenticated users read kpi targets" on public.training_kpi_targets;
create policy "authenticated users read kpi targets" on public.training_kpi_targets
  for select using (auth.role() = 'authenticated');

drop policy if exists "admins and hr manage kpi targets" on public.training_kpi_targets;
create policy "admins and hr manage kpi targets" on public.training_kpi_targets
  for all using (public.is_hr_or_admin())
  with check (public.is_hr_or_admin());

-- 7. KPI Report Export Audit Log table
create table if not exists public.kpi_report_exports (
  id bigint generated always as identity primary key,
  exported_by uuid not null references public.profiles(id) on delete cascade,
  exporter_role text not null,
  report_scope text not null check (report_scope in ('company', 'department', 'course', 'employee')),
  format text not null check (format in ('csv', 'pdf')),
  filters jsonb not null default '{}'::jsonb,
  row_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_kpi_report_exports_user_created
  on public.kpi_report_exports (exported_by, created_at desc);

alter table public.kpi_report_exports enable row level security;

drop policy if exists "users insert own kpi report exports" on public.kpi_report_exports;
create policy "users insert own kpi report exports" on public.kpi_report_exports
  for insert with check (auth.uid() = exported_by);

drop policy if exists "users read own kpi report exports" on public.kpi_report_exports;
create policy "users read own kpi report exports" on public.kpi_report_exports
  for select using (auth.uid() = exported_by);

drop policy if exists "admins and hr read all kpi report exports" on public.kpi_report_exports;
create policy "admins and hr read all kpi report exports" on public.kpi_report_exports
  for select using (public.is_hr_or_admin());

drop policy if exists "managers read team kpi report exports" on public.kpi_report_exports;
create policy "managers read team kpi report exports" on public.kpi_report_exports
  for select using (
    public.current_user_role() = 'manager'
    and exists (
      select 1 from public.profiles p
      where p.id = kpi_report_exports.exported_by
        and (p.department = public.current_user_department() or p.manager_id = auth.uid())
    )
  );

-- 8. Optimized SQL Views (security_invoker = true so RLS applies cleanly per caller role)

-- 8a. Employee-wise KPI view (visible employees scoped by Admin/HR vs Manager vs Employee)
create or replace view public.v_kpi_employee_metrics
with (security_invoker = true) as
with visible_employees as (
  select p.*
  from public.profiles p
  where p.role = 'employee'
    and coalesce(p.is_active, true) = true
    and (
      public.current_user_role() in ('admin', 'hr')
      or p.id = auth.uid()
      or (
        public.current_user_role() = 'manager'
        and (p.department = public.current_user_department() or p.manager_id = auth.uid())
      )
    )
),
published_modules as (
  select m.id, m.department, m.duration_seconds
  from public.modules m
  where m.is_draft = false
    and m.is_archived = false
    and (m.scheduled_date is null or m.scheduled_date <= current_date)
),
emp_lessons as (
  select
    e.id as user_id,
    count(pm.id)::int as assigned_lessons
  from visible_employees e
  left join published_modules pm
    on pm.department = 'General' or pm.department = e.department
  group by e.id
),
emp_completions as (
  select
    e.id as user_id,
    count(vc.id) filter (where vc.completed = true and pm.id is not null)::int as completed_lessons,
    count(vc.id) filter (where vc.completed = false and vc.watched_seconds > 0 and pm.id is not null)::int as in_progress_lessons,
    coalesce(sum(vc.watched_seconds) filter (where pm.id is not null), 0)::bigint as watched_seconds,
    max(greatest(coalesce(vc.completed_at, '-infinity'::timestamptz), coalesce(vc.last_watched_at, '-infinity'::timestamptz))) as last_video_at
  from visible_employees e
  left join public.video_completions vc on vc.user_id = e.id
  left join published_modules pm
    on pm.id = vc.module_id
   and (pm.department = 'General' or pm.department = e.department)
  group by e.id
),
emp_study as (
  select
    s.user_id,
    coalesce(sum(s.seconds), 0)::bigint as study_seconds,
    count(distinct s.day) filter (where s.seconds > 0)::int as active_study_days,
    max(s.day) filter (where s.seconds > 0) as last_study_day
  from public.study_log s
  join visible_employees e on e.id = s.user_id
  group by s.user_id
),
emp_quizzes as (
  select
    qa.user_id,
    count(*)::int as quiz_attempts_count,
    count(*) filter (where qa.passed = true)::int as quiz_passes_count,
    round(avg(case when qa.total > 0 then (qa.score::numeric / qa.total::numeric) * 100 else 0 end), 1) as avg_quiz_score_pct,
    round((count(*) filter (where qa.passed = true)::numeric / nullif(count(*), 0)::numeric) * 100, 1) as quiz_pass_rate_pct,
    round((count(*) filter (where qa.attempt_number = 1 and qa.passed = true)::numeric / nullif(count(*) filter (where qa.attempt_number = 1), 0)::numeric) * 100, 1) as first_attempt_pass_rate_pct,
    max(qa.created_at) as last_quiz_at
  from public.quiz_attempts qa
  join visible_employees e on e.id = qa.user_id
  group by qa.user_id
),
base as (
  select
    e.id as user_id,
    e.full_name,
    e.email,
    e.department,
    e.due_date,
    el.assigned_lessons,
    coalesce(ec.completed_lessons, 0) as completed_lessons,
    coalesce(ec.in_progress_lessons, 0) as in_progress_lessons,
    greatest(el.assigned_lessons - coalesce(ec.completed_lessons, 0), 0)::int as pending_lessons,
    case
      when e.due_date is not null and e.due_date < current_date
      then greatest(el.assigned_lessons - coalesce(ec.completed_lessons, 0), 0)::int
      else 0
    end as overdue_lessons,
    case
      when el.assigned_lessons > 0
      then least(100.0, round((coalesce(ec.completed_lessons, 0)::numeric / el.assigned_lessons::numeric) * 100, 1))
      else 0.0
    end as completion_rate_pct,
    greatest(coalesce(es.study_seconds, 0), coalesce(ec.watched_seconds, 0))::bigint as learning_seconds,
    round(greatest(coalesce(es.study_seconds, 0), coalesce(ec.watched_seconds, 0))::numeric / 3600.0, 2) as learning_hours,
    coalesce(es.active_study_days, 0) as active_study_days,
    coalesce(eq.quiz_attempts_count, 0) as quiz_attempts_count,
    coalesce(eq.quiz_passes_count, 0) as quiz_passes_count,
    eq.avg_quiz_score_pct,
    eq.quiz_pass_rate_pct,
    eq.first_attempt_pass_rate_pct,
    nullif(
      greatest(
        coalesce(ec.last_video_at, '-infinity'::timestamptz),
        coalesce(eq.last_quiz_at, '-infinity'::timestamptz),
        coalesce(e.last_activity_at, '-infinity'::timestamptz),
        coalesce(es.last_study_day::timestamptz, '-infinity'::timestamptz)
      ),
      '-infinity'::timestamptz
    ) as last_active_at
  from visible_employees e
  join emp_lessons el on el.user_id = e.id
  left join emp_completions ec on ec.user_id = e.id
  left join emp_study es on es.user_id = e.id
  left join emp_quizzes eq on eq.user_id = e.id
),
scored as (
  select
    b.*,
    case
      when b.assigned_lessons > 0 and b.completed_lessons >= b.assigned_lessons then 'Compliant'
      when b.due_date is not null and b.due_date < current_date then 'Overdue'
      when b.completion_rate_pct < 60
        and (
          (b.due_date is not null and b.due_date <= (current_date + interval '14 days'))
          or b.last_active_at is null
          or b.last_active_at < (now() - interval '7 days')
        )
      then 'At Risk'
      else 'In Progress'
    end as compliance_status,
    (b.assigned_lessons > 0 and b.completed_lessons >= b.assigned_lessons)
      or (b.due_date is null or b.due_date >= current_date) and b.completion_rate_pct >= 100 as is_compliant,
    round(
      (b.completion_rate_pct * 0.45)
      + (coalesce(b.avg_quiz_score_pct, b.completion_rate_pct) * 0.35)
      + (coalesce(b.quiz_pass_rate_pct, b.completion_rate_pct) * 0.20),
      1
    ) as effectiveness_index
  from base b
)
select
  s.*,
  dense_rank() over (order by s.effectiveness_index desc, s.completion_rate_pct desc, coalesce(s.avg_quiz_score_pct, 0) desc, s.learning_hours desc)::int as rank_overall,
  dense_rank() over (partition by s.department order by s.effectiveness_index desc, s.completion_rate_pct desc, coalesce(s.avg_quiz_score_pct, 0) desc)::int as rank_in_department
from scored s;

-- 8b. Department-wise KPI view
create or replace view public.v_kpi_department_metrics
with (security_invoker = true) as
select
  m.department,
  count(*)::int as employee_count,
  count(*) filter (where m.last_active_at is not null)::int as participating_employees,
  count(*) filter (where m.last_active_at >= (now() - interval '30 days'))::int as active_learners_30d,
  round((count(*) filter (where m.last_active_at is not null)::numeric / nullif(count(*), 0)::numeric) * 100, 1) as participation_rate_pct,
  round(avg(m.completion_rate_pct), 1) as avg_completion_rate_pct,
  round(sum(m.learning_hours), 2) as total_learning_hours,
  round(avg(m.learning_hours), 2) as avg_learning_hours,
  sum(m.quiz_attempts_count)::int as quiz_attempts_count,
  round(avg(m.avg_quiz_score_pct) filter (where m.avg_quiz_score_pct is not null), 1) as avg_quiz_score_pct,
  round(
    (sum(m.quiz_passes_count)::numeric / nullif(sum(m.quiz_attempts_count), 0)::numeric) * 100,
    1
  ) as quiz_pass_rate_pct,
  count(*) filter (where m.compliance_status = 'Compliant')::int as compliant_count,
  count(*) filter (where m.compliance_status in ('In Progress', 'At Risk'))::int as pending_count,
  count(*) filter (where m.compliance_status = 'Overdue')::int as overdue_count,
  round((count(*) filter (where m.compliance_status = 'Compliant')::numeric / nullif(count(*), 0)::numeric) * 100, 1) as compliance_rate_pct,
  round(avg(m.effectiveness_index), 1) as training_effectiveness_score
from public.v_kpi_employee_metrics m
group by m.department
order by avg_completion_rate_pct desc nulls last, m.department asc;

-- 8c. Course-wise KPI view
create or replace view public.v_kpi_course_metrics
with (security_invoker = true) as
with visible_employees as (
  select p.*
  from public.profiles p
  where p.role = 'employee'
    and coalesce(p.is_active, true) = true
    and (
      public.current_user_role() in ('admin', 'hr')
      or p.id = auth.uid()
      or (
        public.current_user_role() = 'manager'
        and (p.department = public.current_user_department() or p.manager_id = auth.uid())
      )
    )
),
course_lessons as (
  select
    c.id as course_id,
    c.title as course_title,
    c.category,
    c.color,
    count(m.id)::int as lesson_count
  from public.courses c
  join public.modules m
    on m.course_id = c.id
   and m.is_draft = false
   and m.is_archived = false
   and (m.scheduled_date is null or m.scheduled_date <= current_date)
  where c.is_published = true
  group by c.id, c.title, c.category, c.color
),
course_employee_progress as (
  select
    cl.course_id,
    e.id as user_id,
    e.due_date,
    count(m.id)::int as total_lessons,
    count(vc.id) filter (where vc.completed = true)::int as done_lessons,
    bool_or(vc.watched_seconds > 0 or vc.completed = true) as has_started,
    coalesce(sum(vc.watched_seconds), 0)::bigint as watched_seconds
  from course_lessons cl
  join visible_employees e
    on cl.category = 'General' or cl.category = e.department
  join public.modules m
    on m.course_id = cl.course_id
   and m.is_draft = false
   and m.is_archived = false
   and (m.scheduled_date is null or m.scheduled_date <= current_date)
   and (m.department = 'General' or m.department = e.department)
  left join public.video_completions vc
    on vc.user_id = e.id and vc.module_id = m.id
  group by cl.course_id, e.id, e.due_date
),
course_quizzes as (
  select
    c.id as course_id,
    count(qa.id)::int as quiz_attempts_count,
    round(avg(case when qa.total > 0 then (qa.score::numeric / qa.total::numeric) * 100 else 0 end), 1) as avg_quiz_score_pct,
    round((count(*) filter (where qa.passed = true)::numeric / nullif(count(qa.id), 0)::numeric) * 100, 1) as quiz_pass_rate_pct
  from course_lessons c
  left join public.quiz_attempts qa
    on qa.user_id in (select id from visible_employees)
   and (
     qa.milestone = c.course_id::text
     or exists (
       select 1 from visible_employees ve
       where ve.id = qa.user_id and (c.category = 'General' or c.category = ve.department)
     )
   )
  group by c.id
)
select
  cl.course_id,
  cl.course_title,
  cl.category,
  cl.color,
  cl.lesson_count,
  count(cep.user_id)::int as target_learners,
  count(cep.user_id) filter (where cep.has_started = true)::int as started_learners,
  count(cep.user_id) filter (where cep.total_lessons > 0 and cep.done_lessons >= cep.total_lessons)::int as completed_learners,
  coalesce(round((count(cep.user_id) filter (where cep.has_started = true)::numeric / nullif(count(cep.user_id), 0)::numeric) * 100, 1), 0.0) as participation_rate_pct,
  coalesce(round((count(cep.user_id) filter (where cep.total_lessons > 0 and cep.done_lessons >= cep.total_lessons)::numeric / nullif(count(cep.user_id), 0)::numeric) * 100, 1), 0.0) as completion_rate_pct,
  coalesce(round(sum(cep.watched_seconds)::numeric / 3600.0, 2), 0.0) as learning_hours,
  cq.avg_quiz_score_pct,
  cq.quiz_pass_rate_pct,
  count(cep.user_id) filter (
    where cep.due_date is not null
      and cep.due_date < current_date
      and not (cep.total_lessons > 0 and cep.done_lessons >= cep.total_lessons)
  )::int as overdue_learners,
  coalesce(round(
    ((count(cep.user_id) filter (where cep.has_started = true and not (cep.total_lessons > 0 and cep.done_lessons >= cep.total_lessons)))::numeric
    / nullif(count(cep.user_id) filter (where cep.has_started = true), 0)::numeric) * 100,
    1
  ), 0.0) as drop_off_rate_pct,
  round(
    (coalesce(round((count(cep.user_id) filter (where cep.total_lessons > 0 and cep.done_lessons >= cep.total_lessons)::numeric / nullif(count(cep.user_id), 0)::numeric) * 100, 1), 0.0) * 0.45)
    + (coalesce(cq.avg_quiz_score_pct, 0.0) * 0.35)
    + (coalesce(cq.quiz_pass_rate_pct, 0.0) * 0.20),
    1
  ) as training_effectiveness_score
from course_lessons cl
left join course_employee_progress cep on cep.course_id = cl.course_id
left join course_quizzes cq on cq.course_id = cl.course_id
group by cl.course_id, cl.course_title, cl.category, cl.color, cl.lesson_count, cq.avg_quiz_score_pct, cq.quiz_pass_rate_pct
order by completion_rate_pct desc, cl.course_title asc;

-- 8d. Monthly trends view (rolling 12 months scoped by caller role)
create or replace view public.v_kpi_monthly_trends
with (security_invoker = true) as
with visible_employees as (
  select p.id
  from public.profiles p
  where p.role = 'employee'
    and coalesce(p.is_active, true) = true
    and (
      public.current_user_role() in ('admin', 'hr')
      or p.id = auth.uid()
      or (
        public.current_user_role() = 'manager'
        and (p.department = public.current_user_department() or p.manager_id = auth.uid())
      )
    )
),
months as (
  select
    date_trunc('month', gs)::date as month_start,
    to_char(gs, 'YYYY-MM') as month_key,
    to_char(gs, 'Mon YYYY') as month_label
  from generate_series(
    date_trunc('month', current_date) - interval '11 months',
    date_trunc('month', current_date),
    interval '1 month'
  ) gs
),
monthly_completions as (
  select
    to_char(coalesce(vc.completed_at, vc.last_watched_at), 'YYYY-MM') as month_key,
    vc.user_id,
    vc.completed,
    vc.watched_seconds
  from public.video_completions vc
  join visible_employees ve on ve.id = vc.user_id
  where coalesce(vc.completed_at, vc.last_watched_at) >= (date_trunc('month', current_date) - interval '11 months')
),
monthly_study as (
  select
    to_char(s.day, 'YYYY-MM') as month_key,
    s.user_id,
    s.seconds
  from public.study_log s
  join visible_employees ve on ve.id = s.user_id
  where s.day >= (date_trunc('month', current_date) - interval '11 months')::date
),
monthly_quizzes as (
  select
    to_char(qa.created_at, 'YYYY-MM') as month_key,
    qa.user_id,
    qa.score,
    qa.total,
    qa.passed
  from public.quiz_attempts qa
  join visible_employees ve on ve.id = qa.user_id
  where qa.created_at >= (date_trunc('month', current_date) - interval '11 months')
)
select
  m.month_key,
  m.month_label,
  (
    select count(distinct u.user_id)::int
    from (
      select user_id from monthly_completions mc where mc.month_key = m.month_key
      union all
      select user_id from monthly_study ms where ms.month_key = m.month_key and ms.seconds > 0
      union all
      select user_id from monthly_quizzes mq where mq.month_key = m.month_key
    ) u
  ) as active_users,
  coalesce((select count(*) filter (where mc.completed = true)::int from monthly_completions mc where mc.month_key = m.month_key), 0) as lesson_completions,
  round(
    greatest(
      coalesce((select sum(ms.seconds) from monthly_study ms where ms.month_key = m.month_key), 0),
      coalesce((select sum(mc.watched_seconds) from monthly_completions mc where mc.month_key = m.month_key), 0)
    )::numeric / 3600.0,
    2
  ) as learning_hours,
  coalesce((select count(*)::int from monthly_quizzes mq where mq.month_key = m.month_key), 0) as quiz_attempts,
  (select round(avg(case when mq.total > 0 then (mq.score::numeric / mq.total::numeric) * 100 else 0 end), 1) from monthly_quizzes mq where mq.month_key = m.month_key) as avg_quiz_score_pct,
  (select round((count(*) filter (where mq.passed = true)::numeric / nullif(count(*), 0)::numeric) * 100, 1) from monthly_quizzes mq where mq.month_key = m.month_key) as quiz_pass_rate_pct
from months m
order by m.month_key asc;

-- 8e. Company / Scope Executive Summary view
create or replace view public.v_kpi_company_summary
with (security_invoker = true) as
select
  count(*)::int as total_employees,
  count(*) filter (where m.last_active_at is not null)::int as participating_employees,
  coalesce(round((count(*) filter (where m.last_active_at is not null)::numeric / nullif(count(*), 0)::numeric) * 100, 1), 0.0) as participation_rate_pct,
  coalesce(round(avg(m.completion_rate_pct), 1), 0.0) as avg_completion_rate_pct,
  coalesce(round(sum(m.learning_hours), 2), 0.0) as total_learning_hours,
  round(avg(m.avg_quiz_score_pct) filter (where m.avg_quiz_score_pct is not null), 1) as avg_quiz_score_pct,
  round((sum(m.quiz_passes_count)::numeric / nullif(sum(m.quiz_attempts_count), 0)::numeric) * 100, 1) as quiz_pass_rate_pct,
  count(*) filter (where m.compliance_status = 'Compliant')::int as compliant_employees,
  count(*) filter (where m.compliance_status in ('In Progress', 'At Risk'))::int as pending_employees,
  count(*) filter (where m.compliance_status = 'Overdue')::int as overdue_employees,
  coalesce(round((count(*) filter (where m.compliance_status = 'Compliant')::numeric / nullif(count(*), 0)::numeric) * 100, 1), 0.0) as compliance_rate_pct,
  coalesce(round(avg(m.effectiveness_index), 1), 0.0) as training_effectiveness_score
from public.v_kpi_employee_metrics m;

-- 9. Grants for authenticated clients
grant select on public.v_kpi_employee_metrics to authenticated;
grant select on public.v_kpi_department_metrics to authenticated;
grant select on public.v_kpi_course_metrics to authenticated;
grant select on public.v_kpi_monthly_trends to authenticated;
grant select on public.v_kpi_company_summary to authenticated;
grant select on public.training_kpi_targets to authenticated;
grant insert, update, delete on public.training_kpi_targets to authenticated;
grant select, insert on public.kpi_report_exports to authenticated;
