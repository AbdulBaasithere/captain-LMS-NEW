<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import {
  DEFAULT_MONITORING_SETTINGS,
  loadMonitoringDashboardData,
  retryFailedNotification,
  runNotificationMonitorNow,
  saveNotificationSettings,
  sendTestNotificationEmail,
  syncAllEnrolments,
  updateEnrolmentDetails,
  type EnrichedEmailLog,
  type EnrichedEnrolment,
  type MonitoringDashboardData,
} from '@/lib/monitoring'
import type { EmailProviderType, NotificationSettings } from '@/lib/database.types'
import BaseModal from '@/components/BaseModal.vue'

const auth = useAuthStore()

type TabId = 'queues' | 'history' | 'enrolments' | 'settings'
const activeTab = ref<TabId>('queues')
const loading = ref(true)
const data = ref<MonitoringDashboardData | null>(null)

// Global filters
const filterDepartment = ref('All')
const filterEmployeeId = ref('All')
const filterSearch = ref('')
const filterNotificationType = ref('All')
const filterDeliveryStatus = ref('All')

// Action states
const syncing = ref(false)
const runningMonitor = ref(false)
const retryingId = ref<number | null>(null)
const bannerMsg = ref<{ ok: boolean; text: string } | null>(null)

// Settings form state
const form = ref<NotificationSettings>({ ...DEFAULT_MONITORING_SETTINGS })
const reminderDaysInput = ref('7, 3, 1')
const savingSettings = ref(false)
const settingsMsg = ref<{ ok: boolean; text: string } | null>(null)

// Test email state
const testToEmail = ref('')
const testCcEmails = ref('')
const sendingTest = ref(false)
const testMsg = ref<{ ok: boolean; text: string } | null>(null)

// Modals
const previewLog = ref<EnrichedEmailLog | null>(null)
const editingEnrolment = ref<EnrichedEnrolment | null>(null)
const editDeadline = ref('')
const editHrEmail = ref('')
const editManagerEmail = ref('')
const editRemindersStopped = ref(false)
const savingEnrolment = ref(false)

async function load() {
  loading.value = true
  const loaded = await loadMonitoringDashboardData()
  data.value = loaded
  form.value = { ...loaded.settings }
  reminderDaysInput.value = (loaded.settings.reminder_days ?? [7, 3, 1]).join(', ')
  if (!testToEmail.value && auth.profile?.email) {
    testToEmail.value = auth.profile.email
  }
  loading.value = false
}

onMounted(load)

const departments = computed(() => {
  if (!data.value) return []
  const set = new Set<string>()
  for (const p of data.value.profiles) {
    if (p.department) set.add(p.department)
  }
  return Array.from(set).sort()
})

const employeeOptions = computed(() => {
  if (!data.value) return []
  return data.value.profiles.filter(
    (p) => p.role === 'employee' && (filterDepartment.value === 'All' || p.department === filterDepartment.value),
  )
})

function matchesCommonFilters(item: { department: string; userId?: string; user_id?: string; employeeName: string; courseTitle: string }) {
  if (filterDepartment.value !== 'All' && item.department !== filterDepartment.value) return false
  const uid = item.userId ?? item.user_id
  if (filterEmployeeId.value !== 'All' && uid !== filterEmployeeId.value) return false
  const q = filterSearch.value.trim().toLowerCase()
  if (q && !item.employeeName.toLowerCase().includes(q) && !item.courseTitle.toLowerCase().includes(q)) return false
  return true
}

const filteredEnrolments = computed(() => {
  if (!data.value) return []
  return data.value.enrolments.filter((e) => matchesCommonFilters(e))
})

const inactiveThreshold = computed(() => form.value.inactivity_days || 7)
const maxReminderWindow = computed(() => Math.max(7, ...(form.value.reminder_days ?? [7, 3, 1])))

const inactiveEnrolments = computed(() =>
  filteredEnrolments.value.filter(
    (e) =>
      e.status !== 'completed' &&
      !e.remindersStopped &&
      e.daysInactive !== null &&
      e.daysInactive >= inactiveThreshold.value,
  ),
)

