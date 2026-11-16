<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
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
import type { CourseKpiMetric, DepartmentKpiMetric } from '@/lib/analyticsKpi'

const props = defineProps<{
  courses: CourseKpiMetric[]
  departments: DepartmentKpiMetric[]
  targetCompletionPct: number
  hideDepartmentToggle?: boolean
}>()

const mode = ref<'course' | 'department'>('course')
const chartWrapEl = ref<HTMLElement | null>(null)
defineExpose({ chartWrapEl })

const chartData = computed(() => {
  if (mode.value === 'department' && !props.hideDepartmentToggle) {
    return props.departments.slice(0, 10).map((d) => ({
      name: shortChartLabel(d.department, 15),
      fullName: d.department,
      completion: d.avgCompletionRatePct,
      participation: d.participationRatePct,
      compliance: d.complianceRatePct,
      meta: `${d.employeeCount} learners`,
    }))
  }
  return props.courses.slice(0, 10).map((c) => ({
    name: shortChartLabel(c.courseTitle, 15),
    fullName: c.courseTitle,
    completion: c.completionRatePct,
    participation: c.participationRatePct,
    compliance: Math.max(0, 100 - c.dropOffRatePct),
    meta: `${c.completedLearners}/${c.targetLearners} completed`,
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
        formatter: (value: number | string, name: string) => [`${value}%`, name],
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
      h(Bar, {
        dataKey: 'completion',
        name: 'Completion Rate',
        fill: CHART_COLORS.blue,
        radius: [6, 6, 0, 0],
        maxBarSize: 32,
      }),
      h(Bar, {
        dataKey: 'participation',
        name: 'Participation Rate',
        fill: CHART_COLORS.teal,
        radius: [6, 6, 0, 0],
        maxBarSize: 32,
      }),
    ),
  )
}
</script>

<template>
  <div ref="chartWrapEl" class="card widget-card">
    <div class="widget-head">
      <div>
        <h3>Course Completion &amp; Participation</h3>
        <p class="sub">
          Completion vs. learner participation against the {{ targetCompletionPct }}% target
        </p>
      </div>
      <div v-if="!hideDepartmentToggle" class="seg">
        <button :class="{ on: mode === 'course' }" @click="mode = 'course'">By Course</button>
        <button :class="{ on: mode === 'department' }" @click="mode = 'department'">By Department</button>
      </div>
    </div>

    <div v-if="!chartData.length" class="empty-chart">
      <p class="sub">No course or department completion records match the selected filters.</p>
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
