<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { initialsOf } from '@/lib/employees'
import {
  fetchOrganizationLeaderboard,
  formatRelativeActivity,
  sortLeaderboardEntries,
  type LeaderboardEntry,
  type LeaderboardPeriod,
  type LeaderboardSortKey,
  type OrganizationLeaderboardPayload,
} from '@/lib/leaderboard'

const auth = useAuthStore()

const loading = ref(true)
const errorMsg = ref('')
const payload = ref<OrganizationLeaderboardPayload | null>(null)

const sortBy = ref<LeaderboardSortKey>('overall')
const period = ref<LeaderboardPeriod>('30d')
const department = ref('All')
const searchQuery = ref('')
const showFormula = ref(false)

async function loadData() {
  loading.value = true
  errorMsg.value = ''
  try {
    payload.value = await fetchOrganizationLeaderboard()
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : 'Unable to load leaderboard rankings.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadData()
})

const isAdmin = computed(() => auth.role === 'admin')

const departmentOptions = computed(() => payload.value?.departments ?? ['All'])

const filteredEntries = computed<LeaderboardEntry[]>(() => {
  if (!payload.value) return []
  const q = searchQuery.value.trim().toLowerCase()
  return payload.value.entries.filter((entry) => {
    if (department.value !== 'All' && entry.department !== department.value) return false
    if (q && !entry.fullName.toLowerCase().includes(q) && !entry.department.toLowerCase().includes(q)) {
      return false
    }
    return true
  })
})

const rankedEntries = computed<LeaderboardEntry[]>(() =>
  sortLeaderboardEntries(filteredEntries.value, sortBy.value, period.value),
)

const globalRankMap = computed(() => {
  const map = new Map<string, number>()
  if (!payload.value) return map
  const fullSorted = sortLeaderboardEntries(payload.value.entries, sortBy.value, period.value)
  fullSorted.forEach((e, idx) => map.set(e.id, idx + 1))
  return map
})

const myEntry = computed(() => {
  const uid = auth.profile?.id
  if (!uid || !payload.value) return null
  return payload.value.entries.find((e) => e.id === uid) ?? null
})

const myGlobalRank = computed(() => {
  const uid = auth.profile?.id
  if (!uid) return 0
  return globalRankMap.value.get(uid) ?? 0
})

const scopeStats = computed(() => {
  const list = filteredEntries.value
  const totalEmployees = list.length
  const totalBadges = list.reduce((s, e) => s + e.totalBadges, 0)
  const criteriaBadges = list.reduce((s, e) => s + e.criteriaBadgesCount, 0)
  const quizBadges = list.reduce((s, e) => s + e.milestoneQuizBadgesCount, 0)
  const customBadges = list.reduce((s, e) => s + e.customBadgesCount, 0)
  const totalCoursesCompleted = list.reduce((s, e) => s + e.coursesCompleted, 0)
  const avgCoursePct = totalEmployees
    ? Math.round(list.reduce((s, e) => s + e.courseCompletionPct, 0) / totalEmployees)
    : 0
  const active7d = list.filter((e) => e.activityCount7d > 0).length
  const active7dPct = totalEmployees ? Math.round((active7d / totalEmployees) * 100) : 0

  return {
    totalEmployees,
    totalBadges,
    criteriaBadges,
    quizBadges,
    customBadges,
    totalCoursesCompleted,
    avgCoursePct,
    active7d,
    active7dPct,
  }
})

function activityForPeriod(entry: LeaderboardEntry): number {
  if (period.value === '7d') return entry.activityCount7d
  if (period.value === '30d') return entry.activityCount30d
  return entry.activityCountAll
}

function periodShortLabel(): string {
  if (period.value === '7d') return '7d actions'
  if (period.value === '30d') return '30d actions'
  return 'total actions'
}