const upcomingDeadlineEnrolments = computed(() =>
  filteredEnrolments.value.filter(
    (e) =>
      e.status !== 'completed' &&
      !e.remindersStopped &&
      e.daysToDeadline !== null &&
      e.daysToDeadline >= 0 &&
      e.daysToDeadline <= maxReminderWindow.value,
  ),
)

const overdueEnrolments = computed(() =>
  filteredEnrolments.value.filter(
    (e) =>
      e.status !== 'completed' &&
      !e.remindersStopped &&
      (e.status === 'overdue' || (e.daysToDeadline !== null && e.daysToDeadline < 0)),
  ),
)

const filteredLogs = computed(() => {
  if (!data.value) return []
  return data.value.emailLogs.filter((l) => {
    if (!matchesCommonFilters(l)) return false
    if (filterNotificationType.value !== 'All' && l.notification_type !== filterNotificationType.value) return false
    if (filterDeliveryStatus.value !== 'All' && l.status !== filterDeliveryStatus.value) return false
    return true
  })
})

const filteredActivity = computed(() => {
  if (!data.value) return []
  return data.value.recentActivity.filter((a) => matchesCommonFilters(a))
})

const kpis = computed(() => {
  const logs = filteredLogs.value
  const sentCount = logs.filter((l) => l.status === 'sent').length
  const failedCount = logs.filter((l) => l.status === 'failed').length
  return {
    sent: sentCount,
    inactive: inactiveEnrolments.value.length,
    upcoming: upcomingDeadlineEnrolments.value.length,
    overdue: overdueEnrolments.value.length,
    failed: failedCount,
  }
})

const providerEnvHints: Record<EmailProviderType, string[]> = {
  resend: ['RESEND_API_KEY', 'LMS_FROM_EMAIL (optional)'],
  smtp: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE'],
  m365: ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'M365_SENDER_USER'],
  google_workspace: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'LMS_FROM_EMAIL'],
}

function formatTypeLabel(t: string): string {
  switch (t) {
    case 'course_start':
      return 'Course Start'
    case 'inactivity_7d':
      return '7-Day Inactivity'
    case 'deadline_reminder':
      return 'Deadline Reminder'
    case 'course_overdue':
      return 'Course Overdue'
    case 'manual_test':
      return 'Test Email'
    default:
      return t
  }
}

function statusPillClass(s: string): string {
  if (s === 'sent' || s === 'completed') return 'pill-teal'
  if (s === 'failed' || s === 'overdue') return 'pill-danger'
  if (s === 'pending' || s === 'in_progress') return 'pill-brass'
  return 'pill-muted'
}

function formatShortDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function handleSync() {
  syncing.value = true
  bannerMsg.value = null
  const res = await syncAllEnrolments()
  syncing.value = false
  if (!res.ok) {
    bannerMsg.value = { ok: false, text: res.error ?? 'Could not sync enrolments.' }
    return
  }
  bannerMsg.value = { ok: true, text: `Synced course enrolments (${res.count ?? 0} active assignments checked).` }
  await load()
}

async function handleRunMonitor() {
  runningMonitor.value = true
  bannerMsg.value = null
  const res = await runNotificationMonitorNow({
    department: filterDepartment.value,
    userId: filterEmployeeId.value !== 'All' ? filterEmployeeId.value : undefined,
  })
  runningMonitor.value = false
  if (!res.ok) {
    bannerMsg.value = {
      ok: false,
      text: res.error ?? 'Failed to reach course-notification-monitor Edge Function. Verify it is deployed.',
    }
    return
  }
  await logActivity(
    auth.profile?.id,
    `Ran course notification monitor (${res.sent ?? 0} sent, ${res.failed ?? 0} failed, ${res.skipped ?? 0} skipped)`,
  )
  bannerMsg.value = {
    ok: (res.failed ?? 0) === 0,
    text: `Monitor run complete — Evaluated: ${res.evaluated ?? 0}, Sent: ${res.sent ?? 0}, Failed: ${res.failed ?? 0}, Skipped: ${res.skipped ?? 0}.${res.errors?.length ? ` First error: ${res.errors[0]}` : ''}`,
  }
  await load()
}

