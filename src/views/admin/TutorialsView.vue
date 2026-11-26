<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { loadDepartments } from '@/lib/departments'
import { probeVideoDurationSeconds } from '@/lib/materials'
import { initialsOf, isActive } from '@/lib/employees'
import {
  deleteTutorial,
  deleteTutorialCategory,
  loadAdminTutorials,
  saveTutorial,
  saveTutorialCategory,
  setTutorialPublished,
  uploadTutorialThumbnail,
  uploadTutorialVideo,
} from '@/lib/tutorials'
import {
  computeTutorialAnalytics,
  detectExternalVideoKind,
  formatTutorialDuration,
  formatTutorialStatusLabel,
  formatVideoSourceLabel,
  parseInstructionBlocks,
  resolveTutorialThumbnail,
  sanitizeExternalUrl,
  type TutorialAnalyticsRow,
} from '@/lib/tutorialHelpers'
import type {
  Department,
  Profile,
  Tutorial,
  TutorialCategory,
  TutorialProgress,
  TutorialVideoSource,
} from '@/lib/database.types'

const auth = useAuthStore()

const loading = ref(true)
const missingTable = ref(false)
const loadError = ref('')
const activeTab = ref<'tutorials' | 'categories' | 'analytics'>('tutorials')

const categories = ref<TutorialCategory[]>([])
const tutorials = ref<Tutorial[]>([])
const progressRows = ref<TutorialProgress[]>([])
const profiles = ref<Profile[]>([])
const departments = ref<Department[]>([])

const search = ref('')
const filterCategory = ref<number | 'all'>('all')
const filterStatus = ref<'all' | 'published' | 'draft'>('all')

// Tutorial Modal State
const modalOpen = ref(false)
const editingId = ref<number | null>(null)
const formTitle = ref('')
const formCategoryId = ref<number | ''>('')
const formDescription = ref('')
const formInstructions = ref('')
const formVideoMode = ref<'external' | 'upload'>('external')
const formExternalUrl = ref('')
const formUploadedVideoUrl = ref('')
const formDurationMin = ref(3)
const formDurationSec = ref(0)
const formThumbnailUrl = ref('')
const formAllDepartments = ref(true)
const formSelectedDepts = ref<string[]>([])
const formPublished = ref(true)
const previewInstructions = ref(false)
const uploadingVideo = ref(false)
const uploadingThumb = ref(false)
const formError = ref('')
const savingTutorial = ref(false)

// Category Modal / Form State
const catEditId = ref<number | null>(null)
const catName = ref('')
const catDesc = ref('')
const catColor = ref('#dd3333')
const catSortOrder = ref(0)
const catError = ref('')
const savingCategory = ref(false)

// Analytics learner drilldown modal
const inspectRow = ref<TutorialAnalyticsRow | null>(null)

async function load() {
  loading.value = true
  const [res, depts] = await Promise.all([loadAdminTutorials(), loadDepartments()])
  missingTable.value = res.missingTable
  loadError.value = res.error ?? ''
  categories.value = res.categories
  tutorials.value = res.tutorials
  progressRows.value = res.progressRows
  profiles.value = res.profiles
  departments.value = depts
  loading.value = false
}

onMounted(load)

const categoryById = computed(() => {
  const m = new Map<number, TutorialCategory>()
  for (const c of categories.value) m.set(c.id, c)
  return m
})

const analytics = computed(() =>
  computeTutorialAnalytics(tutorials.value, categories.value, progressRows.value, profiles.value),
)

const analyticsByTutorialId = computed(() => {
  const m = new Map<number, TutorialAnalyticsRow>()
  for (const r of analytics.value.rows) m.set(r.tutorial.id, r)
  return m
})

