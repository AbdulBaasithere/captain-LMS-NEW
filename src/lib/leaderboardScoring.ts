export type LeaderboardPeriod = 'all' | '30d' | '7d'
export type LeaderboardSortKey = 'overall' | 'badges' | 'completion' | 'activity'

export interface EarnedBadgePreview {
  icon: string
  name: string
  source: 'criteria' | 'quiz' | 'custom'
}

export interface LeaderboardEntry {
  id: string
  fullName: string
  department: string
  criteriaBadgesCount: number
  milestoneQuizBadgesCount: number
  customBadgesCount: number
  totalBadges: number
  badgePreviews: EarnedBadgePreview[]
  coursesCompleted: number
  coursesTotal: number
  courseCompletionPct: number
  lessonsCompleted: number
  lessonsTotal: number
  lessonCompletionPct: number
  completedCourseMinutes: number
  certificatesEarned: number
  activityCountAll: number
  activityCount30d: number
  activityCount7d: number
  activeDays14d: number
  lastActiveAt: string | null
  overallScore: number
}

export interface LeaderboardSummary {
  totalEmployees: number
  totalBadgesAwarded: number
  avgCourseCompletionPct: number
  activeLast7DaysCount: number
  activeLast7DaysPct: number
  totalCoursesCompleted: number
}

export interface OrganizationLeaderboardPayload {
  entries: LeaderboardEntry[]
  departments: string[]
  summary: LeaderboardSummary
  generatedAt: string
  source: 'server' | 'client'
}

export interface LeaderboardInputProfile {
  id: string
  full_name: string
  department: string
  role: string
  is_active?: boolean
  last_activity_at?: string | null
}

export interface LeaderboardInputModule {
  id: number
  course_id?: number | null
  department: string
  duration_seconds: number
  is_draft?: boolean
  is_archived?: boolean
}

export interface LeaderboardInputCourse {
  id: number
  title: string
  category: string
  is_published: boolean
}

export interface LeaderboardInputEnrolment {
  user_id: string
  course_id: number
}

export interface LeaderboardInputCompletion {
  user_id: string
  module_id: number
  completed: boolean
  completed_at?: string | null
  last_watched_at?: string | null
  watched_seconds?: number | null
}

export interface LeaderboardInputAttempt {
  user_id: string
  milestone: string
  passed: boolean
  created_at: string
}

export interface LeaderboardInputActivityLog {
  user_id: string
  event_type?: string
  created_at: string
}

export interface LeaderboardInputCriterion {
  id: number
  slug: string
  name: string
  icon: string
  tier_order: number
  match_mode: string
  min_course_duration_minutes: number
  min_courses_completed: number
  min_certificates_earned: number
  is_active: boolean
}

export interface LeaderboardInputCustomBadge {
  id: number
  name: string
  icon: string
  is_active: boolean
}

export interface LeaderboardInputBadgeAward {
  badge_id: number
  user_id: string
  awarded_at: string
}

export interface LeaderboardInputIssuedCertificate {
  id: number
  user_id: string
  issued_date: string
  created_at?: string
}

export interface ComputeLeaderboardInput {
  profiles: LeaderboardInputProfile[]
  modules: LeaderboardInputModule[]
  courses: LeaderboardInputCourse[]
  enrolments: LeaderboardInputEnrolment[]
  completions: LeaderboardInputCompletion[]
  attempts: LeaderboardInputAttempt[]
  activityLogs: LeaderboardInputActivityLog[]
  badgeCriteria: LeaderboardInputCriterion[]
  customBadges: LeaderboardInputCustomBadge[]
  badgeAwards: LeaderboardInputBadgeAward[]
  issuedCertificates: LeaderboardInputIssuedCertificate[]
  departments?: string[]
  nowMs?: number
}

const MILESTONE_QUIZ_META: Record<string, { icon: string; name: string }> = {
  '1': { icon: '🥉', name: 'Bronze Milestone' },
  '2': { icon: '🥈', name: 'Silver Milestone' },
  '3': { icon: '🥇', name: 'Gold Milestone' },
  '4': { icon: '💎', name: 'Diamond Milestone' },
  '5': { icon: '💎', name: 'Diamond II Milestone' },
  final: { icon: '🏆', name: 'Captain Master' },
}

