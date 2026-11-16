-- ============================================================================
-- Captain LMS — Audience Default Course Colours
-- Migration: 20261115_audience_colors.sql
-- Adds persisted colour assignment per audience (including built-in 'General')
-- so Create Course automatically defaults to the audience's assigned colour
-- and newly created audiences receive a unique colour automatically.
-- Safe to re-run (idempotent).
-- ============================================================================

alter table public.departments
  add column if not exists color text;

create table if not exists public.audience_colors (
  audience_name text primary key,
  color text not null,
  updated_at timestamptz not null default now()
);

alter table public.audience_colors enable row level security;

drop policy if exists "authenticated read audience_colors" on public.audience_colors;
create policy "authenticated read audience_colors" on public.audience_colors
  for select using (auth.role() = 'authenticated');

drop policy if exists "admins manage audience_colors" on public.audience_colors;
create policy "admins manage audience_colors" on public.audience_colors
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Seed sensible defaults for General + any existing departments without a colour yet
insert into public.audience_colors (audience_name, color)
values ('General', '#0f1b33')
on conflict (audience_name) do nothing;

with palette as (
  select array[
    '#2f5be8', '#eab308', '#0f7f6c', '#6d3fc0', '#f08a24',
    '#a3306b', '#1d8348', '#0284c7', '#1f4e8c', '#b4530f'
  ] as cols
),
numbered as (
  select
    d.id,
    d.name,
    coalesce(
      d.color,
      case
        when lower(d.name) like '%engineer%' then '#2f5be8'
        when lower(d.name) like '%soft%skill%' then '#eab308'
        when lower(d.name) like '%sales%' then '#f08a24'
        when lower(d.name) like '%finance%' then '#1d8348'
        when lower(d.name) like '%marketing%' then '#a3306b'
        when lower(d.name) like '%operation%' then '#6d3fc0'
        when lower(d.name) like '%support%' then '#0284c7'
        else (select cols[1 + ((row_number() over (order by d.id) - 1) % array_length(cols, 1))] from palette)
      end
    ) as resolved_color
  from public.departments d
)
update public.departments d
set color = n.resolved_color
from numbered n
where d.id = n.id
  and (d.color is null or d.color = '');

insert into public.audience_colors (audience_name, color)
select d.name, d.color
from public.departments d
where d.color is not null and d.color <> ''
on conflict (audience_name) do update
  set color = excluded.color,
      updated_at = now()
where public.audience_colors.color is null or public.audience_colors.color = '';