const filteredTutorials = computed(() => {
  const q = search.value.trim().toLowerCase()
  return tutorials.value.filter((t) => {
    if (filterCategory.value !== 'all' && t.category_id !== filterCategory.value) return false
    if (filterStatus.value === 'published' && !t.is_published) return false
    if (filterStatus.value === 'draft' && t.is_published) return false
    if (q) {
      const catNameText = t.category_id ? categoryById.value.get(t.category_id)?.name ?? '' : ''
      const hay = `${t.title}\n${t.description}\n${catNameText}\n${t.departments.join(' ')}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

const tutorialCountByCategory = computed(() => {
  const m = new Map<number, number>()
  for (const t of tutorials.value) {
    if (t.category_id) m.set(t.category_id, (m.get(t.category_id) ?? 0) + 1)
  }
  return m
})

const instructionPreviewBlocks = computed(() => parseInstructionBlocks(formInstructions.value))

const detectedUrlPreview = computed(() => {
  if (formVideoMode.value !== 'external' || !formExternalUrl.value.trim()) return null
  return detectExternalVideoKind(formExternalUrl.value)
})

const inspectLearners = computed(() => {
  if (!inspectRow.value) return []
  const profileMap = new Map<string, Profile>()
  for (const p of profiles.value) profileMap.set(p.id, p)

  return progressRows.value
    .filter((row) => row.tutorial_id === inspectRow.value!.tutorial.id)
    .map((row) => ({
      progress: row,
      profile: profileMap.get(row.user_id) ?? null,
    }))
    .sort((a, b) => (b.progress.updated_at ?? '').localeCompare(a.progress.updated_at ?? ''))
})

function openCreateModal() {
  editingId.value = null
  formTitle.value = ''
  formCategoryId.value = categories.value[0]?.id ?? ''
  formDescription.value = ''
  formInstructions.value = ''
  formVideoMode.value = 'external'
  formExternalUrl.value = ''
  formUploadedVideoUrl.value = ''
  formDurationMin.value = 3
  formDurationSec.value = 0
  formThumbnailUrl.value = ''
  formAllDepartments.value = true
  formSelectedDepts.value = []
  formPublished.value = true
  previewInstructions.value = false
  formError.value = ''
  modalOpen.value = true
}

function openEditModal(t: Tutorial) {
  editingId.value = t.id
  formTitle.value = t.title
  formCategoryId.value = t.category_id ?? ''
  formDescription.value = t.description
  formInstructions.value = t.instructions
  formVideoMode.value = t.video_source === 'upload' ? 'upload' : 'external'
  formUploadedVideoUrl.value = t.video_source === 'upload' ? t.video_url ?? '' : ''
  formExternalUrl.value =
    t.video_source === 'youtube'
      ? t.video_url || (t.youtube_id ? `https://youtu.be/${t.youtube_id}` : '')
      : t.video_source === 'external'
        ? t.video_url ?? ''
        : ''
  const secs = Math.max(0, t.duration_seconds || 0)
  formDurationMin.value = Math.floor(secs / 60)
  formDurationSec.value = secs % 60
  formThumbnailUrl.value = t.thumbnail_url ?? ''
  const isGeneral = !t.departments?.length || t.departments.includes('General')
  formAllDepartments.value = isGeneral
  formSelectedDepts.value = isGeneral ? [] : [...t.departments]
  formPublished.value = t.is_published
  previewInstructions.value = false
  formError.value = ''
  modalOpen.value = true
}

function toggleDeptSelection(deptName: string) {
  if (formSelectedDepts.value.includes(deptName)) {
    formSelectedDepts.value = formSelectedDepts.value.filter((d) => d !== deptName)
  } else {
    formSelectedDepts.value = [...formSelectedDepts.value, deptName]
  }
}

async function onVideoFilePicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  formError.value = ''
  uploadingVideo.value = true
  try {
    const [probed, upload] = await Promise.all([
      probeVideoDurationSeconds(file),
      uploadTutorialVideo(file),
    ])
    if (upload.error || !upload.url) {
      formError.value = upload.error ?? 'Video upload failed.'
      return
    }
    formUploadedVideoUrl.value = upload.url
    if (probed && probed > 0) {
      formDurationMin.value = Math.floor(probed / 60)
      formDurationSec.value = probed % 60
    }
  } finally {
    uploadingVideo.value = false
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function onThumbnailFilePicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  formError.value = ''
  uploadingThumb.value = true
  try {
    const upload = await uploadTutorialThumbnail(file)
    if (upload.error || !upload.url) {
      formError.value = upload.error ?? 'Thumbnail upload failed.'
      return
    }
    formThumbnailUrl.value = upload.url
  } finally {
    uploadingThumb.value = false
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function submitTutorialForm() {
  formError.value = ''
  if (!formTitle.value.trim()) {
    formError.value = 'Tutorial title is required.'
    return
  }

  let videoSource: TutorialVideoSource = 'external'
  let videoUrl: string | null = null
  let youtubeId: string | null = null

  if (formVideoMode.value === 'upload') {
    if (!formUploadedVideoUrl.value.trim()) {
      formError.value = 'Upload a video file or switch to External Video URL.'
      return
    }
    videoSource = 'upload'
    videoUrl = formUploadedVideoUrl.value.trim()
  } else {
    const detected = detectExternalVideoKind(formExternalUrl.value)
    if (detected.kind === 'invalid') {
      formError.value = detected.error
      return
    }
    if (detected.kind === 'youtube') {
      videoSource = 'youtube'
      youtubeId = detected.youtubeId
      videoUrl = sanitizeExternalUrl(formExternalUrl.value) ?? `https://youtu.be/${detected.youtubeId}`
    } else {
      videoSource = 'external'
      videoUrl =
        detected.kind === 'direct_video'
          ? detected.mediaUrl
          : detected.kind === 'external_link'
            ? detected.url
            : sanitizeExternalUrl(formExternalUrl.value)
    }
  }

  const rawThumb = formThumbnailUrl.value.trim()
  let safeThumb: string | null = null
  if (rawThumb) {
    safeThumb = sanitizeExternalUrl(rawThumb)
    if (!safeThumb) {
      formError.value = 'Thumbnail URL must start with https:// or http://'
      return
    }
  }

  const depts = formAllDepartments.value
    ? ['General']
    : formSelectedDepts.value.length > 0
      ? formSelectedDepts.value
      : []

  if (depts.length === 0) {
    formError.value = 'Select at least one department or choose All Departments (General).'
    return
  }

  const totalSeconds = Math.max(0, Math.round(formDurationMin.value || 0)) * 60 +
    Math.max(0, Math.min(59, Math.round(formDurationSec.value || 0)))

  savingTutorial.value = true
  const { error } = await saveTutorial({
    id: editingId.value ?? undefined,
    title: formTitle.value,
    description: formDescription.value,
    instructions: formInstructions.value,
    category_id: formCategoryId.value ? Number(formCategoryId.value) : null,
    thumbnail_url: safeThumb,
    video_source: videoSource,
    video_url: videoUrl,
    youtube_id: youtubeId,
    duration_seconds: totalSeconds,
    departments: depts,
    is_published: formPublished.value,
    created_by: auth.profile?.id ?? null,
  })
  savingTutorial.value = false

  if (error) {
    formError.value = error
    return
  }

  await logActivity(
    auth.profile?.id,
    `${editingId.value ? 'Updated' : 'Created'} Captain Academy tutorial "${formTitle.value.trim()}"`,
  )
  modalOpen.value = false
  await load()
}

async function togglePublish(t: Tutorial) {
  const next = !t.is_published
  const { error } = await setTutorialPublished(t.id, next)
  if (!error) {
    await logActivity(auth.profile?.id, `${next ? 'Published' : 'Unpublished'} tutorial "${t.title}"`)
    await load()
  }
}

async function removeTutorial(t: Tutorial) {
  if (!window.confirm(`Delete tutorial "${t.title}"?\n\nThis removes the tutorial and its employee progress records.`)) {
    return
  }
  const { error } = await deleteTutorial(t.id)
  if (!error) {
    await logActivity(auth.profile?.id, `Deleted tutorial "${t.title}"`)
    await load()
  }
}

function editCategory(c: TutorialCategory) {
  catEditId.value = c.id
  catName.value = c.name
  catDesc.value = c.description
  catColor.value = c.color || '#dd3333'
  catSortOrder.value = c.sort_order
  catError.value = ''
}

function resetCategoryForm() {
  catEditId.value = null
  catName.value = ''
  catDesc.value = ''
  catColor.value = '#dd3333'
  catSortOrder.value = categories.value.length + 1
  catError.value = ''
}

async function submitCategoryForm() {
  catError.value = ''
  if (!catName.value.trim()) {
    catError.value = 'Category name is required.'
    return
  }
  savingCategory.value = true
  const { error } = await saveTutorialCategory({
    id: catEditId.value ?? undefined,
    name: catName.value,
    description: catDesc.value,
    color: catColor.value,
    sort_order: catSortOrder.value,
    created_by: auth.profile?.id ?? null,
  })
  savingCategory.value = false
  if (error) {
    catError.value = error
    return
  }
  await logActivity(
    auth.profile?.id,
    `${catEditId.value ? 'Updated' : 'Created'} tutorial category "${catName.value.trim()}"`,
  )
  resetCategoryForm()
  await load()
}

async function removeCategory(c: TutorialCategory) {
  const count = tutorialCountByCategory.value.get(c.id) ?? 0
  if (
    !window.confirm(
      `Delete category "${c.name}"?${count > 0 ? `\n\n${count} tutorial(s) in this category will become uncategorized.` : ''}`,
    )
  ) {
    return
  }
  const { error } = await deleteTutorialCategory(c.id)
  if (!error) {
    await logActivity(auth.profile?.id, `Deleted tutorial category "${c.name}"`)
    if (catEditId.value === c.id) resetCategoryForm()
    await load()
  }
}

function previewThumb(t: Tutorial): string | null {
  return resolveTutorialThumbnail(t)
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>Captain Academy — Tutorials &amp; Guides</h2>
        <p>Create, categorize, publish, and measure video walkthroughs &amp; written guides.</p>
      </div>
      <button v-if="!missingTable" type="button" class="btn btn-primary" @click="openCreateModal">
        + New Tutorial
      </button>
    </div>

    <div v-if="missingTable" class="card" style="padding: 22px; max-width: 680px">
      <h3 style="font-size: 18px; margin-bottom: 6px">One-time database setup needed</h3>
      <p class="hint" style="font-size: 13.5px; margin-top: 0">
        Run <code>supabase/migrations/20261125_captain_academy_tutorials.sql</code> in Supabase → SQL Editor, then
        refresh this page. That creates <code>tutorial_categories</code>, <code>tutorials</code>,
        <code>tutorial_progress</code>, RLS policies, and the <code>tutorial-media</code> storage bucket.
      </p>
    </div>

    <div v-else-if="loadError" class="card" style="padding: 18px; color: var(--danger)">
      Could not load Captain Academy data: {{ loadError }}
    </div>

    <template v-else>
      <!-- Analytics KPI Summary Strip -->
      <div class="kpi-strip">
        <div class="card stat">
          <div class="lbl">Published Guides</div>
          <div class="val tabular">{{ analytics.publishedCount }} <span class="of">/ {{ analytics.totalTutorials }}</span></div>
          <div class="sub">{{ analytics.draftCount }} unpublished draft{{ analytics.draftCount === 1 ? '' : 's' }}</div>
        </div>
        <div class="card stat">
          <div class="lbl">Total Views</div>
          <div class="val tabular">{{ analytics.totalViews }}</div>
          <div class="sub">Across all Captain Academy videos</div>
        </div>
        <div class="card stat">
          <div class="lbl">Employee Completions</div>
          <div class="val tabular">{{ analytics.totalCompletions }}</div>
          <div class="sub">{{ analytics.avgCompletionRatePct }}% avg completion rate</div>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <div class="tab-bar">
        <button
          type="button"
          class="chip-btn"
          :class="{ on: activeTab === 'tutorials' }"
          @click="activeTab = 'tutorials'"
        >
          🎬 Tutorials ({{ tutorials.length }})
        </button>
        <button
          type="button"
          class="chip-btn"
          :class="{ on: activeTab === 'categories' }"
          @click="activeTab = 'categories'"
        >
          🗂 Categories ({{ categories.length }})
        </button>
        <button
          type="button"
          class="chip-btn"
          :class="{ on: activeTab === 'analytics' }"
          @click="activeTab = 'analytics'"
        >
          📊 Views &amp; Completion Analytics
        </button>
      </div>

      <!-- TAB 1: TUTORIALS CRUD -->
      <div v-if="activeTab === 'tutorials'" class="card" style="padding: 18px">
        <div class="admin-filters">
          <input
            v-model="search"
            type="search"
            placeholder="Search tutorials by title, category, or department…"
            style="max-width: 340px"
          />
          <select v-model="filterCategory" style="max-width: 210px">
            <option value="all">All categories</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <select v-model="filterStatus" style="max-width: 170px">
            <option value="all">All statuses</option>
            <option value="published">Published only</option>
            <option value="draft">Drafts only</option>
          </select>
        </div>

        <div v-if="loading" class="sub" style="padding: 20px 0">Loading tutorials…</div>
        <div v-else-if="filteredTutorials.length === 0" class="sub" style="padding: 20px 0">
          No tutorials match yet. Click <b>+ New Tutorial</b> to create your first Academy guide.
        </div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Tutorial</th>
                <th>Category</th>
                <th>Media</th>
                <th>Visibility</th>
                <th>Status</th>
                <th>Views / Done</th>
                <th style="text-align: right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in filteredTutorials" :key="t.id">
                <td>
                  <div class="tut-cell">
                    <div class="mini-thumb" :style="{ background: t.category_id ? categoryById.get(t.category_id)?.color || '#dd3333' : '#dd3333' }">
                      <img v-if="previewThumb(t)" :src="previewThumb(t)!" :alt="t.title" />
                      <span v-else>▶</span>
                    </div>
                    <div style="min-width: 0">
                      <div style="font-weight: 700">{{ t.title }}</div>
                      <div class="sub tut-sub-desc">
                        {{ t.description || 'No description' }}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span class="pill pill-muted">
                    {{ t.category_id ? categoryById.get(t.category_id)?.name || 'Uncategorized' : 'Uncategorized' }}
                  </span>
                </td>
                <td>
                  <div style="font-size: 12.5px; font-weight: 600">{{ formatVideoSourceLabel(t.video_source) }}</div>
                  <div class="sub tabular" style="font-size: 12px">{{ formatTutorialDuration(t.duration_seconds) }}</div>
                </td>
                <td>
                  <span v-if="!t.departments?.length || t.departments.includes('General')" class="pill pill-teal">
                    All Departments
                  </span>
                  <div v-else class="row wrap" style="gap: 4px">
                    <span v-for="d in t.departments" :key="d" class="pill pill-outline">{{ d }}</span>
                  </div>
                </td>
                <td>
                  <span class="pill" :class="t.is_published ? 'pill-teal' : 'pill-brass'">
                    {{ t.is_published ? 'Published' : 'Draft' }}
                  </span>
                </td>
                <td class="tabular" style="font-size: 12.5px">
                  <div><b>{{ analyticsByTutorialId.get(t.id)?.totalViews ?? t.view_count }}</b> views</div>
                  <div class="sub">{{ analyticsByTutorialId.get(t.id)?.completedCount ?? 0 }} completed</div>
                </td>
                <td style="text-align: right; white-space: nowrap">
                  <div class="row" style="justify-content: flex-end; gap: 6px">
                    <button type="button" class="btn btn-ghost btn-sm" @click="openEditModal(t)">Edit</button>
                    <button type="button" class="btn btn-ghost btn-sm" @click="togglePublish(t)">
                      {{ t.is_published ? 'Unpublish' : 'Publish' }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      style="color: var(--danger)"
                      @click="removeTutorial(t)"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- TAB 2: CATEGORIES MANAGER -->
      <div v-else-if="activeTab === 'categories'" class="cat-grid">
        <div class="card" style="padding: 18px">
          <h3 style="font-size: 17px; margin-bottom: 12px">
            {{ catEditId ? 'Edit Category' : 'Add Category' }}
          </h3>
          <div class="field">
            <label>Category Name</label>
            <input v-model="catName" type="text" placeholder="e.g. Onboarding Walkthroughs" />
          </div>
          <div class="field">
            <label>Description</label>
            <input v-model="catDesc" type="text" placeholder="Short summary shown to employees" />
          </div>
          <div class="row" style="gap: 12px">
            <div class="field" style="flex: 1">
              <label>Accent Color</label>
              <input v-model="catColor" type="color" style="height: 42px; padding: 4px" />
            </div>
            <div class="field" style="flex: 1">
              <label>Display Order</label>
              <input v-model.number="catSortOrder" type="number" min="0" />
            </div>
          </div>
          <p v-if="catError" class="hint" style="color: var(--danger); margin-bottom: 10px">{{ catError }}</p>
          <div class="row" style="gap: 8px">
            <button type="button" class="btn btn-primary" :disabled="savingCategory" @click="submitCategoryForm">
              {{ savingCategory ? 'Saving…' : catEditId ? 'Update Category' : 'Create Category' }}
            </button>
            <button v-if="catEditId" type="button" class="btn btn-ghost" @click="resetCategoryForm">Cancel</button>
          </div>
        </div>

        <div class="card" style="padding: 18px">
          <h3 style="font-size: 17px; margin-bottom: 12px">Existing Categories</h3>
          <div v-if="categories.length === 0" class="sub">No categories yet.</div>
          <div v-else class="cat-list">
            <div v-for="c in categories" :key="c.id" class="cat-row">
              <span class="cat-swatch" :style="{ background: c.color }" />
              <div style="flex: 1; min-width: 0">
                <div style="font-weight: 700">{{ c.name }}</div>
                <div class="sub" style="font-size: 12px">
                  {{ c.description || 'No description' }} · Order #{{ c.sort_order }} ·
                  {{ tutorialCountByCategory.get(c.id) ?? 0 }} tutorial(s)
                </div>
              </div>
              <div class="row" style="gap: 6px">
                <button type="button" class="btn btn-ghost btn-sm" @click="editCategory(c)">Edit</button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  style="color: var(--danger)"
                  @click="removeCategory(c)"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 3: ANALYTICS -->
      <div v-else class="card" style="padding: 18px">
        <div class="row wrap" style="justify-content: space-between; margin-bottom: 12px">
          <div>
            <h3 style="font-size: 17px; margin: 0">Tutorial Views &amp; Employee Completions</h3>
            <p class="sub" style="margin: 2px 0 0">Click Inspect on any row to see individual employee progress.</p>
          </div>
        </div>

        <div v-if="analytics.rows.length === 0" class="sub" style="padding: 20px 0">
          No tutorials created yet.
        </div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Tutorial</th>
                <th>Category</th>
                <th>Total Views</th>
                <th>Unique Viewers</th>
                <th>In Progress</th>
                <th>Completed</th>
                <th>Completion Rate</th>
                <th style="text-align: right">Details</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in analytics.rows" :key="row.tutorial.id">
                <td>
                  <div style="font-weight: 700">{{ row.tutorial.title }}</div>
                  <div class="sub" style="font-size: 11.5px">
                    {{ row.tutorial.is_published ? 'Published' : 'Draft' }} ·
                    {{ row.tutorial.departments.includes('General') ? 'All Teams' : row.tutorial.departments.join(', ') }}
                  </div>
                </td>
                <td>
                  <span class="pill pill-muted">{{ row.categoryName }}</span>
                </td>
                <td class="tabular"><b>{{ row.totalViews }}</b></td>
                <td class="tabular">{{ row.uniqueViewers }}</td>
                <td class="tabular">{{ row.inProgressCount }}</td>
                <td class="tabular"><b>{{ row.completedCount }}</b></td>
                <td style="min-width: 140px">
                  <div class="row" style="gap: 8px; align-items: center">
                    <div class="progress" style="flex: 1">
                      <span :style="{ width: `${row.completionRatePct}%` }" />
                    </div>
                    <span class="tabular" style="font-size: 12px; font-weight: 700">{{ row.completionRatePct }}%</span>
                  </div>
                </td>
                <td style="text-align: right">
                  <button type="button" class="btn btn-ghost btn-sm" @click="inspectRow = row">
                    Inspect Learners
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ADD / EDIT TUTORIAL MODAL -->
    <div v-if="modalOpen" class="modal-backdrop" @click.self="modalOpen = false">
      <div class="modal modal-wide">
        <div class="modal-head">
          <div>
            <h3 style="margin: 0; font-size: 19px">
              {{ editingId ? 'Edit Tutorial' : 'New Captain Academy Tutorial' }}
            </h3>
            <p class="sub" style="margin: 2px 0 0">Add a video, thumbnail, written steps, and department access.</p>
          </div>
          <button type="button" class="modal-close" aria-label="Close modal" @click="modalOpen = false">✕</button>
        </div>

        <div class="field">
          <label>Tutorial Title *</label>
          <input v-model="formTitle" type="text" placeholder="e.g. How to Submit Weekly Safety Reports" />
        </div>

        <div class="row wrap" style="gap: 12px">
          <div class="field" style="flex: 1; min-width: 200px">
            <label>Category</label>
            <select v-model="formCategoryId">
              <option value="">Uncategorized</option>
              <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <div class="field" style="width: 110px">
            <label>Minutes</label>
            <input v-model.number="formDurationMin" type="number" min="0" />
          </div>
          <div class="field" style="width: 110px">
            <label>Seconds</label>
            <input v-model.number="formDurationSec" type="number" min="0" max="59" />
          </div>
        </div>

        <div class="field">
          <label>Short Description</label>
          <input v-model="formDescription" type="text" placeholder="1–2 sentence summary for the tutorial card" />
        </div>

        <!-- Video Source Selection -->
        <div class="field">
          <label>Video Source *</label>
          <div class="row" style="gap: 8px; margin-bottom: 10px">
            <button
              type="button"
              class="chip-btn"
              :class="{ on: formVideoMode === 'external' }"
              @click="formVideoMode = 'external'"
            >
              🔗 External Video URL / YouTube
            </button>
            <button
              type="button"
              class="chip-btn"
              :class="{ on: formVideoMode === 'upload' }"
              @click="formVideoMode = 'upload'"
            >
              ⬆ Upload Video File
            </button>
          </div>

          <div v-if="formVideoMode === 'external'">
            <input
              v-model="formExternalUrl"
              type="text"
              placeholder="Paste YouTube, Vimeo, Loom, or direct .mp4 URL"
            />
            <p v-if="detectedUrlPreview" class="hint">
              <template v-if="detectedUrlPreview.kind === 'youtube'">
                Detected YouTube video (ID: <code>{{ detectedUrlPreview.youtubeId }}</code>)
              </template>
              <template v-else-if="detectedUrlPreview.kind === 'vimeo'">Detected Vimeo embed</template>
              <template v-else-if="detectedUrlPreview.kind === 'loom'">Detected Loom embed</template>
              <template v-else-if="detectedUrlPreview.kind === 'direct_video'">Detected direct MP4/WebM stream</template>
              <template v-else-if="detectedUrlPreview.kind === 'external_link'">External video link</template>
              <template v-else>{{ detectedUrlPreview.error }}</template>
            </p>
          </div>

          <div v-else class="upload-box">
            <input
              type="file"
              accept=".mp4,.webm,.mov,.m4v,.ogg,video/*"
              :disabled="uploadingVideo"
              @change="onVideoFilePicked"
            />
            <p class="hint">
              {{ uploadingVideo ? 'Uploading video & detecting duration…' : 'MP4, WebM, MOV, M4V, or OGG (max 50MB).' }}
            </p>
            <p v-if="formUploadedVideoUrl" class="hint" style="color: var(--teal); font-weight: 700">
              ✓ Video uploaded and linked
            </p>
          </div>
        </div>

        <!-- Thumbnail Upload or URL -->
        <div class="field">
          <label>Thumbnail Image (optional — YouTube auto-fills if blank)</label>
          <div class="row wrap" style="gap: 8px; align-items: center">
            <input
              v-model="formThumbnailUrl"
              type="url"
              placeholder="https://… or upload an image file"
              style="flex: 1; min-width: 200px"
            />
            <label class="btn btn-ghost btn-sm" style="margin: 0; cursor: pointer">
              {{ uploadingThumb ? 'Uploading…' : 'Upload Image' }}
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.gif,image/*"
                style="display: none"
                :disabled="uploadingThumb"
                @change="onThumbnailFilePicked"
              />
            </label>
          </div>
        </div>

        <!-- Department Visibility -->
        <div class="field">
          <label>Department Visibility</label>
          <div class="row wrap" style="gap: 8px; margin-bottom: 8px">
            <button
              type="button"
              class="chip-btn"
              :class="{ on: formAllDepartments }"
              @click="formAllDepartments = true"
            >
              All Departments (General)
            </button>
            <button
              type="button"
              class="chip-btn"
              :class="{ on: !formAllDepartments }"
              @click="formAllDepartments = false"
            >
              Specific Departments
            </button>
          </div>
          <div v-if="!formAllDepartments" class="dept-checks">
            <label v-for="d in departments" :key="d.id" class="dept-chip-label">
              <input
                type="checkbox"
                :checked="formSelectedDepts.includes(d.name)"
                style="width: auto"
                @change="toggleDeptSelection(d.name)"
              />
              <span>{{ d.name }}</span>
            </label>
          </div>
        </div>

        <!-- Written Instructions -->
        <div class="field">
          <div class="row" style="justify-content: space-between; margin-bottom: 6px">
            <label style="margin: 0">Written Instructions (supports # Heading, 1. Step, - Bullet)</label>
            <button type="button" class="btn btn-ghost btn-sm" @click="previewInstructions = !previewInstructions">
              {{ previewInstructions ? 'Edit text' : 'Preview steps' }}
            </button>
          </div>

          <textarea
            v-if="!previewInstructions"
            v-model="formInstructions"
            rows="6"
            placeholder="# Before you begin&#10;1. Open the Captain portal&#10;2. Select your department workflow&#10;- Save your progress before closing"
          />
          <div v-else class="instructions-preview">
            <p v-if="instructionPreviewBlocks.length === 0" class="sub">Nothing written yet.</p>
            <template v-for="(b, i) in instructionPreviewBlocks" :key="i">
              <h4 v-if="b.type === 'heading'" style="margin: 6px 0 2px; font-size: 14px">{{ b.text }}</h4>
              <div v-else-if="b.type === 'ordered'" style="font-size: 13px"><b>{{ b.orderNumber }}.</b> {{ b.text }}</div>
              <div v-else-if="b.type === 'bullet'" style="font-size: 13px">• {{ b.text }}</div>
              <p v-else style="margin: 2px 0; font-size: 13px">{{ b.text }}</p>
            </template>
          </div>
        </div>

        <label class="row" style="gap: 8px; cursor: pointer; margin-bottom: 14px">
          <input v-model="formPublished" type="checkbox" style="width: auto" />
          <span>Publish immediately so employees in selected departments can watch</span>
        </label>

        <p v-if="formError" class="hint" style="color: var(--danger); margin-bottom: 10px">{{ formError }}</p>

        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button type="button" class="btn btn-ghost" @click="modalOpen = false">Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="savingTutorial || uploadingVideo || uploadingThumb"
            @click="submitTutorialForm"
          >
            {{ savingTutorial ? 'Saving…' : editingId ? 'Save Changes' : 'Create Tutorial' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ANALYTICS INSPECT LEARNERS MODAL -->
    <div v-if="inspectRow" class="modal-backdrop" @click.self="inspectRow = null">
      <div class="modal modal-wide">
        <div class="modal-head">
          <div>
            <h3 style="margin: 0; font-size: 18px">{{ inspectRow.tutorial.title }}</h3>
            <p class="sub" style="margin: 2px 0 0">
              {{ inspectRow.totalViews }} total views · {{ inspectRow.completedCount }} completed
            </p>
          </div>
          <button type="button" class="modal-close" aria-label="Close modal" @click="inspectRow = null">✕</button>
        </div>

        <div v-if="inspectLearners.length === 0" class="sub" style="padding: 16px 0">
          No employees have viewed this tutorial yet.
        </div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Department</th>
                <th>Status</th>
                <th>Views</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in inspectLearners" :key="entry.progress.id">
                <td>
                  <div class="row" style="gap: 8px">
                    <div class="avatar" style="width: 26px; height: 26px; font-size: 10px">
                      {{ initialsOf(entry.profile?.full_name) }}
                    </div>
                    <div>
                      <div style="font-weight: 600">{{ entry.profile?.full_name || 'Unknown user' }}</div>
                      <div v-if="entry.profile && !isActive(entry.profile)" class="sub" style="font-size: 11px">
                        Inactive
                      </div>
                    </div>
                  </div>
                </td>
                <td>{{ entry.profile?.department || '—' }}</td>
                <td>
                  <span
                    class="pill"
                    :class="
                      entry.progress.status === 'completed'
                        ? 'pill-teal'
                        : entry.progress.status === 'in_progress'
                          ? 'pill-brass'
                          : 'pill-muted'
                    "
                  >
                    {{ formatTutorialStatusLabel(entry.progress.status) }}
                  </span>
                </td>
                <td class="tabular">{{ entry.progress.view_count }}</td>
                <td class="tabular">{{ entry.progress.progress_pct }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-bottom: 18px;
}
@media (max-width: 720px) {
  .kpi-strip {
    grid-template-columns: 1fr;
  }
}

.tab-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.admin-filters {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.table-wrap {
  overflow-x: auto;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.data-table th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-soft);
  padding: 10px 6px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.data-table td {
  padding: 11px 6px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.tut-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tut-sub-desc {
  font-size: 12px;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini-thumb {
  width: 64px;
  aspect-ratio: 16 / 9;
  border-radius: 7px;
  overflow: hidden;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 12px;
  flex: none;
}
.mini-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cat-grid {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 860px) {
  .cat-grid {
    grid-template-columns: 1fr;
  }
}
.cat-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cat-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--paper);
}
.cat-swatch {
  width: 14px;
  height: 28px;
  border-radius: 6px;
  flex: none;
}

.upload-box {
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  background: var(--paper);
}
.dept-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dept-chip-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--paper);
  cursor: pointer;
  font-size: 12.5px;
}
.instructions-preview {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--paper);
  min-height: 120px;
}
</style>