export const DEFAULT_LEADERBOARD_CRITERIA: LeaderboardInputCriterion[] = [
  {
    id: 1,
    slug: 'first-milestone',
    name: 'Pathfinder',
    icon: '🌱',
    tier_order: 1,
    match_mode: 'all',
    min_course_duration_minutes: 15,
    min_courses_completed: 1,
    min_certificates_earned: 1,
    is_active: true,
  },
  {
    id: 2,
    slug: 'bronze-scholar',
    name: 'Bronze Scholar',
    icon: '🥉',
    tier_order: 2,
    match_mode: 'all',
    min_course_duration_minutes: 60,
    min_courses_completed: 2,
    min_certificates_earned: 2,
    is_active: true,
  },
  {
    id: 3,
    slug: 'silver-achiever',
    name: 'Silver Achiever',
    icon: '🥈',
    tier_order: 3,
    match_mode: 'all',
    min_course_duration_minutes: 180,
    min_courses_completed: 3,
    min_certificates_earned: 4,
    is_active: true,
  },
  {
    id: 4,
    slug: 'gold-specialist',
    name: 'Gold Specialist',
    icon: '🥇',
    tier_order: 4,
    match_mode: 'all',
    min_course_duration_minutes: 300,
    min_courses_completed: 5,
    min_certificates_earned: 6,
    is_active: true,
  },
  {
    id: 5,
    slug: 'captain-distinction',
    name: 'Captain Distinction',
    icon: '🏆',
    tier_order: 5,
    match_mode: 'all',
    min_course_duration_minutes: 600,
    min_courses_completed: 8,
    min_certificates_earned: 10,
    is_active: true,
  },
]

function parseTimeMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function toIsoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function computeOverallScore(params: {
  totalBadges: number
  coursesCompleted: number
  courseCompletionPct: number
  activityCount30d: number
  activeDays14d: number
}): number {
  const badgePts = params.totalBadges * 120
  const coursePts = params.coursesCompleted * 100 + Math.min(100, Math.max(0, params.courseCompletionPct))
  const activityPts = Math.min(params.activityCount30d, 40) * 10 + Math.min(params.activeDays14d, 14) * 15
  return Math.round(badgePts + coursePts + activityPts)
}

export function sortLeaderboardEntries(
  entries: LeaderboardEntry[],
  sortBy: LeaderboardSortKey,
  period: LeaderboardPeriod,
): LeaderboardEntry[] {
  const activityForPeriod = (e: LeaderboardEntry) =>
    period === '7d' ? e.activityCount7d : period === '30d' ? e.activityCount30d : e.activityCountAll

  return [...entries].sort((a, b) => {
    if (sortBy === 'badges') {
      return (
        b.totalBadges - a.totalBadges ||
        b.overallScore - a.overallScore ||
        b.coursesCompleted - a.coursesCompleted ||
        a.fullName.localeCompare(b.fullName)
      )
    }
    if (sortBy === 'completion') {
      return (
        b.courseCompletionPct - a.courseCompletionPct ||
        b.coursesCompleted - a.coursesCompleted ||
        b.lessonCompletionPct - a.lessonCompletionPct ||
        b.overallScore - a.overallScore ||
        a.fullName.localeCompare(b.fullName)
      )
    }
    if (sortBy === 'activity') {
      const diffAct = activityForPeriod(b) - activityForPeriod(a)
      if (diffAct !== 0) return diffAct
      const bTime = parseTimeMs(b.lastActiveAt) ?? 0
      const aTime = parseTimeMs(a.lastActiveAt) ?? 0
      if (bTime !== aTime) return bTime - aTime
      return b.overallScore - a.overallScore || a.fullName.localeCompare(b.fullName)
    }

    // Default: 'overall'
    if (period === 'all') {
      return (
        b.overallScore - a.overallScore ||
        b.totalBadges - a.totalBadges ||
        b.coursesCompleted - a.coursesCompleted ||
        b.activityCount30d - a.activityCount30d ||
        a.fullName.localeCompare(b.fullName)
      )
    }

    // When a recent window ('7d' or '30d') is active on Overall, blend earned progress with period activity momentum
    const scoreWithWindow = (e: LeaderboardEntry) => {
      const windowEvents = activityForPeriod(e)
      const base = e.totalBadges * 120 + e.coursesCompleted * 100 + e.courseCompletionPct
      const windowMomentum = Math.min(windowEvents, 40) * (period === '7d' ? 18 : 10) + e.activeDays14d * 15
      return base + windowMomentum
    }

    return (
      scoreWithWindow(b) - scoreWithWindow(a) ||
      activityForPeriod(b) - activityForPeriod(a) ||
      b.totalBadges - a.totalBadges ||
      a.fullName.localeCompare(b.fullName)
    )
  })
}

