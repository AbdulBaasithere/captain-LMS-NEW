<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useSort } from '@/composables/useSort'
import {
  DEFAULT_KPI_TARGETS,
  computeFilteredKpiSnapshot,
  loadKpiDataset,
  saveKpiTargets,
  type ComplianceStatus,
  type CourseKpiMetric,
  type DepartmentKpiMetric,
  type EmployeeKpiMetric,
  type KpiDataset,
  type KpiDateRange,
  type KpiFilterState,
  type KpiTargetsConfig,
  type MonthlyTrendMetric,
} from '@/lib/analyticsKpi'
import { exportKpiCsv, exportKpiPdf, type KpiCsvDataset } from '@/lib/kpiExport'
import type { Role } from '@/lib/database.types'
import { isoDay, relativeTime } from '@/lib/learning'
import { initialsOf } from '@/lib/employees'
import BaseModal from '@/components/BaseModal.vue'
import KpiSummaryStrip from './KpiSummaryStrip.vue'
import CompletionRateWidget from './CompletionRateWidget.vue'
import QuizPerformanceWidget from './QuizPerformanceWidget.vue'
import ActiveUserTrendsWidget from './ActiveUserTrendsWidget.vue'
import ComplianceDistributionWidget from './ComplianceDistributionWidget.vue'
import KpiChartsModule, { type KpiTableTab } from './KpiChartsModule.vue'

const props = defineProps<{
  role: Role
  title?: string
  subtitle?: string
}>()

const auth = useAuthStore()
const dataset = ref<KpiDataset | null>(null)
const loading = ref(true)
const loadError = ref('')
const exportingPdf = ref(false)
const exportingCsv = ref(false)
const actionFeedback = ref<{ ok: boolean; text: string } | null>(null)

const filters = reactive<KpiFilterState>({
  dateRange: 'all',
  startDate: '',
  endDate: '',
  department: 'All',
  courseId: 'All',
  status: 'All',
  search: '',
})

const activeTableTab = ref<KpiTableTab>(
  props.role === 'employee' ? 'courses' : 'employees',
)
const showTableCharts = ref(true)
const csvDataset = ref<KpiCsvDataset>(
  props.role === 'employee' ? 'courses' : 'employees',
)

// Chart container refs exposed by Recharts widgets for PDF snapshotting
const completionWidgetRef = ref<{ chartWrapEl: HTMLElement | null } | null>(null)
const quizWidgetRef = ref<{ chartWrapEl: HTMLElement | null } | null>(null)
const trendsWidgetRef = ref<{ chartWrapEl: HTMLElement | null } | null>(null)
const complianceWidgetRef = ref<{ chartWrapEl: HTMLElement | null } | null>(null)
const tableChartsWidgetRef = ref<{ chartWrapEl: HTMLElement | null } | null>(null)

// KPI Target modal (Admin & HR)
const showTargetsModal = ref(false)
const savingTargets = ref(false)
const targetsForm = ref<KpiTargetsConfig>({ ...DEFAULT_KPI_TARGETS })
const targetsError = ref('')

const isCompanyScope = computed(() => props.role === 'admin' || props.role === 'hr')
const isPersonal = computed(() => props.role === 'employee')
const canEditTargets = computed(() => props.role === 'admin' || props.role === 'hr')