function scoreForDisplay(entry: LeaderboardEntry): number {
  if (period.value === 'all') return entry.overallScore
  const windowEvents = activityForPeriod(entry)
  const base = entry.totalBadges * 120 + entry.coursesCompleted * 100 + entry.courseCompletionPct
  const momentum = Math.min(windowEvents, 40) * (period.value === '7d' ? 18 : 10) + entry.activeDays14d * 15
  return Math.round(base + momentum)
}

function primaryHighlightValue(entry: LeaderboardEntry): string {
  if (sortBy.value === 'badges') {
    return `${entry.totalBadges} ${entry.totalBadges === 1 ? 'badge' : 'badges'}`
  }
  if (sortBy.value === 'completion') {
    return `${entry.courseCompletionPct}% complete`
  }
  if (sortBy.value === 'activity') {
    const count = activityForPeriod(entry)
    return `${count} ${count === 1 ? 'action' : 'actions'}`
  }
  return `${scoreForDisplay(entry).toLocaleString()} pts`
}

interface PodiumSlot {
  entry: LeaderboardEntry
  rank: number
  stepHeightPx: number
  accentColor: string
  medal: string
}

// Visual podium places 2nd on left, 1st center (tallest), 3rd right
const podiumSlots = computed<PodiumSlot[]>(() => {
  const [first, second, third] = rankedEntries.value
  const slots: PodiumSlot[] = []
  if (second) {
    slots.push({
      entry: second,
      rank: 2,
      stepHeightPx: 92,
      accentColor: '#5c6b8a',
      medal: '🥈',
    })
  }
  if (first) {
    slots.push({
      entry: first,
      rank: 1,
      stepHeightPx: 126,
      accentColor: '#b97b18',
      medal: '🥇',
    })
  }
  if (third) {
    slots.push({
      entry: third,
      rank: 3,
      stepHeightPx: 72,
      accentColor: '#9c4e24',
      medal: '🥉',
    })
  }
  return slots
})

function hasActiveFilters(): boolean {
  return department.value !== 'All' || searchQuery.value.trim().length > 0
}

function clearFilters() {
  department.value = 'All'
  searchQuery.value = ''
}

const sortOptions: { id: LeaderboardSortKey; label: string }[] = [
  { id: 'overall', label: 'Overall' },
  { id: 'badges', label: 'Badges' },
  { id: 'completion', label: 'Course completion' },
  { id: 'activity', label: 'Recent activity' },
]

const periodOptions: { id: LeaderboardPeriod; label: string }[] = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All-time' },
]

function rankDisplay(idx: number): string {
  const r = idx + 1
  if (r === 1) return '🥇 #1'
  if (r === 2) return '🥈 #2'
  if (r === 3) return '🥉 #3'
  return `#${r}`
}

function badgeBreakdownText(e: LeaderboardEntry): string {
  const parts: string[] = []
  if (e.criteriaBadgesCount > 0) parts.push(`${e.criteriaBadgesCount} milestone`)
  if (e.milestoneQuizBadgesCount > 0) parts.push(`${e.milestoneQuizBadgesCount} quiz`)
  if (e.customBadgesCount > 0) parts.push(`${e.customBadgesCount} recognition`)
  return parts.length ? parts.join(' · ') : 'None yet'
}
</script>

