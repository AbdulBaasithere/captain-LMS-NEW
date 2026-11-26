import { supabase } from './supabase'
import { inferVideoType } from './materialHelpers'
import {
  FALLBACK_TUTORIAL_BUCKET,
  MAX_TUTORIAL_THUMBNAIL_BYTES,
  MAX_TUTORIAL_VIDEO_BYTES,
  TUTORIAL_BUCKET,
  inferThumbnailExtension,
  isTutorialVisibleToDepartment,
  slugifyCategoryName,
} from './tutorialHelpers'
import type {
  Profile,
  Tutorial,
  TutorialCategory,
  TutorialProgress,
  TutorialStatus,
  TutorialVideoSource,
} from './database.types'

function isMissingRelationError(message: string | undefined): boolean {
  const m = (message ?? '').toLowerCase()
  return (
    m.includes('does not exist') ||
    m.includes('could not find the table') ||
    m.includes('schema cache') ||
    m.includes('relation')
  )
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export interface EmployeeTutorialsPayload {
  missingTable: boolean
  categories: TutorialCategory[]
  tutorials: Tutorial[]
  progressRows: TutorialProgress[]
  error: string | null
}

export interface AdminTutorialsPayload {
  missingTable: boolean
  categories: TutorialCategory[]
  tutorials: Tutorial[]
  progressRows: TutorialProgress[]
  profiles: Profile[]
  error: string | null
}

export async function loadEmployeeTutorials(
  userId: string,
  department: string,
): Promise<EmployeeTutorialsPayload> {
  const [catsRes, tutsRes, progRes] = await Promise.all([
    supabase
      .from('tutorial_categories')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('tutorials')
      .select('*')
      .eq('is_published', true)
      .order('created_at', { ascending: false }),
    supabase.from('tutorial_progress').select('*').eq('user_id', userId),
  ])

  const firstErr = catsRes.error ?? tutsRes.error ?? progRes.error
  if (firstErr) {
    if (isMissingRelationError(firstErr.message)) {
      return {
        missingTable: true,
        categories: [],
        tutorials: [],
        progressRows: [],
        error: null,
      }
    }
    return {
      missingTable: false,
      categories: [],
      tutorials: [],
      progressRows: [],
      error: firstErr.message,
    }
  }

  const visibleTutorials = ((tutsRes.data ?? []) as Tutorial[]).filter((t) =>
    isTutorialVisibleToDepartment(t.departments, department),
  )

  return {
    missingTable: false,
    categories: (catsRes.data ?? []) as TutorialCategory[],
    tutorials: visibleTutorials,
    progressRows: (progRes.data ?? []) as TutorialProgress[],
    error: null,
  }
}

export async function loadSingleEmployeeTutorial(
  tutorialId: number,
  userId: string,
  department: string,
): Promise<{
  missingTable: boolean
  tutorial: Tutorial | null
  categories: TutorialCategory[]
  relatedTutorials: Tutorial[]
  progress: TutorialProgress | null
  error: string | null
}> {
  const [tutRes, catsRes, relatedRes, progRes] = await Promise.all([
    supabase.from('tutorials').select('*').eq('id', tutorialId).maybeSingle(),
    supabase
      .from('tutorial_categories')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('tutorials')
      .select('*')
      .eq('is_published', true)
      .order('created_at', { ascending: false }),
    supabase
      .from('tutorial_progress')
      .select('*')
      .eq('tutorial_id', tutorialId)
      .eq('user_id', userId)
      .maybeSingle(),
  ])

  const err = tutRes.error ?? catsRes.error ?? relatedRes.error ?? progRes.error
  if (err) {
    return {
      missingTable: isMissingRelationError(err.message),
      tutorial: null,
      categories: [],
      relatedTutorials: [],
      progress: null,
      error: isMissingRelationError(err.message) ? null : err.message,
    }
  }

  const tut = (tutRes.data as Tutorial | null) ?? null
  if (!tut || (!tut.is_published) || !isTutorialVisibleToDepartment(tut.departments, department)) {
    return {
      missingTable: false,
      tutorial: null,
      categories: (catsRes.data ?? []) as TutorialCategory[],
      relatedTutorials: [],
      progress: null,
      error: tut ? 'This tutorial is not available for your department.' : 'Tutorial not found.',
    }
  }

  const visibleRelated = ((relatedRes.data ?? []) as Tutorial[])
    .filter((item) => item.id !== tut.id && isTutorialVisibleToDepartment(item.departments, department))

  return {
    missingTable: false,
    tutorial: tut,
    categories: (catsRes.data ?? []) as TutorialCategory[],
    relatedTutorials: visibleRelated,
    progress: (progRes.data as TutorialProgress | null) ?? null,
    error: null,
  }
}

export async function loadAdminTutorials(): Promise<AdminTutorialsPayload> {
  const [catsRes, tutsRes, progRes, profsRes] = await Promise.all([
    supabase
      .from('tutorial_categories')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase.from('tutorials').select('*').order('created_at', { ascending: false }),
    supabase.from('tutorial_progress').select('*'),
    supabase.from('profiles').select('*').order('full_name', { ascending: true }),
  ])

  const firstErr = catsRes.error ?? tutsRes.error ?? progRes.error
  if (firstErr) {
    if (isMissingRelationError(firstErr.message)) {
      return {
        missingTable: true,
        categories: [],
        tutorials: [],
        progressRows: [],
        profiles: [],
        error: null,
      }
    }
    return {
      missingTable: false,
      categories: [],
      tutorials: [],
      progressRows: [],
      profiles: [],
      error: firstErr.message,
    }
  }

  return {
    missingTable: false,
    categories: (catsRes.data ?? []) as TutorialCategory[],
    tutorials: (tutsRes.data ?? []) as Tutorial[],
    progressRows: (progRes.data ?? []) as TutorialProgress[],
    profiles: (profsRes.data ?? []) as Profile[],
    error: null,
  }
}

export interface UpsertTutorialInput {
  id?: number
  title: string
  description: string
  instructions: string
  category_id: number | null
  thumbnail_url: string | null
  video_source: TutorialVideoSource
  video_url: string | null
  youtube_id: string | null
  duration_seconds: number
  departments: string[]
  is_published: boolean
  created_by?: string | null
}

export async function saveTutorial(
  input: UpsertTutorialInput,
): Promise<{ tutorial: Tutorial | null; error: string | null }> {
  const payload = {
    title: input.title.trim(),
    description: input.description.trim(),
    instructions: input.instructions,
    category_id: input.category_id,
    thumbnail_url: input.thumbnail_url?.trim() || null,
    video_source: input.video_source,
    video_url: input.video_url?.trim() || null,
    youtube_id: input.youtube_id?.trim() || null,
    duration_seconds: Math.max(0, Math.round(input.duration_seconds || 0)),
    departments: input.departments.length > 0 ? input.departments : ['General'],
    is_published: input.is_published,
    updated_at: new Date().toISOString(),
  }

  if (input.id) {
    const { data, error } = await supabase
      .from('tutorials')
      .update(payload)
      .eq('id', input.id)
      .select()
      .single()
    return { tutorial: (data as Tutorial | null) ?? null, error: error?.message ?? null }
  }

  const { data, error } = await supabase
    .from('tutorials')
    .insert({ ...payload, created_by: input.created_by ?? null })
    .select()
    .single()
  return { tutorial: (data as Tutorial | null) ?? null, error: error?.message ?? null }
}

export async function setTutorialPublished(
  id: number,
  isPublished: boolean,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('tutorials')
    .update({ is_published: isPublished, updated_at: new Date().toISOString() })
    .eq('id', id)
  return { error: error?.message ?? null }
}

export async function deleteTutorial(id: number): Promise<{ error: string | null }> {
  const { error } = await supabase.from('tutorials').delete().eq('id', id)
  return { error: error?.message ?? null }
}

export async function saveTutorialCategory(input: {
  id?: number
  name: string
  description: string
  color: string
  sort_order: number
  created_by?: string | null
}): Promise<{ category: TutorialCategory | null; error: string | null }> {
  const name = input.name.trim()
  if (!name) return { category: null, error: 'Category name is required.' }
  const slug = slugifyCategoryName(name)

  if (input.id) {
    const { data, error } = await supabase
      .from('tutorial_categories')
      .update({
        name,
        slug,
        description: input.description.trim(),
        color: input.color || '#dd3333',
        sort_order: Number.isFinite(input.sort_order) ? input.sort_order : 0,
      })
      .eq('id', input.id)
      .select()
      .single()
    return { category: (data as TutorialCategory | null) ?? null, error: error?.message ?? null }
  }

  const { data, error } = await supabase
    .from('tutorial_categories')
    .insert({
      name,
      slug,
      description: input.description.trim(),
      color: input.color || '#dd3333',
      sort_order: Number.isFinite(input.sort_order) ? input.sort_order : 0,
      created_by: input.created_by ?? null,
    })
    .select()
    .single()
  return { category: (data as TutorialCategory | null) ?? null, error: error?.message ?? null }
}

export async function deleteTutorialCategory(id: number): Promise<{ error: string | null }> {
  const { error } = await supabase.from('tutorial_categories').delete().eq('id', id)
  return { error: error?.message ?? null }
}

async function uploadToTutorialBucket(
  path: string,
  file: File,
): Promise<{ url: string | null; error: string | null }> {
  const primary = await supabase.storage.from(TUTORIAL_BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type || undefined,
  })
  if (!primary.error) {
    const { data } = supabase.storage.from(TUTORIAL_BUCKET).getPublicUrl(path)
    return { url: data.publicUrl, error: null }
  }

  // Graceful fallback to existing module-materials bucket if tutorial-media bucket isn't provisioned yet
  if (primary.error.message.toLowerCase().includes('bucket')) {
    const fallbackPath = `tutorials/${path}`
    const fallback = await supabase.storage.from(FALLBACK_TUTORIAL_BUCKET).upload(fallbackPath, file, {
      upsert: true,
      contentType: file.type || undefined,
    })
    if (!fallback.error) {
      const { data } = supabase.storage.from(FALLBACK_TUTORIAL_BUCKET).getPublicUrl(fallbackPath)
      return { url: data.publicUrl, error: null }
    }
    return { url: null, error: fallback.error.message }
  }

  return { url: null, error: primary.error.message }
}

