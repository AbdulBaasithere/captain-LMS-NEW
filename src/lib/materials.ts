import { supabase } from './supabase'
import type { Module } from './database.types'
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  MATERIAL_BUCKET,
  MAX_MATERIAL_SIZE_BYTES,
  VIDEO_INDEX_OBJECT,
  applyUploadedVideoToModule,
  documentEmbedUrl,
  formatDuration,
  hasAnyVideo,
  inferDocumentType,
  inferVideoType,
  isMissingModuleColumnError,
  materialType,
  type MaterialLike,
  type UploadedVideoManifest,
  type UploadedVideoManifestEntry,
} from './materialHelpers'

export {
  ALLOWED_DOCUMENT_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  MATERIAL_BUCKET,
  MAX_MATERIAL_SIZE_BYTES,
  VIDEO_INDEX_OBJECT,
  applyUploadedVideoToModule,
  documentEmbedUrl,
  formatDuration,
  hasAnyVideo,
  inferDocumentType,
  inferVideoType,
  isMissingModuleColumnError,
  materialType,
  type MaterialLike,
  type UploadedVideoManifest,
  type UploadedVideoManifestEntry,
}

export interface UploadResult {
  url: string | null
  type: string | null
  error: string | null
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export async function uploadModuleMaterial(moduleId: number, file: File): Promise<UploadResult> {
  const type = inferDocumentType(file.name)
  if (!type) return { url: null, type: null, error: 'Only PDF, PPTX, or DOCX files are supported.' }
  if (file.size > MAX_MATERIAL_SIZE_BYTES) return { url: null, type: null, error: 'File is too large (50MB max).' }

  const path = `${moduleId}/${Date.now()}-${sanitizeFilename(file.name)}`
  const { error } = await supabase.storage.from(MATERIAL_BUCKET).upload(path, file, { upsert: true })
  if (error) return { url: null, type: null, error: error.message }

  const { data } = supabase.storage.from(MATERIAL_BUCKET).getPublicUrl(path)
  return { url: data.publicUrl, type, error: null }
}

export async function uploadModuleVideo(moduleId: number, file: File): Promise<UploadResult> {
  const type = inferVideoType(file.name)
  if (!type) {
    return {
      url: null,
      type: null,
      error: 'Only MP4, WebM, MOV, M4V, or OGG video files are supported.',
    }
  }
  if (file.size > MAX_MATERIAL_SIZE_BYTES) {
    return { url: null, type: null, error: 'Video file is too large (50MB max).' }
  }

  const path = `${moduleId}/videos/${Date.now()}-${sanitizeFilename(file.name)}`
  const { error } = await supabase.storage.from(MATERIAL_BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type || undefined,
  })
  if (error) return { url: null, type: null, error: error.message }

  const { data } = supabase.storage.from(MATERIAL_BUCKET).getPublicUrl(path)
  return { url: data.publicUrl, type, error: null }
}

