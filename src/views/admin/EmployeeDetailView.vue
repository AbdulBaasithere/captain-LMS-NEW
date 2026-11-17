<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { loadDepartments } from '@/lib/departments'
import { manageEmployee, isActive } from '@/lib/employees'
import { allMilestonesForTrack, milestoneLabel, attemptsFor, maxAttemptsFor, hasPassed, loadTrackData } from '@/lib/quiz'
import { loadCourses } from '@/lib/courses'
import {
  assignCourseToEmployees,
  updateCourseAssignmentDeadline,
  unassignCourseFromEmployee,
} from '@/lib/courseAssignments'
import { loadIssuedCertificates, type IssuedCertificate } from '@/lib/issuedCertificates'
import {
  loadBadgeCriteria,
  loadCustomBadges,
  loadEmployeeBadgeAwards,
  computeLearnerBadgeMetrics,
  evaluateAllBadges,
  formatDurationMinutes,
  type BadgeCriterion,
  type CustomBadge,
  type EmployeeBadgeAward,
} from '@/lib/badges'
import type {
  Course,
  CourseEnrolment,
  Department,
  Module,
  Profile,
  QuizAttempt,
  QuizAttemptGrant,
  VideoCompletion,
} from '@/lib/database.types'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const employeeId = route.params.id as string

const employee = ref<Profile | null>(null)
const attempts = ref<QuizAttempt[]>([])
const grants = ref<QuizAttemptGrant[]>([])
const loading = ref(true)
const granting = ref<string | null>(null)
const allModulesDone = ref(false)
const dueDate = ref('')
const savingDueDate = ref(false)
const escalating = ref(false)

const departments = ref<Department[]>([])
const selectedDepartment = ref('')
const savingDepartment = ref(false)
const track = ref<Module[]>([])
const completions = ref<VideoCompletion[]>([])
const badgeCriteria = ref<BadgeCriterion[]>([])
const employeeCourses = ref<Awaited<ReturnType<typeof loadCourses>>>([])
const allCourses = ref<Course[]>([])
const enrolments = ref<CourseEnrolment[]>([])
const assignCourseId = ref<number | ''>('')
const assignDeadline = ref('')
const assigningCourse = ref(false)
const assignMessage = ref<{ ok: boolean; text: string } | null>(null)
const editingEnrolmentDeadlines = ref<Record<number, string>>({})
const busyEnrolmentId = ref<number | null>(null)

const employeeIssuedCerts = ref<IssuedCertificate[]>([])
const employeeBadgeAwards = ref<EmployeeBadgeAward[]>([])
const customBadgesById = ref<Map<number, CustomBadge>>(new Map())

const managerOptions = ref<Profile[]>([])
const managerId = ref('')
const managerEmail = ref('')
const hrEmail = ref('')
const savingStakeholders = ref(false)
const stakeholderMessage = ref<{ ok: boolean; text: string } | null>(null)

const accountEmail = ref<string | null>(null)
const lastSignIn = ref<string | null>(null)
const editName = ref('')
const editRole = ref('employee')
const savingAccount = ref(false)
const accountMessage = ref<{ ok: boolean; text: string } | null>(null)
const accountBusy = ref(false)

async function loadAccountInfo() {
  const info = await manageEmployee({ action: 'get', id: employeeId })
  accountEmail.value = info.email ?? null
  lastSignIn.value = info.last_sign_in_at ?? null
}

async function saveAccount() {
  if (!employee.value) return
  accountMessage.value = null
  savingAccount.value = true
  const result = await manageEmployee({ action: 'update', id: employeeId, full_name: editName.value, role: editRole.value })
  savingAccount.value = false
  if (result.error) {
    accountMessage.value = { ok: false, text: result.error }
    return
  }
  await logActivity(auth.profile?.id, `Updated ${editName.value.trim()}'s account (name/role: ${editRole.value})`)
  accountMessage.value = { ok: true, text: 'Saved.' }
  if (employeeId === auth.profile?.id) await auth.fetchProfile()
  await load()
}

