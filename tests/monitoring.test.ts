import test from 'node:test'
import assert from 'node:assert/strict'
import {
  diffCalendarDays,
  elapsedDaysSince,
  evaluateEnrolment,
  isEnrolmentCompleted,
  resolveNotificationRecipients,
  type EnrolmentRecord,
  type MonitoringSettings,
} from '../supabase/functions/course-notification-monitor/monitor-logic.ts'
import { renderCourseNotificationEmail } from '../supabase/functions/course-notification-monitor/email-templates.ts'

const BASE_SETTINGS: MonitoringSettings = {
  enabled: true,
  inactivity_days: 7,
  reminder_days: [7, 3, 1],
  send_course_start: true,
  send_inactivity: true,
  send_deadline_reminders: true,
  send_overdue: true,
  default_hr_email: 'hr-default@company.com',
}

function makeEnrolment(overrides: Partial<EnrolmentRecord> = {}): EnrolmentRecord {
  return {
    id: 1,
    user_id: 'emp-123',
    course_id: 42,
    hr_email: null,
    manager_email: null,
    deadline_date: '2026-11-20',
    status: 'in_progress',
    progress_pct: 25,
    enrolled_at: '2026-11-01T09:00:00Z',
    started_at: '2026-11-02T10:00:00Z',
    last_activity_at: '2026-11-02T10:30:00Z',
    completed_at: null,
    course_start_notified_at: '2026-11-02T10:00:05Z',
    last_inactivity_notified_at: null,
    reminders_stopped: false,
    ...overrides,
  }
}

test('1. Course start triggers immediately once and respects idempotency', () => {
  const now = new Date('2026-11-02T10:05:00Z')
  const enrolment = makeEnrolment({
    course_start_notified_at: null,
    deadline_date: '2026-11-25',
  })
  const keys = new Set<string>()

  const first = evaluateEnrolment(enrolment, BASE_SETTINGS, now, keys)
  assert.equal(first.length, 1)
  assert.equal(first[0]?.type, 'course_start')
  assert.equal(first[0]?.idempotencyKey, 'course_start:emp-123:42')

  // Subsequent run with key recorded should NOT duplicate
  keys.add(first[0]!.idempotencyKey)
  const second = evaluateEnrolment(enrolment, BASE_SETTINGS, now, keys)
  assert.equal(second.length, 0)
})

test('2. Detects 7 consecutive days of inactivity and prevents duplicate notifications', () => {
  const now = new Date('2026-11-09T12:00:00Z') // 7 days after 2026-11-02T10:30:00Z
  assert.equal(elapsedDaysSince('2026-11-02T10:30:00Z', now), 7)

  const enrolment = makeEnrolment({
    last_activity_at: '2026-11-02T10:30:00Z',
    deadline_date: '2026-11-30',
  })
  const keys = new Set<string>()

  const actions = evaluateEnrolment(enrolment, BASE_SETTINGS, now, keys)
  assert.equal(actions.length, 1)
  assert.equal(actions[0]?.type, 'inactivity_7d')
  assert.equal(actions[0]?.daysInactive, 7)

  // Next day (day 8) with same idle anchor & notified timestamp must NOT send duplicate
  const notifiedEnrolment = makeEnrolment({
    ...enrolment,
    last_inactivity_notified_at: '2026-11-09T12:00:00Z',
  })
  const nextDayActions = evaluateEnrolment(notifiedEnrolment, BASE_SETTINGS, new Date('2026-11-10T12:00:00Z'), keys)
  assert.equal(nextDayActions.length, 0)
})

test('3. Resuming learning resets inactivity window cleanly', () => {
  const enrolment = makeEnrolment({
    last_activity_at: '2026-11-12T08:00:00Z', // resumed after earlier 2026-11-09 notification
    last_inactivity_notified_at: '2026-11-09T12:00:00Z',
    deadline_date: '2026-12-15',
  })

  // 3 days after resuming -> no inactivity alert
  const day3 = evaluateEnrolment(enrolment, BASE_SETTINGS, new Date('2026-11-15T10:00:00Z'), new Set())
  assert.equal(day3.length, 0)

  // 7 days after resuming -> eligible again with new anchor key
  const day7 = evaluateEnrolment(enrolment, BASE_SETTINGS, new Date('2026-11-19T10:00:00Z'), new Set())
  assert.equal(day7.length, 1)
  assert.equal(day7[0]?.type, 'inactivity_7d')
  assert.equal(day7[0]?.idempotencyKey, 'inactivity_7d:emp-123:42:2026-11-12')
})

test('4. Sends deadline reminders at 7, 3, and 1 days before deadline', () => {
  const deadline = '2026-11-20'
  assert.equal(diffCalendarDays('2026-11-13', deadline), 7)
  assert.equal(diffCalendarDays('2026-11-17', deadline), 3)
  assert.equal(diffCalendarDays('2026-11-19', deadline), 1)

  const enrolment = makeEnrolment({
    deadline_date: deadline,
    last_activity_at: '2026-11-19T06:00:00Z', // active recently
  })

  for (const [dateStr, expectedDays] of [
    ['2026-11-13T08:00:00Z', 7],
    ['2026-11-17T08:00:00Z', 3],
    ['2026-11-19T08:00:00Z', 1],
  ] as const) {
    const res = evaluateEnrolment(enrolment, BASE_SETTINGS, new Date(dateStr), new Set())
    assert.equal(res.length, 1)
    assert.equal(res[0]?.type, 'deadline_reminder')
    assert.equal(res[0]?.daysRemaining, expectedDays)
  }

  // Day 5 before deadline should NOT trigger (only 7, 3, 1 configured)
  const day5 = evaluateEnrolment(enrolment, BASE_SETTINGS, new Date('2026-11-15T08:00:00Z'), new Set())
  assert.equal(day5.filter((a) => a.type === 'deadline_reminder').length, 0)

  // Duplicate prevention: once 3-day or 1-day reminder key is recorded, re-running does NOT duplicate
  const existingKeys = new Set([
    'deadline_3d:emp-123:42:2026-11-20',
    'deadline_1d:emp-123:42:2026-11-20',
  ])
  assert.equal(evaluateEnrolment(enrolment, BASE_SETTINGS, new Date('2026-11-17T08:00:00Z'), existingKeys).length, 0)
  assert.equal(evaluateEnrolment(enrolment, BASE_SETTINGS, new Date('2026-11-19T08:00:00Z'), existingKeys).length, 0)
})

