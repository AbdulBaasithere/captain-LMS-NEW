<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { parseEmployeeCsv, type ParsedEmployeeRow } from '@/lib/csv'
import { loadDepartments } from '@/lib/departments'
import { useSort } from '@/composables/useSort'
import { manageEmployee, bulkInviteEmployees, isActive, initialsOf } from '@/lib/employees'
import type { Profile, Department } from '@/lib/database.types'

const auth = useAuthStore()
const employees = ref<Profile[]>([])
const today = new Date().toISOString().slice(0, 10)

const csvPreview = ref<ParsedEmployeeRow[]>([])
const csvError = ref('')
const importing = ref(false)
const retryingFailed = ref(false)
const importProgress = ref<{ done: number; total: number }>({ done: 0, total: 0 })
const importResults = ref<{ email: string; success: boolean; provider?: string; error?: string }[]>([])
const lastImportedRows = ref<ParsedEmployeeRow[]>([])

const departments = ref<Department[]>([])
const showInactive = ref(false)
const showAddForm = ref(false)
const newName = ref('')
const newEmail = ref('')
const newDepartment = ref('General')
const newRole = ref('employee')
const adding = ref(false)
const addMessage = ref<{ ok: boolean; text: string } | null>(null)
const busyId = ref<string | null>(null)
const rowError = ref('')

async function loadEmployees() {
  const { data } = await supabase.from('profiles').select('*').order('full_name')
  employees.value = data ?? []
}

onMounted(async () => {
  await loadEmployees()
  departments.value = await loadDepartments()
})

const visibleEmployees = computed(() => employees.value.filter((e) => showInactive.value || isActive(e)))
const { sorted: sortedEmployees, toggle, indicator, ariaSort } = useSort(visibleEmployees, {
  name: (e) => e.full_name,
  department: (e) => e.department,
  role: (e) => e.role,
  deadline: (e) => e.due_date,
  status: (e) => (isActive(e) ? 'Active' : 'Inactive'),
})
const inactiveCount = computed(() => employees.value.filter((e) => !isActive(e)).length)

async function addEmployee() {
  addMessage.value = null
  adding.value = true
  const result = await manageEmployee({
    action: 'create',
    email: newEmail.value,
    full_name: newName.value,
    department: newDepartment.value,
    role: newRole.value,
  })
  adding.value = false
  if (result.error) {
    addMessage.value = { ok: false, text: result.error }
    return
  }
  await logActivity(auth.profile?.id, `Added ${newName.value.trim()} as ${newRole.value} (${newDepartment.value}) and sent an invite via Resend`)
  addMessage.value = { ok: true, text: `Invite email sent via Resend to ${newEmail.value.trim()} — they can open the link to access Captain LMS.` }
  newName.value = ''
  newEmail.value = ''
  newRole.value = 'employee'
  await loadEmployees()
}

async function toggleActive(e: Profile) {
  const deactivating = isActive(e)
  if (
    deactivating &&
    !window.confirm(
      `Deactivate ${e.full_name}?\n\nThey won't be able to sign in and will disappear from reports. Their history is kept and you can reactivate them any time.`,
    )
  )
    return
  busyId.value = e.id
  rowError.value = ''
  const result = await manageEmployee({ action: deactivating ? 'deactivate' : 'reactivate', id: e.id })
  busyId.value = null
  if (result.error) {
    rowError.value = result.error
    return
  }
  await logActivity(auth.profile?.id, `${deactivating ? 'Deactivated' : 'Reactivated'} ${e.full_name}`)
  await loadEmployees()
}

async function deleteEmployee(e: Profile) {
  if (
    !window.confirm(
      `Delete ${e.full_name} permanently?\n\nThis removes their account and ALL their training history (completions, quiz attempts, badges). This cannot be undone.\n\nIf you only want to stop them signing in, use Deactivate instead.`,
    )
  )
    return
  busyId.value = e.id
  rowError.value = ''
  const result = await manageEmployee({ action: 'delete', id: e.id })
  busyId.value = null
  if (result.error) {
    rowError.value = result.error
    return
  }
  await logActivity(auth.profile?.id, `Deleted ${e.full_name}`)
  await loadEmployees()
}

function isOverdue(e: Profile) {
  return !!e.due_date && e.due_date < today
}

function onCsvSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importResults.value = []
  lastImportedRows.value = []
  csvError.value = ''
  file.text().then((text) => {
    const parsed = parseEmployeeCsv(text)
    csvPreview.value = parsed
    if (!parsed.length) {
      csvError.value = 'No valid employee rows found. Make sure the CSV has Name, Email, Department headers and at least one valid email row.'
    }
  })
}

