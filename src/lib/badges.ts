import { supabase } from '@/lib/supabase'
import { courseProgress, type CourseVM } from '@/lib/courses'
import { hasAnyVideo } from '@/lib/materialHelpers'
import type {
  BadgeCriterionRow,
  CustomBadgeRow,
  EmployeeBadgeAwardRow,
  QuizAttempt,
  VideoCompletion,
} from '@/lib/database.types'

export type BadgeMatchMode = 'all' | 'any'

export interface BadgeCriterion {
  id: number
  slug: string
  name: string
  description: string
  icon: string
  tierOrder: number
  matchMode: BadgeMatchMode
  minCourseDurationMinutes: number
  minCoursesCompleted: number
  minCertificatesEarned: number
  isActive: boolean
}

export interface BadgeCriterionInput {
  id?: number
  slug?: string
  name: string
  description: string
  icon: string
  tierOrder: number
  matchMode: BadgeMatchMode
  minCourseDurationMinutes: number
  minCoursesCompleted: number
  minCertificatesEarned: number
  isActive: boolean
}

export interface LearnerBadgeMetrics {
  completedCourseDurationMinutes: number
  watchedMinutes: number
  coursesCompleted: number
  courseCertificatesEarned: number
  milestoneCertificatesEarned: number
  issuedCertificatesEarned: number
  certificatesEarned: number
}

export type CriterionKey = 'duration' | 'courses' | 'certificates'

export interface CriterionCheckResult {
  key: CriterionKey
  label: string
  current: number
  target: number
  currentFormatted: string
  targetFormatted: string
  pct: number
  met: boolean
}

export interface BadgeEvaluation {
  badge: BadgeCriterion
  eligible: boolean
  overallPct: number
  metCount: number
  totalChecks: number
  checks: CriterionCheckResult[]
  summaryHint: string
}

const LOCAL_BADGES_KEY = 'captain_milestone_badge_criteria_v1'

export const DEFAULT_BADGE_CRITERIA: BadgeCriterion[] = [
  {
    id: 1,
    slug: 'first-milestone',
    name: 'Pathfinder',
    description: 'Complete your first full course and earn your inaugural completion certificate.',
    icon: '🌱',
    tierOrder: 1,
    matchMode: 'all',
    minCourseDurationMinutes: 15,
    minCoursesCompleted: 1,
    minCertificatesEarned: 1,
    isActive: true,
  },
  {
    id: 2,
    slug: 'bronze-scholar',
    name: 'Bronze Scholar',
    description: 'Finish at least 2 courses totaling 1 hour of curriculum with 2 earned certificates.',
    icon: '🥉',
    tierOrder: 2,
    matchMode: 'all',
    minCourseDurationMinutes: 60,
    minCoursesCompleted: 2,
    minCertificatesEarned: 2,
    isActive: true,
  },
  {
    id: 3,
    slug: 'silver-achiever',
    name: 'Silver Achiever',
    description: 'Accumulate 3 hours of completed coursework across 3 courses and 4 earned certificates.',
    icon: '🥈',
    tierOrder: 3,
    matchMode: 'all',
    minCourseDurationMinutes: 180,
    minCoursesCompleted: 3,
    minCertificatesEarned: 4,
    isActive: true,
  },
  {
    id: 4,
    slug: 'gold-specialist',
    name: 'Gold Specialist',
    description: 'Demonstrate sustained mastery with 5 completed courses, 5 hours of learning, and 6 certificates.',
    icon: '🥇',
    tierOrder: 4,
    matchMode: 'all',
    minCourseDurationMinutes: 300,
    minCoursesCompleted: 5,
    minCertificatesEarned: 6,
    isActive: true,
  },
  {
    id: 5,
    slug: 'captain-distinction',
    name: 'Captain Distinction',
    description: 'Highest recognition for completing 8+ courses, 10+ curriculum hours, and 10+ total certificates.',
    icon: '🏆',
    tierOrder: 5,
    matchMode: 'all',
    minCourseDurationMinutes: 600,
    minCoursesCompleted: 8,
    minCertificatesEarned: 10,
    isActive: true,
  },
]

function rowToModel(row: BadgeCriterionRow): BadgeCriterion {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon || '🏅',
    tierOrder: row.tier_order ?? 1,
    matchMode: row.match_mode === 'any' ? 'any' : 'all',
    minCourseDurationMinutes: Math.max(0, Number(row.min_course_duration_minutes ?? 0)),
    minCoursesCompleted: Math.max(0, Number(row.min_courses_completed ?? 0)),
    minCertificatesEarned: Math.max(0, Number(row.min_certificates_earned ?? 0)),
    isActive: row.is_active !== false,
  }
}

