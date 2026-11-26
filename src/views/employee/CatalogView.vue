<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import {
  COURSE_DIFFICULTIES,
  courseProgress,
  courseCode,
  filterCatalogCourses,
  formatCourseTime,
  type CourseVM,
  type CourseProgress,
} from '@/lib/courses'
import { loadEmployeeCoursesAndEnrolments } from '@/lib/courseAssignments'
import CertificateModal from '@/components/CertificateModal.vue'
import { buildCertificateData, type CertificateData } from '@/lib/certificate'
import type { CourseDifficulty, CourseEnrolment, VideoCompletion } from '@/lib/database.types'

export interface CourseWithProgress extends CourseVM {
  progress: CourseProgress
  enrolment?: CourseEnrolment
}

const auth = useAuthStore()
const router = useRouter()
const courses = ref<CourseVM[]>([])
const completions = ref<VideoCompletion[]>([])
const enrolmentByCourseId = ref<Map<number, CourseEnrolment>>(new Map())
const loading = ref(true)
const search = ref('')
const category = ref('All')
const difficulty = ref<'All' | CourseDifficulty>('All')
const statusFilter = ref<'All' | 'In progress' | 'Completed' | 'Not started'>('All')
const assignedOnly = ref(false)

onMounted(async () => {
  const dept = auth.profile?.department
  const userId = auth.profile?.id
  if (!dept || !userId) return
  const [assignedData, { data: comps }] = await Promise.all([
    loadEmployeeCoursesAndEnrolments(userId, dept),
    supabase.from('video_completions').select('*').eq('user_id', userId),
  ])
  completions.value = (comps ?? []) as VideoCompletion[]
  courses.value = assignedData.courses
  enrolmentByCourseId.value = assignedData.enrolmentByCourseId
  loading.value = false
})

const categories = computed(() => ['All', ...new Set(courses.value.map((c) => c.category))])

const coursesWithProgress = computed<CourseWithProgress[]>(() => {
  return courses.value.map((c) => ({
    ...c,
    progress: courseProgress(c, completions.value),
    enrolment: c.dbId ? enrolmentByCourseId.value.get(c.dbId) : undefined,
  }))
})

const assignedCount = computed(() =>
  coursesWithProgress.value.filter((c) => Boolean(c.enrolment?.assigned_by)).length,
)

const summaryStats = computed(() => {
  const total = coursesWithProgress.value.length
  const completed = coursesWithProgress.value.filter((c) => c.progress.status === 'completed').length
  const inProgress = coursesWithProgress.value.filter((c) => c.progress.status === 'in-progress').length
  return { total, completed, inProgress }
})

const difficultyCounts = computed<Record<'All' | CourseDifficulty, number>>(() => {
  const counts: Record<'All' | CourseDifficulty, number> = {
    All: coursesWithProgress.value.length,
    Beginner: 0,
    Intermediate: 0,
    Advanced: 0,
  }
  for (const c of coursesWithProgress.value) {
    counts[c.difficulty] += 1
  }
  return counts
})

const shown = computed(() => {
  const base = filterCatalogCourses(coursesWithProgress.value, {
    search: search.value,
    category: category.value,
    difficulty: difficulty.value,
    status: statusFilter.value,
  })
  return assignedOnly.value ? base.filter((c) => Boolean(c.enrolment?.assigned_by)) : base
})

const hasActiveFilters = computed(
  () =>
    search.value.trim().length > 0 ||
    category.value !== 'All' ||
    difficulty.value !== 'All' ||
    statusFilter.value !== 'All' ||
    assignedOnly.value,
)

function resetFilters() {
  search.value = ''
  category.value = 'All'
  difficulty.value = 'All'
  statusFilter.value = 'All'
  assignedOnly.value = false
}

function difficultyClass(level: CourseDifficulty): string {
  if (level === 'Beginner') return 'diff-beginner'
  if (level === 'Intermediate') return 'diff-intermediate'
  return 'diff-advanced'
}

