export const MATERIAL_BUCKET = 'module-materials'
export const VIDEO_INDEX_OBJECT = '_video-index.json'
export const ALLOWED_DOCUMENT_EXTENSIONS = ['pdf', 'pptx', 'ppt', 'docx', 'doc'] as const
export const ALLOWED_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogg'] as const
export const MAX_MATERIAL_SIZE_BYTES = 50 * 1024 * 1024 // 50MB — Supabase Storage's free-tier default object limit

export interface MaterialLike {
  youtube_id?: string | null
  video_url?: string | null
  video_type?: string | null
  document_url?: string | null
  document_type?: string | null
}

export interface UploadedVideoManifestEntry {
  video_url: string
  video_type: string
  duration_seconds?: number
  updated_at: string
}

export type UploadedVideoManifest = Record<string, UploadedVideoManifestEntry>

export function inferDocumentType(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase().split(/[?#]/)[0]
  return ext && (ALLOWED_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext) ? ext : null
}

export function inferVideoType(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase().split(/[?#]/)[0]
  return ext && (ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(ext) ? ext : null
}

export function hasAnyVideo(m: Pick<MaterialLike, 'youtube_id' | 'video_url'> | null | undefined): boolean {
  return !!(m?.youtube_id || m?.video_url)
}

export function isMissingModuleColumnError(message: string | null | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  const mentionsTarget = lower.includes('schema cache') || lower.includes('video_type') || lower.includes('video_url')
  const isColumnError = lower.includes('column') || lower.includes('could not find') || lower.includes('does not exist')
  return mentionsTarget && isColumnError
}

export function applyUploadedVideoToModule<
  T extends { id: number; video_url?: string | null; video_type?: string | null; duration_seconds: number },
>(mod: T, entry: UploadedVideoManifestEntry | null | undefined): T {
  if (mod.video_url) {
    if (mod.video_type) return mod
    return {
      ...mod,
      video_type: inferVideoType(mod.video_url) ?? mod.video_type ?? 'mp4',
    }
  }
  if (!entry?.video_url) return mod
  return {
    ...mod,
    video_url: entry.video_url,
    video_type: entry.video_type || inferVideoType(entry.video_url) || 'mp4',
    duration_seconds:
      mod.duration_seconds === 300 && entry.duration_seconds && entry.duration_seconds > 0
        ? entry.duration_seconds
        : mod.duration_seconds,
  }
}

/** Native browser PDF viewer needs just the file URL; PPTX/DOCX need Microsoft's free Office
 * Online Viewer, since no browser renders those formats natively — it fetches the file itself
 * from the given public URL, so this only works once the module is live on a real internet
 * address (not from a local dev server). */
export function documentEmbedUrl(url: string, type: string): string {
  if (type === 'pdf') return url
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`
}

/** Plain-text learning-material type for any module — describes YouTube, uploaded video,
 * document/presentation extension, or combinations thereof. */
export function materialType(m: MaterialLike): string {
  const hasYt = !!m.youtube_id
  const hasVid = !!m.video_url
  const docLabel = m.document_type ? m.document_type.toUpperCase() : m.document_url ? 'DOC' : null

  const parts: string[] = []
  if (hasYt && hasVid) {
    parts.push('YouTube', 'Uploaded Video')
  } else if (hasYt || hasVid) {
    parts.push('Video')
  }
  if (docLabel) {
    parts.push(docLabel)
  }
  return parts.length ? parts.join(' + ') : 'None'
}

/** Minutes for a video (the real length once someone's played it at least once — a fresh video
 * shows a 5-minute placeholder until then), "Untimed" for a document-only lesson, or "—" for neither. */
export function formatDuration(m: MaterialLike & { duration_seconds: number }): string {
  if (!hasAnyVideo(m)) return m.document_type || m.document_url ? 'Untimed' : '—'
  const mins = Math.round(m.duration_seconds / 60)
  return mins < 1 ? '<1 min' : `${mins} min`
}
