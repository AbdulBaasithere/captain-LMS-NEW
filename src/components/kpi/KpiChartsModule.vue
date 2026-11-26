<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Bar,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts'
import RechartsHost from './RechartsHost.vue'
import {
  h,
  CHART_COLORS,
  AXIS_TICK_STYLE,
  GRID_PROPS,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_ITEM_STYLE,
  LEGEND_WRAPPER_STYLE,
  shortChartLabel,
} from './rechartsTheme'
import type {
  CourseKpiMetric,
  DepartmentKpiMetric,
  EmployeeKpiMetric,
  MonthlyTrendMetric,
} from '@/lib/analyticsKpi'

export type KpiTableTab = 'employees' | 'departments' | 'courses' | 'trends'
export type ChartsModuleMode = 'activeTable' | 'completionOverTime' | 'hoursAndVelocity'

const props = defineProps<{
  activeTab: KpiTableTab
  employees: EmployeeKpiMetric[]
  departments: DepartmentKpiMetric[]
  courses: CourseKpiMetric[]
  monthlyTrends: MonthlyTrendMetric[]
  targetCompletionPct: number
  targetPassRatePct: number
  isCompanyScope?: boolean
  isPersonal?: boolean
  filterSummary?: string
}>()

const chartMode = ref<ChartsModuleMode>('completionOverTime')
const chartWrapEl = ref<HTMLElement | null>(null)
defineExpose({ chartWrapEl })

const activeTableSubtitle = computed(() => {
  if (props.activeTab === 'employees') {
    return props.isPersonal
      ? 'Personal completion rate, quiz score accuracy, and effectiveness index'
      : `Top ${Math.min(12, props.employees.length)} filtered learners from the Employee Rankings table`
  }
  if (props.activeTab === 'departments') {
    return 'Department comparison of avg completion, training compliance, and quiz scores'
  }
  if (props.activeTab === 'courses') {
    return `Top ${Math.min(12, props.courses.length)} filtered courses comparing completion, participation, and drop-off rates`
  }
  return 'Monthly learning hours logged, active learners, and lesson completions'
})

const headingTitle = computed(() => {
  if (chartMode.value === 'completionOverTime') return 'Course Completion Rates Over Time'
  if (chartMode.value === 'hoursAndVelocity') return 'Learning Hours & Assessment Activity Over Time'
  if (props.activeTab === 'employees') return 'Employee Rankings Visualization'
  if (props.activeTab === 'departments') return 'Department Performance Visualization'
  if (props.activeTab === 'courses') return 'Course Effectiveness Visualization'
  return 'Monthly KPI Trends Visualization'
})

const headingSubtitle = computed(() => {
  if (chartMode.value === 'completionOverTime') {
    return `Cumulative course completion rate, monthly quiz pass rate, and average quiz score vs. ${props.targetCompletionPct}% target`
  }
  if (chartMode.value === 'hoursAndVelocity') {
    return 'Monthly learning hours alongside completed lessons and quiz attempts'
  }
  return activeTableSubtitle.value
})

const overTimeData = computed(() =>
  props.monthlyTrends.map((t) => ({
    name: t.monthLabel,
    cumulativeCompletion: t.cumulativeCompletionRatePct,
    monthlyShare: t.completionRatePct,
    avgQuizScore: t.avgQuizScorePct ?? 0,
    quizPassRate: t.quizPassRatePct ?? 0,
    learningHours: t.learningHours,
    lessonCompletions: t.lessonCompletions,
    quizAttempts: t.quizAttempts,
    activeUsers: t.activeUsers,
  })),
)

