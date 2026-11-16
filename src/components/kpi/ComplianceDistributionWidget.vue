<script setup lang="ts">
import { ref, computed } from 'vue'
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts'
import RechartsHost from './RechartsHost.vue'
import { h, CHART_COLORS, TOOLTIP_CONTENT_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE } from './rechartsTheme'
import type { EmployeeKpiMetric } from '@/lib/analyticsKpi'

const props = defineProps<{
  employees: EmployeeKpiMetric[]
  complianceRatePct: number
  targetCompliancePct: number
}>()

const chartWrapEl = ref<HTMLElement | null>(null)
defineExpose({ chartWrapEl })

const breakdown = computed(() => {
  const counts = {
    Compliant: 0,
    'In Progress': 0,
    'At Risk': 0,
    Overdue: 0,
  }
  for (const e of props.employees) {
    counts[e.complianceStatus]++
  }
  const total = Math.max(1, props.employees.length)
  return [
    { name: 'Compliant', value: counts.Compliant, pct: Math.round((counts.Compliant / total) * 100), color: CHART_COLORS.teal },
    { name: 'In Progress', value: counts['In Progress'], pct: Math.round((counts['In Progress'] / total) * 100), color: CHART_COLORS.blue },
    { name: 'At Risk', value: counts['At Risk'], pct: Math.round((counts['At Risk'] / total) * 100), color: CHART_COLORS.brass },
    { name: 'Overdue', value: counts.Overdue, pct: Math.round((counts.Overdue / total) * 100), color: CHART_COLORS.danger },
  ]
})

const nonZeroSlices = computed(() => breakdown.value.filter((b) => b.value > 0))

function renderChart() {
  return h(
    ResponsiveContainer,
    { width: '100%', height: 220 },
    h(
      PieChart,
      null,
      h(Tooltip, {
        contentStyle: TOOLTIP_CONTENT_STYLE,
        labelStyle: TOOLTIP_LABEL_STYLE,
        itemStyle: TOOLTIP_ITEM_STYLE,
        formatter: (value: number | string, name: string) => [`${value} learners`, name],
      }),
      h(
        Pie,
        {
          data: nonZeroSlices.value,
          dataKey: 'value',
          nameKey: 'name',
          cx: '50%',
          cy: '50%',
          innerRadius: 62,
          outerRadius: 90,
          paddingAngle: 2,
          strokeWidth: 0,
        },
        nonZeroSlices.value.map((entry) => h(Cell, { key: entry.name, fill: entry.color })),
      ),
    ),
  )
}
</script>

<template>
  <div ref="chartWrapEl" class="card widget-card">
    <div class="widget-head">
      <div>
        <h3>Training Compliance Breakdown</h3>
        <p class="sub">
          Current standing vs. {{ targetCompliancePct }}% compliance target
        </p>
      </div>
      <div class="compliance-readout">
        <span class="pct-num">{{ complianceRatePct }}%</span>
        <span class="sub">compliant</span>
      </div>
    </div>

    <div v-if="!employees.length" class="empty-chart">
      <p class="sub">No active employees match the current filter.</p>
    </div>

    <div v-else class="compliance-body">
      <div class="ring-box">
        <RechartsHost :render-chart="renderChart" :height="220" :min-height="220" />
      </div>
      <div class="legend-list">
        <div v-for="item in breakdown" :key="item.name" class="legend-row">
          <span class="legend-swatch" :style="{ background: item.color }" aria-hidden="true" />
          <span class="legend-name">{{ item.name }}</span>
          <span class="legend-val">{{ item.value }}</span>
          <span class="legend-pct">{{ item.pct }}%</span>
        </div>
      </div>
    </div>
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
  margin-bottom: 10px;
}
.widget-head h3 {
  font-size: 17px;
}
.compliance-readout {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pct-num {
  display: block;
  font-size: 22px;
  font-weight: 800;
  color: var(--ink);
  line-height: 1.1;
}
.compliance-body {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 1fr;
  gap: 16px;
  align-items: center;
}
@media (max-width: 640px) {
  .compliance-body {
    grid-template-columns: 1fr;
  }
}
.ring-box {
  min-width: 0;
}
.legend-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.legend-row {
  display: grid;
  grid-template-columns: 10px 1fr auto 42px;
  gap: 10px;
  align-items: center;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}
.legend-row:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}
.legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
.legend-name {
  font-weight: 600;
  color: var(--ink);
  font-size: 13.5px;
}
.legend-val {
  font-family: 'IBM Plex Mono', monospace;
  font-weight: 600;
  color: var(--ink);
  font-size: 13px;
}
.legend-pct {
  text-align: right;
  color: var(--ink-soft);
  font-size: 12.5px;
}
.empty-chart {
  height: 220px;
  display: grid;
  place-items: center;
  text-align: center;
}
</style>