async function loadData() {
  if (!auth.profile) return
  loading.value = true
  loadError.value = ''
  try {
    const loaded = await loadKpiDataset(props.role, auth.profile.id, auth.profile.department)
    dataset.value = loaded
    targetsForm.value = { ...loaded.targets }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Unable to load KPI analytics dataset.'
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

const snapshot = computed(() => {
  if (!dataset.value) return null
  return computeFilteredKpiSnapshot(dataset.value, filters)
})

const employeeRows = computed<EmployeeKpiMetric[]>(() => snapshot.value?.employees ?? [])
const departmentRows = computed<DepartmentKpiMetric[]>(() => snapshot.value?.departments ?? [])
const courseRows = computed<CourseKpiMetric[]>(() => snapshot.value?.courses ?? [])
const trendRows = computed<MonthlyTrendMetric[]>(() => snapshot.value?.monthlyTrends ?? [])

const empSort = useSort(employeeRows, {
  rank: (e) => e.rankOverall,
  name: (e) => e.fullName,
  department: (e) => e.department,
  completion: (e) => e.completionRatePct,
  hours: (e) => e.learningHours,
  quizAvg: (e) => e.avgQuizScorePct,
  passRate: (e) => e.quizPassRatePct,
  overdue: (e) => e.overdueLessons,
  status: (e) => e.complianceStatus,
  effectiveness: (e) => e.effectivenessIndex,
})

const deptSort = useSort(departmentRows, {
  department: (d) => d.department,
  employees: (d) => d.employeeCount,
  participation: (d) => d.participationRatePct,
  completion: (d) => d.avgCompletionRatePct,
  hours: (d) => d.totalLearningHours,
  quizAvg: (d) => d.avgQuizScorePct,
  passRate: (d) => d.quizPassRatePct,
  compliance: (d) => d.complianceRatePct,
  effectiveness: (d) => d.trainingEffectivenessScore,
})

const courseSort = useSort(courseRows, {
  title: (c) => c.courseTitle,
  category: (c) => c.category,
  participation: (c) => c.participationRatePct,
  completion: (c) => c.completionRatePct,
  dropOff: (c) => c.dropOffRatePct,
  hours: (c) => c.learningHours,
  quizAvg: (c) => c.avgQuizScorePct,
  passRate: (c) => c.quizPassRatePct,
  overdue: (c) => c.overdueLearners,
  effectiveness: (c) => c.trainingEffectivenessScore,
})

const trendsSort = useSort(trendRows, {
  month: (t) => t.monthKey,
  activeUsers: (t) => t.activeUsers,
  completions: (t) => t.lessonCompletions,
  monthlyRate: (t) => t.completionRatePct,
  cumulativeRate: (t) => t.cumulativeCompletionRatePct,
  hours: (t) => t.learningHours,
  attempts: (t) => t.quizAttempts,
  quizAvg: (t) => t.avgQuizScorePct,
  passRate: (t) => t.quizPassRatePct,
})

const hasActiveFilters = computed(
  () =>
    filters.dateRange !== 'all' ||
    filters.startDate.trim().length > 0 ||
    filters.endDate.trim().length > 0 ||
    filters.department !== 'All' ||
    filters.courseId !== 'All' ||
    filters.status !== 'All' ||
    filters.search.trim().length > 0,
)

const activeFilterSummary = computed(() => {
  const parts: string[] = []
  if (filters.dateRange === 'custom') {
    parts.push(`${filters.startDate || 'Start'} to ${filters.endDate || 'Today'}`)
  } else if (filters.dateRange !== 'all') {
    parts.push(dateOptions.find((o) => o.value === filters.dateRange)?.label ?? filters.dateRange)
  } else {
    parts.push('All time')
  }
  if (isCompanyScope.value) {
    parts.push(filters.department === 'All' ? 'All departments' : filters.department)
  } else if (auth.profile?.department) {
    parts.push(auth.profile.department)
  }
  return parts.join(' · ')
})

function onDateRangeSelect(next: KpiDateRange) {
  filters.dateRange = next
  if (next === 'custom') {
    if (!filters.endDate) filters.endDate = isoDay(new Date())
    if (!filters.startDate) {
      const start = new Date()
      start.setDate(start.getDate() - 30)
      filters.startDate = isoDay(start)
    }
  } else {
    filters.startDate = ''
    filters.endDate = ''
  }
}

function onCustomDateChange() {
  if (filters.startDate || filters.endDate) {
    filters.dateRange = 'custom'
  } else if (filters.dateRange === 'custom') {
    filters.dateRange = 'all'
  }
}

function resetFilters() {
  filters.dateRange = 'all'
  filters.startDate = ''
  filters.endDate = ''
  filters.department = 'All'
  filters.courseId = 'All'
  filters.status = 'All'
  filters.search = ''
}

function complianceColorClass(status: ComplianceStatus): string {
  if (status === 'Compliant') return 'st-ok'
  if (status === 'In Progress') return 'st-blue'
  if (status === 'At Risk') return 'st-warn'
  return 'st-danger'
}

function complianceGlyph(status: ComplianceStatus): string {
  if (status === 'Compliant') return '✓'
  if (status === 'In Progress') return '→'
  if (status === 'At Risk') return '▲'
  return '!'
}

async function handleCsvExport(targetDataset?: KpiCsvDataset) {
  if (!snapshot.value) return
  const chosen = targetDataset ?? csvDataset.value
  exportingCsv.value = true
  actionFeedback.value = null
  try {
    await exportKpiCsv({
      dataset: chosen,
      snapshot: {
        ...snapshot.value,
        employees: empSort.sorted.value,
        departments: deptSort.sorted.value,
        courses: courseSort.sorted.value,
        monthlyTrends: trendsSort.sorted.value,
      },
      filters: { ...filters },
      role: props.role,
      userId: auth.profile?.id,
    })
    actionFeedback.value = {
      ok: true,
      text: chosen === 'all' ? 'Exported complete KPI workbook as CSV.' : `Exported ${chosen} KPI table as CSV.`,
    }
  } catch (err) {
    actionFeedback.value = { ok: false, text: err instanceof Error ? err.message : 'CSV export failed.' }
  } finally {
    exportingCsv.value = false
  }
}

async function handlePdfExport() {
  if (!snapshot.value) return
  exportingPdf.value = true
  actionFeedback.value = null
  try {
    await exportKpiPdf({
      snapshot: snapshot.value,
      filters: { ...filters },
      role: props.role,
      viewerName: auth.profile?.full_name ?? 'Captain LMS User',
      userId: auth.profile?.id,
      chartContainers: [
        { title: 'Course Completion & Participation Rate', el: completionWidgetRef.value?.chartWrapEl ?? null },
        { title: 'Quiz Performance & Training Effectiveness', el: quizWidgetRef.value?.chartWrapEl ?? null },
        { title: 'Completion Rate & Monthly Learning Trends', el: trendsWidgetRef.value?.chartWrapEl ?? null },
        { title: 'Training Compliance Breakdown', el: complianceWidgetRef.value?.chartWrapEl ?? null },
        { title: 'Table KPI Visualization Module', el: tableChartsWidgetRef.value?.chartWrapEl ?? null },
      ],
    })
    actionFeedback.value = { ok: true, text: 'Generated and downloaded PDF KPI report.' }
  } catch (err) {
    actionFeedback.value = { ok: false, text: err instanceof Error ? err.message : 'PDF export failed.' }
  } finally {
    exportingPdf.value = false
  }
}

async function handleSaveTargets() {
  savingTargets.value = true
  targetsError.value = ''
  const res = await saveKpiTargets(targetsForm.value, auth.profile?.id)
  savingTargets.value = false
  if (!res.ok) {
    targetsError.value = res.error ?? 'Failed to save KPI targets.'
    return
  }
  showTargetsModal.value = false
  actionFeedback.value = { ok: true, text: 'Organization KPI targets updated.' }
  await loadData()
}

const dateOptions: { value: KpiDateRange; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '6m', label: 'Last 6 months' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'custom', label: 'Custom range' },
]

const statusOptions: Array<'All' | ComplianceStatus> = ['All', 'Compliant', 'In Progress', 'At Risk', 'Overdue']
</script>

<template>
  <section class="kpi-workspace">
    <!-- Optional Header & Export Action Row -->
    <div class="kpi-head">
      <div>
        <p v-if="subtitle" class="kicker-line">{{ subtitle }}</p>
        <h3 v-if="title" class="kpi-title">{{ title }}</h3>
      </div>

      <div class="kpi-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="loadData">
          ↻ Refresh
        </button>

        <button
          v-if="canEditTargets && snapshot?.sqlViewsReady"
          class="btn btn-ghost btn-sm"
          @click="showTargetsModal = true"
        >
          ◎ KPI Targets
        </button>

        <div class="csv-group">
          <select v-model="csvDataset" aria-label="Select CSV export scope" class="csv-select">
            <option v-if="!isPersonal" value="employees">Employees CSV</option>
            <option v-else value="employees">Personal Transcript CSV</option>
            <option v-if="isCompanyScope" value="departments">Departments CSV</option>
            <option value="courses">Courses CSV</option>
            <option value="trends">Monthly Trends CSV</option>
            <option value="all">All KPI Tables CSV</option>
          </select>
          <button
            class="btn btn-ghost btn-sm"
            :disabled="loading || !snapshot || exportingCsv"
            @click="handleCsvExport()"
          >
            {{ exportingCsv ? 'Exporting…' : '↓ Export CSV' }}
          </button>
        </div>

        <button
          class="btn btn-primary btn-sm"
          :disabled="loading || !snapshot || exportingPdf"
          @click="handlePdfExport"
        >
          {{ exportingPdf ? 'Generating PDF…' : '↓ Export PDF Report' }}
        </button>
      </div>
    </div>

    <!-- Non-blocking SQL view advisory (Admin/HR only) -->
    <div
      v-if="canEditTargets && snapshot && !snapshot.sqlViewsReady"
      class="card notice-banner"
    >
      <div>
        <strong>SQL KPI views pending deployment</strong>
        <p class="sub">
          Displaying live client-computed KPIs. Execute
          <code>supabase/migrations/20261115_analytics_kpi_dashboard.sql</code>
          in the Supabase SQL Editor to activate server-side PostgreSQL views, HR role RLS, target thresholds, and report export audit logs.
        </p>
      </div>
    </div>

    <div
      v-if="actionFeedback"
      class="card feedback-line"
      :class="actionFeedback.ok ? 'fb-ok' : 'fb-err'"
    >
      <span>{{ actionFeedback.text }}</span>
      <button class="fb-dismiss" aria-label="Dismiss message" @click="actionFeedback = null">✕</button>
    </div>

    <!-- Filter Bar -->
    <div class="card filter-card">
      <div class="filter-grid">
        <div class="f-item">
          <label for="kpi-range">Time Window</label>
          <select
            id="kpi-range"
            :value="filters.dateRange"
            @change="onDateRangeSelect(($event.target as HTMLSelectElement).value as KpiDateRange)"
          >
            <option v-for="opt in dateOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>

        <div class="f-item">
          <label for="kpi-start">From Date</label>
          <input
            id="kpi-start"
            v-model="filters.startDate"
            type="date"
            @change="onCustomDateChange"
          />
        </div>

        <div class="f-item">
          <label for="kpi-end">To Date</label>
          <input
            id="kpi-end"
            v-model="filters.endDate"
            type="date"
            @change="onCustomDateChange"
          />
        </div>

        <div v-if="isCompanyScope" class="f-item">
          <label for="kpi-dept">Department</label>
          <select id="kpi-dept" v-model="filters.department">
            <option value="All">All departments</option>
            <option v-for="dept in snapshot?.availableDepartments ?? []" :key="dept" :value="dept">
              {{ dept }}
            </option>
          </select>
        </div>

        <div class="f-item">
          <label for="kpi-course">Course</label>
          <select id="kpi-course" v-model="filters.courseId">
            <option value="All">All courses</option>
            <option v-for="c in dataset?.courses ?? []" :key="c.id" :value="c.id">
              {{ c.title }}
            </option>
          </select>
        </div>

        <div v-if="!isPersonal" class="f-item">
          <label for="kpi-status">Compliance Status</label>
          <select id="kpi-status" v-model="filters.status">
            <option v-for="st in statusOptions" :key="st" :value="st">
              {{ st === 'All' ? 'All statuses' : st }}
            </option>
          </select>
        </div>

        <div v-if="!isPersonal" class="f-item f-search">
          <label for="kpi-search">Search Employee</label>
          <input
            id="kpi-search"
            v-model="filters.search"
            type="text"
            placeholder="Name, email, or department…"
          />
        </div>

        <div v-if="hasActiveFilters" class="f-reset">
          <button class="btn btn-ghost btn-sm" @click="resetFilters">Reset filters</button>
        </div>
      </div>
    </div>

    <p v-if="loading" class="sub">Calculating real-time KPI metrics…</p>
    <p v-else-if="loadError" class="st-danger" style="font-weight: 600">{{ loadError }}</p>

    <template v-else-if="snapshot">
      <!-- 7-Tile KPI Summary Strip -->
      <KpiSummaryStrip
        :summary="snapshot.summary"
        :targets="snapshot.targets"
        :is-personal="isPersonal"
      />

      <!-- 2x2 Recharts Visualization Grid -->
      <div class="charts-grid">
        <CompletionRateWidget
          ref="completionWidgetRef"
          :courses="snapshot.courses"
          :departments="snapshot.departments"
          :target-completion-pct="snapshot.targets.targetCompletionPct"
          :hide-department-toggle="!isCompanyScope"
        />

        <QuizPerformanceWidget
          ref="quizWidgetRef"
          :courses="snapshot.courses"
          :departments="snapshot.departments"
          :monthly-trends="snapshot.monthlyTrends"
          :target-pass-rate-pct="snapshot.targets.targetPassRatePct"
          :hide-department-toggle="!isCompanyScope"
        />

        <ActiveUserTrendsWidget
          ref="trendsWidgetRef"
          :trends="snapshot.monthlyTrends"
          :target-completion-pct="snapshot.targets.targetCompletionPct"
          :hide-active-users="isPersonal"
        />

        <ComplianceDistributionWidget
          ref="complianceWidgetRef"
          :employees="snapshot.employees"
          :compliance-rate-pct="snapshot.summary.complianceRatePct"
          :target-compliance-pct="snapshot.targets.targetCompliancePct"
        />
      </div>

      <!-- Granular Sortable Breakdown Tables + Synchronized Charts Module -->
      <div class="card explorer-card">
        <div class="explorer-head">
          <div>
            <h3>Detailed Performance Breakdown</h3>
            <p class="sub">
              {{
                isPersonal
                  ? 'Personal training transcript, rankings, and course metrics'
                  : 'Sortable KPI tables and synchronized Recharts visualizations'
              }}
              · {{ activeFilterSummary }}
            </p>
          </div>
          <div class="row wrap" style="gap: 8px; align-items: center">
            <div class="seg">
              <button
                :class="{ on: activeTableTab === 'employees' }"
                @click="activeTableTab = 'employees'"
              >
                {{ isPersonal ? 'My Scorecard' : `Employees (${empSort.sorted.value.length})` }}
              </button>
              <button
                v-if="isCompanyScope"
                :class="{ on: activeTableTab === 'departments' }"
                @click="activeTableTab = 'departments'"
              >
                Departments ({{ deptSort.sorted.value.length }})
              </button>
              <button
                :class="{ on: activeTableTab === 'courses' }"
                @click="activeTableTab = 'courses'"
              >
                Courses ({{ courseSort.sorted.value.length }})
              </button>
              <button
                :class="{ on: activeTableTab === 'trends' }"
                @click="activeTableTab = 'trends'"
              >
                Monthly Trends ({{ trendsSort.sorted.value.length }})
              </button>
            </div>
            <button
              class="btn btn-ghost btn-sm"
              @click="showTableCharts = !showTableCharts"
            >
              {{ showTableCharts ? 'Hide Chart' : 'Show Chart' }}
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="exportingCsv"
              title="Export current table to CSV"
              @click="handleCsvExport(activeTableTab)"
            >
              ↓ Table CSV
            </button>
          </div>
        </div>

        <!-- Granular Table Date Range & Department Filter Bar -->
        <div class="table-filter-bar">
          <div class="tf-item">
            <label for="tbl-range">Date Range</label>
            <select
              id="tbl-range"
              :value="filters.dateRange"
              @change="onDateRangeSelect(($event.target as HTMLSelectElement).value as KpiDateRange)"
            >
              <option v-for="opt in dateOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>

          <div class="tf-item">
            <label for="tbl-start">From</label>
            <input
              id="tbl-start"
              v-model="filters.startDate"
              type="date"
              @change="onCustomDateChange"
            />
          </div>

          <div class="tf-item">
            <label for="tbl-end">To</label>
            <input
              id="tbl-end"
              v-model="filters.endDate"
              type="date"
              @change="onCustomDateChange"
            />
          </div>

          <div v-if="isCompanyScope" class="tf-item">
            <label for="tbl-dept">Department</label>
            <select id="tbl-dept" v-model="filters.department">
              <option value="All">All departments</option>
              <option v-for="dept in snapshot.availableDepartments" :key="dept" :value="dept">
                {{ dept }}
              </option>
            </select>
          </div>

          <div v-else class="tf-item">
            <label>Department Scope</label>
            <div class="tf-static">{{ auth.profile?.department || 'General' }}</div>
          </div>

          <div v-if="hasActiveFilters" class="tf-reset">
            <button class="btn btn-ghost btn-sm" @click="resetFilters">Reset</button>
          </div>
        </div>

        <!-- Synchronized Recharts Charts Module for Table Data -->
        <KpiChartsModule
          v-if="showTableCharts"
          ref="tableChartsWidgetRef"
          :active-tab="activeTableTab"
          :employees="empSort.sorted.value"
          :departments="deptSort.sorted.value"
          :courses="courseSort.sorted.value"
          :monthly-trends="snapshot.monthlyTrends"
          :target-completion-pct="snapshot.targets.targetCompletionPct"
          :target-pass-rate-pct="snapshot.targets.targetPassRatePct"
          :is-company-scope="isCompanyScope"
          :is-personal="isPersonal"
          :filter-summary="activeFilterSummary"
        />

        <!-- TAB A: EMPLOYEE RANKINGS & SCORECARD -->
        <div v-if="activeTableTab === 'employees'" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="sortable num" :aria-sort="empSort.ariaSort('rank')" @click="empSort.toggle('rank')">
                  Rank <span class="sort-ind">{{ empSort.indicator('rank') }}</span>
                </th>
                <th class="sortable" :aria-sort="empSort.ariaSort('name')" @click="empSort.toggle('name')">
                  Employee <span class="sort-ind">{{ empSort.indicator('name') }}</span>
                </th>
                <th class="sortable" :aria-sort="empSort.ariaSort('department')" @click="empSort.toggle('department')">
                  Department <span class="sort-ind">{{ empSort.indicator('department') }}</span>
                </th>
                <th class="sortable num" :aria-sort="empSort.ariaSort('completion')" @click="empSort.toggle('completion')">
                  Completion <span class="sort-ind">{{ empSort.indicator('completion') }}</span>
                </th>
                <th class="sortable num" :aria-sort="empSort.ariaSort('hours')" @click="empSort.toggle('hours')">
                  Hours <span class="sort-ind">{{ empSort.indicator('hours') }}</span>
                </th>
                <th class="sortable num" :aria-sort="empSort.ariaSort('quizAvg')" @click="empSort.toggle('quizAvg')">
                  Quiz Avg <span class="sort-ind">{{ empSort.indicator('quizAvg') }}</span>
                </th>
                <th class="sortable num" :aria-sort="empSort.ariaSort('passRate')" @click="empSort.toggle('passRate')">
                  Pass Rate <span class="sort-ind">{{ empSort.indicator('passRate') }}</span>
                </th>
                <th class="sortable num" :aria-sort="empSort.ariaSort('overdue')" @click="empSort.toggle('overdue')">
                  Pending / Overdue <span class="sort-ind">{{ empSort.indicator('overdue') }}</span>
                </th>
                <th class="sortable" :aria-sort="empSort.ariaSort('status')" @click="empSort.toggle('status')">
                  Compliance <span class="sort-ind">{{ empSort.indicator('status') }}</span>
                </th>
                <th class="sortable num" :aria-sort="empSort.ariaSort('effectiveness')" @click="empSort.toggle('effectiveness')">
                  Effect. Index <span class="sort-ind">{{ empSort.indicator('effectiveness') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in empSort.sorted.value" :key="e.userId">
                <td class="mono num">
                  #{{ e.rankOverall }}
                  <span v-if="!isPersonal" class="sub block-sub">Dept #{{ e.rankInDepartment }}</span>
                </td>
                <td>
                  <div class="emp-cell">
                    <div class="avatar" style="width: 30px; height: 30px; font-size: 11px">
                      {{ initialsOf(e.fullName) }}
                    </div>
                    <div>
                      <RouterLink
                        v-if="role === 'admin'"
                        :to="`/admin/employees/${e.userId}`"
                        class="emp-link"
                      >
                        {{ e.fullName }}
                      </RouterLink>
                      <span v-else class="emp-name">{{ e.fullName }}</span>
                      <div class="sub">
                        {{ e.lastActiveAt ? `Active ${relativeTime(e.lastActiveAt)}` : 'No activity logged' }}
                      </div>
                    </div>
                  </div>
                </td>
                <td>{{ e.department }}</td>
                <td class="num">
                  <div class="inline-bar">
                    <div class="bar"><i :style="{ width: e.completionRatePct + '%' }" /></div>
                    <span class="mono">{{ e.completionRatePct }}%</span>
                  </div>
                  <span class="sub">{{ e.completedLessons }}/{{ e.assignedLessons }} lessons</span>
                </td>
                <td class="mono num">{{ e.learningHours }}h</td>
                <td class="mono num">{{ e.avgQuizScorePct === null ? '—' : `${e.avgQuizScorePct}%` }}</td>
                <td class="mono num">
                  {{ e.quizPassRatePct === null ? '—' : `${e.quizPassRatePct}%` }}
                  <span v-if="e.quizAttemptsCount > 0" class="sub block-sub">
                    {{ e.quizPassesCount }}/{{ e.quizAttemptsCount }} passes
                  </span>
                </td>
                <td class="mono num">
                  {{ e.pendingLessons }} pending
                  <span v-if="e.overdueLessons > 0" class="st-danger block-sub">
                    {{ e.overdueLessons }} overdue
                  </span>
                </td>
                <td>
                  <span class="status-text" :class="complianceColorClass(e.complianceStatus)">
                    {{ complianceGlyph(e.complianceStatus) }} {{ e.complianceStatus }}
                  </span>
                  <span v-if="e.dueDate" class="sub block-sub">Due {{ e.dueDate }}</span>
                </td>
                <td class="mono num eff-val">{{ e.effectivenessIndex }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!empSort.sorted.value.length" class="empty-table sub">
            No employee KPI records match the current filters.
          </p>
        </div>

        <!-- TAB B: DEPARTMENT BREAKDOWN -->
        <div v-else-if="activeTableTab === 'departments' && isCompanyScope" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="sortable" :aria-sort="deptSort.ariaSort('department')" @click="deptSort.toggle('department')">
                  Department <span class="sort-ind">{{ deptSort.indicator('department') }}</span>
                </th>
                <th class="sortable num" :aria-sort="deptSort.ariaSort('employees')" @click="deptSort.toggle('employees')">
                  Employees <span class="sort-ind">{{ deptSort.indicator('employees') }}</span>
                </th>
                <th class="sortable num" :aria-sort="deptSort.ariaSort('participation')" @click="deptSort.toggle('participation')">
                  Participation <span class="sort-ind">{{ deptSort.indicator('participation') }}</span>
                </th>
                <th class="sortable num" :aria-sort="deptSort.ariaSort('completion')" @click="deptSort.toggle('completion')">
                  Avg Completion <span class="sort-ind">{{ deptSort.indicator('completion') }}</span>
                </th>
                <th class="sortable num" :aria-sort="deptSort.ariaSort('hours')" @click="deptSort.toggle('hours')">
                  Learning Hours <span class="sort-ind">{{ deptSort.indicator('hours') }}</span>
                </th>
                <th class="sortable num" :aria-sort="deptSort.ariaSort('quizAvg')" @click="deptSort.toggle('quizAvg')">
                  Quiz Avg <span class="sort-ind">{{ deptSort.indicator('quizAvg') }}</span>
                </th>
                <th class="sortable num" :aria-sort="deptSort.ariaSort('passRate')" @click="deptSort.toggle('passRate')">
                  Pass Rate <span class="sort-ind">{{ deptSort.indicator('passRate') }}</span>
                </th>
                <th class="sortable num" :aria-sort="deptSort.ariaSort('compliance')" @click="deptSort.toggle('compliance')">
                  Compliance <span class="sort-ind">{{ deptSort.indicator('compliance') }}</span>
                </th>
                <th class="sortable num" :aria-sort="deptSort.ariaSort('effectiveness')" @click="deptSort.toggle('effectiveness')">
                  Effectiveness <span class="sort-ind">{{ deptSort.indicator('effectiveness') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in deptSort.sorted.value" :key="d.department">
                <td><b>{{ d.department }}</b></td>
                <td class="mono num">
                  {{ d.employeeCount }}
                  <span class="sub block-sub">{{ d.activeLearners30d }} active 30d</span>
                </td>
                <td class="mono num">{{ d.participationRatePct }}%</td>
                <td class="num">
                  <div class="inline-bar">
                    <div class="bar"><i :style="{ width: d.avgCompletionRatePct + '%' }" /></div>
                    <span class="mono">{{ d.avgCompletionRatePct }}%</span>
                  </div>
                </td>
                <td class="mono num">
                  {{ d.totalLearningHours }}h
                  <span class="sub block-sub">{{ d.avgLearningHours }}h / learner</span>
                </td>
                <td class="mono num">{{ d.avgQuizScorePct === null ? '—' : `${d.avgQuizScorePct}%` }}</td>
                <td class="mono num">{{ d.quizPassRatePct === null ? '—' : `${d.quizPassRatePct}%` }}</td>
                <td class="mono num">
                  <span :class="d.complianceRatePct >= snapshot.targets.targetCompliancePct ? 'st-ok' : d.overdueCount > 0 ? 'st-danger' : 'st-warn'">
                    {{ d.complianceRatePct }}%
                  </span>
                  <span class="sub block-sub">
                    {{ d.compliantCount }} ok · {{ d.pendingCount }} pend · {{ d.overdueCount }} late
                  </span>
                </td>
                <td class="mono num eff-val">{{ d.trainingEffectivenessScore }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!deptSort.sorted.value.length" class="empty-table sub">
            No departments match the current filters.
          </p>
        </div>

        <!-- TAB C: COURSE EFFECTIVENESS -->
        <div v-else-if="activeTableTab === 'courses'" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="sortable" :aria-sort="courseSort.ariaSort('title')" @click="courseSort.toggle('title')">
                  Course <span class="sort-ind">{{ courseSort.indicator('title') }}</span>
                </th>
                <th class="sortable" :aria-sort="courseSort.ariaSort('category')" @click="courseSort.toggle('category')">
                  Audience <span class="sort-ind">{{ courseSort.indicator('category') }}</span>
                </th>
                <th class="sortable num" :aria-sort="courseSort.ariaSort('participation')" @click="courseSort.toggle('participation')">
                  Participation <span class="sort-ind">{{ courseSort.indicator('participation') }}</span>
                </th>
                <th class="sortable num" :aria-sort="courseSort.ariaSort('completion')" @click="courseSort.toggle('completion')">
                  Completion <span class="sort-ind">{{ courseSort.indicator('completion') }}</span>
                </th>
                <th class="sortable num" :aria-sort="courseSort.ariaSort('dropOff')" @click="courseSort.toggle('dropOff')">
                  Drop-Off <span class="sort-ind">{{ courseSort.indicator('dropOff') }}</span>
                </th>
                <th class="sortable num" :aria-sort="courseSort.ariaSort('hours')" @click="courseSort.toggle('hours')">
                  Hours <span class="sort-ind">{{ courseSort.indicator('hours') }}</span>
                </th>
                <th class="sortable num" :aria-sort="courseSort.ariaSort('quizAvg')" @click="courseSort.toggle('quizAvg')">
                  Quiz Avg <span class="sort-ind">{{ courseSort.indicator('quizAvg') }}</span>
                </th>
                <th class="sortable num" :aria-sort="courseSort.ariaSort('passRate')" @click="courseSort.toggle('passRate')">
                  Pass Rate <span class="sort-ind">{{ courseSort.indicator('passRate') }}</span>
                </th>
                <th class="sortable num" :aria-sort="courseSort.ariaSort('overdue')" @click="courseSort.toggle('overdue')">
                  Overdue <span class="sort-ind">{{ courseSort.indicator('overdue') }}</span>
                </th>
                <th class="sortable num" :aria-sort="courseSort.ariaSort('effectiveness')" @click="courseSort.toggle('effectiveness')">
                  Effect. Score <span class="sort-ind">{{ courseSort.indicator('effectiveness') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in courseSort.sorted.value" :key="c.courseId">
                <td>
                  <div class="course-name-cell">
                    <span class="course-dot" :style="{ background: c.color }" aria-hidden="true" />
                    <div>
                      <b>{{ c.courseTitle }}</b>
                      <span class="sub block-sub">{{ c.lessonCount }} lessons</span>
                    </div>
                  </div>
                </td>
                <td>{{ c.category }}</td>
                <td class="mono num">
                  {{ c.participationRatePct }}%
                  <span class="sub block-sub">{{ c.startedLearners }}/{{ c.targetLearners }} started</span>
                </td>
                <td class="num">
                  <div class="inline-bar">
                    <div class="bar"><i :style="{ width: c.completionRatePct + '%', background: c.color }" /></div>
                    <span class="mono">{{ c.completionRatePct }}%</span>
                  </div>
                </td>
                <td class="mono num" :class="c.dropOffRatePct > 30 ? 'st-warn' : ''">{{ c.dropOffRatePct }}%</td>
                <td class="mono num">{{ c.learningHours }}h</td>
                <td class="mono num">{{ c.avgQuizScorePct === null ? '—' : `${c.avgQuizScorePct}%` }}</td>
                <td class="mono num">{{ c.quizPassRatePct === null ? '—' : `${c.quizPassRatePct}%` }}</td>
                <td class="mono num" :class="c.overdueLearners > 0 ? 'st-danger' : ''">{{ c.overdueLearners }}</td>
                <td class="mono num eff-val">{{ c.trainingEffectivenessScore }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!courseSort.sorted.value.length" class="empty-table sub">
            No courses match the current filters.
          </p>
        </div>

        <!-- TAB D: MONTHLY TRENDS -->
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="sortable" :aria-sort="trendsSort.ariaSort('month')" @click="trendsSort.toggle('month')">
                  Month <span class="sort-ind">{{ trendsSort.indicator('month') }}</span>
                </th>
                <th v-if="!isPersonal" class="sortable num" :aria-sort="trendsSort.ariaSort('activeUsers')" @click="trendsSort.toggle('activeUsers')">
                  Active Users <span class="sort-ind">{{ trendsSort.indicator('activeUsers') }}</span>
                </th>
                <th class="sortable num" :aria-sort="trendsSort.ariaSort('completions')" @click="trendsSort.toggle('completions')">
                  Lesson Completions <span class="sort-ind">{{ trendsSort.indicator('completions') }}</span>
                </th>
                <th class="sortable num" :aria-sort="trendsSort.ariaSort('monthlyRate')" @click="trendsSort.toggle('monthlyRate')">
                  Monthly Share <span class="sort-ind">{{ trendsSort.indicator('monthlyRate') }}</span>
                </th>
                <th class="sortable num" :aria-sort="trendsSort.ariaSort('cumulativeRate')" @click="trendsSort.toggle('cumulativeRate')">
                  Cumulative Completion <span class="sort-ind">{{ trendsSort.indicator('cumulativeRate') }}</span>
                </th>
                <th class="sortable num" :aria-sort="trendsSort.ariaSort('hours')" @click="trendsSort.toggle('hours')">
                  Learning Hours <span class="sort-ind">{{ trendsSort.indicator('hours') }}</span>
                </th>
                <th class="sortable num" :aria-sort="trendsSort.ariaSort('attempts')" @click="trendsSort.toggle('attempts')">
                  Quiz Attempts <span class="sort-ind">{{ trendsSort.indicator('attempts') }}</span>
                </th>
                <th class="sortable num" :aria-sort="trendsSort.ariaSort('quizAvg')" @click="trendsSort.toggle('quizAvg')">
                  Quiz Avg <span class="sort-ind">{{ trendsSort.indicator('quizAvg') }}</span>
                </th>
                <th class="sortable num" :aria-sort="trendsSort.ariaSort('passRate')" @click="trendsSort.toggle('passRate')">
                  Pass Rate <span class="sort-ind">{{ trendsSort.indicator('passRate') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in trendsSort.sorted.value" :key="t.monthKey">
                <td><b>{{ t.monthLabel }}</b></td>
                <td v-if="!isPersonal" class="mono num">{{ t.activeUsers }}</td>
                <td class="mono num">{{ t.lessonCompletions }}</td>
                <td class="mono num">{{ t.completionRatePct }}%</td>
                <td class="num">
                  <div class="inline-bar">
                    <div class="bar"><i :style="{ width: t.cumulativeCompletionRatePct + '%' }" /></div>
                    <span class="mono">{{ t.cumulativeCompletionRatePct }}%</span>
                  </div>
                </td>
                <td class="mono num">{{ t.learningHours }}h</td>
                <td class="mono num">{{ t.quizAttempts }}</td>
                <td class="mono num">{{ t.avgQuizScorePct === null ? '—' : `${t.avgQuizScorePct}%` }}</td>
                <td class="mono num">{{ t.quizPassRatePct === null ? '—' : `${t.quizPassRatePct}%` }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!trendsSort.sorted.value.length" class="empty-table sub">
            No monthly trend records match the selected date range.
          </p>
        </div>
      </div>
    </template>

    <!-- Target Benchmark Configuration Modal (Admin & HR) -->
    <BaseModal v-if="showTargetsModal" title="Organization KPI Benchmarks" @close="showTargetsModal = false">
      <p class="sub" style="margin-bottom: 14px">
        Configure company-wide KPI reference lines and compliance targets shown across Recharts widgets and PDF exports.
      </p>
      <div class="modal-grid">
        <div class="field">
          <label>Target Course Completion (%)</label>
          <input v-model.number="targetsForm.targetCompletionPct" type="number" min="1" max="100" />
        </div>
        <div class="field">
          <label>Target Quiz Pass Rate (%)</label>
          <input v-model.number="targetsForm.targetPassRatePct" type="number" min="1" max="100" />
        </div>
        <div class="field">
          <label>Target Training Compliance (%)</label>
          <input v-model.number="targetsForm.targetCompliancePct" type="number" min="1" max="100" />
        </div>
        <div class="field">
          <label>Monthly Learning Hours Benchmark</label>
          <input v-model.number="targetsForm.targetLearningHoursMonthly" type="number" min="0.5" max="80" step="0.5" />
        </div>
      </div>
      <p v-if="targetsError" class="st-danger" style="font-size: 13px; margin-bottom: 10px">{{ targetsError }}</p>
      <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 8px">
        <button class="btn btn-ghost btn-sm" @click="showTargetsModal = false">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="savingTargets" @click="handleSaveTargets">
          {{ savingTargets ? 'Saving…' : 'Save Benchmarks' }}
        </button>
      </div>
    </BaseModal>
  </section>
</template>

<style scoped>
.kpi-workspace {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.kpi-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.kicker-line {
  font-size: 12.5px;
  color: var(--ink-soft);
  font-weight: 600;
}
.kpi-title {
  font-size: 20px;
}
.kpi-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.kpi-actions .btn {
  white-space: nowrap;
}
.csv-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.csv-select {
  width: auto;
  min-width: 140px;
  padding: 6px 10px;
  font-size: 12.5px;
}
.notice-banner {
  padding: 14px 18px;
  border-color: var(--brass);
  background: var(--brass-soft);
}
.notice-banner .sub {
  color: var(--ink);
  margin-top: 4px;
}
.feedback-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
}
.fb-ok {
  border-color: var(--teal);
  color: var(--teal);
}
.fb-err {
  border-color: var(--danger);
  color: var(--danger);
}
.fb-dismiss {
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  font-weight: 700;
  padding: 2px 6px;
}
.filter-card {
  padding: 14px 16px;
}
.filter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  align-items: end;
}
.f-item label {
  display: block;
  font-size: 11.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-soft);
  margin-bottom: 5px;
}
.f-reset {
  display: flex;
  align-items: flex-end;
}
.f-reset .btn {
  white-space: nowrap;
}
.charts-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 1040px) {
  .charts-grid {
    grid-template-columns: 1fr;
  }
}
.explorer-card {
  overflow: hidden;
}
.explorer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border);
}
.explorer-head h3 {
  font-size: 17px;
}
.explorer-head .seg button {
  white-space: nowrap;
}
.table-filter-bar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  align-items: end;
  padding: 12px 20px;
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--border);
}
.tf-item label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-soft);
  margin-bottom: 4px;
}
.tf-static {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  padding: 8px 0;
}
.tf-reset {
  display: flex;
  align-items: flex-end;
}
.tf-reset .btn {
  white-space: nowrap;
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
.block-sub {
  display: block;
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 11.5px;
  font-weight: 500;
}
.emp-cell,
.course-name-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.emp-link,
.emp-name {
  font-weight: 700;
  text-decoration: none;
  color: var(--ink);
}
.emp-link:hover {
  color: var(--accent-text);
  text-decoration: underline;
}
.course-dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  flex: none;
}
.inline-bar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 120px;
}
.inline-bar .bar {
  flex: 1;
}
.status-text {
  font-size: 12.5px;
  font-weight: 700;
  white-space: nowrap;
}
.st-ok {
  color: var(--teal);
}
.st-blue {
  color: var(--accent-text);
}
.st-warn {
  color: var(--brass-strong);
}
.st-danger {
  color: var(--danger);
}
.eff-val {
  color: var(--ink);
  font-weight: 700;
}
.empty-table {
  padding: 24px;
  text-align: center;
}
.modal-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 560px) {
  .modal-grid {
    grid-template-columns: 1fr;
  }
}
</style>
