export type NotificationType =
  | 'course_start'
  | 'inactivity_7d'
  | 'deadline_reminder'
  | 'course_overdue'
  | 'manual_test'

export interface EnrolmentRecord {
  id: number
  user_id: string
  course_id: number
  hr_email: string | null
  manager_email: string | null
  deadline_date: string | null
  status: 'not_started' | 'in_progress' | 'completed' | 'overdue'
  progress_pct: number
  enrolled_at: string
  started_at: string | null
  last_activity_at: string | null
  completed_at: string | null
  course_start_notified_at: string | null
  last_inactivity_notified_at: string | null
  reminders_stopped: boolean
}

export interface MonitoringSettings {
  enabled: boolean
  inactivity_days: number
  reminder_days: number[]
  send_course_start: boolean
  send_inactivity: boolean
  send_deadline_reminders: boolean
  send_overdue: boolean
  default_hr_email: string | null
}

export interface PendingNotificationAction {
  type: Exclude<NotificationType, 'manual_test'>
  idempotencyKey: string
  daysInactive?: number
  daysRemaining?: number
  daysOverdue?: number
}

const MS_PER_DAY = 86_400_000

/**
 * Returns YYYY-MM-DD in UTC for a Date or ISO timestamp.
 */
export function toUtcDateString(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input
  return d.toISOString().slice(0, 10)
}

/**
 * Computes exact whole calendar day difference (targetDate - baseDate) in UTC.
 * Example: diffCalendarDays('2026-11-12', '2026-11-19') => 7
 *          diffCalendarDays('2026-11-12', '2026-11-10') => -2
 */
export function diffCalendarDays(baseDateStr: string, targetDateStr: string): number {
  const [by, bm, bd] = baseDateStr.slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = targetDateStr.slice(0, 10).split('-').map(Number)
  const baseUtc = Date.UTC(by ?? 0, (bm ?? 1) - 1, bd ?? 1)
  const targetUtc = Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1)
  return Math.round((targetUtc - baseUtc) / MS_PER_DAY)
}

/**
 * Computes whole elapsed 24h days between two ISO timestamps.
 */
export function elapsedDaysSince(sinceIso: string, now: Date): number {
  const diffMs = now.getTime() - new Date(sinceIso).getTime()
  return Math.floor(diffMs / MS_PER_DAY)
}

/**
 * Checks whether an enrolment is considered completed (and thus all reminders must stop).
 */
export function isEnrolmentCompleted(e: EnrolmentRecord): boolean {
  return (
    e.status === 'completed' ||
    e.completed_at !== null ||
    e.reminders_stopped === true ||
    e.progress_pct >= 100
  )
}

/**
 * Pure evaluation function for an enrolment row against monitoring rules.
 * Guarantees:
 *  - Stops all reminders immediately upon 100% completion.
 *  - Detects course start if started_at exists and not yet notified.
 *  - Detects N consecutive days of inactivity, resets when last_activity_at advances,
 *    and prevents duplicate inactivity notifications for the same inactivity window.
 *  - Sends deadline reminders at configured intervals (e.g. 7, 3, 1 days before deadline).
 *  - Sends overdue notice once past deadline until completed.
 *  - Deduplicates via existingIdempotencyKeys.
 */
