import { supabase } from '@/lib/supabase'
import { loadBadgeCriteria, loadCustomBadges, loadEmployeeBadgeAwards } from '@/lib/badges'
import { loadIssuedCertificates } from '@/lib/issuedCertificates'
import { loadDepartments } from '@/lib/departments'
import {
  computeOrganizationLeaderboard,
  sortLeaderboardEntries,
  type EarnedBadgePreview,
  type LeaderboardEntry,
  type LeaderboardPeriod,
  type LeaderboardSortKey,
  type LeaderboardSummary,
  type OrganizationLeaderboardPayload,
  type LeaderboardInputActivityLog,
  type LeaderboardInputAttempt,
  type LeaderboardInputCompletion,
  type LeaderboardInputCourse,
  type LeaderboardInputEnrolment,
  type LeaderboardInputModule,
  type LeaderboardInputProfile,
} from './leaderboardScoring'

export {
  sortLeaderboardEntries,
  type EarnedBadgePreview,
  type LeaderboardEntry,
  type LeaderboardPeriod,
  type LeaderboardSortKey,
  type LeaderboardSummary,
  type OrganizationLeaderboardPayload,
}

export async function fetchOrganizationLeaderboard(): Promise<OrganizationLeaderboardPayload> {
  const { data: sessionData } = await supabase.auth.getSession()
  const accessToken = sessionData.session?.access_token

  if (accessToken) {
    try {
      const res = await fetch('/api/organization-leaderboard', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
      if (res.ok) {
        const json = (await res.json()) as OrganizationLeaderboardPayload
        if (json && Array.isArray(json.entries)) {
          return json
        }
      }
    } catch {
      // Fall back to direct Supabase queries below
    }
  }

  const cutoff30dIso = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const [
    profilesRes,
    modulesRes,
    coursesRes,
    enrolmentsRes,
    completionsRes,
    attemptsRes,
    activityLogsRes,
    criteriaRes,
    customBadgesRes,
    awardsRes,
    issuedCertsRes,
    depts,
  ] = await Promise.all([
    supabase.from('profiles').select('id, full_name, department, role, is_active, last_activity_at'),
    supabase.from('modules').select('id, course_id, department, duration_seconds, is_draft, is_archived'),
    supabase.from('courses').select('id, title, category, is_published'),
    supabase.from('course_enrolments').select('user_id, course_id'),
    supabase.from('video_completions').select('user_id, module_id, completed, completed_at, last_watched_at, watched_seconds'),
    supabase.from('quiz_attempts').select('user_id, milestone, passed, created_at'),
    supabase.from('learning_activity_logs').select('user_id, event_type, created_at').gte('created_at', cutoff30dIso),
    loadBadgeCriteria({ includeInactive: false }),
    loadCustomBadges({ includeInactive: false }),
    loadEmployeeBadgeAwards(),
    loadIssuedCertificates(),
    loadDepartments(),
  ])

  return computeOrganizationLeaderboard(
    {
      profiles: (profilesRes.data ?? []) as LeaderboardInputProfile[],
      modules: (modulesRes.data ?? []) as LeaderboardInputModule[],
      courses: (!coursesRes.error && coursesRes.data ? coursesRes.data : []) as LeaderboardInputCourse[],
      enrolments: (!enrolmentsRes.error && enrolmentsRes.data ? enrolmentsRes.data : []) as LeaderboardInputEnrolment[],
      completions: (!completionsRes.error && completionsRes.data ? completionsRes.data : []) as LeaderboardInputCompletion[],
      attempts: (!attemptsRes.error && attemptsRes.data ? attemptsRes.data : []) as LeaderboardInputAttempt[],
      activityLogs: (!activityLogsRes.error && activityLogsRes.data ? activityLogsRes.data : []) as LeaderboardInputActivityLog[],
      badgeCriteria: criteriaRes.criteria.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        icon: c.icon,
        tier_order: c.tierOrder,
        match_mode: c.matchMode,
        min_course_duration_minutes: c.minCourseDurationMinutes,
        min_courses_completed: c.minCoursesCompleted,
        min_certificates_earned: c.minCertificatesEarned,
        is_active: c.isActive,
      })),
      customBadges: customBadgesRes.badges.map((b) => ({
        id: b.id,
        name: b.name,
        icon: b.icon,
        is_active: b.isActive,
      })),
      badgeAwards: awardsRes.awards.map((a) => ({
        badge_id: a.badgeId,
        user_id: a.userId,
        awarded_at: a.awardedAt,
      })),
      issuedCertificates: issuedCertsRes.certificates.map((ic) => ({
        id: ic.id,
        user_id: ic.userId,
        issued_date: ic.issuedDate,
        created_at: ic.createdAt,
      })),
      departments: ['General', ...depts.map((d) => d.name)],
    },
    'client',
  )
}

export function formatRelativeActivity(iso: string | null): string {
  if (!iso) return 'No activity yet'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'No activity yet'
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSec < 60) return 'Just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
