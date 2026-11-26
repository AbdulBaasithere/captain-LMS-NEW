<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { loadEmployeeTutorials } from '@/lib/tutorials'
import {
  enrichTutorials,
  filterTutorials,
  formatTutorialDuration,
  formatTutorialStatusLabel,
  type TutorialWithMeta,
} from '@/lib/tutorialHelpers'
import type { Tutorial, TutorialCategory, TutorialProgress, TutorialStatus } from '@/lib/database.types'

const auth = useAuthStore()
const router = useRouter()

const loading = ref(true)
const missingTable = ref(false)
const loadError = ref('')
const categories = ref<TutorialCategory[]>([])
const tutorials = ref<Tutorial[]>([])
const progressRows = ref<TutorialProgress[]>([])

const search = ref('')
const selectedCategoryId = ref<number | 'all'>('all')
const selectedStatus = ref<TutorialStatus | 'all'>('all')
const groupByCategory = ref(true)

onMounted(async () => {
  const userId = auth.profile?.id
  const dept = auth.profile?.department ?? 'General'
  if (!userId) {
    loading.value = false
    return
  }

  const res = await loadEmployeeTutorials(userId, dept)
  missingTable.value = res.missingTable
  loadError.value = res.error ?? ''
  categories.value = res.categories
  tutorials.value = res.tutorials
  progressRows.value = res.progressRows
  loading.value = false
})

const enriched = computed<TutorialWithMeta[]>(() =>
  enrichTutorials(tutorials.value, categories.value, progressRows.value),
)

const categoryCounts = computed(() => {
  const map = new Map<number, number>()
  for (const item of enriched.value) {
    if (item.category_id) map.set(item.category_id, (map.get(item.category_id) ?? 0) + 1)
  }
  return map
})

const summaryStats = computed(() => {
  const total = enriched.value.length
  const completed = enriched.value.filter((t) => t.status === 'completed').length
  const inProgress = enriched.value.filter((t) => t.status === 'in_progress').length
  return { total, completed, inProgress }
})

const shown = computed(() =>
  filterTutorials(enriched.value, {
    search: search.value,
    categoryId: selectedCategoryId.value,
    status: selectedStatus.value,
  }),
)

const groupedSections = computed(() => {
  const sections: { key: string; name: string; color: string; description: string; items: TutorialWithMeta[] }[] = []
  const byCat = new Map<number | 'none', TutorialWithMeta[]>()

  for (const item of shown.value) {
    const key = item.category_id ?? 'none'
    const list = byCat.get(key) ?? []
    list.push(item)
    byCat.set(key, list)
  }

  for (const cat of categories.value) {
    const items = byCat.get(cat.id)
    if (items?.length) {
      sections.push({
        key: `cat-${cat.id}`,
        name: cat.name,
        color: cat.color || '#dd3333',
        description: cat.description,
        items,
      })
    }
  }

  const uncategorized = byCat.get('none')
  if (uncategorized?.length) {
    sections.push({
      key: 'cat-none',
      name: 'General Guides',
      color: '#dd3333',
      description: 'Standalone academy tutorials and quick-start walkthroughs',
      items: uncategorized,
    })
  }

  return sections
})

const hasActiveFilters = computed(
  () =>
    search.value.trim().length > 0 ||
    selectedCategoryId.value !== 'all' ||
    selectedStatus.value !== 'all',
)

function resetFilters() {
  search.value = ''
  selectedCategoryId.value = 'all'
  selectedStatus.value = 'all'
}

function openTutorial(id: number) {
  router.push(`/app/tutorials/${id}`)
}

function deptScopeLabel(depts: string[]): string {
  if (!depts?.length || depts.includes('General')) return 'All teams'
  return depts.join(', ')
}

