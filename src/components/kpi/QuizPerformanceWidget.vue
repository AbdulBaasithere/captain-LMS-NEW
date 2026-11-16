<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  ResponsiveContainer,
  ComposedChart,
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
import type { CourseKpiMetric, DepartmentKpiMetric, MonthlyTrendMetric } from '@/lib/analyticsKpi'

const props = defineProps<{
  courses: CourseKpiMetric[]
  departments: DepartmentKpiMetric[]
  monthlyTrends: MonthlyTrendMetric[]
  targetPassRatePct: number
  hideDepartmentToggle?: boolean
}>()

const dimension = ref<'course' | 'department' | 'monthly'>('course')
const chartWrapEl = ref<HTMLElement | null>(null)
defineExpose({ chartWrapEl })

const chartData = computed(() => {
  if (dimension.value === 'monthly') {
    return props.monthlyTrends
      .filter((t) => t.quizAttempts > 0 || t.activeUsers > 0)
      .map((t) => ({
        name: t.monthLabel,
        fullName: `${t.monthLabel} (${t.quizAttempts} attempts)`,
        avgScore: t.avgQuizScorePct ?? 0,
        passRate: t.quizPassRatePct ?? 0,
        effectiveness: t.avgQuizScorePct !== null && t.quizPassRatePct !== null
          ? Math.round((t.avgQuizScorePct * 0.55 + t.quizPassRatePct * 0.45) * 10) / 10
          : 0,
      }))
  }
  if (dimension.value === 'department' && !props.hideDepartmentToggle) {
    return props.departments.slice(0, 10).map((d) => ({
      name: shortChartLabel(d.department, 14),
      fullName: `${d.department} (${d.quizAttemptsCount} attempts)`,
      avgScore: d.avgQuizScorePct ?? 0,
      passRate: d.quizPassRatePct ?? 0,
      effectiveness: d.trainingEffectivenessScore,
    }))
  }
  return props.courses.slice(0, 10).map((c) => ({
    name: shortChartLabel(c.courseTitle, 14),
    fullName: c.courseTitle,
    avgScore: c.avgQuizScorePct ?? 0,
    passRate: c.quizPassRatePct ?? 0,
    effectiveness: c.trainingEffectivenessScore,
  }))
})

function renderChart() {
  return h(
    ResponsiveContainer,
    { width: '100%', height: 280 },
    h(
      ComposedChart,
      { data: chartData.value, margin: { top: 14, right: 16, left: -12, bottom: 6 } },
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
        formatter: (value: number | string, name: string) => [
          name === 'Effectiveness Index' ? `${value}/100` : `${value}%`,
          name,
        ],
        labelFormatter: (_label: string, payload: Array<{ payload?: { fullName?: string } }>) =>
          payload?.[0]?.payload?.fullName ?? _label,
      }),
      h(Legend, { wrapperStyle: LEGEND_WRAPPER_STYLE }),
      h(ReferenceLine, {
        y: props.targetPassRatePct,
        stroke: CHART_COLORS.teal,
        strokeDasharray: '5 4',
        label: {
          value: `Pass Target ${props.targetPassRatePct}%`,
          position: 'insideTopRight',
          fill: 'var(--teal)',
          fontSize: 11,
        },
      }),
      h(Bar, {
        dataKey: 'avgScore',
        name: 'Avg Quiz Score',
        fill: CHART_COLORS.indigo,
        radius: [6, 6, 0, 0],
        maxBarSize: 28,
      }),
      h(Bar, {
        dataKey: 'passRate',
        name: 'Quiz Pass Rate',
        fill: CHART_COLORS.blue,
        radius: [6, 6, 0, 0],
        maxBarSize: 28,
      }),
      h(Line, {
        type: 'monotone',
        dataKey: 'effectiveness',
        name: 'Effectiveness Index',
        stroke: CHART_COLORS.brass,
        strokeWidth: 2.5,
        dot: { r: 3.5, fill: CHART_COLORS.brass },
      }),
    ),
  )
}
</script>

<template>
  <div ref="chartWrapEl" class="card widget-card">
    <div class="widget-head">
      <div>
        <h3>Quiz Performance &amp; Effectiveness</h3>
        <p class="sub">
          Average quiz scores, pass rates, and training effectiveness index (target {{ targetPassRatePct }}%)
        </p>
      </div>
      <div class="seg">
        <button :class="{ on: dimension === 'course' }" @click="dimension = 'course'">Course</button>
        <button v-if="!hideDepartmentToggle" :class="{ on: dimension === 'department' }" @click="dimension = 'department'">
          Department
        </button>
        <button :class="{ on: dimension === 'monthly' }" @click="dimension = 'monthly'">Monthly</button>
      </div>
    </div>

    <div v-if="!chartData.length" class="empty-chart">
      <p class="sub">No quiz attempts recorded for the current selection.</p>
    </div>
    <RechartsHost v-else :render-chart="renderChart" :height="280" />
  </div>
</template>

<style scoped>
.widget-card {
  padding: 20px;
}
.widget-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.widget-head h3 {
  font-size: 17px;
}
.empty-chart {
  height: 280px;
  display: grid;
  place-items: center;
  text-align: center;
}
</style>