async function toggleActive() {
  if (!employee.value) return
  const deactivating = isActive(employee.value)
  if (
    deactivating &&
    !window.confirm(
      `Deactivate ${employee.value.full_name}?\n\nThey won't be able to sign in and will disappear from the leaderboard and reports. Their history is kept and you can reactivate them any time.`,
    )
  )
    return
  accountMessage.value = null
  accountBusy.value = true
  const result = await manageEmployee({ action: deactivating ? 'deactivate' : 'reactivate', id: employeeId })
  accountBusy.value = false
  if (result.error) {
    accountMessage.value = { ok: false, text: result.error }
    return
  }
  await logActivity(auth.profile?.id, `${deactivating ? 'Deactivated' : 'Reactivated'} ${employee.value.full_name}`)
  await load()
}

async function deleteAccount() {
  if (!employee.value) return
  if (
    !window.confirm(
      `Delete ${employee.value.full_name} permanently?\n\nThis removes their account and ALL their training history (completions, quiz attempts, badges). This cannot be undone.\n\nIf you only want to stop them signing in, use Deactivate instead.`,
    )
  )
    return
  accountMessage.value = null
  accountBusy.value = true
  const name = employee.value.full_name
  const result = await manageEmployee({ action: 'delete', id: employeeId })
  accountBusy.value = false
  if (result.error) {
    accountMessage.value = { ok: false, text: result.error }
    return
  }
  await logActivity(auth.profile?.id, `Deleted ${name}`)
  router.push('/admin/employees')
}

async function load() {
  loading.value = true
  const [{ data: emp }, { data: att }, { data: grt }, depts, { data: mgrs }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', employeeId).single(),
    supabase.from('quiz_attempts').select('*').eq('user_id', employeeId),
    supabase.from('quiz_attempt_grants').select('*').eq('user_id', employeeId),
    loadDepartments(),
    supabase.from('profiles').select('*').in('role', ['manager', 'admin']).order('full_name'),
  ])
  employee.value = emp
  attempts.value = att ?? []
  grants.value = grt ?? []
  dueDate.value = emp?.due_date ?? ''
  departments.value = depts
  selectedDepartment.value = emp?.department ?? 'General'
  editName.value = emp?.full_name ?? ''
  editRole.value = emp?.role ?? 'employee'
  managerOptions.value = ((mgrs ?? []) as Profile[]).filter((m) => m.id !== employeeId && isActive(m))
  managerId.value = emp?.manager_id ?? ''
  managerEmail.value = emp?.manager_email ?? ''
  hrEmail.value = emp?.hr_email ?? ''

  if (emp) {
    const [trackData, badgeRes, { data: courseRows }, { data: enrolRows }, issuedRes, customRes, awardsRes] =
      await Promise.all([
        loadTrackData(employeeId, emp.department),
        loadBadgeCriteria({ includeInactive: false }),
        supabase.from('courses').select('*').order('title'),
        supabase.from('course_enrolments').select('*').eq('user_id', employeeId).order('enrolled_at', { ascending: false }),
        loadIssuedCertificates({ userId: employeeId }),
        loadCustomBadges({ includeInactive: true }),
        loadEmployeeBadgeAwards({ userId: employeeId }),
      ])
    track.value = trackData.track
    completions.value = trackData.completions
    employeeCourses.value = await loadCourses(trackData.track)
    badgeCriteria.value = badgeRes.criteria
    allCourses.value = (courseRows ?? []) as Course[]
    enrolments.value = (enrolRows ?? []) as CourseEnrolment[]
    editingEnrolmentDeadlines.value = Object.fromEntries(
      enrolments.value.map((e) => [e.id, e.deadline_date ?? '']),
    )
    assignDeadline.value = emp.due_date ?? ''
    employeeIssuedCerts.value = issuedRes.certificates
    employeeBadgeAwards.value = awardsRes.awards
    customBadgesById.value = new Map(customRes.badges.map((b) => [b.id, b]))
    const doneIds = new Set(trackData.completions.filter((c) => c.completed).map((c) => c.module_id))
    allModulesDone.value = trackData.track.length > 0 && trackData.track.every((m) => doneIds.has(m.id))
  }
  loading.value = false
}