function statusBadgeClass(status: TutorialStatus): string {
  if (status === 'completed') return 'status-completed'
  if (status === 'in_progress') return 'status-progress'
  return 'status-new'
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>Captain Academy — Tutorials &amp; Guides</h2>
        <p>Step-by-step video walkthroughs and written guides organized by topic.</p>
      </div>

      <div v-if="!loading && summaryStats.total > 0" class="academy-summary">
        <span class="summary-chip done">
          <b>{{ summaryStats.completed }}</b> / {{ summaryStats.total }} completed
        </span>
        <span v-if="summaryStats.inProgress > 0" class="summary-chip active">
          <b>{{ summaryStats.inProgress }}</b> in progress
        </span>
      </div>
    </div>

    <div v-if="missingTable" class="card" style="padding: 20px; max-width: 680px; margin-bottom: 16px">
      <h3 style="font-size: 18px; margin-bottom: 6px">Academy tutorials setup pending</h3>
      <p class="hint" style="font-size: 13.5px; margin-top: 0">
        Ask your administrator to run the SQL migration
        <code>supabase/migrations/20261125_captain_academy_tutorials.sql</code> in Supabase SQL Editor to enable
        Captain Academy tutorials.
      </p>
    </div>

    <div v-else-if="loadError" class="card" style="padding: 18px; color: var(--danger); margin-bottom: 16px">
      Could not load tutorials: {{ loadError }}
    </div>

    <template v-else>
      <!-- Search & Filter Controls -->
      <div class="card filters-container">
        <div class="search-row">
          <div class="search-box">
            <span class="search-icon" aria-hidden="true">🔍</span>
            <input
              v-model="search"
              type="search"
              class="search-input"
              placeholder="Search tutorials by title, category, or written instructions…"
              aria-label="Search tutorials"
            />
            <button
              v-if="search"
              type="button"
              class="search-clear"
              aria-label="Clear search"
              @click="search = ''"
            >
              ✕
            </button>
          </div>

          <button
            type="button"
            class="btn btn-ghost btn-sm"
            @click="groupByCategory = !groupByCategory"
          >
            {{ groupByCategory ? 'Show flat grid' : 'Group by category' }}
          </button>

          <button
            v-if="hasActiveFilters"
            type="button"
            class="btn btn-ghost btn-sm"
            @click="resetFilters"
          >
            Reset filters
          </button>
        </div>

        <div class="facets-grid">
          <div class="facet-group">
            <span class="filter-label">Category:</span>
            <div class="status-chips">
              <button
                type="button"
                class="chip-btn status-filter-btn"
                :class="{ on: selectedCategoryId === 'all' }"
                @click="selectedCategoryId = 'all'"
              >
                All <span class="chip-count">({{ enriched.length }})</span>
              </button>
              <button
                v-for="cat in categories"
                :key="cat.id"
                type="button"
                class="chip-btn status-filter-btn"
                :class="{ on: selectedCategoryId === cat.id }"
                @click="selectedCategoryId = cat.id"
              >
                {{ cat.name }}
                <span class="chip-count">({{ categoryCounts.get(cat.id) ?? 0 }})</span>
              </button>
            </div>
          </div>

          <div class="facet-group">
            <span class="filter-label">Progress:</span>
            <div class="status-chips">
              <button
                v-for="opt in ([
                  { id: 'all', label: 'All' },
                  { id: 'not_started', label: 'Not Started' },
                  { id: 'in_progress', label: 'In Progress' },
                  { id: 'completed', label: 'Completed' },
                ] as const)"
                :key="opt.id"
                type="button"
                class="chip-btn status-filter-btn"
                :class="{ on: selectedStatus === opt.id }"
                @click="selectedStatus = opt.id"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="results-bar">
        <p class="sub">
          <template v-if="loading">Loading tutorials…</template>
          <template v-else>
            Showing <b>{{ shown.length }}</b> of {{ enriched.length }} tutorial{{ enriched.length === 1 ? '' : 's' }}
          </template>
        </p>
      </div>

      <!-- Empty State -->
      <div v-if="!loading && shown.length === 0" class="card empty-state">
        <p style="margin-bottom: 10px">
          {{
            enriched.length === 0
              ? 'No tutorials have been published for your department yet.'
              : 'No tutorials match your current search or filters.'
          }}
        </p>
        <button v-if="hasActiveFilters" type="button" class="btn btn-primary btn-sm" @click="resetFilters">
          Clear filters
        </button>
      </div>

      <!-- Grouped by Category -->
      <template v-else-if="groupByCategory">
        <section v-for="sec in groupedSections" :key="sec.key" class="category-section">
          <div class="category-head">
            <div class="category-title-wrap">
              <span class="category-dot" :style="{ background: sec.color }" />
              <div>
                <h3>{{ sec.name }}</h3>
                <p v-if="sec.description" class="sub">{{ sec.description }}</p>
              </div>
            </div>
            <span class="pill pill-muted">{{ sec.items.length }} guide{{ sec.items.length === 1 ? '' : 's' }}</span>
          </div>

          <div class="tutorial-grid">
            <button
              v-for="t in sec.items"
              :key="t.id"
              type="button"
              class="card tutorial-card"
              @click="openTutorial(t.id)"
            >
              <div class="thumb-wrap" :style="{ background: t.categoryColor }">
                <img
                  v-if="t.resolvedThumbnailUrl"
                  :src="t.resolvedThumbnailUrl"
                  :alt="t.title"
                  class="thumb-img"
                  loading="lazy"
                />
                <div v-else class="thumb-fallback">
                  <span class="thumb-play-icon">▶</span>
                </div>

                <span class="thumb-cat">{{ t.categoryName }}</span>
                <span class="thumb-duration tabular">{{ formatTutorialDuration(t.duration_seconds) }}</span>
                <span class="status-pill thumb-status" :class="statusBadgeClass(t.status)">
                  {{ t.status === 'completed' ? '✓ Completed' : formatTutorialStatusLabel(t.status) }}
                </span>
              </div>

              <div class="card-body">
                <h4>{{ t.title }}</h4>
                <p v-if="t.description" class="tut-desc">{{ t.description }}</p>
                <div class="tut-meta">
                  <span>👥 {{ deptScopeLabel(t.departments) }}</span>
                  <span v-if="t.instructions.trim()">📝 Written guide</span>
                </div>
                <div v-if="t.status === 'in_progress' && (t.progress?.progress_pct ?? 0) > 0" class="progress" style="margin-top: 8px">
                  <span :style="{ width: `${t.progress?.progress_pct ?? 0}%` }" />
                </div>
                <div class="tut-cta">
                  <span>{{ t.status === 'completed' ? 'Rewatch tutorial →' : t.status === 'in_progress' ? 'Continue watching →' : 'Watch tutorial →' }}</span>
                </div>
              </div>
            </button>
          </div>
        </section>
      </template>

      <!-- Flat Grid View -->
      <div v-else class="tutorial-grid">
        <button
          v-for="t in shown"
          :key="t.id"
          type="button"
          class="card tutorial-card"
          @click="openTutorial(t.id)"
        >
          <div class="thumb-wrap" :style="{ background: t.categoryColor }">
            <img
              v-if="t.resolvedThumbnailUrl"
              :src="t.resolvedThumbnailUrl"
              :alt="t.title"
              class="thumb-img"
              loading="lazy"
            />
            <div v-else class="thumb-fallback">
              <span class="thumb-play-icon">▶</span>
            </div>

            <span class="thumb-cat">{{ t.categoryName }}</span>
            <span class="thumb-duration tabular">{{ formatTutorialDuration(t.duration_seconds) }}</span>
            <span class="status-pill thumb-status" :class="statusBadgeClass(t.status)">
              {{ t.status === 'completed' ? '✓ Completed' : formatTutorialStatusLabel(t.status) }}
            </span>
          </div>

          <div class="card-body">
            <h4>{{ t.title }}</h4>
            <p v-if="t.description" class="tut-desc">{{ t.description }}</p>
            <div class="tut-meta">
              <span>👥 {{ deptScopeLabel(t.departments) }}</span>
              <span v-if="t.instructions.trim()">📝 Written guide</span>
            </div>
            <div v-if="t.status === 'in_progress' && (t.progress?.progress_pct ?? 0) > 0" class="progress" style="margin-top: 8px">
              <span :style="{ width: `${t.progress?.progress_pct ?? 0}%` }" />
            </div>
            <div class="tut-cta">
              <span>{{ t.status === 'completed' ? 'Rewatch tutorial →' : t.status === 'in_progress' ? 'Continue watching →' : 'Watch tutorial →' }}</span>
            </div>
          </div>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.academy-summary {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.summary-chip {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--ink-soft);
}
.summary-chip.done {
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}
.summary-chip.active {
  border-color: rgba(221, 51, 51, 0.35);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.filters-container {
  padding: 16px;
  margin-bottom: 14px;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.search-box {
  position: relative;
  flex: 1;
  min-width: 220px;
}
.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  pointer-events: none;
  opacity: 0.7;
}
.search-input {
  padding-left: 36px;
  padding-right: 34px;
}
.search-clear {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: var(--surface-sunken);
  color: var(--ink-soft);
  width: 22px;
  height: 22px;
  border-radius: 99px;
  font-size: 11px;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.facets-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.facet-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.filter-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-soft);
  min-width: 68px;
}
.status-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.status-filter-btn {
  font-size: 12px;
  padding: 5px 11px;
}
.chip-count {
  opacity: 0.72;
  font-size: 11px;
  margin-left: 2px;
}
.results-bar {
  margin-bottom: 14px;
}
.empty-state {
  padding: 32px;
  text-align: center;
  color: var(--ink-soft);
}