const failedRetryRows = computed(() => {
  const failedEmails = new Set(
    importResults.value.filter((r) => !r.success && r.email).map((r) => r.email.trim().toLowerCase()),
  )
  return lastImportedRows.value.filter((r) => failedEmails.has(r.email.trim().toLowerCase()))
})

async function runImport() {
  if (!csvPreview.value.length || importing.value || retryingFailed.value) return
  const rowsToInvite = [...csvPreview.value]
  importing.value = true
  importResults.value = []
  csvError.value = ''
  lastImportedRows.value = rowsToInvite
  importProgress.value = { done: 0, total: rowsToInvite.length }

  const { results, error } = await bulkInviteEmployees(rowsToInvite, (done, total) => {
    importProgress.value = { done, total }
  })
  importResults.value = results
  if (error) {
    csvError.value = error
  }

  const successCount = results.filter((r) => r.success).length
  if (successCount > 0) {
    await logActivity(auth.profile?.id, `Bulk-invited ${successCount} of ${rowsToInvite.length} employees via Resend CSV import`)
    await loadEmployees()
  }
  if (results.length > 0) {
    csvPreview.value = []
  }
  importing.value = false
}

async function retryFailedImport() {
  const rowsToRetry = [...failedRetryRows.value]
  if (!rowsToRetry.length || importing.value || retryingFailed.value) return

  retryingFailed.value = true
  csvError.value = ''
  importProgress.value = { done: 0, total: rowsToRetry.length }

  const { results: retryResults, error } = await bulkInviteEmployees(rowsToRetry, (done, total) => {
    importProgress.value = { done, total }
  })

  if (error) {
    csvError.value = error
  }

  const retryMap = new Map(retryResults.map((r) => [r.email.trim().toLowerCase(), r]))
  importResults.value = importResults.value.map((prev) => {
    const updated = retryMap.get(prev.email.trim().toLowerCase())
    return updated ?? prev
  })

  const retriedSuccessCount = retryResults.filter((r) => r.success).length
  if (retriedSuccessCount > 0) {
    await logActivity(
      auth.profile?.id,
      `Retried failed invites: invited ${retriedSuccessCount} of ${rowsToRetry.length} employees via Resend`,
    )
    await loadEmployees()
  }

  retryingFailed.value = false
}
</script>