test('5. Sends overdue notification once past deadline and stops on duplicate key', () => {
  const enrolment = makeEnrolment({
    deadline_date: '2026-11-10',
    last_activity_at: '2026-11-11T09:00:00Z',
  })
  const keys = new Set<string>()
  const actions = evaluateEnrolment(enrolment, BASE_SETTINGS, new Date('2026-11-12T08:00:00Z'), keys)
  assert.equal(actions.length, 1)
  assert.equal(actions[0]?.type, 'course_overdue')
  assert.equal(actions[0]?.daysOverdue, 2)

  keys.add(actions[0]!.idempotencyKey)
  const nextRun = evaluateEnrolment(enrolment, BASE_SETTINGS, new Date('2026-11-13T08:00:00Z'), keys)
  assert.equal(nextRun.length, 0)
})

test('6. Automatically stops ALL reminders (inactivity, 3d, 1d, overdue) upon 100% completion', () => {
  const completedVariants: Partial<EnrolmentRecord>[] = [
    { status: 'completed', progress_pct: 100, completed_at: '2026-11-05T10:00:00Z', reminders_stopped: true },
    { progress_pct: 100 },
    { completed_at: '2026-11-05T10:00:00Z' },
    { reminders_stopped: true },
  ]

  for (const variant of completedVariants) {
    // Test both 1 day before deadline (final reminder date) and past deadline with 30 days of inactivity
    for (const [deadlineDate, evalIso] of [
      ['2026-11-20', '2026-11-19T08:00:00Z'], // 1 day before deadline + 49d idle
      ['2026-11-20', '2026-11-17T08:00:00Z'], // 3 days before deadline + 47d idle
      ['2026-11-01', '2026-11-20T08:00:00Z'], // overdue + 50d idle
    ] as const) {
      const enrolment = makeEnrolment({
        deadline_date: deadlineDate,
        last_activity_at: '2026-10-01T00:00:00Z', // well over 7 days inactive
        course_start_notified_at: null,
        ...variant,
      })
      assert.equal(isEnrolmentCompleted(enrolment), true)
      const actions = evaluateEnrolment(enrolment, BASE_SETTINGS, new Date(evalIso), new Set())
      assert.equal(actions.length, 0)
    }
  }
})

test('7. Resolves TO employee and CC HR + Manager without duplicates', () => {
  const res = resolveNotificationRecipients({
    employeeEmail: ' Employee@Company.com ',
    enrolmentHrEmail: null,
    profileHrEmail: 'HR@Company.com',
    defaultHrEmail: 'hr-default@company.com',
    enrolmentManagerEmail: 'Manager@Company.com',
    profileManagerEmail: 'employee@company.com',
  })
  assert.equal(res.to, 'employee@company.com')
  assert.deepEqual(res.cc, ['hr@company.com', 'manager@company.com'])

  // If employee is also listed as HR, do not put TO address into CC
  const selfCc = resolveNotificationRecipients({
    employeeEmail: 'hr@company.com',
    profileHrEmail: 'hr@company.com',
    profileManagerEmail: 'mgr@company.com',
  })
  assert.equal(selfCc.to, 'hr@company.com')
  assert.deepEqual(selfCc.cc, ['mgr@company.com'])
})

test('8. Renders HTML & text email templates for 3d reminder and 1d final reminder with safe escaping', () => {
  const threeDay = renderCourseNotificationEmail({
    notificationType: 'deadline_reminder',
    employeeName: 'Jane <Doe>',
    department: 'Engineering',
    courseName: 'Security & Compliance 101',
    progressPct: 67,
    lastActivityIso: '2026-11-10T14:30:00Z',
    deadlineDate: '2026-11-15',
    courseUrl: 'https://lms.company.com/app/modules/99',
    daysRemaining: 3,
  })

  assert.match(threeDay.subject, /Reminder: 3 days left/)
  assert.match(threeDay.html, /3-DAY REMINDER/)
  assert.match(threeDay.html, /Jane &lt;Doe&gt;/)
  assert.match(threeDay.html, /Security &amp; Compliance 101/)
  assert.match(threeDay.html, /67% completed/)
  assert.match(threeDay.html, /Nov 15, 2026/)
  assert.match(threeDay.html, /https:\/\/lms\.company\.com\/app\/modules\/99/)
  assert.match(threeDay.text, /Progress: 67%/)

  const oneDayFinal = renderCourseNotificationEmail({
    notificationType: 'deadline_reminder',
    employeeName: 'Jane Doe',
    department: 'Engineering',
    courseName: 'Security & Compliance 101',
    progressPct: 80,
    lastActivityIso: '2026-11-10T14:30:00Z',
    deadlineDate: '2026-11-15',
    courseUrl: 'https://lms.company.com/app/modules/99',
    daysRemaining: 1,
  })

  assert.match(oneDayFinal.subject, /FINAL REMINDER/)
  assert.match(oneDayFinal.html, /FINAL REMINDER/)
  assert.match(oneDayFinal.html, /Complete Course Today/)
})