.category-section {
  margin-bottom: 26px;
}
.category-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.category-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.category-dot {
  width: 12px;
  height: 12px;
  border-radius: 4px;
  flex: none;
}
.category-head h3 {
  font-size: 18px;
  margin: 0;
}

.tutorial-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 16px;
}
.tutorial-card {
  text-align: left;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
  font: inherit;
  color: inherit;
  display: flex;
  flex-direction: column;
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}
.tutorial-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.1);
}

.thumb-wrap {
  position: relative;
  aspect-ratio: 16 / 9;
  width: 100%;
  overflow: hidden;
  background: #181316;
}
.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.55));
}
.thumb-play-icon {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  color: #181316;
  display: grid;
  place-items: center;
  font-size: 16px;
  padding-left: 3px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
}
.thumb-cat {
  position: absolute;
  top: 10px;
  left: 10px;
  background: rgba(255, 255, 255, 0.94);
  color: #141013;
  border-radius: 99px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 700;
}
.thumb-duration {
  position: absolute;
  right: 10px;
  bottom: 10px;
  background: rgba(15, 15, 18, 0.85);
  color: #ffffff;
  border-radius: 6px;
  padding: 2px 7px;
  font-size: 11.5px;
  font-weight: 700;
}
.thumb-status {
  position: absolute;
  top: 10px;
  right: 10px;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 99px;
  font-size: 11px;
  font-weight: 700;
}
.status-pill.status-completed {
  background: #10b981;
  color: #ffffff;
}
.status-pill.status-progress {
  background: rgba(245, 158, 11, 0.94);
  color: #ffffff;
}
.status-pill.status-new {
  background: rgba(0, 0, 0, 0.55);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.35);
}

.card-body {
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  flex: 1;
}
.card-body h4 {
  font-size: 16px;
  line-height: 1.35;
  margin: 0 0 6px;
}
.tut-desc {
  font-size: 12.5px;
  color: var(--ink-soft);
  margin: 0 0 10px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tut-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--ink-soft);
}
.tut-cta {
  margin-top: auto;
  padding-top: 10px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--accent-text);
}
</style>