const activeTableData = computed(() => {
  if (props.activeTab === 'employees') {
    return props.employees.slice(0, 12).map((e) => ({
      name: shortChartLabel(e.fullName, 14),
      fullName: `${e.fullName} · ${e.department}`,
      completion: e.completionRatePct,
      quizAvg: e.avgQuizScorePct ?? 0,
      effectiveness: e.effectivenessIndex,
      meta: `${e.learningHours}h · ${e.complianceStatus}`,
    }))
  }
  if (props.activeTab === 'departments') {
    return props.departments.slice(0, 12).map((d) => ({
      name: shortChartLabel(d.department, 14),
      fullName: `${d.department} (${d.employeeCount} staff)`,
      completion: d.avgCompletionRatePct,
      compliance: d.complianceRatePct,
      participation: d.participationRatePct,
      effectiveness: d.trainingEffectivenessScore,
      meta: `${d.totalLearningHours}h total`,
    }))
  }
  if (props.activeTab === 'courses') {
    return props.courses.slice(0, 12).map((c) => ({
      name: shortChartLabel(c.courseTitle, 14),
      fullName: `${c.courseTitle} (${c.category})`,
      completion: c.completionRatePct,
      participation: c.participationRatePct,
      dropOff: c.dropOffRatePct,
      effectiveness: c.trainingEffectivenessScore,
      meta: `${c.completedLearners}/${c.targetLearners} completed`,
    }))
  }
  return overTimeData.value.map((t) => ({
    ...t,
    fullName: t.name,
    meta: `${t.activeUsers} active learners`,
  }))
})

const hasData = computed(() => {
  if (chartMode.value === 'activeTable') return activeTableData.value.length > 0
  return overTimeData.value.length > 0
})