const selectedCert = ref<CertificateData | null>(null)

function openCertificate(c: CourseWithProgress) {
  if (!auth.profile) return
  selectedCert.value = buildCertificateData(c, c.progress, auth.profile, completions.value)
}

function open(c: CourseWithProgress) {
  const lesson = c.progress.nextLesson ?? c.lessons[0]
  if (lesson) router.push(`/app/modules/${lesson.id}`)
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>Course catalog</h2>
        <p>Every course, document and video published for you.</p>
      </div>

      <!-- Overall progress summary -->
      <div v-if="!loading && summaryStats.total > 0" class="catalog-summary">
        <span class="summary-chip done">
          <b>{{ summaryStats.completed }}</b> / {{ summaryStats.total }} completed
        </span>
        <span v-if="summaryStats.inProgress > 0" class="summary-chip active">
          <b>{{ summaryStats.inProgress }}</b> in progress
        </span>
      </div>
    </div>

    <!-- Real-Time Search & Multi-Facet Filter Bar -->
    <div class="card filters-container">
      <div class="search-row">
        <div class="search-box">
          <span class="search-icon" aria-hidden="true">🔍</span>
          <input
            v-model="search"
            type="search"
            class="search-input"
            placeholder="Search courses in real time by title, category, or difficulty…"
            aria-label="Search courses by title, category, or difficulty"
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
              v-for="c in categories"
              :key="c"
              type="button"
              class="chip-btn status-filter-btn"
              :class="{ on: category === c }"
              @click="category = c"
            >
              {{ c }}
            </button>
          </div>
        </div>

        <div class="facet-group">
          <span class="filter-label">Difficulty:</span>
          <div class="status-chips">
            <button
              v-for="lvl in (['All', ...COURSE_DIFFICULTIES] as const)"
              :key="lvl"
              type="button"
              class="chip-btn status-filter-btn"
              :class="{ on: difficulty === lvl }"
              @click="difficulty = lvl"
            >
              {{ lvl }}
              <span class="chip-count">({{ difficultyCounts[lvl] }})</span>
            </button>
          </div>
        </div>

        <div class="facet-group">
          <span class="filter-label">Progress:</span>
          <div class="status-chips">
            <button
              v-for="s in (['All', 'In progress', 'Completed', 'Not started'] as const)"
              :key="s"
              type="button"
              class="chip-btn status-filter-btn"
              :class="{ on: statusFilter === s }"
              @click="statusFilter = s"
            >
              {{ s }}
            </button>
            <button
              v-if="assignedCount > 0"
              type="button"
              class="chip-btn status-filter-btn"
              :class="{ on: assignedOnly }"
              @click="assignedOnly = !assignedOnly"
            >
              Assigned to me ({{ assignedCount }})
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Live Result Count & Active Filter Tags -->
    <div class="results-bar">
      <p class="sub">
        <template v-if="loading">Loading courses…</template>
        <template v-else>
          Showing <b>{{ shown.length }}</b> of {{ coursesWithProgress.length }} course{{ coursesWithProgress.length === 1 ? '' : 's' }}
        </template>
      </p>
      <div v-if="hasActiveFilters && !loading" class="active-tags">
        <span v-if="search.trim()" class="active-tag">Search: "{{ search.trim() }}"</span>
        <span v-if="category !== 'All'" class="active-tag">Category: {{ category }}</span>
        <span v-if="difficulty !== 'All'" class="active-tag">Difficulty: {{ difficulty }}</span>
        <span v-if="statusFilter !== 'All'" class="active-tag">Status: {{ statusFilter }}</span>
      </div>
    </div>

    <!-- Course Cards Grid -->
    <div class="course-grid">
      <button v-for="c in shown" :key="c.id" class="card course-card" @click="open(c)">
        <div class="cover" :style="{ background: c.color }">
          <span class="cat">{{ c.category }}</span>

          <!-- Visual Progress Pill on Cover -->
          <div class="cover-status">
            <span v-if="c.progress.status === 'completed'" class="status-pill status-completed">
              ✓ Completed
            </span>
            <span v-else-if="c.progress.status === 'in-progress'" class="status-pill status-progress">
              {{ c.progress.pct }}% Done
            </span>
            <span v-else class="status-pill status-new">
              Not started
            </span>
          </div>

          <b>{{ courseCode(c.title) }}</b>
        </div>

        <div class="body">
          <div class="title-row">
            <h3>{{ c.title }}</h3>
          </div>
          <div class="meta">
            <span class="difficulty-badge" :class="difficultyClass(c.difficulty)">{{ c.difficulty }}</span>
            <span v-if="c.enrolment?.assigned_by" style="color: var(--accent-text); font-weight: 700">Assigned</span>
            <span v-if="c.enrolment?.deadline_date" style="color: var(--ink-soft)">Due {{ c.enrolment.deadline_date }}</span>
            <span>▶ {{ c.progress.videos }} video{{ c.progress.videos === 1 ? '' : 's' }}</span>
            <span>📄 {{ c.progress.docs }} doc{{ c.progress.docs === 1 ? '' : 's' }}</span>
            <span>{{ formatCourseTime(c.progress.minutes) }}</span>
          </div>
          <p v-if="c.description" class="course-desc">{{ c.description }}</p>

          <!-- Comprehensive Visual Progress Indicator -->
          <div class="progress-section">
            <div class="progress-labels">
              <span class="progress-count">
                <template v-if="c.progress.status === 'completed'">
                  All {{ c.progress.total }} lessons completed
                </template>
                <template v-else-if="c.progress.status === 'in-progress'">
                  {{ c.progress.done }} of {{ c.progress.total }} lessons completed
                </template>
                <template v-else>
                  0 of {{ c.progress.total }} lessons completed
                </template>
              </span>
              <span class="progress-pct" :class="{ 'pct-done': c.progress.status === 'completed' }">
                {{ c.progress.pct }}%
              </span>
            </div>

            <!-- Visual Progress Bar -->
            <div class="progress-bar-track">
              <div
                class="progress-bar-fill"
                :class="{ 'fill-completed': c.progress.status === 'completed' }"
                :style="{
                  width: c.progress.pct + '%',
                  backgroundColor: c.progress.status === 'completed' ? '#10b981' : c.color,
                }"
              />
            </div>

            <!-- Contextual Next Step or Celebration Note -->
            <div class="progress-footer">
              <div v-if="c.progress.status === 'completed'" class="footer-note done row wrap" style="gap: 6px; width: 100%; justify-content: space-between; align-items: center">
                <span>🏆 Completed</span>
                <span
                  class="cert-badge-link"
                  title="Download official PDF Certificate"
                  @click.stop="openCertificate(c)"
                >
                  🎓 Certificate (PDF) ↗
                </span>
              </div>
              <span v-else-if="c.progress.status === 'in-progress' && c.progress.nextLesson" class="footer-note continue">
                <span>Continue: {{ c.progress.nextLesson.title }} →</span>
              </span>
              <span v-else class="footer-note not-started">
                <span>Start lesson 1 →</span>
              </span>
            </div>
          </div>
        </div>
      </button>
    </div>

    <div v-if="!loading && !shown.length" class="card empty-state">
      <p style="margin-bottom: 12px">No courses match your current search or filters.</p>
      <button type="button" class="btn btn-primary btn-sm" @click="resetFilters">Clear search &amp; filters</button>
    </div>

    <CertificateModal v-if="selectedCert" :certificate="selectedCert" @close="selectedCert = null" />
  </div>
