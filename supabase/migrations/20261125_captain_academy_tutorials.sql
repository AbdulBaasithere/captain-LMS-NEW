-- ============================================================================
-- Captain Academy — Tutorials & Guides
-- Migration: 20261125_captain_academy_tutorials.sql
-- Safe to re-run (idempotent). Run in Supabase SQL Editor or via Supabase CLI.
-- ============================================================================

-- 1. Categories for Captain Academy tutorials
create table if not exists public.tutorial_categories (
  id bigint generated always as identity primary key,
  name text not null unique,
  slug text not null unique,
  description text not null default '',
  color text not null default '#dd3333',
  sort_order int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_tutorial_categories_order
  on public.tutorial_categories (sort_order asc, id asc);

alter table public.tutorial_categories enable row level security;

drop policy if exists "authenticated users read tutorial categories" on public.tutorial_categories;
create policy "authenticated users read tutorial categories" on public.tutorial_categories
  for select using (auth.role() = 'authenticated');

drop policy if exists "admins manage tutorial categories" on public.tutorial_categories;
create policy "admins manage tutorial categories" on public.tutorial_categories
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- 2. Tutorials table (uploaded or external videos + written instructions + department visibility)
create table if not exists public.tutorials (
  id bigint generated always as identity primary key,
  title text not null,
  description text not null default '',
  instructions text not null default '',
  category_id bigint references public.tutorial_categories(id) on delete set null,
  thumbnail_url text,
  video_source text not null check (video_source in ('upload', 'youtube', 'external')) default 'external',
  video_url text,
  youtube_id text,
  duration_seconds int not null default 180 check (duration_seconds >= 0),
  departments text[] not null default array['General']::text[],
  is_published boolean not null default false,
  view_count int not null default 0 check (view_count >= 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tutorials_published_category
  on public.tutorials (is_published, category_id, created_at desc);

create index if not exists idx_tutorials_departments_gin
  on public.tutorials using gin (departments);

alter table public.tutorials enable row level security;

drop policy if exists "admins manage tutorials" on public.tutorials;
create policy "admins manage tutorials" on public.tutorials
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists "employees read published department tutorials" on public.tutorials;
create policy "employees read published department tutorials" on public.tutorials
  for select using (
    is_published = true
    and (
      'General' = any(departments)
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and p.department = any(tutorials.departments)
      )
    )
  );

-- 3. Per-employee tutorial progress & view tracking
create table if not exists public.tutorial_progress (
  id bigint generated always as identity primary key,
  tutorial_id bigint not null references public.tutorials(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('not_started', 'in_progress', 'completed')) default 'not_started',
  watched_seconds int not null default 0 check (watched_seconds >= 0),
  progress_pct int not null default 0 check (progress_pct between 0 and 100),
  view_count int not null default 0 check (view_count >= 0),
  last_viewed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tutorial_id, user_id)
);

create index if not exists idx_tutorial_progress_user
  on public.tutorial_progress (user_id, updated_at desc);

create index if not exists idx_tutorial_progress_tutorial
  on public.tutorial_progress (tutorial_id, status);

alter table public.tutorial_progress enable row level security;

drop policy if exists "employees read own tutorial progress" on public.tutorial_progress;
create policy "employees read own tutorial progress" on public.tutorial_progress
  for select using (auth.uid() = user_id);

drop policy if exists "employees insert own tutorial progress" on public.tutorial_progress;
create policy "employees insert own tutorial progress" on public.tutorial_progress
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.tutorials t
      join public.profiles p on p.id = auth.uid()
      where t.id = tutorial_id
        and (
          p.role = 'admin'
          or (
            t.is_published = true
            and ('General' = any(t.departments) or p.department = any(t.departments))
          )
        )
    )
  );

drop policy if exists "employees update own tutorial progress" on public.tutorial_progress;
create policy "employees update own tutorial progress" on public.tutorial_progress
  for update using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.tutorials t
      join public.profiles p on p.id = auth.uid()
      where t.id = tutorial_id
        and (
          p.role = 'admin'
          or (
            t.is_published = true
            and ('General' = any(t.departments) or p.department = any(t.departments))
          )
        )
    )
  );

drop policy if exists "employees delete own tutorial progress" on public.tutorial_progress;
create policy "employees delete own tutorial progress" on public.tutorial_progress
  for delete using (auth.uid() = user_id);

drop policy if exists "admins read all tutorial progress" on public.tutorial_progress;
create policy "admins read all tutorial progress" on public.tutorial_progress
  for select using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- 4. Narrow RPC for safely recording views without granting employees UPDATE access on tutorials
create or replace function public.record_tutorial_view(p_tutorial_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_dept text;
  v_role text;
  v_allowed boolean := false;
  v_now timestamptz := now();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Not authenticated');
  end if;

  select department, role into v_dept, v_role
  from public.profiles
  where id = v_uid;

  select exists (
    select 1 from public.tutorials t
    where t.id = p_tutorial_id
      and (
        v_role = 'admin'
        or (
          t.is_published = true
          and ('General' = any(t.departments) or coalesce(v_dept, 'General') = any(t.departments))
        )
      )
  ) into v_allowed;

  if not v_allowed then
    return jsonb_build_object('ok', false, 'error', 'Tutorial not accessible');
  end if;

  update public.tutorials
  set view_count = view_count + 1
  where id = p_tutorial_id;

  insert into public.tutorial_progress (
    tutorial_id,
    user_id,
    status,
    view_count,
    last_viewed_at,
    updated_at
  )
  values (
    p_tutorial_id,
    v_uid,
    'in_progress',
    1,
    v_now,
    v_now
  )
  on conflict (tutorial_id, user_id) do update
  set
    view_count = public.tutorial_progress.view_count + 1,
    last_viewed_at = v_now,
    status = case
      when public.tutorial_progress.status = 'not_started' then 'in_progress'
      else public.tutorial_progress.status
    end,
    updated_at = v_now;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.record_tutorial_view(bigint) to authenticated;

-- 5. Dedicated public storage bucket for tutorial videos & thumbnails
insert into storage.buckets (id, name, public)
values ('tutorial-media', 'tutorial-media', true)
on conflict (id) do nothing;

drop policy if exists "tutorial media publicly readable" on storage.objects;
create policy "tutorial media publicly readable" on storage.objects
  for select using (bucket_id = 'tutorial-media');

drop policy if exists "admins upload tutorial media" on storage.objects;
create policy "admins upload tutorial media" on storage.objects
  for insert with check (
    bucket_id = 'tutorial-media'
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists "admins update tutorial media" on storage.objects;
create policy "admins update tutorial media" on storage.objects
  for update using (
    bucket_id = 'tutorial-media'
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists "admins delete tutorial media" on storage.objects;
create policy "admins delete tutorial media" on storage.objects
  for delete using (
    bucket_id = 'tutorial-media'
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- 6. Starter categories (idempotent)
insert into public.tutorial_categories (name, slug, description, color, sort_order) values
  ('Getting Started', 'getting-started', 'Essential walkthroughs for new team members', '#dd3333', 1),
  ('Platform Guides', 'platform-guides', 'Step-by-step tool and software tutorials', '#2563eb', 2),
  ('Workflows & SOPs', 'workflows-sops', 'Standard operating procedures and daily tasks', '#0f766e', 3),
  ('Safety & Compliance', 'safety-compliance', 'Workplace safety, security, and policy guides', '#b45309', 4)
on conflict (slug) do nothing;

-- Refresh PostgREST schema cache immediately
notify pgrst, 'reload schema';