function renderChart() {
  if (chartMode.value === 'completionOverTime') {
    return h(
      ResponsiveContainer,
      { width: '100%', height: 290 },
      h(
        ComposedChart,
        { data: overTimeData.value, margin: { top: 14, right: 18, left: -10, bottom: 6 } },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'moduleCumCompGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '5%', stopColor: CHART_COLORS.blue, stopOpacity: 0.25 }),
            h('stop', { offset: '95%', stopColor: CHART_COLORS.blue, stopOpacity: 0.02 }),
          ),
        ),
        h(CartesianGrid, GRID_PROPS),
        h(XAxis, { dataKey: 'name', tick: AXIS_TICK_STYLE, axisLine: { stroke: 'var(--border)' }, tickLine: false }),
        h(YAxis, {
          domain: [0, 100],
          unit: '%',
          tick: AXIS_TICK_STYLE,
          axisLine: false,
          tickLine: false,
        }),
        h(Tooltip, {
          contentStyle: TOOLTIP_CONTENT_STYLE,
          labelStyle: TOOLTIP_LABEL_STYLE,
          itemStyle: TOOLTIP_ITEM_STYLE,
          formatter: (val: number | string, name: string) => [`${val}%`, name],
        }),
        h(Legend, { wrapperStyle: LEGEND_WRAPPER_STYLE }),
        h(ReferenceLine, {
          y: props.targetCompletionPct,
          stroke: CHART_COLORS.brass,
          strokeDasharray: '5 4',
          label: {
            value: `Completion Target ${props.targetCompletionPct}%`,
            position: 'insideTopRight',
            fill: 'var(--brass-strong)',
            fontSize: 11,
          },
        }),
        h(Area, {
          type: 'monotone',
          dataKey: 'cumulativeCompletion',
          name: 'Cumulative Completion Rate',
          stroke: CHART_COLORS.blue,
          strokeWidth: 2.6,
          fill: 'url(#moduleCumCompGrad)',
          dot: { r: 3.5, fill: CHART_COLORS.blue },
        }),
        h(Bar, {
          dataKey: 'monthlyShare',
          name: 'Monthly Completion Gain',
          fill: CHART_COLORS.teal,
          radius: [4, 4, 0, 0],
          maxBarSize: 22,
        }),
        h(Line, {
          type: 'monotone',
          dataKey: 'quizPassRate',
          name: 'Quiz Pass Rate',
          stroke: CHART_COLORS.indigo,
          strokeWidth: 2.2,
          dot: { r: 3, fill: CHART_COLORS.indigo },
        }),
      ),
    )
  }

  if (chartMode.value === 'hoursAndVelocity' || (chartMode.value === 'activeTable' && props.activeTab === 'trends')) {
    return h(
      ResponsiveContainer,
      { width: '100%', height: 290 },
      h(
        ComposedChart,
        { data: overTimeData.value, margin: { top: 14, right: 18, left: -10, bottom: 6 } },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'moduleHoursGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '5%', stopColor: CHART_COLORS.teal, stopOpacity: 0.24 }),
            h('stop', { offset: '95%', stopColor: CHART_COLORS.teal, stopOpacity: 0.02 }),
          ),
        ),
        h(CartesianGrid, GRID_PROPS),
        h(XAxis, { dataKey: 'name', tick: AXIS_TICK_STYLE, axisLine: { stroke: 'var(--border)' }, tickLine: false }),
        h(YAxis, { tick: AXIS_TICK_STYLE, axisLine: false, tickLine: false }),
        h(Tooltip, {
          contentStyle: TOOLTIP_CONTENT_STYLE,
          labelStyle: TOOLTIP_LABEL_STYLE,
          itemStyle: TOOLTIP_ITEM_STYLE,
          formatter: (val: number | string, name: string) => [
            name === 'Learning Hours' ? `${val} hrs` : val,
            name,
          ],
        }),
        h(Legend, { wrapperStyle: LEGEND_WRAPPER_STYLE }),
        h(Area, {
          type: 'monotone',
          dataKey: 'learningHours',
          name: 'Learning Hours',
          stroke: CHART_COLORS.teal,
          strokeWidth: 2.4,
          fill: 'url(#moduleHoursGrad)',
          dot: { r: 3, fill: CHART_COLORS.teal },
        }),
        h(Bar, {
          dataKey: 'lessonCompletions',
          name: 'Lesson Completions',
          fill: CHART_COLORS.blue,
          radius: [4, 4, 0, 0],
          maxBarSize: 22,
        }),
        ...(!props.isPersonal
          ? [
              h(Line, {
                type: 'monotone',
                dataKey: 'activeUsers',
                name: 'Active Learners',
                stroke: CHART_COLORS.brass,
                strokeWidth: 2.4,
                dot: { r: 3.5, fill: CHART_COLORS.brass },
              }),
            ]
          : []),
      ),
    )
  }

  // Active Table Comparison: Employees / Departments / Courses
  const barSeries =
    props.activeTab === 'employees'
      ? [
          h(Bar, { dataKey: 'completion', name: 'Completion %', fill: CHART_COLORS.blue, radius: [5, 5, 0, 0], maxBarSize: 24 }),
          h(Bar, { dataKey: 'quizAvg', name: 'Quiz Avg %', fill: CHART_COLORS.teal, radius: [5, 5, 0, 0], maxBarSize: 24 }),
          h(Line, { type: 'monotone', dataKey: 'effectiveness', name: 'Effectiveness Index', stroke: CHART_COLORS.brass, strokeWidth: 2.4, dot: { r: 3.5, fill: CHART_COLORS.brass } }),
        ]
      : props.activeTab === 'departments'
        ? [
            h(Bar, { dataKey: 'completion', name: 'Avg Completion %', fill: CHART_COLORS.blue, radius: [5, 5, 0, 0], maxBarSize: 22 }),
            h(Bar, { dataKey: 'compliance', name: 'Compliance %', fill: CHART_COLORS.teal, radius: [5, 5, 0, 0], maxBarSize: 22 }),
            h(Bar, { dataKey: 'participation', name: 'Participation %', fill: CHART_COLORS.indigo, radius: [5, 5, 0, 0], maxBarSize: 22 }),
            h(Line, { type: 'monotone', dataKey: 'effectiveness', name: 'Effectiveness Score', stroke: CHART_COLORS.brass, strokeWidth: 2.4, dot: { r: 3.5, fill: CHART_COLORS.brass } }),
          ]
        : [
            h(Bar, { dataKey: 'completion', name: 'Completion %', fill: CHART_COLORS.blue, radius: [5, 5, 0, 0], maxBarSize: 22 }),
            h(Bar, { dataKey: 'participation', name: 'Participation %', fill: CHART_COLORS.teal, radius: [5, 5, 0, 0], maxBarSize: 22 }),
            h(Bar, { dataKey: 'dropOff', name: 'Drop-Off %', fill: CHART_COLORS.danger, radius: [5, 5, 0, 0], maxBarSize: 22 }),
            h(Line, { type: 'monotone', dataKey: 'effectiveness', name: 'Effectiveness Score', stroke: CHART_COLORS.brass, strokeWidth: 2.4, dot: { r: 3.5, fill: CHART_COLORS.brass } }),
          ]

  return h(
    ResponsiveContainer,
    { width: '100%', height: 290 },
    h(
      ComposedChart,
      { data: activeTableData.value, margin: { top: 14, right: 18, left: -10, bottom: 6 } },
      h(CartesianGrid, GRID_PROPS),
      h(XAxis, { dataKey: 'name', tick: AXIS_TICK_STYLE, axisLine: { stroke: 'var(--border)' }, tickLine: false }),
      h(YAxis, {
        domain: [0, 100],
        unit: '%',
        tick: AXIS_TICK_STYLE,
        axisLine: false,
        tickLine: false,
      }),
      h(Tooltip, {
        contentStyle: TOOLTIP_CONTENT_STYLE,
        labelStyle: TOOLTIP_LABEL_STYLE,
        itemStyle: TOOLTIP_ITEM_STYLE,
        formatter: (val: number | string, name: string) => [
          name.includes('Effectiveness') ? `${val}/100` : `${val}%`,
          name,
        ],
        labelFormatter: (_label: string, payload: Array<{ payload?: { fullName?: string; meta?: string } }>) => {
          const item = payload?.[0]?.payload
          return item ? `${item.fullName} (${item.meta})` : _label
        },
      }),
      h(Legend, { wrapperStyle: LEGEND_WRAPPER_STYLE }),
      h(ReferenceLine, {
        y: props.targetCompletionPct,
        stroke: CHART_COLORS.brass,
        strokeDasharray: '5 4',
        label: {
          value: `Target ${props.targetCompletionPct}%`,
          position: 'insideTopRight',
          fill: 'var(--brass-strong)',
          fontSize: 11,
        },
      }),
      ...barSeries,
    ),
  )
}
</script>

