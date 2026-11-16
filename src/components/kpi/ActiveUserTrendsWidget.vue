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
} from './rechartsTheme'
import type { MonthlyTrendMetric } from '@/lib/analyticsKpi'

const props = defineProps<{
  trends: MonthlyTrendMetric[]
  hideActiveUsers?: boolean
  targetCompletionPct?: number
}>()

const view = ref<'completionRate' | 'activity' | 'hours'>('completionRate')
const chartWrapEl = ref<HTMLElement | null>(null)
defineExpose({ chartWrapEl })

const chartData = computed(() =>
  props.trends.map((t) => ({
    name: t.monthLabel,
    activeUsers: t.activeUsers,
    lessonCompletions: t.lessonCompletions,
    learningHours: t.learningHours,
    quizAttempts: t.quizAttempts,
    completionRatePct: t.completionRatePct,
    cumulativeCompletionRatePct: t.cumulativeCompletionRatePct,
  })),
)

function renderChart() {
  if (view.value === 'completionRate') {
    return h(
      ResponsiveContainer,
      { width: '100%', height: 280 },
      h(
        ComposedChart,
        { data: chartData.value, margin: { top: 14, right: 16, left: -10, bottom: 6 } },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'kpiCumCompGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '5%', stopColor: CHART_COLORS.blue, stopOpacity: 0.28 }),
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
        h(Area, {
          type: 'monotone',
          dataKey: 'cumulativeCompletionRatePct',
          name: 'Cumulative Completion Rate',
          stroke: CHART_COLORS.blue,
          strokeWidth: 2.5,
          fill: 'url(#kpiCumCompGrad)',
          dot: { r: 3.5, fill: CHART_COLORS.blue },
        }),
        h(Bar, {
          dataKey: 'completionRatePct',
          name: 'Monthly Completion Share',
          fill: CHART_COLORS.teal,
          radius: [5, 5, 0, 0],
          maxBarSize: 22,
        }),
      ),
    )
  }

  if (view.value === 'hours') {
    return h(
      ResponsiveContainer,
      { width: '100%', height: 280 },
      h(
        ComposedChart,
        { data: chartData.value, margin: { top: 14, right: 16, left: -10, bottom: 6 } },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'kpiHoursGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '5%', stopColor: CHART_COLORS.teal, stopOpacity: 0.28 }),
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
          fill: 'url(#kpiHoursGrad)',
          dot: { r: 3, fill: CHART_COLORS.teal },
        }),
        h(Bar, {
          dataKey: 'quizAttempts',
          name: 'Quiz Attempts',
          fill: CHART_COLORS.brass,
          radius: [5, 5, 0, 0],
          maxBarSize: 24,
        }),
      ),
    )
  }

  return h(
    ResponsiveContainer,
    { width: '100%', height: 280 },
    h(
      ComposedChart,
      { data: chartData.value, margin: { top: 14, right: 16, left: -10, bottom: 6 } },
      h(
        'defs',
        null,
        h(
          'linearGradient',
          { id: 'kpiCompGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '5%', stopColor: CHART_COLORS.blue, stopOpacity: 0.24 }),
          h('stop', { offset: '95%', stopColor: CHART_COLORS.blue, stopOpacity: 0.02 }),
        ),
      ),
      h(CartesianGrid, GRID_PROPS),
      h(XAxis, { dataKey: 'name', tick: AXIS_TICK_STYLE, axisLine: { stroke: 'var(--border)' }, tickLine: false }),
      h(YAxis, { tick: AXIS_TICK_STYLE, allowDecimals: false, axisLine: false, tickLine: false }),
      h(Tooltip, {
        contentStyle: TOOLTIP_CONTENT_STYLE,
        labelStyle: TOOLTIP_LABEL_STYLE,
        itemStyle: TOOLTIP_ITEM_STYLE,
      }),
      h(Legend, { wrapperStyle: LEGEND_WRAPPER_STYLE }),
      h(Area, {
        type: 'monotone',
        dataKey: 'lessonCompletions',
        name: 'Lesson Completions',
        stroke: CHART_COLORS.blue,
        strokeWidth: 2.2,
        fill: 'url(#kpiCompGrad)',
        dot: { r: 3, fill: CHART_COLORS.blue },
      }),
      ...(!props.hideActiveUsers
        ? [
            h(Line, {
              type: 'monotone',
              dataKey: 'activeUsers',
              name: 'Active Learners',
              stroke: CHART_COLORS.brass,
              strokeWidth: 2.5,
              dot: { r: 3.5, fill: CHART_COLORS.brass },
            }),
          ]
        : []),
    ),
  )
}
</script>

<template>
  <div ref="chartWrapEl" class="card widget-card">
    <div class="widget-head">
      <div>
        <h3>Completion Rate &amp; Monthly Trends</h3>
        <p class="sub">
          {{
            view === 'completionRate'
              ? 'Cumulative course completion rate trajectory and monthly share'
              : view === 'activity'
                ? 'Monthly active learners and lesson completion velocity'
                : 'Monthly learning hours logged and quiz assessments taken'
          }}
        </p>
      </div>
      <div class="seg">
        <button :class="{ on: view === 'completionRate' }" @click="view = 'completionRate'">Completion %</button>
        <button :class="{ on: view === 'activity' }" @click="view = 'activity'">Users &amp; Volume</button>
        <button :class="{ on: view === 'hours' }" @click="view = 'hours'">Hours &amp; Quizzes</button>
      </div>
    </div>

    <div v-if="!chartData.length" class="empty-chart">
      <p class="sub">No monthly trend activity recorded yet.</p>
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
