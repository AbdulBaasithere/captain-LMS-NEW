import { supabase } from '@/lib/supabase'
import { isActive } from '@/lib/employees'
import type {
  Course,
  CourseEnrolment,
  EmailNotificationLog,
  LearningActivityLog,
  LearningEventType,
  Module,
  NotificationSettings,
  Profile,
  VideoCompletion,
} from '@/lib/database.types'

const MS_PER_DAY = 86_400_000

export interface RecordActivityInput {
  userId: string
  courseId: number | null | undefined
  moduleId?: number | null
  eventType: LearningEventType
  progressPct?: number | null
  metadata?: Record<string, unknown>
}

interface RecordActivityRpcResult {
  ok?: boolean
  enrolment_id?: number
  progress_pct?: number
  is_first_start?: boolean
  is_completed?: boolean
}

// Guard against duplicate in-flight course-start Edge Function invocations in the same session
const dispatchedStarts = new Set<string>()

/**
 * Records granular employee learning activity via secure RPC and triggers an immediate
 * course-start notification when an employee starts their first lesson in a course.
 * Fails silently if migration tables/RPCs are not yet deployed so core LMS playback never breaks.
 */
export async function recordLearningActivity(input: RecordActivityInput): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('record_learning_activity', {
      p_course_id: input.courseId ?? null,
      p_module_id: input.moduleId ?? null,
      p_event_type: input.eventType,
      p_progress_pct: input.progressPct ?? null,
      p_metadata: input.metadata ?? {},
    })

    if (error) return

    const res = (data ?? {}) as RecordActivityRpcResult
    if (res.is_first_start && input.courseId) {
      const cacheKey = `${input.userId}:${input.courseId}`
      if (!dispatchedStarts.has(cacheKey)) {
        dispatchedStarts.add(cacheKey)
        void triggerCourseStartNotification(input.userId, input.courseId)
      }
    }
  } catch {
    // Non-blocking telemetry
  }
}

export async function triggerCourseStartNotification(userId: string, courseId: number): Promise<void> {
  try {
    await supabase.functions.invoke('course-notification-monitor', {
      body: {
        action: 'course_started',
        user_id: userId,
        course_id: courseId,
        origin: typeof window !== 'undefined' ? window.location.origin : '',
      },
    })
  } catch {
    // Edge Function may not be deployed yet; daily cron monitor also catches unnotified starts
  }
}

export interface EnrichedEnrolment {
  id: number
  userId: string
  employeeName: string
  employeeEmail: string | null
  department: string
  courseId: number
  courseTitle: string
  courseCategory: string
  status: 'not_started' | 'in_progress' | 'completed' | 'overdue'
  progressPct: number
  deadlineDate: string | null
  startedAt: string | null
  lastActivityAt: string | null
  completedAt: string | null
  hrEmail: string | null
  managerEmail: string | null
  courseStartNotifiedAt: string | null
  lastInactivityNotifiedAt: string | null
  remindersStopped: boolean
  daysInactive: number | null
  daysToDeadline: number | null
  isVirtual: boolean
}

export interface EnrichedEmailLog extends EmailNotificationLog {
  employeeName: string
  department: string
  courseTitle: string
}

export interface MonitoringDashboardData {
  schemaReady: boolean
  settings: NotificationSettings
  profiles: Profile[]
  courses: Course[]
  enrolments: EnrichedEnrolment[]
  emailLogs: EnrichedEmailLog[]
  recentActivity: (LearningActivityLog & { employeeName: string; courseTitle: string; department: string })[]
}

export const DEFAULT_MONITORING_SETTINGS: NotificationSettings = {
  id: 1,
  enabled: true,
  inactivity_days: 7,
  reminder_days: [7, 3, 1],
  send_course_start: true,
  send_inactivity: true,
  send_deadline_reminders: true,
  send_overdue: true,
  sender_name: 'Captain LMS Notifications',
  sender_email: 'lms@captainandcompany.com',
  default_hr_email: null,
  email_provider: 'resend',
  lms_base_url: typeof window !== 'undefined' ? window.location.origin : '',
  updated_by: null,
  updated_at: new Date().toISOString(),
}

function diffDaysUtc(fromIsoDate: string, toIsoDate: string): number {
  const [fy, fm, fd] = fromIsoDate.slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = toIsoDate.slice(0, 10).split('-').map(Number)
  const fromUtc = Date.UTC(fy ?? 0, (fm ?? 1) - 1, fd ?? 1)
  const toUtc = Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1)
  return Math.round((toUtc - fromUtc) / MS_PER_DAY)
}

function computeDaysInactive(lastActivity: string | null, completedAt: string | null, now: Date): number | null {
  if (completedAt || !lastActivity) return null
  const diff = Math.floor((now.getTime() - new Date(lastActivity).getTime()) / MS_PER_DAY)
  return Math.max(0, diff)
}