export function computeOrganizationLeaderboard(
  input: ComputeLeaderboardInput,
  source: 'server' | 'client' = 'server',
): OrganizationLeaderboardPayload {
  const nowMs = input.nowMs ?? Date.now()
  const cutoff7d = nowMs - 7 * 86_400_000
  const cutoff14d = nowMs - 14 * 86_400_000
  const cutoff30d = nowMs - 30 * 86_400_000

  const activeEmployees = input.profiles.filter(
    (p) => p.role === 'employee' && p.is_active !== false,
  )

  const publishedModules = input.modules.filter((m) => !m.is_draft && !m.is_archived)
  const publishedCourses = input.courses.filter((c) => c.is_published)

  const lessonsByCourseId = new Map<number, LeaderboardInputModule[]>()
  const unassignedModules: LeaderboardInputModule[] = []
  for (const mod of publishedModules) {
    if (typeof mod.course_id === 'number' && mod.course_id > 0) {
      const arr = lessonsByCourseId.get(mod.course_id)
      if (arr) arr.push(mod)
      else lessonsByCourseId.set(mod.course_id, [mod])
    } else {
      unassignedModules.push(mod)
    }
  }

  // Fallback virtual course buckets if courses table hasn't been populated yet
  const useVirtualCourses = publishedCourses.length === 0 && publishedModules.length > 0
  const virtualGroups = new Map<string, LeaderboardInputModule[]>()
  if (useVirtualCourses) {
    for (const m of publishedModules) {
      const dept = m.department || 'General'
      const arr = virtualGroups.get(dept)
      if (arr) arr.push(m)
      else virtualGroups.set(dept, [m])
    }
  }

  const enrolledCourseIdsByUser = new Map<string, Set<number>>()
  for (const enr of input.enrolments) {
    const set = enrolledCourseIdsByUser.get(enr.user_id)
    if (set) set.add(enr.course_id)
    else enrolledCourseIdsByUser.set(enr.user_id, new Set([enr.course_id]))
  }

  const completionsByUser = new Map<string, LeaderboardInputCompletion[]>()
  for (const comp of input.completions) {
    const arr = completionsByUser.get(comp.user_id)
    if (arr) arr.push(comp)
    else completionsByUser.set(comp.user_id, [comp])
  }

  const attemptsByUser = new Map<string, LeaderboardInputAttempt[]>()
  for (const att of input.attempts) {
    const arr = attemptsByUser.get(att.user_id)
    if (arr) arr.push(att)
    else attemptsByUser.set(att.user_id, [att])
  }

  const logsByUser = new Map<string, LeaderboardInputActivityLog[]>()
  for (const log of input.activityLogs) {
    const arr = logsByUser.get(log.user_id)
    if (arr) arr.push(log)
    else logsByUser.set(log.user_id, [log])
  }

  const activeCriteria = [...input.badgeCriteria]
    .filter(
      (c) =>
        c.is_active !== false &&
        (c.min_course_duration_minutes > 0 ||
          c.min_courses_completed > 0 ||
          c.min_certificates_earned > 0),
    )
    .sort((a, b) => a.tier_order - b.tier_order || a.id - b.id)

  const customBadgeMap = new Map<number, LeaderboardInputCustomBadge>()
  for (const cb of input.customBadges) {
    if (cb.is_active !== false) customBadgeMap.set(cb.id, cb)
  }

  const awardsByUser = new Map<string, LeaderboardInputBadgeAward[]>()
  for (const aw of input.badgeAwards) {
    if (!customBadgeMap.has(aw.badge_id)) continue
    const arr = awardsByUser.get(aw.user_id)
    if (arr) arr.push(aw)
    else awardsByUser.set(aw.user_id, [aw])
  }

  const issuedCertsByUser = new Map<string, LeaderboardInputIssuedCertificate[]>()
  for (const ic of input.issuedCertificates) {
    const arr = issuedCertsByUser.get(ic.user_id)
    if (arr) arr.push(ic)
    else issuedCertsByUser.set(ic.user_id, [ic])
  }

  const deptSet = new Set<string>(input.departments ?? [])

  const entries: LeaderboardEntry[] = activeEmployees.map((emp) => {
    const dept = emp.department || 'General'
    deptSet.add(dept)

    const userCompletions = completionsByUser.get(emp.id) ?? []
    const doneModuleIds = new Set<number>()
    for (const c of userCompletions) {
      if (c.completed) doneModuleIds.add(c.module_id)
    }

    const enrolledSet = enrolledCourseIdsByUser.get(emp.id) ?? new Set<number>()

    let coursesTotal = 0
    let coursesCompleted = 0
    let completedCourseMinutes = 0
    const visibleModuleIds = new Set<number>()

    if (useVirtualCourses) {
      for (const [vDept, vMods] of virtualGroups.entries()) {
        if (vDept !== 'General' && vDept !== dept) continue
        if (vMods.length === 0) continue
        coursesTotal += 1
        for (const m of vMods) visibleModuleIds.add(m.id)
        const allDone = vMods.every((m) => doneModuleIds.has(m.id))
        if (allDone) {
          coursesCompleted += 1
          const totalSec = vMods.reduce((sum, m) => sum + (m.duration_seconds > 0 ? m.duration_seconds : 300), 0)
          completedCourseMinutes += Math.round(totalSec / 60)
        }
      }
    } else {
      for (const course of publishedCourses) {
        const courseLessons = lessonsByCourseId.get(course.id) ?? []
        if (courseLessons.length === 0) continue
        const isExplicitlyEnrolled = enrolledSet.has(course.id)
        const relevantLessons = isExplicitlyEnrolled
          ? courseLessons
          : courseLessons.filter((l) => l.department === 'General' || l.department === dept)

        if (relevantLessons.length === 0) continue

        coursesTotal += 1
        for (const l of relevantLessons) visibleModuleIds.add(l.id)

        if (relevantLessons.every((l) => doneModuleIds.has(l.id))) {
          coursesCompleted += 1
          const totalSec = relevantLessons.reduce(
            (sum, l) => sum + (l.duration_seconds > 0 ? l.duration_seconds : 300),
            0,
          )
          completedCourseMinutes += Math.round(totalSec / 60)
        }
      }
      // Include unassigned published modules relevant to the employee in lesson tracking
      for (const um of unassignedModules) {
        if (um.department === 'General' || um.department === dept) {
          visibleModuleIds.add(um.id)
        }
      }
    }

    const lessonsTotal = visibleModuleIds.size
    let lessonsCompleted = 0
    for (const mid of visibleModuleIds) {
      if (doneModuleIds.has(mid)) lessonsCompleted += 1
    }

    const courseCompletionPct = coursesTotal > 0 ? Math.round((coursesCompleted / coursesTotal) * 100) : 0
    const lessonCompletionPct = lessonsTotal > 0 ? Math.round((lessonsCompleted / lessonsTotal) * 100) : 0

    // Passed milestone quizzes
    const userAttempts = attemptsByUser.get(emp.id) ?? []
    const passedMilestones = new Set<string>()
    for (const att of userAttempts) {
      if (att.passed) passedMilestones.add(att.milestone)
    }

    const userIssuedCerts = issuedCertsByUser.get(emp.id) ?? []
    const certificatesEarned = coursesCompleted + passedMilestones.size + userIssuedCerts.length

    // Evaluate criteria-based milestone badges
    const badgePreviews: EarnedBadgePreview[] = []
    let criteriaBadgesCount = 0

    for (const rule of activeCriteria) {
      const checks: boolean[] = []
      if (rule.min_course_duration_minutes > 0) {
        checks.push(completedCourseMinutes >= rule.min_course_duration_minutes)
      }
      if (rule.min_courses_completed > 0) {
        checks.push(coursesCompleted >= rule.min_courses_completed)
      }
      if (rule.min_certificates_earned > 0) {
        checks.push(certificatesEarned >= rule.min_certificates_earned)
      }
      const metCount = checks.filter(Boolean).length
      const unlocked =
        checks.length > 0 && (rule.match_mode === 'any' ? metCount > 0 : metCount === checks.length)
      if (unlocked) {
        criteriaBadgesCount += 1
        badgePreviews.push({ icon: rule.icon || '🏅', name: rule.name, source: 'criteria' })
      }
    }

    // Milestone quiz badges
    const orderedQuizKeys = ['1', '2', '3', '4', '5', 'final']
    let milestoneQuizBadgesCount = 0
    for (const key of orderedQuizKeys) {
      if (passedMilestones.has(key)) {
        milestoneQuizBadgesCount += 1
        const meta = MILESTONE_QUIZ_META[key] ?? { icon: '🎖️', name: `Milestone ${key}` }
        badgePreviews.push({ icon: meta.icon, name: meta.name, source: 'quiz' })
      }
    }
    for (const m of passedMilestones) {
      if (!orderedQuizKeys.includes(m)) {
        milestoneQuizBadgesCount += 1
        badgePreviews.push({ icon: '🎖️', name: `Milestone ${m}`, source: 'quiz' })
      }
    }

    // Direct admin-awarded custom badges
    const userAwards = awardsByUser.get(emp.id) ?? []
    const seenCustomIds = new Set<number>()
    let customBadgesCount = 0
    for (const aw of userAwards) {
      if (seenCustomIds.has(aw.badge_id)) continue
      const badge = customBadgeMap.get(aw.badge_id)
      if (!badge) continue
      seenCustomIds.add(aw.badge_id)
      customBadgesCount += 1
      badgePreviews.push({ icon: badge.icon || '🌟', name: badge.name, source: 'custom' })
    }

    const totalBadges = criteriaBadgesCount + milestoneQuizBadgesCount + customBadgesCount

    // Activity timestamps (deduplicated slightly per event source for clean activity metrics)
    const activityTimestamps: number[] = []
    let latestMs: number | null = parseTimeMs(emp.last_activity_at)

    const recordTs = (iso: string | null | undefined, countEvent = true) => {
      const ms = parseTimeMs(iso)
      if (ms === null) return
      if (latestMs === null || ms > latestMs) latestMs = ms
      if (countEvent) activityTimestamps.push(ms)
    }

    for (const comp of userCompletions) {
      if (comp.completed) {
        recordTs(comp.completed_at ?? comp.last_watched_at, true)
      } else if ((comp.watched_seconds ?? 0) > 0 && comp.last_watched_at) {
        recordTs(comp.last_watched_at, true)
      }
    }
    for (const att of userAttempts) {
      recordTs(att.created_at, true)
    }
    for (const aw of userAwards) {
      recordTs(aw.awarded_at, true)
    }
    for (const ic of userIssuedCerts) {
      recordTs(ic.created_at ?? `${ic.issued_date}T12:00:00Z`, true)
    }

    // Add non-duplicate extra log timestamps (e.g. lesson_view / course_completed logs)
    const userLogs = logsByUser.get(emp.id) ?? []
    for (const log of userLogs) {
      if (log.event_type === 'quiz_attempt') {
        recordTs(log.created_at, false)
      } else {
        recordTs(log.created_at, true)
      }
    }

    let activityCount7d = 0
    let activityCount30d = 0
    const activeDaySet14d = new Set<string>()
    for (const ts of activityTimestamps) {
      if (ts >= cutoff7d) activityCount7d += 1
      if (ts >= cutoff30d) activityCount30d += 1
      if (ts >= cutoff14d) activeDaySet14d.add(toIsoDay(ts))
    }

    const overallScore = computeOverallScore({
      totalBadges,
      coursesCompleted,
      courseCompletionPct,
      activityCount30d,
      activeDays14d: activeDaySet14d.size,
    })

    return {
      id: emp.id,
      fullName: emp.full_name,
      department: dept,
      criteriaBadgesCount,
      milestoneQuizBadgesCount,
      customBadgesCount,
      totalBadges,
      badgePreviews: badgePreviews.slice(0, 8),
      coursesCompleted,
      coursesTotal,
      courseCompletionPct,
      lessonsCompleted,
      lessonsTotal,
      lessonCompletionPct,
      completedCourseMinutes,
      certificatesEarned,
      activityCountAll: activityTimestamps.length,
      activityCount30d,
      activityCount7d,
      activeDays14d: activeDaySet14d.size,
      lastActiveAt: latestMs !== null ? new Date(latestMs).toISOString() : null,
      overallScore,
    }
  })

  const ranked = sortLeaderboardEntries(entries, 'overall', 'all')

  const totalEmployees = ranked.length
  const totalBadgesAwarded = ranked.reduce((s, e) => s + e.totalBadges, 0)
  const avgCourseCompletionPct = totalEmployees
    ? Math.round(ranked.reduce((s, e) => s + e.courseCompletionPct, 0) / totalEmployees)
    : 0
  const activeLast7DaysCount = ranked.filter((e) => {
    const ms = parseTimeMs(e.lastActiveAt)
    return (ms !== null && ms >= cutoff7d) || e.activityCount7d > 0
  }).length
  const activeLast7DaysPct = totalEmployees
    ? Math.round((activeLast7DaysCount / totalEmployees) * 100)
    : 0
  const totalCoursesCompleted = ranked.reduce((s, e) => s + e.coursesCompleted, 0)

  const departments = [
    'All',
    ...[...deptSet].filter((d) => d && d !== 'All').sort((a, b) => a.localeCompare(b)),
  ]

  return {
    entries: ranked,
    departments,
    summary: {
      totalEmployees,
      totalBadgesAwarded,
      avgCourseCompletionPct,
      activeLast7DaysCount,
      activeLast7DaysPct,
      totalCoursesCompleted,
    },
    generatedAt: new Date(nowMs).toISOString(),
    source,
  }
}