async function readVideoManifest(): Promise<UploadedVideoManifest> {
  try {
    const { data: listed, error: listErr } = await supabase.storage
      .from(MATERIAL_BUCKET)
      .list('', { limit: 10, search: VIDEO_INDEX_OBJECT })
    if (listErr || !listed?.some((item) => item.name === VIDEO_INDEX_OBJECT)) {
      return {}
    }
    const { data: pub } = supabase.storage.from(MATERIAL_BUCKET).getPublicUrl(VIDEO_INDEX_OBJECT)
    const res = await fetch(`${pub.publicUrl}?v=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return {}
    const parsed = (await res.json()) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as UploadedVideoManifest
  } catch {
    return {}
  }
}

async function writeVideoManifest(manifest: UploadedVideoManifest): Promise<{ error: string | null }> {
  const body = new Blob([JSON.stringify(manifest)], { type: 'application/json' })
  const { error } = await supabase.storage.from(MATERIAL_BUCKET).upload(VIDEO_INDEX_OBJECT, body, {
    upsert: true,
    contentType: 'application/json',
    cacheControl: '0',
  })
  return { error: error?.message ?? null }
}

async function findLatestStorageVideoForModule(moduleId: number): Promise<UploadedVideoManifestEntry | null> {
  try {
    const { data, error } = await supabase.storage.from(MATERIAL_BUCKET).list(`${moduleId}/videos`, {
      limit: 20,
      sortBy: { column: 'created_at', order: 'desc' },
    })
    if (error || !data?.length) return null
    const videoItem = data.find((f) => inferVideoType(f.name) !== null)
    if (!videoItem) return null
    const videoType = inferVideoType(videoItem.name) ?? 'mp4'
    const { data: pub } = supabase.storage.from(MATERIAL_BUCKET).getPublicUrl(`${moduleId}/videos/${videoItem.name}`)
    return {
      video_url: pub.publicUrl,
      video_type: videoType,
      updated_at: videoItem.updated_at ?? videoItem.created_at ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/**
 * Links an uploaded video to a module. Tries writing `video_url` and `video_type` to `public.modules`,
 * and seamlessly falls back to saving the mapping inside the existing `module-materials` Supabase Storage
 * bucket (`_video-index.json`) if those columns aren't in PostgREST's schema cache yet.
 */
export async function saveModuleUploadedVideo(
  moduleId: number,
  url: string,
  type: string,
  probedDurationSeconds?: number | null,
  updateDurationColumn = true,
): Promise<{ error: string | null }> {
  const payload: Record<string, unknown> = {
    video_url: url,
    video_type: type,
    ...(updateDurationColumn && probedDurationSeconds && probedDurationSeconds > 0
      ? { duration_seconds: probedDurationSeconds }
      : {}),
  }

  const { error: dbError } = await supabase.from('modules').update(payload).eq('id', moduleId)
  if (!dbError) {
    // Keep manifest clean if an entry existed previously
    const existing = await readVideoManifest()
    if (existing[String(moduleId)]) {
      delete existing[String(moduleId)]
      await writeVideoManifest(existing)
    }
    return { error: null }
  }

  if (!isMissingModuleColumnError(dbError.message)) {
    return { error: dbError.message }
  }

  // Fallback when Postgres / PostgREST schema cache doesn't have video_url / video_type yet:
  // 1) Update duration_seconds alone (which exists in the base schema) if provided
  if (updateDurationColumn && probedDurationSeconds && probedDurationSeconds > 0) {
    await supabase.from('modules').update({ duration_seconds: probedDurationSeconds }).eq('id', moduleId)
  }

  // 2) Store the module -> uploaded video mapping in shared Supabase Storage manifest
  const manifest = await readVideoManifest()
  manifest[String(moduleId)] = {
    video_url: url,
    video_type: type,
    ...(probedDurationSeconds && probedDurationSeconds > 0 ? { duration_seconds: probedDurationSeconds } : {}),
    updated_at: new Date().toISOString(),
  }
  const { error: manifestErr } = await writeVideoManifest(manifest)
  if (manifestErr) {
    return { error: manifestErr }
  }
  return { error: null }
}

/**
 * Removes all uploaded video files for a module from Storage, clears any manifest entry, and clears
 * `video_url` / `video_type` on `public.modules` (ignoring missing-column schema cache errors cleanly).
 */
export async function clearModuleUploadedVideo(moduleId: number, currentVideoUrl?: string | null): Promise<void> {
  await deleteMaterialFile(currentVideoUrl)
  try {
    const { data: files } = await supabase.storage.from(MATERIAL_BUCKET).list(`${moduleId}/videos`, { limit: 100 })
    if (files?.length) {
      await supabase.storage.from(MATERIAL_BUCKET).remove(files.map((f) => `${moduleId}/videos/${f.name}`))
    }
  } catch {
    // Ignore listing/remove errors if folder is already empty
  }

  const manifest = await readVideoManifest()
  if (manifest[String(moduleId)]) {
    delete manifest[String(moduleId)]
    await writeVideoManifest(manifest)
  }

  const { error } = await supabase.from('modules').update({ video_url: null, video_type: null }).eq('id', moduleId)
  if (error && !isMissingModuleColumnError(error.message)) {
    console.error('Could not clear module uploaded video columns:', error.message)
  }
}

/** Hydrates an array of modules with any uploaded videos stored in the shared Storage index. */
export async function hydrateModulesUploadedVideos(modules: Module[]): Promise<Module[]> {
  if (!modules.length) return modules
  const manifest = await readVideoManifest()
  return modules.map((m) => applyUploadedVideoToModule(m, manifest[String(m.id)]))
}

/** Hydrates a single module from DB columns, the shared Storage index, or `<moduleId>/videos/` listing. */
export async function hydrateModuleUploadedVideo(mod: Module | null): Promise<Module | null> {
  if (!mod) return null
  if (mod.video_url) return applyUploadedVideoToModule(mod, null)
  const manifest = await readVideoManifest()
  const fromManifest = manifest[String(mod.id)]
  if (fromManifest?.video_url) {
    return applyUploadedVideoToModule(mod, fromManifest)
  }
  const fromFolder = await findLatestStorageVideoForModule(mod.id)
  return fromFolder ? applyUploadedVideoToModule(mod, fromFolder) : mod
}

/** Reads the video duration in seconds from a local File via an offscreen <video> element.
 * Returns null if the browser can't decode metadata within 5 seconds. */
export function probeVideoDurationSeconds(file: File): Promise<number | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    let settled = false

    const finish = (seconds: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(objectUrl)
      resolve(seconds)
    }

    const timer = setTimeout(() => finish(null), 5000)

    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const secs = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration) : null
      finish(secs)
    }
    video.onerror = () => finish(null)
    video.src = objectUrl
  })
}

/** Removes an uploaded file from storage given its public URL (no-op for anything not in our bucket). */
export async function deleteMaterialFile(publicUrl: string | null | undefined): Promise<void> {
  if (!publicUrl) return
  const marker = `/${MATERIAL_BUCKET}/`
  const i = publicUrl.indexOf(marker)
  if (i === -1) return
  const path = decodeURIComponent(publicUrl.slice(i + marker.length))
  await supabase.storage.from(MATERIAL_BUCKET).remove([path])
}
