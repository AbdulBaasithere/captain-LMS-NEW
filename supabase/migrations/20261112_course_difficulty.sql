-- ============================================================================
-- Captain LMS — Course Difficulty Level Column
-- Migration: 20261112_course_difficulty.sql
-- Safe to re-run (idempotent).
-- ============================================================================

alter table public.courses
  add column if not exists difficulty text not null default 'Beginner'
  check (difficulty in ('Beginner', 'Intermediate', 'Advanced'));
