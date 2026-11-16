<script setup lang="ts">
import type { CompanyKpiSummary, KpiTargetsConfig } from '@/lib/analyticsKpi'

defineProps<{
  summary: CompanyKpiSummary
  targets: KpiTargetsConfig
  isPersonal?: boolean
}>()
</script>

<template>
  <div class="kpi-strip">
    <div class="card stat">
      <div class="lbl">Course Completion Rate</div>
      <div class="val">{{ summary.avgCompletionRatePct }}%</div>
      <div class="sub">
        Target {{ targets.targetCompletionPct }}%
        <span :class="summary.avgCompletionRatePct >= targets.targetCompletionPct ? 'ok-txt' : 'warn-txt'">
          · {{ summary.avgCompletionRatePct >= targets.targetCompletionPct ? 'On target' : `${(targets.targetCompletionPct - summary.avgCompletionRatePct).toFixed(1)}% below` }}
        </span>
      </div>
    </div>

    <div class="card stat">
      <div class="lbl">Learning Hours Logged</div>
      <div class="val">{{ summary.totalLearningHours }}h</div>
      <div class="sub">
        {{ isPersonal ? `Monthly benchmark ${targets.targetLearningHoursMonthly}h` : `${summary.participatingEmployees} of ${summary.totalEmployees} active learners` }}
      </div>
    </div>

    <div class="card stat">
      <div class="lbl">{{ isPersonal ? 'Training Participation' : 'Participation Rate' }}</div>
      <div class="val">{{ summary.participationRatePct }}%</div>
      <div class="sub">
        {{ summary.participatingEmployees }} active · {{ Math.max(0, summary.totalEmployees - summary.participatingEmployees) }} unstarted
      </div>
    </div>

    <div class="card stat">
      <div class="lbl">Avg. Quiz Score &amp; Pass Rate</div>
      <div class="val">
        {{ summary.avgQuizScorePct === null ? '—' : `${summary.avgQuizScorePct}%` }}
      </div>
      <div class="sub">
        Pass rate:
        <b>{{ summary.quizPassRatePct === null ? '—' : `${summary.quizPassRatePct}%` }}</b>
        · Target {{ targets.targetPassRatePct }}%
      </div>
    </div>

    <div class="card stat">
      <div class="lbl">Training Compliance</div>
      <div class="val">{{ summary.complianceRatePct }}%</div>
      <div class="sub">
        {{ summary.compliantEmployees }} compliant · target {{ targets.targetCompliancePct }}%
      </div>
    </div>

    <div class="card stat">
      <div class="lbl">Pending &amp; Overdue</div>
      <div class="val">
        {{ summary.pendingEmployees + summary.overdueEmployees }}
      </div>
      <div class="sub">
        {{ summary.pendingEmployees }} in progress ·
        <span :class="summary.overdueEmployees > 0 ? 'danger-txt' : 'ok-txt'">
          {{ summary.overdueEmployees }} overdue
        </span>
      </div>
    </div>

    <div class="card stat dark" style="grid-column: span 2">
      <div class="lbl">Training Effectiveness Index</div>
      <div class="val">{{ summary.trainingEffectivenessScore }} <span class="of">/ 100</span></div>
      <div class="sub">
        Composite of completion (45%), quiz score accuracy (35%), and assessment pass rate (20%)
      </div>
    </div>
  </div>
</template>

<style scoped>
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
@media (max-width: 1120px) {
  .kpi-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 600px) {
  .kpi-strip {
    grid-template-columns: 1fr;
  }
  .kpi-strip .stat.dark {
    grid-column: span 1 !important;
  }
}
.val {
  font-variant-numeric: tabular-nums;
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
</style>