<template>
  <div>
    <div class="topline">
      <div><h2>Employees</h2></div>
      <button class="btn btn-primary btn-sm" @click="showAddForm = !showAddForm">{{ showAddForm ? 'Close' : '+ Add employee' }}</button>
    </div>

    <div v-if="showAddForm" class="card" style="padding: 18px; margin-bottom: 20px; max-width: 520px">
      <div class="panel-title"><h3>Add an employee</h3></div>
      <div class="field"><label>Full name</label><input v-model="newName" type="text" /></div>
      <div class="field"><label>Work email</label><input v-model="newEmail" type="email" /></div>
      <div class="field">
        <label>Department</label>
        <select v-model="newDepartment">
          <option value="General">General</option>
          <option v-for="d in departments" :key="d.id" :value="d.name">{{ d.name }}</option>
        </select>
      </div>
      <div class="field">
        <label>Role</label>
        <select v-model="newRole">
          <option value="employee">Employee</option>
          <option value="hr">HR (company-wide KPI &amp; compliance insights, read-only)</option>
          <option value="manager">Manager (sees their department's team, read-only)</option>
          <option value="admin">Admin (full control)</option>
        </select>
      </div>
      <button class="btn btn-primary btn-sm" :disabled="adding || !newName.trim() || !newEmail.trim()" @click="addEmployee">
        {{ adding ? 'Sending invite…' : 'Send invite' }}
      </button>
      <p v-if="addMessage" class="hint" style="margin-top: 8px" :style="{ color: addMessage.ok ? 'var(--teal)' : 'var(--danger)' }">
        {{ addMessage.text }}
      </p>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 560px">
      <div class="panel-title"><h3>Bulk import (CSV)</h3></div>
      <p class="hint" style="margin-bottom: 8px">
        Upload a CSV with <code>Name, Email, Department</code> columns (header row required). Invitations are sent in
        batches via Resend so bulk imports are not limited by Supabase's 2/hour email cap.
      </p>
      <input type="file" accept=".csv,text/csv" @change="onCsvSelected" />
      <p v-if="csvError" class="hint" style="color: var(--danger); margin-top: 8px">{{ csvError }}</p>

      <div v-if="csvPreview.length" style="margin-top: 12px">
        <p class="hint">{{ csvPreview.length }} row(s) parsed:</p>
        <div v-for="(r, i) in csvPreview.slice(0, 10)" :key="i" style="font-size: 12.5px; color: var(--ink-soft)">
          {{ r.full_name }} — {{ r.email }} — {{ r.department }}
        </div>
        <p v-if="csvPreview.length > 10" class="hint">…and {{ csvPreview.length - 10 }} more</p>
        <button class="btn btn-primary btn-sm" style="margin-top: 8px" :disabled="importing || retryingFailed" @click="runImport">
          {{ importing ? `Inviting ${importProgress.done} / ${importProgress.total}…` : `Invite ${csvPreview.length} employee(s)` }}
        </button>
      </div>

      <div v-if="importResults.length" style="margin-top: 12px">
        <p class="hint" style="margin-bottom: 6px">
          {{ importResults.filter((r) => r.success).length }} invited ·
          {{ importResults.filter((r) => !r.success).length }} failed
        </p>
        <div v-for="(r, i) in importResults" :key="i" style="font-size: 12.5px" :style="{ color: r.success ? 'var(--teal)' : 'var(--danger)' }">
          {{ r.email || 'Import' }} — {{ r.success ? `Invited${r.provider ? ` (${r.provider})` : ''}` : r.error }}
        </div>
        <button
          v-if="failedRetryRows.length > 0"
          class="btn btn-ghost btn-sm"
          style="margin-top: 10px"
          :disabled="importing || retryingFailed"
          @click="retryFailedImport"
        >
          {{
            retryingFailed
              ? `Retrying ${importProgress.done} / ${importProgress.total}…`
              : `Retry Failed Invites (${failedRetryRows.length})`
          }}
        </button>
      </div>
    </div>

    <div v-if="inactiveCount" style="margin-bottom: 10px">
      <label style="display: inline-flex; align-items: center; gap: 6px; font-weight: 400">
        <input v-model="showInactive" type="checkbox" style="width: auto" />
        Show {{ inactiveCount }} inactive
      </label>
    </div>
    <p v-if="rowError" class="hint" style="color: var(--danger); margin-bottom: 8px">{{ rowError }}</p>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th class="sortable" :aria-sort="ariaSort('name')" @click="toggle('name')">
              Name <span class="sort-ind">{{ indicator('name') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('department')" @click="toggle('department')">
              Department <span class="sort-ind">{{ indicator('department') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('role')" @click="toggle('role')">
              Role <span class="sort-ind">{{ indicator('role') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('deadline')" @click="toggle('deadline')">
              Deadline <span class="sort-ind">{{ indicator('deadline') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('status')" @click="toggle('status')">
              Status <span class="sort-ind">{{ indicator('status') }}</span>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in sortedEmployees" :key="e.id" :style="{ opacity: isActive(e) ? 1 : 0.55 }">
            <td style="font-weight: 600">
              <RouterLink :to="`/admin/employees/${e.id}`" style="display: flex; align-items: center; gap: 10px; text-decoration: none">
                <div class="avatar" style="width: 26px; height: 26px; font-size: 11px">
                  {{ initialsOf(e.full_name) }}
                </div>
                {{ e.full_name }}
              </RouterLink>
            </td>
            <td>{{ e.department }}</td>
            <td><span class="pill pill-outline">{{ e.role }}</span></td>
            <td>
              <span v-if="isOverdue(e)" class="pill pill-danger">Overdue · {{ e.due_date }}</span>
              <span v-else-if="e.due_date" style="color: var(--ink-soft)">{{ e.due_date }}</span>
              <span v-else style="color: var(--ink-soft)">—</span>
            </td>
            <td><span :class="['pill', isActive(e) ? 'pill-teal' : 'pill-muted']">{{ isActive(e) ? 'Active' : 'Inactive' }}</span></td>
            <td style="white-space: nowrap">
              <RouterLink class="btn btn-ghost btn-sm" :to="`/admin/employees/${e.id}`">Edit</RouterLink>
              <button
                v-if="e.id !== auth.profile?.id"
                class="btn btn-ghost btn-sm"
                style="margin-left: 4px"
                :disabled="busyId === e.id"
                @click="toggleActive(e)"
              >
                {{ isActive(e) ? 'Deactivate' : 'Reactivate' }}
              </button>
              <button
                v-if="e.id !== auth.profile?.id"
                class="btn btn-ghost btn-sm"
                style="margin-left: 4px; color: var(--danger)"
                :disabled="busyId === e.id"
                @click="deleteEmployee(e)"
              >
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
