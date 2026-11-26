-- ============================================================================
-- Captain LMS — Shared Company Certificate Template Storage
-- Migration: 20261112_certificate_template_storage.sql
-- Stores the active custom PDF certificate template & overlay placement config
-- globally so all employees receive certificates generated from the admin's template.
-- Safe to re-run (idempotent).
-- ============================================================================

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create table if not exists public.certificate_settings (
  id int primary key default 1 check (id = 1),
  config jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.certificate_settings (id, config)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

alter table public.certificate_settings enable row level security;

drop policy if exists "authenticated users read certificate settings" on public.certificate_settings;
create policy "authenticated users read certificate settings" on public.certificate_settings
  for select using (auth.role() = 'authenticated');

drop policy if exists "admins manage certificate settings" on public.certificate_settings;
create policy "admins manage certificate settings" on public.certificate_settings
  for all using (public.current_user_role() = 'admin');