<template>
  <div class="org-lb-page">
    <!-- Top Header -->
    <div class="topline">
      <div>
        <h2 class="lb-title">Organization Leaderboard</h2>
        <p class="lb-subtitle">
          Employees ranked by total badge count, course completion, and recent learning activity.
        </p>
      </div>
      <div class="row wrap" style="gap: 10px; align-items: center">
        <div v-if="!loading && myEntry && myGlobalRank > 0" class="my-rank-summary tabular">
          Your standing: <b>#{{ myGlobalRank }}</b> of {{ payload?.entries.length ?? 0 }}
          <span aria-hidden="true">·</span>
          <span>{{ scoreForDisplay(myEntry).toLocaleString() }} pts</span>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :aria-expanded="showFormula"
          @click="showFormula = !showFormula"
        >
          {{ showFormula ? 'Hide scoring guide' : 'Scoring guide' }}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="loading"
          @click="loadData"
        >
          {{ loading ? 'Refreshing…' : '↻ Refresh' }}
        </button>
      </div>
    </div>

    <!-- Collapsible Transparent Scoring Guide -->
    <div v-if="showFormula" class="card formula-panel">
      <div class="formula-grid">
        <div>
          <div class="formula-heading">1. Badge Count Weight</div>
          <p class="sub">
            <b class="tabular">120 pts</b> per earned badge across Milestone Eligibility Rules, Milestone Quiz Badges, and Admin-Awarded Recognition Badges.
          </p>
        </div>
        <div>
          <div class="formula-heading">2. Course Completion Weight</div>
          <p class="sub">
            <b class="tabular">100 pts</b> for each 100% completed course plus up to <b class="tabular">100 pts</b> for overall course completion percentage.
          </p>
        </div>
        <div>
          <div class="formula-heading">3. Recent Activity Weight</div>
          <p class="sub">
            <b class="tabular">10–18 pts</b> per recent learning action (lesson completions, video progress, quizzes, certificates) plus <b class="tabular">15 pts</b> per active day in the last 14 days.
          </p>
        </div>
      </div>
    </div>

    <!-- Organization Snapshot Metrics -->
    <div class="kpi-strip">
      <div class="card kpi-cell">
        <div class="kpi-label">Active learners</div>
        <div class="kpi-value tabular">{{ loading ? '—' : scopeStats.totalEmployees }}</div>
        <div class="sub tabular">
          {{ department === 'All' ? 'Across all departments' : `${department} department` }}
        </div>
      </div>
      <div class="card kpi-cell">
        <div class="kpi-label">Total badges earned</div>
        <div class="kpi-value tabular">{{ loading ? '—' : scopeStats.totalBadges }}</div>
        <div class="sub tabular">
          {{ scopeStats.criteriaBadges }} milestone · {{ scopeStats.quizBadges }} quiz · {{ scopeStats.customBadges }} recognition
        </div>
      </div>
      <div class="card kpi-cell">
        <div class="kpi-label">Avg course completion</div>
        <div class="kpi-value tabular">{{ loading ? '—' : `${scopeStats.avgCoursePct}%` }}</div>
        <div class="sub tabular">{{ scopeStats.totalCoursesCompleted }} courses completed in scope</div>
      </div>
      <div class="card kpi-cell">
        <div class="kpi-label">Active last 7 days</div>
        <div class="kpi-value tabular">{{ loading ? '—' : scopeStats.active7d }}</div>
        <div class="sub tabular">{{ scopeStats.active7dPct }}% engagement rate this week</div>
      </div>
    </div>

    <!-- Controls Toolbar -->
    <div class="card toolbar-card">
      <div class="toolbar-row">
        <div class="control-group">
          <span class="control-label">Rank by</span>
          <div class="seg" role="group" aria-label="Rank criteria">
            <button
              v-for="opt in sortOptions"
              :key="opt.id"
              type="button"
              class="nowrap"
              :class="{ on: sortBy === opt.id }"
              @click="sortBy = opt.id"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div class="control-group">
          <span class="control-label">Activity window</span>
          <div class="seg" role="group" aria-label="Activity window">
            <button
              v-for="p in periodOptions"
              :key="p.id"
              type="button"
              class="nowrap"
              :class="{ on: period === p.id }"
              @click="period = p.id"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="control-group filter-right">
          <select v-model="department" aria-label="Filter by department" class="dept-select">
            <option v-for="d in departmentOptions" :key="d" :value="d">
              {{ d === 'All' ? 'All departments' : d }}
            </option>
          </select>
          <input
            v-model="searchQuery"
            type="search"
            class="search-input"
            placeholder="Search employee or department…"
            aria-label="Search employee or department"
          />
        </div>
      </div>
    </div>

    <!-- Error State -->
    <div v-if="errorMsg" class="card state-card">
      <h3 style="font-size: 16px; margin: 0 0 6px; color: var(--danger)">Could not load leaderboard</h3>
      <p class="sub" style="margin: 0 0 14px">{{ errorMsg }}</p>
      <button type="button" class="btn btn-primary btn-sm" @click="loadData">Try again</button>
    </div>

    <!-- Loading Skeleton -->
    <template v-else-if="loading">
      <div class="card podium-card skeleton-box" style="height: 240px; margin-bottom: 16px" />
      <div class="card table-card">
        <div v-for="n in 6" :key="n" class="skeleton-row" />
      </div>
    </template>

    <!-- Empty State -->
    <div v-else-if="rankedEntries.length === 0" class="card state-card">
      <h3 style="font-size: 17px; margin: 0 0 6px; color: var(--ink)">No matching employees</h3>
      <p class="sub" style="margin: 0 0 14px">
        {{ hasActiveFilters() ? 'No active employees match the current department or search filter.' : 'No active employees found yet.' }}
      </p>
      <button v-if="hasActiveFilters()" type="button" class="btn btn-primary btn-sm" @click="clearFilters">
        Clear filters
      </button>
    </div>

    <!-- Populated Leaderboard -->
    <template v-else>
      <!-- Top 3 Podium -->
      <section v-if="podiumSlots.length > 0" class="card podium-card" aria-label="Top 3 performers">
        <div class="podium-header">
          <h3 style="font-size: 16px; margin: 0">Top Performers</h3>
          <span class="sub">
            Sorted by {{ sortOptions.find((o) => o.id === sortBy)?.label.toLowerCase() }}
            <span aria-hidden="true">·</span>
            {{ periodOptions.find((p) => p.id === period)?.label }}
          </span>
        </div>

        <div class="podium-grid">
          <div
            v-for="slot in podiumSlots"
            :key="slot.entry.id"
            class="podium-slot"
            :class="{ 'is-me': slot.entry.id === auth.profile?.id }"
          >
            <div class="podium-avatar" :style="{ background: slot.accentColor }">
              {{ initialsOf(slot.entry.fullName) }}
            </div>
            <div class="podium-name">
              <RouterLink
                v-if="isAdmin"
                :to="`/admin/employees/${slot.entry.id}`"
                class="emp-link"
              >
                {{ slot.entry.fullName }}
              </RouterLink>
              <span v-else>{{ slot.entry.fullName }}</span>
              <span v-if="slot.entry.id === auth.profile?.id" class="me-tag">(You)</span>
            </div>
            <div class="sub podium-meta">
              {{ slot.entry.department }}
              <span aria-hidden="true">·</span>
              {{ formatRelativeActivity(slot.entry.lastActiveAt) }}
            </div>
            <div class="podium-stats sub tabular">
              <span>{{ slot.entry.totalBadges }} badges</span>
              <span aria-hidden="true">·</span>
              <span>{{ slot.entry.courseCompletionPct }}% courses</span>
              <span aria-hidden="true">·</span>
              <span>{{ activityForPeriod(slot.entry) }} {{ periodShortLabel() }}</span>
            </div>
            <div
              class="podium-step"
              :style="{ height: `${slot.stepHeightPx}px`, background: slot.accentColor }"
            >
              <div class="podium-rank tabular">{{ slot.medal }} #{{ slot.rank }}</div>
              <div class="podium-highlight tabular">{{ primaryHighlightValue(slot.entry) }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- Full Standings Table -->
      <section class="card table-card" aria-label="Full organization standings">
        <div class="table-header-bar">
          <div>
            <h3 style="font-size: 16px; margin: 0">Full Standings</h3>
            <span class="sub tabular">
              Showing {{ rankedEntries.length }} {{ rankedEntries.length === 1 ? 'employee' : 'employees' }}
            </span>
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width: 84px">Rank</th>
                <th>Employee</th>
                <th style="text-align: right">Badges</th>
                <th style="min-width: 200px">Course Completion</th>
                <th style="text-align: right">Recent Activity</th>
                <th style="text-align: right">Score</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(entry, idx) in rankedEntries"
                :key="entry.id"
                class="lb-table-row"
                :class="{ 'is-me': entry.id === auth.profile?.id }"
              >
                <td class="rank-cell tabular" :class="`top-${idx < 3 ? idx + 1 : 'other'}`">
                  {{ rankDisplay(idx) }}
                </td>
                <td>
                  <div class="emp-cell">
                    <div class="avatar" style="width: 34px; height: 34px">
                      {{ initialsOf(entry.fullName) }}
                    </div>
                    <div class="emp-info">
                      <div class="emp-name-line">
                        <RouterLink
                          v-if="isAdmin"
                          :to="`/admin/employees/${entry.id}`"
                          class="emp-link"
                        >
                          {{ entry.fullName }}
                        </RouterLink>
                        <span v-else class="emp-name-text">{{ entry.fullName }}</span>
                        <span v-if="entry.id === auth.profile?.id" class="me-tag">(You)</span>
                      </div>
                      <div class="sub">{{ entry.department }}</div>
                    </div>
                  </div>
                </td>
                <td style="text-align: right">
                  <div class="metric-primary tabular">
                    {{ entry.totalBadges }} {{ entry.totalBadges === 1 ? 'badge' : 'badges' }}
                  </div>
                  <div class="sub tabular badge-sub">
                    {{ badgeBreakdownText(entry) }}
                    <span
                      v-if="entry.badgePreviews.length"
                      class="badge-icons-inline"
                      :title="entry.badgePreviews.map((b) => b.name).join(', ')"
                    >
                      · {{ entry.badgePreviews.slice(0, 4).map((b) => b.icon).join(' ') }}
                    </span>
                  </div>
                </td>
                <td>
                  <div class="course-comp-cell">
                    <div class="course-comp-top tabular">
                      <span class="metric-primary">{{ entry.courseCompletionPct }}%</span>
                      <span class="sub">
                        {{ entry.coursesCompleted }}/{{ entry.coursesTotal }} courses
                        <span aria-hidden="true">·</span>
                        {{ entry.lessonsCompleted }}/{{ entry.lessonsTotal }} lessons
                      </span>
                    </div>
                    <div class="progress" style="height: 6px">
                      <span
                        :style="{
                          width: `${entry.courseCompletionPct}%`,
                          background: entry.courseCompletionPct >= 100 ? 'var(--teal)' : 'var(--blue)',
                        }"
                      />
                    </div>
                  </div>
                </td>
                <td style="text-align: right">
                  <div class="metric-primary tabular">
                    {{ activityForPeriod(entry) }} {{ periodShortLabel() }}
                  </div>
                  <div class="sub tabular">
                    {{ entry.activeDays14d }} active d (14d)
                    <span aria-hidden="true">·</span>
                    {{ formatRelativeActivity(entry.lastActiveAt) }}
                  </div>
                </td>
                <td style="text-align: right">
                  <div class="score-val tabular">{{ scoreForDisplay(entry).toLocaleString() }}</div>
                  <div class="sub">pts</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.org-lb-page {
  width: 100%;
  max-width: 1200px;
}