function buildFallbackEnrolments(
  profiles: Profile[],
  courses: Course[],
  modules: Module[],
  completions: VideoCompletion[],
  now: Date,
): EnrichedEnrolment[] {
  const today = now.toISOString().slice(0, 10)
  const employees = profiles.filter((p) => p.role === 'employee' && isActive(p))
  const publishedCourses = courses.filter((c) => c.is_published)
  const compByKey = new Map(completions.map((c) => [`${c.user_id}:${c.module_id}`, c]))
  const mgrMap = new Map(profiles.map((p) => [p.id, p]))
  const rows: EnrichedEnrolment[] = []
  let syntheticId = -1

  for (const emp of employees) {
    for (const course of publishedCourses) {
      const lessons = modules.filter(
        (m) =>
          m.course_id === course.id &&
          !m.is_draft &&
          !m.is_archived &&
          (m.department === 'General' || m.department === emp.department),
      )
      if (!lessons.length) continue

      let doneCount = 0
      let hasStarted = false
      let lastActivity: string | null = null
      let lastCompleted: string | null = null

      for (const l of lessons) {
        const c = compByKey.get(`${emp.id}:${l.id}`)
        if (!c) continue
        if (c.completed) doneCount += 1
        if (c.completed || c.watched_seconds > 0) hasStarted = true
        const ts = c.last_watched_at ?? c.completed_at
        if (ts && (!lastActivity || ts > lastActivity)) lastActivity = ts
        if (c.completed && c.completed_at && (!lastCompleted || c.completed_at > lastCompleted)) {
          lastCompleted = c.completed_at
        }
      }

      const pct = Math.round((doneCount / lessons.length) * 100)
      const isDone = doneCount >= lessons.length
      const deadline = emp.due_date ?? null
      const daysToDeadline = deadline ? diffDaysUtc(today, deadline) : null
      const status: EnrichedEnrolment['status'] = isDone
        ? 'completed'
        : deadline && deadline < today
          ? 'overdue'
          : hasStarted
            ? 'in_progress'
            : 'not_started'

      const linkedMgr = emp.manager_id ? mgrMap.get(emp.manager_id) : undefined

      rows.push({
        id: syntheticId--,
        userId: emp.id,
        employeeName: emp.full_name,
        employeeEmail: emp.email ?? null,
        department: emp.department,
        courseId: course.id,
        courseTitle: course.title,
        courseCategory: course.category,
        status,
        progressPct: pct,
        deadlineDate: deadline,
        startedAt: hasStarted ? lastActivity : null,
        lastActivityAt: lastActivity,
        completedAt: isDone ? lastCompleted : null,
        hrEmail: emp.hr_email ?? null,
        managerEmail: emp.manager_email ?? linkedMgr?.email ?? null,
        courseStartNotifiedAt: null,
        lastInactivityNotifiedAt: null,
        remindersStopped: isDone,
        daysInactive: isDone ? null : computeDaysInactive(lastActivity, null, now),
        daysToDeadline,
        isVirtual: true,
      })
    }
  }

  return rows
}

