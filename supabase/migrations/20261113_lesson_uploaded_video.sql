-- Optional DB column migration for direct uploaded videos on lessons (modules).
-- The app also works out-of-the-box via Supabase Storage even before running this migration,
-- and running this stores video_url/video_type directly on public.modules as well.

alter table public.modules add column if not exists video_url text;
alter table public.modules add column if not exists video_type text;

-- Refresh PostgREST schema cache immediately
notify pgrst, 'reload schema';