async function handleRetry(log: EnrichedEmailLog) {
  retryingId.value = log.id
  bannerMsg.value = null
  const res = await retryFailedNotification(log.id)
  retryingId.value = null
  if (!res.ok) {
    bannerMsg.value = { ok: false, text: `Retry failed for ${log.to_email}: ${res.error}` }
  } else {
    bannerMsg.value = { ok: true, text: `Successfully resent notification to ${log.to_email}.` }
  }
  await load()
}

async function handleSaveSettings() {
  savingSettings.value = true
  settingsMsg.value = null

  const parsedDays = reminderDaysInput.value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 90)
  const uniqueSorted = Array.from(new Set(parsedDays.length ? parsedDays : [7, 3, 1])).sort((a, b) => b - a)

  const res = await saveNotificationSettings(
    {
      enabled: form.value.enabled,
      inactivity_days: Math.max(1, Math.min(90, Number(form.value.inactivity_days) || 7)),
      reminder_days: uniqueSorted,
      send_course_start: form.value.send_course_start,
      send_inactivity: form.value.send_inactivity,
      send_deadline_reminders: form.value.send_deadline_reminders,
      send_overdue: form.value.send_overdue,
      sender_name: form.value.sender_name.trim() || 'Captain LMS Notifications',
      sender_email: form.value.sender_email.trim() || 'lms@captainandcompany.com',
      default_hr_email: form.value.default_hr_email?.trim() || null,
      email_provider: form.value.email_provider,
      lms_base_url: form.value.lms_base_url.trim(),
    },
    auth.profile?.id,
  )

  savingSettings.value = false
  if (!res.ok) {
    settingsMsg.value = { ok: false, text: res.error ?? 'Could not save settings.' }
    return
  }
  await logActivity(auth.profile?.id, 'Updated automated course monitoring & email settings')
  settingsMsg.value = { ok: true, text: 'Notification settings saved.' }
  await load()
}

async function handleSendTest() {
  sendingTest.value = true
  testMsg.value = null
  const ccList = testCcEmails.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const res = await sendTestNotificationEmail({
    toEmail: testToEmail.value,
    ccEmails: ccList,
  })
  sendingTest.value = false
  if (!res.ok) {
    testMsg.value = { ok: false, text: res.error ?? 'Test email dispatch failed.' }
    return
  }
  testMsg.value = { ok: true, text: `Test email sent successfully via ${res.provider ?? form.value.email_provider}.` }
  await load()
}

function openEditEnrolment(e: EnrichedEnrolment) {
  editingEnrolment.value = e
  editDeadline.value = e.deadlineDate ?? ''
  editHrEmail.value = e.hrEmail ?? ''
  editManagerEmail.value = e.managerEmail ?? ''
  editRemindersStopped.value = e.remindersStopped
}