const coursesById = computed(() => {
  const m = new Map<number, Course>()
  for (const c of allCourses.value) m.set(c.id, c)
  return m
})

const assignableCourses = computed(() => {
  const assignedIds = new Set(enrolments.value.map((e) => e.course_id))
  return allCourses.value.filter((c) => !assignedIds.has(c.id))
})

async function handleAssignCourse() {
  if (!employee.value || !assignCourseId.value) return
  const c = coursesById.value.get(Number(assignCourseId.value))
  if (!c) return
  assigningCourse.value = true
  assignMessage.value = null
  const profilesMap = new Map<string, Profile>([[employee.value.id, employee.value]])
  const res = await assignCourseToEmployees({
    courseId: c.id,
    courseTitle: c.title,
    userIds: [employee.value.id],
    deadlineDate: assignDeadline.value || null,
    assignedBy: auth.profile?.id,
    profilesById: profilesMap,
  })
  assigningCourse.value = false
  if (!res.ok) {
    assignMessage.value = { ok: false, text: res.error ?? 'Could not assign course.' }
    return
  }
  await logActivity(auth.profile?.id, `Assigned course "${c.title}" to ${employee.value.full_name}`)
  assignMessage.value = { ok: true, text: `Assigned "${c.title}" to ${employee.value.full_name}.` }
  assignCourseId.value = ''
  await load()
}

async function handleSaveEnrolmentDeadline(e: CourseEnrolment) {
  busyEnrolmentId.value = e.id
  const nextDate = editingEnrolmentDeadlines.value[e.id] ?? ''
  const res = await updateCourseAssignmentDeadline({
    enrolmentId: e.id,
    deadlineDate: nextDate || null,
    isCompleted: e.status === 'completed' || Boolean(e.completed_at),
    hasStarted: e.status === 'in_progress' || e.progress_pct > 0 || Boolean(e.started_at),
  })
  busyEnrolmentId.value = null
  if (!res.ok) {
    assignMessage.value = { ok: false, text: res.error ?? 'Could not update deadline.' }
    return
  }
  const cTitle = coursesById.value.get(e.course_id)?.title ?? `Course #${e.course_id}`
  await logActivity(auth.profile?.id, `Updated deadline for "${cTitle}" (${employee.value?.full_name})`)
  assignMessage.value = { ok: true, text: `Updated deadline for "${cTitle}".` }
  await load()
}

async function handleUnassignCourse(e: CourseEnrolment) {
  const cTitle = coursesById.value.get(e.course_id)?.title ?? `Course #${e.course_id}`
  if (!window.confirm(`Remove assignment of "${cTitle}" from ${employee.value?.full_name}?`)) return
  busyEnrolmentId.value = e.id
  const res = await unassignCourseFromEmployee(e.id)
  busyEnrolmentId.value = null
  if (!res.ok) {
    assignMessage.value = { ok: false, text: res.error ?? 'Could not unassign course.' }
    return
  }
  await logActivity(auth.profile?.id, `Unassigned course "${cTitle}" from ${employee.value?.full_name}`)
  assignMessage.value = { ok: true, text: `Removed "${cTitle}" assignment.` }
  await load()
}

onMounted(async () => {
  await load()
  await loadAccountInfo()
})

async function saveDepartment() {
  if (!employee.value || selectedDepartment.value === employee.value.department) return
  const fromDept = employee.value.department
  const toDept = selectedDepartment.value
  const confirmed = window.confirm(
    `Move ${employee.value.full_name} from ${fromDept} to ${toDept}?\n\nThis permanently clears their training history — every module completion, quiz attempt, badge, and granted extra attempt — since it no longer applies to the new department's track. This cannot be undone.`,
  )
  if (!confirmed) return

  savingDepartment.value = true
  await supabase.from('profiles').update({ department: toDept }).eq('id', employeeId)
  await Promise.all([
    supabase.from('video_completions').delete().eq('user_id', employeeId),
    supabase.from('quiz_attempts').delete().eq('user_id', employeeId),
    supabase.from('quiz_attempt_grants').delete().eq('user_id', employeeId),
  ])
  await logActivity(
    auth.profile?.id,
    `Moved ${employee.value.full_name} from ${fromDept} to ${toDept} and cleared their training history`,
  )
  savingDepartment.value = false
  await load()
}