.tabular {
  font-variant-numeric: tabular-nums;
}

.nowrap {
  white-space: nowrap;
  flex-shrink: 0;
}

.lb-title {
  text-wrap: balance;
}

.lb-subtitle {
  max-width: 68ch;
}

.my-rank-summary {
  font-size: 13px;
  color: var(--ink-soft);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.my-rank-summary b {
  color: var(--ink);
}

.formula-panel {
  padding: 16px 20px;
  margin-bottom: 16px;
}

.formula-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

@media (max-width: 820px) {
  .formula-grid {
    grid-template-columns: 1fr;
  }
}

.formula-heading {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  margin-bottom: 4px;
}

.kpi-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}

@media (max-width: 960px) {
  .kpi-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .kpi-strip {
    grid-template-columns: 1fr;
  }
}

.kpi-cell {
  padding: 16px 18px;
}

.kpi-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-soft);
}

.kpi-value {
  font-size: 28px;
  font-weight: 800;
  color: var(--ink);
  margin: 4px 0 3px;
  line-height: 1.15;
}

.toolbar-card {
  padding: 14px 18px;
  margin-bottom: 16px;
}

.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px 18px;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.control-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-soft);
}

.filter-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

@media (max-width: 960px) {
  .filter-right {
    margin-left: 0;
    width: 100%;
  }
}