export function evaluateEnrolment(
  enrolment: EnrolmentRecord,
  settings: MonitoringSettings,
  now: Date,
  existingIdempotencyKeys: Set<string>,
): PendingNotificationAction[] {
  if (!settings.enabled) return []
  if (isEnrolmentCompleted(enrolment)) return []

  const actions: PendingNotificationAction[] = []
  const todayStr = toUtcDateString(now)

  // 1. Course Start (catch-up in monitor if immediate trigger was missed or offline)
  if (
    settings.send_course_start &&
    enrolment.started_at &&
    !enrolment.course_start_notified_at
  ) {
    const key = `course_start:${enrolment.user_id}:${enrolment.course_id}`
    if (!existingIdempotencyKeys.has(key)) {
      actions.push({
        type: 'course_start',
        idempotencyKey: key,
      })
    }
  }

  // 2. Consecutive Inactivity Detection (default 7 days) — never sent if course is completed
  if (settings.send_inactivity && !isEnrolmentCompleted(enrolment)) {
    const activityAnchor = enrolment.last_activity_at ?? enrolment.started_at ?? enrolment.enrolled_at
    if (activityAnchor) {
      const daysInactive = elapsedDaysSince(activityAnchor, now)
      const alreadyNotifiedInThisIdlePeriod =
        enrolment.last_inactivity_notified_at !== null &&
        new Date(enrolment.last_inactivity_notified_at).getTime() >= new Date(activityAnchor).getTime()

      if (daysInactive >= settings.inactivity_days && !alreadyNotifiedInThisIdlePeriod) {
        const anchorStamp = activityAnchor.slice(0, 10)
        const key = `inactivity_${settings.inactivity_days}d:${enrolment.user_id}:${enrolment.course_id}:${anchorStamp}`
        if (!existingIdempotencyKeys.has(key)) {
          actions.push({
            type: 'inactivity_7d',
            idempotencyKey: key,
            daysInactive,
          })
        }
      }
    }
  }

  // 3. Deadline Reminders (7, 3, and 1 day before deadline) & Overdue Detection — stopped on completion
  if (enrolment.deadline_date && !isEnrolmentCompleted(enrolment)) {
    const daysRemaining = diffCalendarDays(todayStr, enrolment.deadline_date)

    if (
      settings.send_deadline_reminders &&
      daysRemaining > 0 &&
      settings.reminder_days.includes(daysRemaining)
    ) {
      const key = `deadline_${daysRemaining}d:${enrolment.user_id}:${enrolment.course_id}:${enrolment.deadline_date}`
      if (!existingIdempotencyKeys.has(key)) {
        actions.push({
          type: 'deadline_reminder',
          idempotencyKey: key,
          daysRemaining,
        })
      }
    }

    if (settings.send_overdue && daysRemaining < 0) {
      const daysOverdue = Math.abs(daysRemaining)
      const key = `overdue:${enrolment.user_id}:${enrolment.course_id}:${enrolment.deadline_date}`
      if (!existingIdempotencyKeys.has(key)) {
        actions.push({
          type: 'course_overdue',
          idempotencyKey: key,
          daysOverdue,
        })
      }
    }
  }

  return actions
}

/**
 * Resolves TO (employee) and CC (HR representative + reporting manager),
 * normalized, validated, and deduplicated without duplicating the TO address.
 */
export function resolveNotificationRecipients(params: {
  employeeEmail: string | null | undefined
  enrolmentHrEmail?: string | null
  profileHrEmail?: string | null
  defaultHrEmail?: string | null
  enrolmentManagerEmail?: string | null
  profileManagerEmail?: string | null
  linkedManagerProfileEmail?: string | null
  departmentManagerEmail?: string | null
}): { to: string | null; cc: string[] } {
  const cleanEmail = (v: string | null | undefined): string | null => {
    if (!v) return null
    const trimmed = v.trim().toLowerCase()
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? trimmed : null
  }

  const to = cleanEmail(params.employeeEmail)
  if (!to) return { to: null, cc: [] }

  const hrCandidate =
    cleanEmail(params.enrolmentHrEmail) ??
    cleanEmail(params.profileHrEmail) ??
    cleanEmail(params.defaultHrEmail)

  const managerCandidate =
    cleanEmail(params.enrolmentManagerEmail) ??
    cleanEmail(params.profileManagerEmail) ??
    cleanEmail(params.linkedManagerProfileEmail) ??
    cleanEmail(params.departmentManagerEmail)

  const ccSet = new Set<string>()
  if (hrCandidate && hrCandidate !== to) ccSet.add(hrCandidate)
  if (managerCandidate && managerCandidate !== to) ccSet.add(managerCandidate)

  return {
    to,
    cc: Array.from(ccSet),
  }
}