export function slugifyBadgeName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || `badge-${Date.now()}`
}

export function formatDurationMinutes(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function readLocalCriteria(): BadgeCriterion[] {
  try {
    const raw = localStorage.getItem(LOCAL_BADGES_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as BadgeCriterion[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        return [...parsed].sort((a, b) => a.tierOrder - b.tierOrder || a.id - b.id)
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return DEFAULT_BADGE_CRITERIA.map((b) => ({ ...b }))
}

function writeLocalCriteria(list: BadgeCriterion[]): void {
  try {
    localStorage.setItem(LOCAL_BADGES_KEY, JSON.stringify(list))
  } catch {
    // Ignore storage write errors
  }
}

export async function loadBadgeCriteria(options: { includeInactive?: boolean } = {}): Promise<{
  criteria: BadgeCriterion[]
  tableMissing: boolean
}> {
  try {
    const { data, error } = await supabase
      .from('badge_criteria')
      .select('*')
      .order('tier_order', { ascending: true })
      .order('id', { ascending: true })

    if (!error && data) {
      const mapped = (data as BadgeCriterionRow[]).map(rowToModel)
      writeLocalCriteria(mapped)
      const filtered = options.includeInactive ? mapped : mapped.filter((b) => b.isActive)
      return { criteria: filtered, tableMissing: false }
    }

    const msg = error?.message ?? ''
    const missing = /does not exist|schema cache|42P01/i.test(msg)
    const fallback = readLocalCriteria()
    return {
      criteria: options.includeInactive ? fallback : fallback.filter((b) => b.isActive),
      tableMissing: missing,
    }
  } catch {
    const fallback = readLocalCriteria()
    return {
      criteria: options.includeInactive ? fallback : fallback.filter((b) => b.isActive),
      tableMissing: true,
    }
  }
}

export async function saveBadgeCriterion(
  input: BadgeCriterionInput,
  updatedBy?: string | null,
): Promise<{ ok: boolean; syncedRemote: boolean; badge?: BadgeCriterion; error?: string }> {
  const payload = {
    slug: input.slug?.trim() || slugifyBadgeName(input.name),
    name: input.name.trim(),
    description: input.description.trim(),
    icon: input.icon.trim() || '🏅',
    tier_order: Math.max(1, Math.round(input.tierOrder || 1)),
    match_mode: input.matchMode,
    min_course_duration_minutes: Math.max(0, Math.round(input.minCourseDurationMinutes || 0)),
    min_courses_completed: Math.max(0, Math.round(input.minCoursesCompleted || 0)),
    min_certificates_earned: Math.max(0, Math.round(input.minCertificatesEarned || 0)),
    is_active: input.isActive,
    updated_by: updatedBy ?? null,
    updated_at: new Date().toISOString(),
  }

  try {
    const query = input.id
      ? supabase.from('badge_criteria').update(payload).eq('id', input.id).select('*').single()
      : supabase.from('badge_criteria').insert(payload).select('*').single()

    const { data, error } = await query
    if (!error && data) {
      const model = rowToModel(data as BadgeCriterionRow)
      const existing = readLocalCriteria()
      const idx = existing.findIndex((b) => b.id === model.id)
      const next = idx >= 0 ? existing.map((b, i) => (i === idx ? model : b)) : [...existing, model]
      writeLocalCriteria(next)
      return { ok: true, syncedRemote: true, badge: model }
    }

    const msg = error?.message ?? 'Failed to save badge rule.'
    const missing = /does not exist|schema cache|42P01/i.test(msg)
    if (!missing) {
      return { ok: false, syncedRemote: false, error: msg }
    }

    // Fallback to localStorage when migration SQL hasn't been executed yet
    const existing = readLocalCriteria()
    const nextId = input.id ?? Math.max(0, ...existing.map((b) => b.id)) + 1
    const localModel: BadgeCriterion = {
      id: nextId,
      slug: payload.slug,
      name: payload.name,
      description: payload.description,
      icon: payload.icon,
      tierOrder: payload.tier_order,
      matchMode: payload.match_mode,
      minCourseDurationMinutes: payload.min_course_duration_minutes,
      minCoursesCompleted: payload.min_courses_completed,
      minCertificatesEarned: payload.min_certificates_earned,
      isActive: payload.is_active,
    }
    const idx = existing.findIndex((b) => b.id === localModel.id)
    const next = idx >= 0 ? existing.map((b, i) => (i === idx ? localModel : b)) : [...existing, localModel]
    writeLocalCriteria(next)
    return {
      ok: true,
      syncedRemote: false,
      badge: localModel,
      error: 'Saved locally (run supabase/migrations/20261116_milestone_badge_criteria.sql to sync across all users).',
    }
  } catch (err) {
    return {
      ok: false,
      syncedRemote: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function deleteBadgeCriterion(
  id: number,
): Promise<{ ok: boolean; syncedRemote: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('badge_criteria').delete().eq('id', id)
    if (!error) {
      writeLocalCriteria(readLocalCriteria().filter((b) => b.id !== id))
      return { ok: true, syncedRemote: true }
    }

    const missing = /does not exist|schema cache|42P01/i.test(error.message)
    if (!missing) {
      return { ok: false, syncedRemote: false, error: error.message }
    }

    writeLocalCriteria(readLocalCriteria().filter((b) => b.id !== id))
    return { ok: true, syncedRemote: false }
  } catch (err) {
    return { ok: false, syncedRemote: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Computes real-time course completion duration, courses completed, and certificates earned
 * for a single learner from their published courses, video completions, and passed quiz attempts.
 */
export function computeLearnerBadgeMetrics(params: {
  courses: CourseVM[]
  completions: VideoCompletion[]
  passedAttempts: QuizAttempt[]
  extraCertificatesCount?: number
}): LearnerBadgeMetrics {
  const { courses, completions, passedAttempts, extraCertificatesCount = 0 } = params

  let coursesCompleted = 0
  let completedCourseDurationMinutes = 0

  for (const course of courses) {
    if (course.lessons.length === 0) continue
    const progress = courseProgress(course, completions)
    if (progress.status === 'completed') {
      coursesCompleted += 1
      if (progress.minutes > 0) {
        completedCourseDurationMinutes += progress.minutes
      } else {
        const fallbackSeconds = course.lessons.reduce(
          (sum, lesson) => sum + (hasAnyVideo(lesson) || lesson.duration_seconds > 0 ? lesson.duration_seconds : 300),
          0,
        )
        completedCourseDurationMinutes += Math.round(fallbackSeconds / 60)
      }
    }
  }

  const watchedSeconds = completions.reduce((sum, c) => sum + Math.max(0, c.watched_seconds || 0), 0)
  const watchedMinutes = Math.round(watchedSeconds / 60)

  const courseCertificatesEarned = coursesCompleted
  const passedMilestones = new Set(passedAttempts.filter((a) => a.passed).map((a) => a.milestone))
  const milestoneCertificatesEarned = passedMilestones.size
  const issuedCertificatesEarned = Math.max(0, Math.round(extraCertificatesCount))
  const certificatesEarned =
    courseCertificatesEarned + milestoneCertificatesEarned + issuedCertificatesEarned

  return {
    completedCourseDurationMinutes,
    watchedMinutes,
    coursesCompleted,
    courseCertificatesEarned,
    milestoneCertificatesEarned,
    issuedCertificatesEarned,
    certificatesEarned,
  }
}

/**
 * Evaluates a learner's eligibility for a single badge criterion.
 */
export function evaluateBadgeEligibility(
  badge: BadgeCriterion,
  metrics: LearnerBadgeMetrics,
): BadgeEvaluation {
  const checks: CriterionCheckResult[] = []

  if (badge.minCourseDurationMinutes > 0) {
    const current = metrics.completedCourseDurationMinutes
    const target = badge.minCourseDurationMinutes
    const pct = Math.min(100, Math.round((current / target) * 100))
    checks.push({
      key: 'duration',
      label: 'Course completion duration',
      current,
      target,
      currentFormatted: formatDurationMinutes(current),
      targetFormatted: formatDurationMinutes(target),
      pct,
      met: current >= target,
    })
  }

  if (badge.minCoursesCompleted > 0) {
    const current = metrics.coursesCompleted
    const target = badge.minCoursesCompleted
    const pct = Math.min(100, Math.round((current / target) * 100))
    checks.push({
      key: 'courses',
      label: 'Courses completed',
      current,
      target,
      currentFormatted: `${current}`,
      targetFormatted: `${target}`,
      pct,
      met: current >= target,
    })
  }

  if (badge.minCertificatesEarned > 0) {
    const current = metrics.certificatesEarned
    const target = badge.minCertificatesEarned
    const pct = Math.min(100, Math.round((current / target) * 100))
    checks.push({
      key: 'certificates',
      label: 'Certificates earned',
      current,
      target,
      currentFormatted: `${current}`,
      targetFormatted: `${target}`,
      pct,
      met: current >= target,
    })
  }

  const totalChecks = checks.length
  const metCount = checks.filter((c) => c.met).length
  const eligible =
    badge.isActive &&
    totalChecks > 0 &&
    (badge.matchMode === 'all' ? metCount === totalChecks : metCount > 0)

  const overallPct =
    totalChecks === 0
      ? 0
      : badge.matchMode === 'all'
        ? Math.round(checks.reduce((s, c) => s + c.pct, 0) / totalChecks)
        : Math.max(...checks.map((c) => c.pct))

  let summaryHint = 'All eligibility criteria met'
  if (!eligible && checks.length > 0) {
    const remaining = checks
      .filter((c) => !c.met)
      .map((c) => {
        const diff = c.target - c.current
        if (c.key === 'duration') return `${formatDurationMinutes(diff)} more coursework`
        if (c.key === 'courses') return `${diff} more ${diff === 1 ? 'course' : 'courses'}`
        return `${diff} more ${diff === 1 ? 'certificate' : 'certificates'}`
      })
    summaryHint =
      badge.matchMode === 'any'
        ? `Meet any one: ${remaining.join(' or ')}`
        : `Remaining: ${remaining.join(' · ')}`
  }

  return {
    badge,
    eligible,
    overallPct,
    metCount,
    totalChecks,
    checks,
    summaryHint,
  }
}

export function evaluateAllBadges(
  criteria: BadgeCriterion[],
  metrics: LearnerBadgeMetrics,
): BadgeEvaluation[] {
  return [...criteria]
    .sort((a, b) => a.tierOrder - b.tierOrder || a.id - b.id)
    .map((badge) => evaluateBadgeEligibility(badge, metrics))
}

// ============================================================================
// Admin-Created Custom Badges & Direct Employee Badge Awards
// ============================================================================

export interface CustomBadge {
  id: number
  slug: string
  name: string
  description: string
  icon: string
  category: string
  isActive: boolean
  createdBy: string | null
  createdAt: string
}

export interface CustomBadgeInput {
  id?: number
  slug?: string
  name: string
  description: string
  icon: string
  category: string
  isActive: boolean
}

export interface EmployeeBadgeAward {
  id: number
  badgeId: number
  userId: string
  reason: string
  awardedBy: string | null
  awardedAt: string
}

const LOCAL_CUSTOM_BADGES_KEY = 'captain_custom_badges_v1'
const LOCAL_BADGE_AWARDS_KEY = 'captain_employee_badge_awards_v1'

function customBadgeRowToModel(row: CustomBadgeRow): CustomBadge {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon || '🏅',
    category: row.category || 'Recognition',
    isActive: row.is_active !== false,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
  }
}

function awardRowToModel(row: EmployeeBadgeAwardRow): EmployeeBadgeAward {
  return {
    id: row.id,
    badgeId: row.badge_id,
    userId: row.user_id,
    reason: row.reason ?? '',
    awardedBy: row.awarded_by ?? null,
    awardedAt: row.awarded_at,
  }
}

function readLocalCustomBadges(): CustomBadge[] {
  try {
    const raw = localStorage.getItem(LOCAL_CUSTOM_BADGES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as CustomBadge[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLocalCustomBadges(list: CustomBadge[]): void {
  try {
    localStorage.setItem(LOCAL_CUSTOM_BADGES_KEY, JSON.stringify(list))
  } catch {
    // ignore storage errors
  }
}

function readLocalBadgeAwards(): EmployeeBadgeAward[] {
  try {
    const raw = localStorage.getItem(LOCAL_BADGE_AWARDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as EmployeeBadgeAward[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLocalBadgeAwards(list: EmployeeBadgeAward[]): void {
  try {
    localStorage.setItem(LOCAL_BADGE_AWARDS_KEY, JSON.stringify(list))
  } catch {
    // ignore storage errors
  }
}

export async function loadCustomBadges(options: { includeInactive?: boolean } = {}): Promise<{
  badges: CustomBadge[]
  tableMissing: boolean
}> {
  try {
    const { data, error } = await supabase
      .from('custom_badges')
      .select('*')
      .order('id', { ascending: false })

    if (!error && data) {
      const mapped = (data as CustomBadgeRow[]).map(customBadgeRowToModel)
      writeLocalCustomBadges(mapped)
      return {
        badges: options.includeInactive ? mapped : mapped.filter((b) => b.isActive),
        tableMissing: false,
      }
    }

    const msg = error?.message ?? ''
    const missing = /does not exist|schema cache|42P01/i.test(msg)
    const fallback = readLocalCustomBadges()
    return {
      badges: options.includeInactive ? fallback : fallback.filter((b) => b.isActive),
      tableMissing: missing,
    }
  } catch {
    const fallback = readLocalCustomBadges()
    return {
      badges: options.includeInactive ? fallback : fallback.filter((b) => b.isActive),
      tableMissing: true,
    }
  }
}

export async function saveCustomBadge(
  input: CustomBadgeInput,
  createdBy?: string | null,
): Promise<{ ok: boolean; syncedRemote: boolean; badge?: CustomBadge; error?: string }> {
  const payload = {
    slug: input.slug?.trim() || slugifyBadgeName(input.name),
    name: input.name.trim(),
    description: input.description.trim(),
    icon: input.icon.trim() || '🏅',
    category: input.category.trim() || 'Recognition',
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  }

  try {
    const query = input.id
      ? supabase.from('custom_badges').update(payload).eq('id', input.id).select('*').single()
      : supabase
          .from('custom_badges')
          .insert({ ...payload, created_by: createdBy ?? null })
          .select('*')
          .single()

    const { data, error } = await query
    if (!error && data) {
      const model = customBadgeRowToModel(data as CustomBadgeRow)
      const existing = readLocalCustomBadges()
      const idx = existing.findIndex((b) => b.id === model.id)
      const next = idx >= 0 ? existing.map((b, i) => (i === idx ? model : b)) : [model, ...existing]
      writeLocalCustomBadges(next)
      return { ok: true, syncedRemote: true, badge: model }
    }

    const msg = error?.message ?? 'Could not save custom badge.'
    const missing = /does not exist|schema cache|42P01/i.test(msg)
    if (!missing) {
      return { ok: false, syncedRemote: false, error: msg }
    }

    const existing = readLocalCustomBadges()
    const nextId = input.id ?? Math.max(0, ...existing.map((b) => b.id)) + 1
    const localModel: CustomBadge = {
      id: nextId,
      slug: payload.slug,
      name: payload.name,
      description: payload.description,
      icon: payload.icon,
      category: payload.category,
      isActive: payload.is_active,
      createdBy: createdBy ?? null,
      createdAt: new Date().toISOString(),
    }
    const idx = existing.findIndex((b) => b.id === localModel.id)
    const next = idx >= 0 ? existing.map((b, i) => (i === idx ? localModel : b)) : [localModel, ...existing]
    writeLocalCustomBadges(next)
    return {
      ok: true,
      syncedRemote: false,
      badge: localModel,
      error:
        'Saved in this browser (run supabase/migrations/20261116_admin_certificates_badges_assignments.sql in Supabase to sync across devices).',
    }
  } catch (err) {
    return {
      ok: false,
      syncedRemote: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function deleteCustomBadge(
  id: number,
): Promise<{ ok: boolean; syncedRemote: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('custom_badges').delete().eq('id', id)
    if (!error) {
      writeLocalCustomBadges(readLocalCustomBadges().filter((b) => b.id !== id))
      writeLocalBadgeAwards(readLocalBadgeAwards().filter((a) => a.badgeId !== id))
      return { ok: true, syncedRemote: true }
    }

    const missing = /does not exist|schema cache|42P01/i.test(error.message)
    if (!missing) {
      return { ok: false, syncedRemote: false, error: error.message }
    }

    writeLocalCustomBadges(readLocalCustomBadges().filter((b) => b.id !== id))
    writeLocalBadgeAwards(readLocalBadgeAwards().filter((a) => a.badgeId !== id))
    return { ok: true, syncedRemote: false }
  } catch (err) {
    return { ok: false, syncedRemote: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function loadEmployeeBadgeAwards(options: { userId?: string } = {}): Promise<{
  awards: EmployeeBadgeAward[]
  tableMissing: boolean
}> {
  try {
    let query = supabase
      .from('employee_badge_awards')
      .select('*')
      .order('awarded_at', { ascending: false })

    if (options.userId) {
      query = query.eq('user_id', options.userId)
    }

    const { data, error } = await query
    if (!error && data) {
      const mapped = (data as EmployeeBadgeAwardRow[]).map(awardRowToModel)
      if (!options.userId) {
        writeLocalBadgeAwards(mapped)
      }
      return { awards: mapped, tableMissing: false }
    }

    const msg = error?.message ?? ''
    const missing = /does not exist|schema cache|42P01/i.test(msg)
    const fallback = readLocalBadgeAwards()
    return {
      awards: options.userId ? fallback.filter((a) => a.userId === options.userId) : fallback,
      tableMissing: missing,
    }
  } catch {
    const fallback = readLocalBadgeAwards()
    return {
      awards: options.userId ? fallback.filter((a) => a.userId === options.userId) : fallback,
      tableMissing: true,
    }
  }
}

export async function awardCustomBadgeToEmployees(params: {
  badgeId: number
  badgeName: string
  userIds: string[]
  reason?: string
  awardedBy?: string | null
}): Promise<{ ok: boolean; syncedRemote: boolean; awardedCount: number; error?: string }> {
  const uniqueIds = [...new Set(params.userIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return { ok: false, syncedRemote: false, awardedCount: 0, error: 'Select at least one employee.' }
  }

  const nowIso = new Date().toISOString()
  const cleanReason = params.reason?.trim() ?? ''
  const rows = uniqueIds.map((uid) => ({
    badge_id: params.badgeId,
    user_id: uid,
    reason: cleanReason,
    awarded_by: params.awardedBy ?? null,
    awarded_at: nowIso,
  }))

  try {
    const { data, error } = await supabase
      .from('employee_badge_awards')
      .upsert(rows, { onConflict: 'badge_id,user_id' })
      .select('*')

    if (!error && data) {
      const mapped = (data as EmployeeBadgeAwardRow[]).map(awardRowToModel)
      const existing = readLocalBadgeAwards().filter(
        (a) => !(a.badgeId === params.badgeId && uniqueIds.includes(a.userId)),
      )
      writeLocalBadgeAwards([...mapped, ...existing])

      await supabase.from('notifications').insert(
        uniqueIds.map((uid) => ({
          user_id: uid,
          text: `You were awarded the "${params.badgeName}" badge!`,
          action: { type: 'goto' as const, view: '/app/badges' },
        })),
      )

      return { ok: true, syncedRemote: true, awardedCount: mapped.length }
    }

    const msg = error?.message ?? 'Could not award badge.'
    const missing = /does not exist|schema cache|42P01/i.test(msg)
    if (!missing) {
      return { ok: false, syncedRemote: false, awardedCount: 0, error: msg }
    }

    const existing = readLocalBadgeAwards().filter(
      (a) => !(a.badgeId === params.badgeId && uniqueIds.includes(a.userId)),
    )
    let nextId = Math.max(0, ...existing.map((a) => a.id)) + 1
    const localAwards: EmployeeBadgeAward[] = rows.map((r) => ({
      id: nextId++,
      badgeId: r.badge_id,
      userId: r.user_id,
      reason: r.reason,
      awardedBy: r.awarded_by,
      awardedAt: r.awarded_at,
    }))
    writeLocalBadgeAwards([...localAwards, ...existing])
    return {
      ok: true,
      syncedRemote: false,
      awardedCount: localAwards.length,
      error:
        'Saved in this browser (run supabase/migrations/20261116_admin_certificates_badges_assignments.sql in Supabase to sync across devices).',
    }
  } catch (err) {
    return {
      ok: false,
      syncedRemote: false,
      awardedCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function revokeEmployeeBadgeAward(
  awardId: number,
): Promise<{ ok: boolean; syncedRemote: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('employee_badge_awards').delete().eq('id', awardId)
    if (!error) {
      writeLocalBadgeAwards(readLocalBadgeAwards().filter((a) => a.id !== awardId))
      return { ok: true, syncedRemote: true }
    }

    const missing = /does not exist|schema cache|42P01/i.test(error.message)
    if (!missing) {
      return { ok: false, syncedRemote: false, error: error.message }
    }

    writeLocalBadgeAwards(readLocalBadgeAwards().filter((a) => a.id !== awardId))
    return { ok: true, syncedRemote: false }
  } catch (err) {
    return { ok: false, syncedRemote: false, error: err instanceof Error ? err.message : String(err) }
  }
}
