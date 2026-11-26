import type {
  Profile,
  Tutorial,
  TutorialCategory,
  TutorialProgress,
  TutorialStatus,
  TutorialVideoSource,
} from './database.types'

export const TUTORIAL_BUCKET = 'tutorial-media'
export const FALLBACK_TUTORIAL_BUCKET = 'module-materials'
export const MAX_TUTORIAL_VIDEO_BYTES = 50 * 1024 * 1024
export const MAX_TUTORIAL_THUMBNAIL_BYTES = 10 * 1024 * 1024
export const ALLOWED_THUMBNAIL_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const

export type DetectedExternalVideo =
  | { kind: 'youtube'; youtubeId: string; embedUrl: string }
  | { kind: 'vimeo'; embedUrl: string }
  | { kind: 'loom'; embedUrl: string }
  | { kind: 'direct_video'; mediaUrl: string }
  | { kind: 'external_link'; url: string }
  | { kind: 'invalid'; error: string }

export interface TutorialInstructionBlock {
  type: 'heading' | 'bullet' | 'ordered' | 'paragraph'
  text: string
  orderNumber?: number
}

export interface TutorialWithMeta extends Tutorial {
  categoryName: string
  categoryColor: string
  progress: TutorialProgress | null
  status: TutorialStatus
  resolvedThumbnailUrl: string | null
}

export interface TutorialAnalyticsRow {
  tutorial: Tutorial
  categoryName: string
  categoryColor: string
  totalViews: number
  uniqueViewers: number
  inProgressCount: number
  completedCount: number
  completionRatePct: number
}

export interface TutorialAnalyticsSummary {
  totalTutorials: number
  publishedCount: number
  draftCount: number
  totalViews: number
  totalCompletions: number
  avgCompletionRatePct: number
  rows: TutorialAnalyticsRow[]
}

export function sanitizeExternalUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

export function parseYoutubeIdSafe(raw: string): string | null {
  const v = raw.trim()
  if (/^[\w-]{11}$/.test(v)) return v
  const m = v.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/)
  return m ? m[1]! : null
}

export function detectExternalVideoKind(raw: string): DetectedExternalVideo {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'invalid', error: 'Enter a video URL or YouTube ID.' }

  // Allow bare 11-char YouTube IDs directly
  if (/^[\w-]{11}$/.test(trimmed)) {
    return {
      kind: 'youtube',
      youtubeId: trimmed,
      embedUrl: `https://www.youtube-nocookie.com/embed/${trimmed}?rel=0&modestbranding=1`,
    }
  }

  const safeUrl = sanitizeExternalUrl(trimmed)
  if (!safeUrl) {
    return {
      kind: 'invalid',
      error: 'Enter a valid https:// or http:// video URL (or an 11-character YouTube ID).',
    }
  }

  const parsed = new URL(safeUrl)
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    const ytId = parseYoutubeIdSafe(safeUrl)
    if (ytId) {
      return {
        kind: 'youtube',
        youtubeId: ytId,
        embedUrl: `https://www.youtube-nocookie.com/embed/${ytId}?rel=0&modestbranding=1`,
      }
    }
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = parsed.pathname.match(/\/(?:video\/)?(\d+)/)
    if (m?.[1]) {
      return { kind: 'vimeo', embedUrl: `https://player.vimeo.com/video/${m[1]}` }
    }
  }

  if (host === 'loom.com') {
    const m = parsed.pathname.match(/\/(?:share|embed)\/([a-zA-Z0-9]+)/)
    if (m?.[1]) {
      return { kind: 'loom', embedUrl: `https://www.loom.com/embed/${m[1]}` }
    }
  }

  if (/\.(mp4|webm|mov|m4v|ogg)(?:$|\?)/i.test(parsed.pathname)) {
    return { kind: 'direct_video', mediaUrl: safeUrl }
  }

  return { kind: 'external_link', url: safeUrl }
}

export function inferThumbnailExtension(filename: string): string | null {
  const ext = filename.trim().split('.').pop()?.toLowerCase() ?? ''
  return (ALLOWED_THUMBNAIL_EXTENSIONS as readonly string[]).includes(ext) ? ext : null
}

export function resolveTutorialThumbnail(
  tutorial: Pick<Tutorial, 'thumbnail_url' | 'youtube_id'>,
): string | null {
  const custom = sanitizeExternalUrl(tutorial.thumbnail_url)
  if (custom) return custom
  if (tutorial.youtube_id && /^[\w-]{11}$/.test(tutorial.youtube_id)) {
    return `https://i.ytimg.com/vi/${tutorial.youtube_id}/hqdefault.jpg`
  }
  return null
}