export async function uploadTutorialVideo(
  file: File,
): Promise<{ url: string | null; type: string | null; error: string | null }> {
  const type = inferVideoType(file.name)
  if (!type) {
    return {
      url: null,
      type: null,
      error: 'Only MP4, WebM, MOV, M4V, or OGG video files are supported.',
    }
  }
  if (file.size > MAX_TUTORIAL_VIDEO_BYTES) {
    return { url: null, type: null, error: 'Video file is too large (50MB max).' }
  }

  const path = `videos/${Date.now()}-${sanitizeFilename(file.name)}`
  const res = await uploadToTutorialBucket(path, file)
  return { url: res.url, type: res.url ? type : null, error: res.error }
}

export async function uploadTutorialThumbnail(
  file: File,
): Promise<{ url: string | null; error: string | null }> {
  const ext = inferThumbnailExtension(file.name)
  if (!ext) {
    return { url: null, error: 'Only PNG, JPG, JPEG, WebP, or GIF images are supported.' }
  }
  if (file.size > MAX_TUTORIAL_THUMBNAIL_BYTES) {
    return { url: null, error: 'Thumbnail image is too large (10MB max).' }
  }

  const path = `thumbnails/${Date.now()}-${sanitizeFilename(file.name)}`
  return uploadToTutorialBucket(path, file)
}