</template>

<style scoped>
.cert-badge-link {
  font-size: 11px;
  font-weight: 600;
  color: #10b981;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.28);
  padding: 3px 8px;
  border-radius: 6px;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.cert-badge-link:hover {
  background: rgba(16, 185, 129, 0.24);
  color: #34d399;
  border-color: rgba(16, 185, 129, 0.45);
}
.catalog-summary {
  display: flex;
  gap: 8px;
  align-items: center;
}
.summary-chip {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--ink-soft);
}
.summary-chip b {
  color: var(--ink);
}
.summary-chip.done {
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}
.summary-chip.done b {
  color: #047857;
}
.summary-chip.active {
  border-color: rgba(221, 51, 51, 0.35);
  background: var(--accent-soft);
  color: var(--accent-text);
}
.summary-chip.active b {
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
  min-width: 240px;
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
.search-clear:hover {
  color: var(--ink);
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
  opacity: 0.7;
  font-size: 11px;
  margin-left: 2px;
}
.results-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.active-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.active-tag {
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 6px;
  background: var(--surface-sunken);
  color: var(--ink-soft);
  border: 1px solid var(--border);
}

.difficulty-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
}
.diff-beginner {
  background: rgba(16, 185, 129, 0.12);
  color: #059669;
}
.diff-intermediate {
  background: rgba(245, 158, 11, 0.14);
  color: #b45309;
}
.diff-advanced {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}
.course-desc {
  font-size: 12.5px;
  color: var(--ink-soft);
  margin: 0 0 10px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.empty-state {
  padding: 32px;
  text-align: center;
  color: var(--ink-soft);
}

.course-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 18px;
}
.course-card {
  text-align: left;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
  font: inherit;
  color: inherit;
  display: flex;
  flex-direction: column;
  transition: transform 0.18s ease, box-shadow 0.18s ease;
  position: relative;
}
.course-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
}
.cover {
  height: 124px;
  position: relative;
  color: #fff;
  padding: 14px;
  overflow: hidden;
}
.cover::before {
  content: '';
  position: absolute;
  width: 190px;
  height: 190px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  right: -60px;
  top: -30px;
}
.cat {
  position: relative;
  background: #fff;
  color: #0f1a2e;
  border-radius: 99px;
  padding: 3px 11px;
  font-size: 11.5px;
  font-weight: 700;
}
.cover-status {
  position: absolute;
  top: 12px;
  right: 14px;
  z-index: 1;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 99px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.status-pill.status-completed {
  background: #10b981;
  color: #ffffff;
  box-shadow: 0 2px 6px rgba(16, 185, 129, 0.4);
}
.status-pill.status-progress {
  background: rgba(255, 255, 255, 0.95);
  color: #0f172a;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}
.status-pill.status-new {
  background: rgba(0, 0, 0, 0.25);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.35);
  backdrop-filter: blur(4px);
}

.cover b {
  position: absolute;
  left: 14px;
  bottom: 10px;
  font-size: 34px;
  font-weight: 800;
}
.body {
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  flex: 1;
}
.body h3 {
  font-size: 16px;
  line-height: 1.35;
  margin-bottom: 6px;
}
.meta {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  color: var(--ink-soft);
  font-size: 12px;
  margin-bottom: 10px;
}

/* Comprehensive Visual Progress Section */
.progress-section {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.progress-labels {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 12px;
}
.progress-count {
  font-weight: 600;
  color: var(--ink-soft);
}
.progress-pct {
  font-weight: 800;
  font-family: 'IBM Plex Mono', monospace;
  color: var(--ink);
}
.progress-pct.pct-done {
  color: #059669;
}
.progress-bar-track {
  height: 8px;
  border-radius: 99px;
  background: var(--surface-sunken);
  overflow: hidden;
  position: relative;
}
.progress-bar-fill {
  height: 100%;
  border-radius: 99px;
  transition: width 0.35s ease;
}
.progress-bar-fill.fill-completed {
  background-color: #10b981 !important;
}

.progress-footer {
  margin-top: 8px;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.footer-note.done {
  color: #059669;
  font-weight: 700;
}
.footer-note.continue {
  color: var(--accent-text);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.footer-note.not-started {
  color: var(--ink-soft);
}
</style>