<template>
  <div ref="chartWrapEl" class="charts-module">
    <div class="cm-head">
      <div>
        <div class="cm-title-row">
          <h4>{{ headingTitle }}</h4>
          <span v-if="filterSummary" class="cm-meta">{{ filterSummary }}</span>
        </div>
        <p class="sub">{{ headingSubtitle }}</p>
      </div>

      <div class="seg">
        <button
          :class="{ on: chartMode === 'completionOverTime' }"
          @click="chartMode = 'completionOverTime'"
        >
          Completion Over Time
        </button>
        <button
          :class="{ on: chartMode === 'activeTable' }"
          @click="chartMode = 'activeTable'"
        >
          Active Table Chart
        </button>
        <button
          :class="{ on: chartMode === 'hoursAndVelocity' }"
          @click="chartMode = 'hoursAndVelocity'"
        >
          Hours &amp; Velocity
        </button>
      </div>
    </div>

    <div v-if="!hasData" class="cm-empty">
      <p class="sub">No KPI records match the selected date range and department filters.</p>
    </div>
    <RechartsHost v-else :render-chart="renderChart" :height="290" :min-height="290" />
  </div>
</template>

<style scoped>
.charts-module {
  padding: 18px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.cm-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.cm-title-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.cm-title-row h4 {
  font-size: 15.5px;
  font-weight: 700;
  color: var(--ink);
  margin: 0;
}
.cm-meta {
  font-size: 12px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.cm-head .seg button {
  white-space: nowrap;
}
.cm-empty {
  height: 290px;
  display: grid;
  place-items: center;
  text-align: center;
}
</style>