export async function loadMonitoringDashboardData(): Promise<MonitoringDashboardData> {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)

  const [profilesRes, coursesRes, modulesRes, completionsRes, settingsRes, enrolmentsRes, logsRes, activityRes] =
    await Promise.all([
      supabase.from('profiles').select('*').order('full_name'),
      supabase.from('courses').select('*').order('id'),
      supabase.from('modules').select('*').order('id'),
      supabase.from('video_completions').select('*'),
      supabase.from('notification_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('course_enrolments').select('*').order('updated_at', { ascending: false }),
      supabase.from('email_notification_logs').select('*').order('created_at', { ascending: false }).limit(250),
      supabase.from('learning_activity_logs').select('*').order('created_at', { ascending: false }).limit(120),
    ])

  const profiles = (profilesRes.data ?? []) as Profile[]
  const courses = (coursesRes.data ?? []) as Course[]
  const modules = (modulesRes.data ?? []) as Module[]
  const completions = (completionsRes.data ?? []) as VideoCompletion[]

  const profileMap = new Map(profiles.map((p) => [p.id, p]))
  const courseMap = new Map(courses.map((c) => [c.id, c]))

  const schemaReady = !settingsRes.error && !enrolmentsRes.error && !logsRes.error

  if (!schemaReady) {
    return {
      schemaReady: false,
      settings: { ...DEFAULT_MONITORING_SETTINGS },
      profiles,
      courses,
      enrolments: buildFallbackEnrolments(profiles, courses, modules, completions, now),
      emailLogs: [],
      recentActivity: [],
    }
  }

  const rawEnrolments = (enrolmentsRes.data ?? []) as CourseEnrolment[]
  const enrolments: EnrichedEnrolment[] = rawEnrolments
    .filter((e) => {
      const p = profileMap.get(e.user_id)
      return p && isActive(p)
    })
    .map((e) => {
      const emp = profileMap.get(e.user_id)!
      const course = courseMap.get(e.course_id)
      const linkedMgr = emp.manager_id ? profileMap.get(emp.manager_id) : undefined
      const isDone = e.status === 'completed' || !!e.completed_at || e.reminders_stopped || e.progress_pct >= 100
      const daysToDeadline = e.deadline_date ? diffDaysUtc(today, e.deadline_date) : null
      const status: EnrichedEnrolment['status'] = isDone
        ? 'completed'
        : e.deadline_date && e.deadline_date < today
          ? 'overdue'
          : e.status

      return {
        id: e.id,
        userId: e.user_id,
        employeeName: emp.full_name,
        employeeEmail: emp.email ?? null,
        department: emp.department,
        courseId: e.course_id,
        courseTitle: course?.title ?? `Course #${e.course_id}`,
        courseCategory: course?.category ?? 'General',
        status,
        progressPct: e.progress_pct,
        deadlineDate: e.deadline_date,
        startedAt: e.started_at,
        lastActivityAt: e.last_activity_at,
        completedAt: e.completed_at,
        hrEmail: e.hr_email ?? emp.hr_email ?? null,
        managerEmail: e.manager_email ?? emp.manager_email ?? linkedMgr?.email ?? null,
        courseStartNotifiedAt: e.course_start_notified_at,
        lastInactivityNotifiedAt: e.last_inactivity_notified_at,
        remindersStopped: e.reminders_stopped || isDone,
        daysInactive: isDone ? null : computeDaysInactive(e.last_activity_at ?? e.started_at, null, now),
        daysToDeadline,
        isVirtual: false,
      }
    })

  const rawLogs = (logsRes.data ?? []) as EmailNotificationLog[]
  const emailLogs: EnrichedEmailLog[] = rawLogs.map((l) => {
    const emp = profileMap.get(l.user_id)
    const course = l.course_id ? courseMap.get(l.course_id) : undefined
    return {
      ...l,
      employeeName: emp?.full_name ?? l.to_email,
      department: emp?.department ?? '—',
      courseTitle: course?.title ?? (l.notification_type === 'manual_test' ? 'System Verification' : '—'),
    }
  })

  const rawActivity = (activityRes.data ?? []) as LearningActivityLog[]
  const recentActivity = rawActivity.map((a) => {
    const emp = profileMap.get(a.user_id)
    const course = a.course_id ? courseMap.get(a.course_id) : undefined
    return {
      ...a,
      employeeName: emp?.full_name ?? 'Unknown',
      department: emp?.department ?? '—',
      courseTitle: course?.title ?? 'Course Activity',
    }
  })

  return {
    schemaReady: true,
    settings: (settingsRes.data as NotificationSettings | null) ?? { ...DEFAULT_MONITORING_SETTINGS },
    profiles,
    courses,
    enrolments,
    emailLogs,
    recentActivity,
  }
}

export async function syncAllEnrolments(): Promise<{ ok: boolean; count?: number; error?: string }> {
  const { data, error } = await supabase.rpc('sync_course_enrolments', { p_user_id: null })
  if (error) return { ok: false, error: error.message }
  return { ok: true, count: Number(data ?? 0) }
}

export async function saveNotificationSettings(
  updates: Partial<NotificationSettings>,
  updatedBy: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('notification_settings')
    .upsert({
      id: 1,
      ...updates,
      updated_by: updatedBy ?? null,
      updated_at: new Date().toISOString(),
    })

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function updateEnrolmentDetails(
  enrolmentId: number,
  updates: {
    deadline_date?: string | null
    hr_email?: string | null
    manager_email?: string | null
    reminders_stopped?: boolean
  },
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('course_enrolments')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', enrolmentId)

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function runNotificationMonitorNow(filters?: {
  department?: string
  userId?: string
}): Promise<{ ok: boolean; evaluated?: number; sent?: number; failed?: number; skipped?: number; errors?: string[]; error?: string }> {
  const { data, error } = await supabase.functions.invoke('course-notification-monitor', {
    body: {
      action: 'run_monitor',
      department: filters?.department && filters.department !== 'All' ? filters.department : undefined,
      user_id: filters?.userId || undefined,
      origin: typeof window !== 'undefined' ? window.location.origin : '',
    },
  })

  if (error) return { ok: false, error: error.message }
  return { ok: true, ...(data as Record<string, unknown>) }
}

export async function retryFailedNotification(logId: number): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('course-notification-monitor', {
    body: {
      action: 'retry_failed',
      log_id: logId,
      origin: typeof window !== 'undefined' ? window.location.origin : '',
    },
  })

  if (error) return { ok: false, error: error.message }
  const parsed = (data ?? {}) as { ok?: boolean; error?: string }
  if (!parsed.ok) return { ok: false, error: parsed.error ?? 'Retry failed' }
  return { ok: true }
}

export async function sendTestNotificationEmail(params: {
  toEmail: string
  ccEmails: string[]
}): Promise<{ ok: boolean; provider?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke('course-notification-monitor', {
    body: {
      action: 'send_test',
      to_email: params.toEmail,
      cc_emails: params.ccEmails,
      origin: typeof window !== 'undefined' ? window.location.origin : '',
    },
  })

  if (error) return { ok: false, error: error.message }
  const parsed = (data ?? {}) as { ok?: boolean; provider?: string; error?: string }
  return { ok: !!parsed.ok, provider: parsed.provider, error: parsed.error }
}