async function handleSaveEnrolment() {
  if (!editingEnrolment.value) return
  savingEnrolment.value = true
  const res = await updateEnrolmentDetails(editingEnrolment.value.id, {
    deadline_date: editDeadline.value || null,
    hr_email: editHrEmail.value.trim() || null,
    manager_email: editManagerEmail.value.trim() || null,
    reminders_stopped: editRemindersStopped.value,
  })
  savingEnrolment.value = false
  if (!res.ok) {
    bannerMsg.value = { ok: false, text: res.error ?? 'Could not update enrolment.' }
    return
  }
  editingEnrolment.value = null
  await load()
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <p>Admin · Automated Monitoring &amp; Email Alerts</p>
        <h2>Course Monitoring</h2>
      </div>
      <div class="row wrap" style="gap: 8px">
        <button class="btn btn-ghost btn-sm" :disabled="syncing || !data?.schemaReady" @click="handleSync">
          {{ syncing ? 'Syncing…' : '↻ Sync Enrolments' }}
        </button>
        <button class="btn btn-primary btn-sm" :disabled="runningMonitor || !data?.schemaReady" @click="handleRunMonitor">
          {{ runningMonitor ? 'Running Monitor…' : '▶ Run Monitor Now' }}
        </button>
      </div>
    </div>

    <div
      v-if="data && !data.schemaReady"
      class="card"
      style="padding: 16px 18px; margin-bottom: 18px; border-color: var(--brass); background: var(--brass-soft)"
    >
      <div style="font-weight: 700; margin-bottom: 4px">Database Migration Required for Full Automation</div>
      <p class="sub" style="color: var(--ink); line-height: 1.5">
        Showing live fallback metrics computed from existing LMS tables. Run
        <code>supabase/migrations/20261112_course_monitoring_notifications.sql</code> in the Supabase SQL Editor and deploy
        <code>supabase/functions/course-notification-monitor</code> to enable automated daily emails, CC routing, and delivery logs.
      </p>
    </div>

    <div
      v-if="bannerMsg"
      class="card"
      style="padding: 12px 16px; margin-bottom: 16px"
      :style="{ borderColor: bannerMsg.ok ? 'var(--teal)' : 'var(--danger)' }"
    >
      <span :style="{ color: bannerMsg.ok ? 'var(--teal)' : 'var(--danger)', fontWeight: 600, fontSize: '13.5px' }">
        {{ bannerMsg.text }}
      </span>
    </div>

    <!-- KPI Cards -->
    <div class="kpi-grid">
      <div class="card stat">
        <div class="lbl">Notifications Sent</div>
        <div class="val">{{ kpis.sent }}</div>
        <div class="sub">delivered via {{ form.email_provider }}</div>
      </div>
      <div class="card stat">
        <div class="lbl">Inactive ({{ inactiveThreshold }}+ Days)</div>
        <div class="val" :style="{ color: kpis.inactive ? 'var(--brass-strong)' : '' }">{{ kpis.inactive }}</div>
        <div class="sub">no recent learning activity</div>
      </div>
      <div class="card stat">
        <div class="lbl">Upcoming Deadlines</div>
        <div class="val">{{ kpis.upcoming }}</div>
        <div class="sub">due within {{ maxReminderWindow }} days</div>
      </div>
      <div class="card stat dark">
        <div class="lbl">Overdue Courses</div>
        <div class="val">{{ kpis.overdue }}</div>
        <div class="sub">past assigned deadline</div>
      </div>
      <div class="card stat">
        <div class="lbl">Failed Deliveries</div>
        <div class="val" :style="{ color: kpis.failed ? 'var(--danger)' : 'var(--teal)' }">{{ kpis.failed }}</div>
        <div class="sub">retryable email failures</div>
      </div>
    </div>

    <!-- Filters Bar -->
    <div class="card" style="padding: 14px 16px; margin-bottom: 18px">
      <div class="filter-bar">
        <div>
          <label>Department</label>
          <select v-model="filterDepartment" @change="filterEmployeeId = 'All'">
            <option value="All">All departments</option>
            <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>
        <div>
          <label>Employee</label>
          <select v-model="filterEmployeeId">
            <option value="All">All employees</option>
            <option v-for="emp in employeeOptions" :key="emp.id" :value="emp.id">{{ emp.full_name }}</option>
          </select>
        </div>
        <div>
          <label>Search employee or course</label>
          <input v-model="filterSearch" type="text" placeholder="Filter by name or course…" />
        </div>
        <div v-if="activeTab === 'history'">
          <label>Notification Type</label>
          <select v-model="filterNotificationType">
            <option value="All">All types</option>
            <option value="course_start">Course Start</option>
            <option value="inactivity_7d">7-Day Inactivity</option>
            <option value="deadline_reminder">Deadline Reminder</option>
            <option value="course_overdue">Course Overdue</option>
            <option value="manual_test">Test Email</option>
          </select>
        </div>
        <div v-if="activeTab === 'history'">
          <label>Delivery Status</label>
          <select v-model="filterDeliveryStatus">
            <option value="All">All statuses</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
            <option value="skipped">Skipped</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Sub-Navigation Tabs -->
    <div class="seg" style="margin-bottom: 18px">
      <button :class="{ on: activeTab === 'queues' }" @click="activeTab = 'queues'">
        Action Queues ({{ kpis.inactive + kpis.upcoming + kpis.overdue }})
      </button>
      <button :class="{ on: activeTab === 'history' }" @click="activeTab = 'history'">
        Notification History ({{ filteredLogs.length }})
      </button>
      <button :class="{ on: activeTab === 'enrolments' }" @click="activeTab = 'enrolments'">
        Enrolments ({{ filteredEnrolments.length }})
      </button>
      <button :class="{ on: activeTab === 'settings' }" @click="activeTab = 'settings'">
        Settings &amp; Test
      </button>
    </div>

    <p v-if="loading" class="sub">Loading monitoring data…</p>

    <!-- TAB 1: ACTION QUEUES (Inactive, Upcoming, Overdue) -->
    <template v-else-if="activeTab === 'queues'">
      <div class="card" style="margin-bottom: 18px">
        <div class="panel-title">
          <h3>Overdue Courses ({{ overdueEnrolments.length }})</h3>
          <span class="sub">Escalated to employee + HR + reporting manager</span>
        </div>
        <div v-if="overdueEnrolments.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Course</th>
                <th>Progress</th>
                <th>Deadline</th>
                <th>Days Overdue</th>
                <th>CC Recipients</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in overdueEnrolments" :key="`${e.userId}:${e.courseId}:od`">
                <td>
                  <b>{{ e.employeeName }}</b>
                  <div class="sub">{{ e.department }} · {{ e.employeeEmail ?? 'No email' }}</div>
                </td>
                <td>{{ e.courseTitle }}</td>
                <td><b>{{ e.progressPct }}%</b></td>
                <td>{{ e.deadlineDate ?? '—' }}</td>
                <td>
                  <span class="pill pill-danger">{{ Math.abs(e.daysToDeadline ?? 0) }}d overdue</span>
                </td>
                <td class="sub">
                  <div>HR: {{ e.hrEmail ?? form.default_hr_email ?? 'Not set' }}</div>
                  <div>Mgr: {{ e.managerEmail ?? 'Not set' }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="sub" style="padding: 16px 18px">No overdue courses for the current filter.</p>
      </div>

      <div class="card" style="margin-bottom: 18px">
        <div class="panel-title">
          <h3>Inactive Employees ({{ inactiveThreshold }}+ Days) ({{ inactiveEnrolments.length }})</h3>
          <span class="sub">Automatically resets whenever the employee resumes learning</span>
        </div>
        <div v-if="inactiveEnrolments.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Course</th>
                <th>Progress</th>
                <th>Last Activity</th>
                <th>Inactive For</th>
                <th>Last Inactivity Email</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in inactiveEnrolments" :key="`${e.userId}:${e.courseId}:inact`">
                <td>
                  <b>{{ e.employeeName }}</b>
                  <div class="sub">{{ e.department }} · {{ e.employeeEmail ?? 'No email' }}</div>
                </td>
                <td>{{ e.courseTitle }}</td>
                <td><b>{{ e.progressPct }}%</b></td>
                <td>{{ formatShortDate(e.lastActivityAt) }}</td>
                <td><span class="pill pill-brass">{{ e.daysInactive }} days</span></td>
                <td class="sub">{{ e.lastInactivityNotifiedAt ? formatShortDate(e.lastInactivityNotifiedAt) : 'Pending next run' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="sub" style="padding: 16px 18px">No inactive employees exceeding {{ inactiveThreshold }} days.</p>
      </div>

      <div class="card">
        <div class="panel-title">
          <h3>Upcoming Deadlines (Next {{ maxReminderWindow }} Days) ({{ upcomingDeadlineEnrolments.length }})</h3>
          <span class="sub">Scheduled reminders at {{ reminderDaysInput }} days before deadline</span>
        </div>
        <div v-if="upcomingDeadlineEnrolments.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Course</th>
                <th>Progress</th>
                <th>Deadline</th>
                <th>Time Left</th>
                <th>CC Recipients</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in upcomingDeadlineEnrolments" :key="`${e.userId}:${e.courseId}:up`">
                <td>
                  <b>{{ e.employeeName }}</b>
                  <div class="sub">{{ e.department }}</div>
                </td>
                <td>{{ e.courseTitle }}</td>
                <td><b>{{ e.progressPct }}%</b></td>
                <td>{{ e.deadlineDate }}</td>
                <td>
                  <span :class="['pill', (e.daysToDeadline ?? 99) <= 1 ? 'pill-danger' : 'pill-brass']">
                    {{
                      e.daysToDeadline === 0
                        ? 'Due today'
                        : e.daysToDeadline === 1
                          ? '1d · Final reminder'
                          : e.daysToDeadline === 3
                            ? '3d · Follow-up reminder'
                            : `${e.daysToDeadline}d left`
                    }}
                  </span>
                </td>
                <td class="sub">
                  <div>HR: {{ e.hrEmail ?? form.default_hr_email ?? 'Not set' }}</div>
                  <div>Mgr: {{ e.managerEmail ?? 'Not set' }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="sub" style="padding: 16px 18px">No upcoming deadlines in the next {{ maxReminderWindow }} days.</p>
      </div>
    </template>

    <!-- TAB 2: NOTIFICATION HISTORY -->
    <template v-else-if="activeTab === 'history'">
      <div class="card">
        <div class="panel-title">
          <h3>Email Delivery History</h3>
          <span class="sub">Deduplicated via idempotency keys · TO employee, CC HR &amp; manager</span>
        </div>
        <div v-if="filteredLogs.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Type</th>
                <th>Employee</th>
                <th>Course</th>
                <th>Recipients (TO / CC)</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in filteredLogs" :key="l.id">
                <td class="sub">{{ formatShortDate(l.sent_at ?? l.created_at) }}</td>
                <td><span class="pill pill-outline">{{ formatTypeLabel(l.notification_type) }}</span></td>
                <td>
                  <b>{{ l.employeeName }}</b>
                  <div class="sub">{{ l.department }}</div>
                </td>
                <td>{{ l.courseTitle }}</td>
                <td class="sub">
                  <div><b>TO:</b> {{ l.to_email }}</div>
                  <div v-if="l.cc_emails?.length"><b>CC:</b> {{ l.cc_emails.join(', ') }}</div>
                </td>
                <td>
                  <span :class="['pill', statusPillClass(l.status)]">{{ l.status }}</span>
                  <div v-if="l.error_message" class="sub" style="color: var(--danger); max-width: 240px; margin-top: 4px">
                    {{ l.error_message }}
                  </div>
                </td>
                <td>
                  <div class="row wrap" style="gap: 6px">
                    <button v-if="l.html_body" class="btn btn-ghost btn-sm" @click="previewLog = l">Preview</button>
                    <button
                      v-if="l.status === 'failed'"
                      class="btn btn-primary btn-sm"
                      :disabled="retryingId === l.id"
                      @click="handleRetry(l)"
                    >
                      {{ retryingId === l.id ? 'Retrying…' : 'Retry' }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="sub" style="padding: 18px">No email notification logs match the current filters yet.</p>
      </div>
    </template>

    <!-- TAB 3: ENROLMENTS & DEADLINES -->
    <template v-else-if="activeTab === 'enrolments'">
      <div class="card">
        <div class="panel-title">
          <h3>Course Enrolments &amp; Reminder Lifecycle</h3>
          <span class="sub">Reminders automatically stop upon 100% completion</span>
        </div>
        <div v-if="filteredEnrolments.length" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Course</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Deadline</th>
                <th>Last Activity</th>
                <th>Reminders</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in filteredEnrolments" :key="`${e.userId}:${e.courseId}`">
                <td>
                  <b>{{ e.employeeName }}</b>
                  <div class="sub">{{ e.department }}</div>
                </td>
                <td>{{ e.courseTitle }}</td>
                <td><b>{{ e.progressPct }}%</b></td>
                <td><span :class="['pill', statusPillClass(e.status)]">{{ e.status.replace('_', ' ') }}</span></td>
                <td class="sub">{{ e.deadlineDate ?? '—' }}</td>
                <td class="sub">{{ e.lastActivityAt ? formatShortDate(e.lastActivityAt) : 'Not started' }}</td>
                <td>
                  <span v-if="e.remindersStopped" class="pill pill-teal">Stopped (Completed)</span>
                  <span v-else class="pill pill-outline">Active</span>
                </td>
                <td>
                  <button v-if="!e.isVirtual" class="btn btn-ghost btn-sm" @click="openEditEnrolment(e)">Edit</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="sub" style="padding: 18px">No course enrolments match the selected filters.</p>
      </div>
    </template>

    <!-- TAB 4: SETTINGS, PROVIDER SECRETS CHECKLIST & TEST -->
    <template v-else-if="activeTab === 'settings'">
      <div class="settings-grid">
        <div class="card" style="padding: 20px">
          <div class="panel-title" style="padding: 0 0 12px">
            <h3>Automation &amp; Reminder Intervals</h3>
          </div>

          <label class="toggle-row">
            <input v-model="form.enabled" type="checkbox" style="width: auto" />
            <span><b>Enable automated course monitoring &amp; emails</b></span>
          </label>
          <label class="toggle-row">
            <input v-model="form.send_course_start" type="checkbox" style="width: auto" />
            <span>Immediate email when employee starts first lesson</span>
          </label>
          <label class="toggle-row">
            <input v-model="form.send_inactivity" type="checkbox" style="width: auto" />
            <span>Inactivity reminder emails</span>
          </label>
          <label class="toggle-row">
            <input v-model="form.send_deadline_reminders" type="checkbox" style="width: auto" />
            <span>Upcoming deadline reminder emails</span>
          </label>
          <label class="toggle-row" style="margin-bottom: 16px">
            <input v-model="form.send_overdue" type="checkbox" style="width: auto" />
            <span>Overdue escalation emails</span>
          </label>

          <div class="two-col">
            <div class="field">
              <label>Inactivity threshold (days)</label>
              <input v-model.number="form.inactivity_days" type="number" min="1" max="90" />
            </div>
            <div class="field">
              <label>Deadline reminder intervals (days before)</label>
              <input v-model="reminderDaysInput" type="text" placeholder="7, 3, 1" />
            </div>
          </div>

          <div class="two-col">
            <div class="field">
              <label>Authorized Sender Name</label>
              <input v-model="form.sender_name" type="text" />
            </div>
            <div class="field">
              <label>Authorized HR/LMS Sender Email</label>
              <input v-model="form.sender_email" type="email" />
            </div>
          </div>

          <div class="two-col">
            <div class="field">
              <label>Default HR Representative CC Email</label>
              <input v-model="form.default_hr_email" type="email" placeholder="hr@company.com" />
            </div>
            <div class="field">
              <label>Email Service Provider</label>
              <select v-model="form.email_provider">
                <option value="resend">Resend API</option>
                <option value="smtp">Corporate SMTP Relay</option>
                <option value="m365">Microsoft 365 (Graph API)</option>
                <option value="google_workspace">Google Workspace (Gmail API)</option>
              </select>
            </div>
          </div>

          <div class="field">
            <label>LMS Public Base URL (used in email CTA links)</label>
            <input v-model="form.lms_base_url" type="url" placeholder="https://lms.yourcompany.com" />
          </div>

          <div class="note-box">
            <b>Required Supabase Edge Function Secrets for {{ form.email_provider.toUpperCase() }}:</b>
            <div class="sub" style="margin-top: 4px">
              Store securely via <code>supabase secrets set</code> (never stored in browser or database):
              <code>{{ providerEnvHints[form.email_provider].join(', ') }}</code>
            </div>
          </div>

          <div class="note-box" style="margin-top: 10px">
            <b>Enforced Monitoring &amp; Deduplication Rules:</b>
            <ul class="sub" style="margin: 6px 0 0 18px; line-height: 1.6">
              <li>Course-start email triggers immediately on the employee's first lesson.</li>
              <li>Inactivity reminder triggers after {{ form.inactivity_days }} consecutive idle days, resets on activity, and never sends if completed.</li>
              <li>Deadline reminders trigger at <b>7 days</b>, again at <b>3 days</b>, and a <b>final reminder at 1 day</b> before deadline.</li>
              <li>Unique <code>idempotency_key</code> constraints prevent duplicate emails for the same event.</li>
              <li>All pending reminders stop immediately when the course reaches 100% completion.</li>
            </ul>
          </div>

          <button class="btn btn-primary" style="margin-top: 14px" :disabled="savingSettings || !data?.schemaReady" @click="handleSaveSettings">
            {{ savingSettings ? 'Saving…' : 'Save Notification Settings' }}
          </button>
          <p v-if="settingsMsg" class="hint" :style="{ color: settingsMsg.ok ? 'var(--teal)' : 'var(--danger)' }">
            {{ settingsMsg.text }}
          </p>
        </div>

        <div style="display: flex; flex-direction: column; gap: 16px">
          <div class="card" style="padding: 20px">
            <div class="panel-title" style="padding: 0 0 10px">
              <h3>Send Verification Test Email</h3>
            </div>
            <p class="hint" style="margin-bottom: 12px">
              Dispatches a live HTML email through the <code>course-notification-monitor</code> Edge Function using your configured provider.
            </p>
            <div class="field">
              <label>TO recipient email</label>
              <input v-model="testToEmail" type="email" placeholder="employee@company.com" />
            </div>
            <div class="field">
              <label>CC emails (comma-separated, optional)</label>
              <input v-model="testCcEmails" type="text" placeholder="hr@company.com, manager@company.com" />
            </div>
            <button class="btn btn-primary btn-sm" :disabled="sendingTest || !data?.schemaReady" @click="handleSendTest">
              {{ sendingTest ? 'Sending…' : 'Send Test Email' }}
            </button>
            <p v-if="testMsg" class="hint" :style="{ color: testMsg.ok ? 'var(--teal)' : 'var(--danger)' }">
              {{ testMsg.text }}
            </p>
          </div>

          <div class="card" style="padding: 20px">
            <div class="panel-title" style="padding: 0 0 10px">
              <h3>Recent Learning Activity Telemetry</h3>
            </div>
            <div v-if="filteredActivity.length" style="max-height: 360px; overflow-y: auto">
              <div v-for="a in filteredActivity.slice(0, 25)" :key="a.id" class="row-item" style="cursor: default">
                <div class="row-info">
                  <div class="t">
                    {{ a.employeeName }} · <span class="pill pill-outline">{{ a.event_type.replace('_', ' ') }}</span>
                  </div>
                  <div class="m">
                    {{ a.courseTitle }}
                    <span v-if="a.progress_pct !== null"> · {{ a.progress_pct }}%</span>
                    · {{ formatShortDate(a.created_at) }}
                  </div>
                </div>
              </div>
            </div>
            <p v-else class="sub">No granular learning activity logged yet.</p>
          </div>
        </div>
      </div>
    </template>

    <!-- HTML Email Preview Modal -->
    <BaseModal v-if="previewLog" :title="previewLog.subject" wide @close="previewLog = null">
      <div class="sub" style="margin-bottom: 12px">
        <b>TO:</b> {{ previewLog.to_email }}
        <span v-if="previewLog.cc_emails?.length"> · <b>CC:</b> {{ previewLog.cc_emails.join(', ') }}</span>
      </div>
      <iframe
        :srcdoc="previewLog.html_body ?? ''"
        sandbox=""
        style="width: 100%; height: 480px; border: 1px solid var(--border); border-radius: 12px; background: #f4f5f7"
      />
    </BaseModal>

    <!-- Edit Enrolment Modal -->
    <BaseModal
      v-if="editingEnrolment"
      :title="`Edit Enrolment — ${editingEnrolment.employeeName}`"
      @close="editingEnrolment = null"
    >
      <p class="sub" style="margin-bottom: 14px">{{ editingEnrolment.courseTitle }}</p>
      <div class="field">
        <label>Completion deadline</label>
        <input v-model="editDeadline" type="date" />
      </div>
      <div class="field">
        <label>Assigned HR representative email (CC)</label>
        <input v-model="editHrEmail" type="email" placeholder="hr@company.com" />
      </div>
      <div class="field">
        <label>Reporting manager email (CC)</label>
        <input v-model="editManagerEmail" type="email" placeholder="manager@company.com" />
      </div>
      <label class="toggle-row" style="margin-bottom: 16px">
        <input v-model="editRemindersStopped" type="checkbox" style="width: auto" />
        <span>Stop all pending reminders for this enrolment</span>
      </label>
      <div class="row" style="justify-content: flex-end; gap: 8px">
        <button class="btn btn-ghost btn-sm" @click="editingEnrolment = null">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="savingEnrolment" @click="handleSaveEnrolment">
          {{ savingEnrolment ? 'Saving…' : 'Save Changes' }}
        </button>
      </div>
    </BaseModal>
  </div>
</template>

<style scoped>
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
@media (max-width: 1100px) {
  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.filter-bar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.settings-grid {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 18px;
  align-items: start;
}
@media (max-width: 1000px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 640px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  cursor: pointer;
  color: var(--ink);
  font-size: 13.5px;
}
.note-box {
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 12.5px;
}
</style>