const isOverdue = computed(() => !!dueDate.value && !allModulesDone.value && dueDate.value < new Date().toISOString().slice(0, 10))

async function saveDueDate() {
  savingDueDate.value = true
  await supabase.from('profiles').update({ due_date: dueDate.value || null }).eq('id', employeeId)
  await supabase
    .from('course_enrolments')
    .update({ deadline_date: dueDate.value || null, updated_at: new Date().toISOString() })
    .eq('user_id', employeeId)
    .is('completed_at', null)
  await logActivity(auth.profile?.id, `Set a training deadline of ${dueDate.value} for ${employee.value?.full_name}`)
  savingDueDate.value = false
  await load()
}

async function saveStakeholders() {
  if (!employee.value) return
  savingStakeholders.value = true
  stakeholderMessage.value = null
  const selectedMgr = managerOptions.value.find((m) => m.id === managerId.value)
  const resolvedMgrEmail = managerEmail.value.trim() || selectedMgr?.email || null
  const resolvedHrEmail = hrEmail.value.trim() || null

  const { error } = await supabase
    .from('profiles')
    .update({
      manager_id: managerId.value || null,
      manager_email: resolvedMgrEmail,
      hr_email: resolvedHrEmail,
    })
    .eq('id', employeeId)

  if (error) {
    savingStakeholders.value = false
    stakeholderMessage.value = { ok: false, text: error.message }
    return
  }

  await supabase
    .from('course_enrolments')
    .update({
      manager_email: resolvedMgrEmail,
      hr_email: resolvedHrEmail,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', employeeId)
    .is('completed_at', null)

  await logActivity(auth.profile?.id, `Updated HR & reporting manager contacts for ${employee.value.full_name}`)
  savingStakeholders.value = false
  stakeholderMessage.value = { ok: true, text: 'Notification contacts saved.' }
  await load()
}

async function sendEscalation() {
  escalating.value = true
  await supabase.from('notifications').insert({
    user_id: employeeId,
    text: `Reminder: your training deadline (${dueDate.value}) has passed — please complete your remaining modules.`,
    action: null,
  })
  await logActivity(auth.profile?.id, `Sent a compliance escalation notice to ${employee.value?.full_name}`)
  escalating.value = false
}

const badgeSummary = computed(() => {
  const metrics = computeLearnerBadgeMetrics({
    courses: employeeCourses.value.filter((c) => c.lessons.length > 0),
    completions: completions.value,
    passedAttempts: attempts.value.filter((a) => a.passed),
    extraCertificatesCount: employeeIssuedCerts.value.length,
  })
  const evaluations = evaluateAllBadges(badgeCriteria.value, metrics)
  return { metrics, evaluations }
})

const rows = computed(() =>
  allMilestonesForTrack(track.value).map((m) => {
    const used = attemptsFor(m, attempts.value)
    return {
      milestone: m,
      label: milestoneLabel(m, track.value),
      used: used.length,
      max: maxAttemptsFor(m, grants.value),
      passed: hasPassed(m, attempts.value),
    }
  }),
)

async function grantExtra(milestone: string) {
  if (!auth.profile) return
  granting.value = milestone
  await supabase.from('quiz_attempt_grants').insert({
    user_id: employeeId,
    milestone,
    extra_attempts: 1,
    granted_by: auth.profile.id,
  })
  await logActivity(auth.profile.id, `Granted ${employee.value?.full_name} an extra attempt on ${milestoneLabel(milestone, track.value)}`)
  granting.value = null
  await load()
}
</script>

<template>
  <div v-if="loading" style="color: var(--ink-soft)">Loading…</div>
  <div v-else-if="employee">
    <div class="topline">
      <div>
        <h2 style="font-size: 20px">{{ employee.full_name }}</h2>
        <p>{{ employee.department }} · {{ employee.role }}</p>
      </div>
      <button class="btn btn-ghost btn-sm" @click="router.push('/admin/employees')">Back to employees</button>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 420px">
      <div class="panel-title">
        <h3>Account</h3>
        <span :class="['pill', isActive(employee) ? 'pill-teal' : 'pill-muted']">{{ isActive(employee) ? 'Active' : 'Inactive' }}</span>
      </div>
      <p class="hint" style="margin-bottom: 10px">
        {{ accountEmail ?? '…' }}
        <template v-if="lastSignIn"> · last sign-in {{ new Date(lastSignIn).toLocaleDateString() }}</template>
        <template v-else-if="accountEmail"> · hasn't signed in yet</template>
      </p>
      <div class="field"><label>Full name</label><input v-model="editName" type="text" /></div>
      <div class="field">
        <label>Role</label>
        <select v-model="editRole">
          <option value="employee">Employee</option>
          <option value="hr">HR</option>
          <option value="manager">Manager</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <button
          class="btn btn-ghost btn-sm"
          :disabled="savingAccount || (editName.trim() === employee.full_name && editRole === employee.role)"
          @click="saveAccount"
        >
          {{ savingAccount ? 'Saving…' : 'Save' }}
        </button>
        <template v-if="employee.id !== auth.profile?.id">
          <button class="btn btn-ghost btn-sm" :disabled="accountBusy" @click="toggleActive">
            {{ isActive(employee) ? 'Deactivate' : 'Reactivate' }}
          </button>
          <button class="btn btn-ghost btn-sm" style="color: var(--danger)" :disabled="accountBusy" @click="deleteAccount">Delete</button>
        </template>
      </div>
      <p v-if="accountMessage" class="hint" style="margin-top: 8px" :style="{ color: accountMessage.ok ? 'var(--teal)' : 'var(--danger)' }">
        {{ accountMessage.text }}
      </p>
      <p class="hint" style="margin-top: 8px">
        Deactivate stops them signing in and hides them from the leaderboard and reports, keeping their history.
        Delete removes the account and all their progress permanently.
      </p>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 420px">
      <div class="panel-title"><h3>Department</h3></div>
      <div class="field">
        <label>Department</label>
        <select v-model="selectedDepartment">
          <option value="General">General</option>
          <option v-for="d in departments" :key="d.id" :value="d.name">{{ d.name }}</option>
        </select>
      </div>
      <button class="btn btn-ghost btn-sm" :disabled="savingDepartment || selectedDepartment === employee.department" @click="saveDepartment">
        {{ savingDepartment ? 'Saving…' : 'Save department' }}
      </button>
      <p class="hint" style="margin-top: 8px">
        Changing this clears their training history — module completions, quiz attempts, badges, and any granted
        extra attempts — since none of it applies to the new department's track. You'll be asked to confirm.
      </p>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 420px">
      <div class="panel-title"><h3>Compliance deadline</h3></div>
      <div class="field">
        <label>Due date</label>
        <input v-model="dueDate" type="date" />
      </div>
      <div style="display: flex; gap: 8px; align-items: center">
        <button class="btn btn-ghost btn-sm" :disabled="savingDueDate" @click="saveDueDate">
          {{ savingDueDate ? 'Saving…' : 'Save deadline' }}
        </button>
        <span v-if="isOverdue" class="pill pill-danger">Overdue</span>
      </div>
      <button v-if="isOverdue" class="btn btn-primary btn-sm" style="margin-top: 10px" :disabled="escalating" @click="sendEscalation">
        {{ escalating ? 'Sending…' : 'Send escalation notice' }}
      </button>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 420px">
      <div class="panel-title"><h3>HR &amp; Manager Email CC</h3></div>
      <div class="field">
        <label>Reporting manager</label>
        <select v-model="managerId">
          <option value="">None (use department manager or manual email)</option>
          <option v-for="m in managerOptions" :key="m.id" :value="m.id">
            {{ m.full_name }} ({{ m.department }}{{ m.email ? ` · ${m.email}` : '' }})
          </option>
        </select>
      </div>
      <div class="field">
        <label>Reporting manager email (override)</label>
        <input v-model="managerEmail" type="email" placeholder="manager@company.com" />
      </div>
      <div class="field">
        <label>Assigned HR representative email</label>
        <input v-model="hrEmail" type="email" placeholder="hr@company.com" />
      </div>
      <button class="btn btn-ghost btn-sm" :disabled="savingStakeholders" @click="saveStakeholders">
        {{ savingStakeholders ? 'Saving…' : 'Save CC contacts' }}
      </button>
      <p
        v-if="stakeholderMessage"
        class="hint"
        style="margin-top: 8px"
        :style="{ color: stakeholderMessage.ok ? 'var(--teal)' : 'var(--danger)' }"
      >
        {{ stakeholderMessage.text }}
      </p>
      <p class="hint" style="margin-top: 8px">
        Copied automatically on course-start, 7-day inactivity, deadline, and overdue email alerts.
      </p>
    </div>

    <!-- Assigned Courses Management Card -->
    <div class="card" style="margin-bottom: 20px">
      <div class="panel-title">
        <div>
          <h3>Assigned Courses</h3>
          <p class="sub" style="margin: 2px 0 0">
            Assign any course directly to {{ employee.full_name }} (including cross-department courses) and manage deadlines.
          </p>
        </div>
        <span class="sub tabular" style="font-weight: 700">{{ enrolments.length }} assigned</span>
      </div>

      <div style="padding: 12px 18px 16px; border-bottom: 1px solid var(--border)">
        <div class="row wrap" style="gap: 10px; align-items: flex-end">
          <div class="field" style="flex: 2; min-width: 220px; margin: 0">
            <label>Assign a course</label>
            <select v-model="assignCourseId">
              <option value="">Select course…</option>
              <option v-for="c in assignableCourses" :key="c.id" :value="c.id">
                {{ c.title }} · {{ c.category }}{{ c.is_published ? '' : ' (Hidden)' }}
              </option>
            </select>
          </div>
          <div class="field" style="width: 170px; margin: 0">
            <label>Deadline (optional)</label>
            <input v-model="assignDeadline" type="date" />
          </div>
          <button
            class="btn btn-primary btn-sm"
            :disabled="assigningCourse || !assignCourseId"
            @click="handleAssignCourse"
          >
            {{ assigningCourse ? 'Assigning…' : '+ Assign course' }}
          </button>
        </div>
        <p
          v-if="assignMessage"
          class="hint"
          style="margin-top: 8px; margin-bottom: 0"
          :style="{ color: assignMessage.ok ? 'var(--teal)' : 'var(--danger)' }"
        >
          {{ assignMessage.text }}
        </p>
      </div>

      <div v-if="!enrolments.length" class="sub" style="padding: 18px">
        No courses assigned yet. Pick a course above to assign it to {{ employee.full_name }}.
      </div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Course</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Deadline</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in enrolments" :key="e.id">
              <td>
                <RouterLink
                  :to="`/admin/courses/${e.course_id}`"
                  style="font-weight: 600; text-decoration: none; color: var(--ink)"
                >
                  {{ coursesById.get(e.course_id)?.title ?? `Course #${e.course_id}` }}
                </RouterLink>
                <div class="sub">
                  {{ coursesById.get(e.course_id)?.category ?? '—' }}
                  <template v-if="e.assigned_by"> · Assigned by admin</template>
                </div>
              </td>
              <td>
                <span
                  :class="[
                    'pill',
                    e.status === 'completed'
                      ? 'pill-teal'
                      : e.status === 'overdue'
                        ? 'pill-danger'
                        : e.status === 'in_progress'
                          ? 'pill-brass'
                          : 'pill-muted',
                  ]"
                >
                  {{ e.status.replace('_', ' ') }}
                </span>
              </td>
              <td class="tabular">{{ e.progress_pct }}%</td>
              <td>
                <div class="row" style="gap: 6px">
                  <input
                    v-model="editingEnrolmentDeadlines[e.id]"
                    type="date"
                    style="width: 145px"
                  />
                  <button
                    class="btn btn-ghost btn-sm"
                    :disabled="busyEnrolmentId === e.id"
                    @click="handleSaveEnrolmentDeadline(e)"
                  >
                    Save
                  </button>
                </div>
              </td>
              <td>
                <button
                  class="btn btn-ghost btn-sm"
                  style="color: var(--danger)"
                  :disabled="busyEnrolmentId === e.id"
                  @click="handleUnassignCourse(e)"
                >
                  Unassign
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom: 20px">
      <div class="panel-title">
        <h3>Milestone &amp; Badge Eligibility</h3>
        <div class="row wrap" style="gap: 8px">
          <RouterLink class="btn btn-ghost btn-sm" to="/admin/certificates">Issue certificate &rarr;</RouterLink>
          <RouterLink class="btn btn-ghost btn-sm" to="/admin/badges?tab=custom">Award badge &rarr;</RouterLink>
          <RouterLink class="btn btn-ghost btn-sm" to="/admin/badges">Configure rules &rarr;</RouterLink>
        </div>
      </div>
      <div style="padding: 8px 18px 14px; font-size: 13px; color: var(--ink-soft); font-variant-numeric: tabular-nums">
        Coursework completed: <b style="color: var(--ink)">{{ formatDurationMinutes(badgeSummary.metrics.completedCourseDurationMinutes) }}</b>
        · Courses completed: <b style="color: var(--ink)">{{ badgeSummary.metrics.coursesCompleted }}</b>
        · Certificates earned: <b style="color: var(--ink)">{{ badgeSummary.metrics.certificatesEarned }}</b>
        <template v-if="employeeBadgeAwards.length">
          · Custom badges: <b style="color: var(--ink)">{{ employeeBadgeAwards.length }}</b>
        </template>
      </div>
      <div v-if="employeeBadgeAwards.length" style="padding: 0 18px 12px; font-size: 12.5px; color: var(--teal); font-weight: 600">
        Direct awards:
        {{
          employeeBadgeAwards
            .map((aw) => `${customBadgesById.get(aw.badgeId)?.icon ?? '🏅'} ${customBadgesById.get(aw.badgeId)?.name ?? 'Badge'}`)
            .join(', ')
        }}
      </div>
      <div v-if="employeeIssuedCerts.length" style="padding: 0 18px 12px; font-size: 12.5px; color: var(--ink-soft)">
        Issued certificates:
        <b style="color: var(--ink)">{{ employeeIssuedCerts.map((c) => c.title).join(', ') }}</b>
      </div>
      <div v-for="ev in badgeSummary.evaluations" :key="ev.badge.id" class="row-item" style="cursor: default">
        <div style="font-size: 20px; width: 28px; text-align: center">{{ ev.badge.icon }}</div>
        <div class="row-info">
          <div class="t">{{ ev.badge.name }}</div>
          <div class="m" style="font-variant-numeric: tabular-nums">{{ ev.summaryHint }}</div>
        </div>
        <span :style="{ fontWeight: 700, fontSize: '12px', color: ev.eligible ? 'var(--teal)' : 'var(--ink-soft)', fontVariantNumeric: 'tabular-nums' }">
          {{ ev.eligible ? 'Eligible · Unlocked' : `${ev.overallPct}%` }}
        </span>
      </div>
    </div>

    <div class="card">
      <div class="panel-title"><h3>Quiz attempts</h3></div>
      <div v-for="r in rows" :key="r.milestone" class="row-item" style="cursor: default">
        <div class="row-info">
          <div class="t">{{ r.label }}</div>
          <div class="m">
            {{ r.used }} of {{ r.max }} attempts used
            <span v-if="r.passed" class="pill pill-teal" style="margin-left: 6px">Passed</span>
            <span v-else-if="r.used >= r.max" class="pill pill-danger" style="margin-left: 6px">Locked</span>
          </div>
        </div>
        <button
          v-if="!r.passed && r.used >= r.max"
          class="btn btn-ghost btn-sm"
          :disabled="granting === r.milestone"
          @click="grantExtra(r.milestone)"
        >
          {{ granting === r.milestone ? 'Granting…' : 'Grant extra attempt' }}
        </button>
      </div>
    </div>
  </div>
</template>