.dept-select {
  width: auto;
  min-width: 160px;
  padding: 8px 12px;
  font-size: 13px;
}

.search-input {
  width: 230px;
  padding: 8px 12px;
  font-size: 13px;
}

@media (max-width: 600px) {
  .dept-select,
  .search-input {
    width: 100%;
  }
}

.podium-card {
  padding: 18px 20px 0;
  margin-bottom: 16px;
  overflow: hidden;
}

.podium-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.podium-grid {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 20px;
}

@media (max-width: 680px) {
  .podium-grid {
    gap: 10px;
  }
}

.podium-slot {
  flex: 1;
  max-width: 270px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.podium-avatar {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 17px;
  margin-bottom: 8px;
}

.podium-slot.is-me .podium-avatar {
  box-shadow: 0 0 0 3px var(--surface), 0 0 0 5px var(--blue);
}

.podium-name {
  font-size: 14.5px;
  font-weight: 700;
  color: var(--ink);
  line-height: 1.3;
}

.podium-meta {
  margin-top: 2px;
}

.podium-stats {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 5px;
}

.podium-step {
  width: 100%;
  margin-top: 12px;
  border-radius: 14px 14px 0 0;
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 12px 10px 8px;
  gap: 2px;
}

.podium-rank {
  font-size: 20px;
  font-weight: 800;
}

.podium-highlight {
  font-size: 12.5px;
  font-weight: 600;
  opacity: 0.94;
}

.table-card {
  overflow: hidden;
}

.table-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--border);
}