export function formatTutorialDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0))
  if (s === 0) return '0:00'
  const hrs = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const rem = s % 60
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`
  }
  return `${mins}:${String(rem).padStart(2, '0')}`
}

export function slugifyCategoryName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'category'
}

export function isTutorialVisibleToDepartment(
  departments: string[] | null | undefined,
  userDepartment: string | null | undefined,
): boolean {
  const list = Array.isArray(departments) && departments.length > 0 ? departments : ['General']
  if (list.some((d) => d.trim().toLowerCase() === 'general')) return true
  const target = (userDepartment ?? '').trim().toLowerCase()
  if (!target) return false
  return list.some((d) => d.trim().toLowerCase() === target)
}

export function resolveTutorialStatus(progress: Pick<TutorialProgress, 'status'> | null | undefined): TutorialStatus {
  if (!progress) return 'not_started'
  if (progress.status === 'completed' || progress.status === 'in_progress') return progress.status
  return 'not_started'
}

export function formatTutorialStatusLabel(status: TutorialStatus): string {
  if (status === 'completed') return 'Completed'
  if (status === 'in_progress') return 'In Progress'
  return 'Not Started'
}

export function enrichTutorials(
  tutorials: Tutorial[],
  categories: TutorialCategory[],
  progressRows: TutorialProgress[],
): TutorialWithMeta[] {
  const catMap = new Map<number, TutorialCategory>()
  for (const c of categories) catMap.set(c.id, c)

  const progMap = new Map<number, TutorialProgress>()
  for (const p of progressRows) progMap.set(p.tutorial_id, p)

  return tutorials.map((t) => {
    const cat = t.category_id ? catMap.get(t.category_id) : undefined
    const prog = progMap.get(t.id) ?? null
    return {
      ...t,
      categoryName: cat?.name ?? 'Uncategorized',
      categoryColor: cat?.color ?? '#dd3333',
      progress: prog,
      status: resolveTutorialStatus(prog),
      resolvedThumbnailUrl: resolveTutorialThumbnail(t),
    }
  })
}

export function filterTutorials(
  list: TutorialWithMeta[],
  filters: {
    search: string
    categoryId: number | 'all'
    status: TutorialStatus | 'all'
  },
): TutorialWithMeta[] {
  const q = filters.search.trim().toLowerCase()
  return list.filter((item) => {
    if (filters.categoryId !== 'all' && item.category_id !== filters.categoryId) return false
    if (filters.status !== 'all' && item.status !== filters.status) return false
    if (q) {
      const hay = `${item.title}\n${item.description}\n${item.instructions}\n${item.categoryName}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/**
 * Parses written instructions safely into structured blocks (no raw HTML injection).
 * Supports `# Heading`, `## Subheading`, `- Bullet`, `* Bullet`, and `1. Step`.
 */
export function parseInstructionBlocks(raw: string | null | undefined): TutorialInstructionBlock[] {
  const lines = (raw ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: TutorialInstructionBlock[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const headingMatch = line.match(/^#{1,3}\s+(.+)$/)
    if (headingMatch?.[1]) {
      blocks.push({ type: 'heading', text: headingMatch[1].trim() })
      continue
    }

    const orderedMatch = line.match(/^(\d+)[.)]\s+(.+)$/)
    if (orderedMatch?.[1] && orderedMatch[2]) {
      blocks.push({
        type: 'ordered',
        orderNumber: Number(orderedMatch[1]),
        text: orderedMatch[2].trim(),
      })
      continue
    }

    const bulletMatch = line.match(/^[-*•]\s+(.+)$/)
    if (bulletMatch?.[1]) {
      blocks.push({ type: 'bullet', text: bulletMatch[1].trim() })
      continue
    }

    blocks.push({ type: 'paragraph', text: line })
  }

  return blocks
}

export function computeTutorialAnalytics(
  tutorials: Tutorial[],
  categories: TutorialCategory[],
  progressRows: TutorialProgress[],
  profiles: Pick<Profile, 'id' | 'department' | 'role' | 'is_active'>[],
): TutorialAnalyticsSummary {
  const catMap = new Map<number, TutorialCategory>()
  for (const c of categories) catMap.set(c.id, c)

  const activeEmployees = profiles.filter((p) => p.role === 'employee' && p.is_active !== false)

  const progressByTutorial = new Map<number, TutorialProgress[]>()
  for (const row of progressRows) {
    const arr = progressByTutorial.get(row.tutorial_id) ?? []
    arr.push(row)
    progressByTutorial.set(row.tutorial_id, arr)
  }

  let totalViews = 0
  let totalCompletions = 0
  let rateSum = 0

  const rows: TutorialAnalyticsRow[] = tutorials.map((t) => {
    const cat = t.category_id ? catMap.get(t.category_id) : undefined
    const entries = progressByTutorial.get(t.id) ?? []

    const summedProgressViews = entries.reduce((sum, e) => sum + (e.view_count || 0), 0)
    const views = Math.max(t.view_count || 0, summedProgressViews)
    const uniqueViewers = entries.filter((e) => e.view_count > 0 || e.status !== 'not_started').length
    const inProgressCount = entries.filter((e) => e.status === 'in_progress').length
    const completedCount = entries.filter((e) => e.status === 'completed').length

    const eligibleEmployees = activeEmployees.filter((emp) =>
      isTutorialVisibleToDepartment(t.departments, emp.department),
    )
    const denominator = eligibleEmployees.length > 0 ? eligibleEmployees.length : uniqueViewers
    const completionRatePct =
      denominator > 0 ? Math.min(100, Math.round((completedCount / denominator) * 100)) : 0

    totalViews += views
    totalCompletions += completedCount
    rateSum += completionRatePct

    return {
      tutorial: t,
      categoryName: cat?.name ?? 'Uncategorized',
      categoryColor: cat?.color ?? '#dd3333',
      totalViews: views,
      uniqueViewers,
      inProgressCount,
      completedCount,
      completionRatePct,
    }
  })

  const publishedCount = tutorials.filter((t) => t.is_published).length
  const draftCount = tutorials.length - publishedCount
  const avgCompletionRatePct = tutorials.length > 0 ? Math.round(rateSum / tutorials.length) : 0

  return {
    totalTutorials: tutorials.length,
    publishedCount,
    draftCount,
    totalViews,
    totalCompletions,
    avgCompletionRatePct,
    rows,
  }
}

export function formatVideoSourceLabel(source: TutorialVideoSource): string {
  if (source === 'upload') return 'Uploaded Video'
  if (source === 'youtube') return 'YouTube'
  return 'External Video'
}
