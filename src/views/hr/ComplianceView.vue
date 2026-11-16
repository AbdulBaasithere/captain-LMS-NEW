<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { loadMonitoringDashboardData, type MonitoringDashboardData } from '@/lib/monitoring'

const loading = ref(true)
const data = ref<MonitoringDashboardData | null>(null)
const departmentFilter = ref('All')
const search = ref('')
const tab = ref<'overdue' | 'inactive' | 'logs'>('overdue')

onMounted(async () => {
  data.value = await loadMonitoringDashboardData()
  loading.value = false
})

const departments = computed(() => {
  if (!data.value) return []
  return Array.from(new Set(data.value.profiles.map((p) => p.department).filter(Boolean))).sort()
})

function matches(item: { department: string; employeeName: string; courseTitle: string }) {
  if (departmentFilter.value !== 'All' && item.department !== departmentFilter.value) return false
  const q = search.value.trim().toLowerCase()
  if (q && !item.employeeName.toLowerCase().includes(q) && !item.courseTitle.toLowerCase().includes(q)) return false
  return true
}

const inactiveDays = computed(() => data.value?.settings.inactivity_days || 7)

const overdueList = computed(() =>
  (data.value?.enrolments ?? []).filter(
    (e) =>
      matches(e) &&
      e.status !== 'completed' &&
      !e.remindersStopped &&
      (e.status === 'overdue' || (e.daysToDeadline !== null && e.daysToDeadline < 0)),
  ),
)

const inactiveList = computed(() =>
  (data.value?.enrolments ?? []).filter(
    (e) =>
      matches(e) &&
      e.status !== 'completed' &&
      !e.remindersStopped &&
      e.daysInactive !== null &&
      e.daysInactive >= inactiveDays.value,
  ),
)

const deliveryLogs = computed(() => (data.value?.emailLogs ?? []).filter((l) => matches(l)))

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <p>HR · Compliance &amp; Notification Audit</p>
        <h2>Compliance &amp; Email Log</h2>
      </div>
    </div>

    <div class="card filter-card">
      <div class="filter-row">
        <div>
          <label for="hr-comp-dept">Department</label>
          <select id="hr-comp-dept" v-model="departmentFilter">
            <option value="All">All departments</option>
            <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>
        <div>
          <label for="hr-comp-search">Search Employee or Course</label>
          <input id="hr-comp-search" v-model="search" type="text" placeholder="Filter…" />
        </div>
      </div>
    </div>

    <div class="seg" style="margin-bottom: 16px">
      <button :class="{ on: tab === 'overdue' }" @click="tab = 'overdue'">
        Overdue ({{ overdueList.length }})
      </button>
      <button :class="{ on: tab === 'inactive' }" @click="tab = 'inactive'">
        Inactive {{ inactiveDays }}+ Days ({{ inactiveList.length }})
      </button>
      <button :class="{ on: tab === 'logs' }" @click="tab = 'logs'">
        Email Audit Log ({{ deliveryLogs.length }})
      </button>
    </div>

    <p v-if="loading" class="sub">Loading compliance records…</p>

    <div v-else-if="tab === 'overdue'" class="card">
      <div class="panel-title">
        <h3>Overdue Courses</h3>
        <span class="sub">Read-only HR compliance view</span>
      </div>
      <div v-if="overdueList.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Course</th>
              <th class="num">Progress</th>
              <th>Deadline</th>
              <th class="num">Days Overdue</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in overdueList" :key="`${e.userId}:${e.courseId}`">
              <td><b>{{ e.employeeName }}</b></td>
              <td>{{ e.department }}</td>
              <td>{{ e.courseTitle }}</td>
              <td class="num mono">{{ e.progressPct }}%</td>
              <td class="mono">{{ e.deadlineDate ?? '—' }}</td>
              <td class="num mono danger-txt">{{ Math.abs(e.daysToDeadline ?? 0) }}d</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="sub empty-msg">No overdue courses match the current filter.</p>
    </div>

    <div v-else-if="tab === 'inactive'" class="card">
      <div class="panel-title">
        <h3>Inactive Learners ({{ inactiveDays }}+ Days)</h3>
      </div>
      <div v-if="inactiveList.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Course</th>
              <th class="num">Progress</th>
              <th>Last Activity</th>
              <th class="num">Idle Days</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in inactiveList" :key="`${e.userId}:${e.courseId}`">
              <td><b>{{ e.employeeName }}</b></td>
              <td>{{ e.department }}</td>
              <td>{{ e.courseTitle }}</td>
              <td class="num mono">{{ e.progressPct }}%</td>
              <td class="sub">{{ fmtDate(e.lastActivityAt) }}</td>
              <td class="num mono warn-txt">{{ e.daysInactive }}d</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="sub empty-msg">No inactive employees exceed {{ inactiveDays }} days.</p>
    </div>

    <div v-else class="card">
      <div class="panel-title">
        <h3>Automated Notification Delivery Log</h3>
      </div>
      <div v-if="deliveryLogs.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Type</th>
              <th>Employee</th>
              <th>Course</th>
              <th>Recipients</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in deliveryLogs" :key="l.id">
              <td class="sub">{{ fmtDate(l.sent_at ?? l.created_at) }}</td>
              <td>{{ l.notification_type.replace(/_/g, ' ') }}</td>
              <td>
                <b>{{ l.employeeName }}</b>
                <div class="sub">{{ l.department }}</div>
              </td>
              <td>{{ l.courseTitle }}</td>
              <td class="sub">
                <div>TO: {{ l.to_email }}</div>
                <div v-if="l.cc_emails?.length">CC: {{ l.cc_emails.join(', ') }}</div>
              </td>
              <td :class="l.status === 'sent' ? 'ok-txt' : l.status === 'failed' ? 'danger-txt' : 'sub'">
                {{ l.status.toUpperCase() }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="sub empty-msg">No notification logs recorded yet.</p>
    </div>
  </div>
</template>

<style scoped>
.filter-card {
  padding: 14px 16px;
  margin-bottom: 16px;
}
.filter-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.filter-row label {
  display: block;
  font-size: 11.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-soft);
  margin-bottom: 5px;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.mono {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12.5px;
  font-weight: 600;
}
.ok-txt {
  color: var(--teal);
  font-weight: 700;
}
.warn-txt {
  color: var(--brass-strong);
  font-weight: 700;
}
.danger-txt {
  color: var(--danger);
  font-weight: 700;
}
.empty-msg {
  padding: 20px;
}
</style>