.lb-table-row {
  transition: background-color 0.15s ease;
}

.lb-table-row:hover {
  background: var(--surface-sunken);
}

.lb-table-row.is-me {
  background: var(--blue-soft);
}

.rank-cell {
  font-weight: 800;
  font-size: 13.5px;
  color: var(--ink-soft);
  white-space: nowrap;
}

.rank-cell.top-1 {
  color: #b97b18;
}

.rank-cell.top-2 {
  color: #5c6b8a;
}

.rank-cell.top-3 {
  color: #9c4e24;
}

.emp-cell {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 180px;
}

.emp-info {
  min-width: 0;
}

.emp-name-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  color: var(--ink);
}

.emp-name-text {
  color: var(--ink);
}

.emp-link {
  color: var(--ink);
  text-decoration: none;
}

.emp-link:hover {
  color: var(--blue);
  text-decoration: underline;
}

.me-tag {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--blue);
}

.metric-primary {
  font-weight: 700;
  color: var(--ink);
  font-size: 13.5px;
}

.badge-sub {
  white-space: nowrap;
}

.badge-icons-inline {
  margin-left: 2px;
}

.course-comp-cell {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 190px;
}

.course-comp-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.score-val {
  font-size: 15px;
  font-weight: 800;
  color: var(--ink);
}

.state-card {
  padding: 36px 24px;
  text-align: center;
}

.skeleton-box {
  background: linear-gradient(90deg, var(--surface) 25%, var(--surface-sunken) 50%, var(--surface) 75%);
  background-size: 200% 100%;
  animation: lbShimmer 1.4s infinite linear;
}

.skeleton-row {
  height: 54px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(90deg, var(--surface) 25%, var(--surface-sunken) 50%, var(--surface) 75%);
  background-size: 200% 100%;
  animation: lbShimmer 1.4s infinite linear;
}

@keyframes lbShimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-box,
  .skeleton-row {
    animation: none;
  }
}
</style>