export async function recordTutorialView(tutorialId: number): Promise<void> {
  try {
    await supabase.rpc('record_tutorial_view', { p_tutorial_id: tutorialId })
  } catch {
    // Non-blocking telemetry
  }
}

export async function saveTutorialProgress(params: {
  tutorialId: number
  userId: string
  status: TutorialStatus
  watchedSeconds?: number
  progressPct?: number
  existing?: TutorialProgress | null
}): Promise<{ progress: TutorialProgress | null; error: string | null }> {
  const nowIso = new Date().toISOString()
  const nextStatus = params.status
  const nextPct =
    nextStatus === 'completed'
      ? 100
      : nextStatus === 'not_started'
        ? 0
        : Math.max(0, Math.min(99, Math.round(params.progressPct ?? params.existing?.progress_pct ?? 0)))

  const nextWatched =
    nextStatus === 'not_started'
      ? 0
      : Math.max(0, Math.round(params.watchedSeconds ?? params.existing?.watched_seconds ?? 0))

  const completedAt =
    nextStatus === 'completed' ? (params.existing?.completed_at ?? nowIso) : null

  const { data, error } = await supabase
    .from('tutorial_progress')
    .upsert(
      {
        tutorial_id: params.tutorialId,
        user_id: params.userId,
        status: nextStatus,
        watched_seconds: nextWatched,
        progress_pct: nextPct,
        view_count: Math.max(1, params.existing?.view_count ?? 1),
        last_viewed_at: params.existing?.last_viewed_at ?? nowIso,
        completed_at: completedAt,
        updated_at: nowIso,
      },
      { onConflict: 'tutorial_id,user_id' },
    )
    .select()
    .single()

  return { progress: (data as TutorialProgress | null) ?? null, error: error?.message ?? null }
}
