<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import {
  loadSingleEmployeeTutorial,
  recordTutorialView,
  saveTutorialProgress,
} from '@/lib/tutorials'
import {
  detectExternalVideoKind,
  formatTutorialDuration,
  formatTutorialStatusLabel,
  parseInstructionBlocks,
  resolveTutorialStatus,
  resolveTutorialThumbnail,
  sanitizeExternalUrl,
} from '@/lib/tutorialHelpers'
import type { Tutorial, TutorialCategory, TutorialProgress, TutorialStatus } from '@/lib/database.types'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const loading = ref(true)
const errorMsg = ref('')
const missingTable = ref(false)
const tutorial = ref<Tutorial | null>(null)
const categories = ref<TutorialCategory[]>([])
const relatedTutorials = ref<Tutorial[]>([])
const progress = ref<TutorialProgress | null>(null)
const savingStatus = ref(false)
const statusNotice = ref('')
const htmlVideoEl = ref<HTMLVideoElement | null>(null)

let lastSyncedSecond = 0
let lastSyncAt = 0

const tutorialId = computed(() => Number(route.params.id))
const currentStatus = computed<TutorialStatus>(() => resolveTutorialStatus(progress.value))

const categoryInfo = computed(() => {
  if (!tutorial.value?.category_id) return null
  return categories.value.find((c) => c.id === tutorial.value!.category_id) ?? null
})

const instructionBlocks = computed(() => parseInstructionBlocks(tutorial.value?.instructions))

const videoPlayback = computed(() => {
  const t = tutorial.value
  if (!t) return null

  if (t.video_source === 'upload') {
    const url = sanitizeExternalUrl(t.video_url)
    return url ? { mode: 'html5' as const, src: url } : null
  }

  if (t.video_source === 'youtube' && t.youtube_id) {
    return {
      mode: 'iframe' as const,
      src: `https://www.youtube-nocookie.com/embed/${t.youtube_id}?rel=0&modestbranding=1`,
    }
  }

  const raw = t.video_url || t.youtube_id || ''
  const detected = detectExternalVideoKind(raw)
  if (detected.kind === 'youtube' || detected.kind === 'vimeo' || detected.kind === 'loom') {
    return { mode: 'iframe' as const, src: detected.embedUrl }
  }
  if (detected.kind === 'direct_video') {
    return { mode: 'html5' as const, src: detected.mediaUrl }
  }
  if (detected.kind === 'external_link') {
    return { mode: 'external_link' as const, url: detected.url }
  }
  return null
})

const nextInCategory = computed(() => {
  const t = tutorial.value
  if (!t) return []
  const sameCat = relatedTutorials.value.filter((item) => item.category_id === t.category_id)
  const others = relatedTutorials.value.filter((item) => item.category_id !== t.category_id)
  return [...sameCat, ...others].slice(0, 6)
})

async function loadPage() {
  loading.value = true
  errorMsg.value = ''
  statusNotice.value = ''
  lastSyncedSecond = 0
  lastSyncAt = 0

  const userId = auth.profile?.id
  const dept = auth.profile?.department ?? 'General'
  const id = tutorialId.value
  if (!userId || !Number.isFinite(id) || id <= 0) {
    errorMsg.value = 'Invalid tutorial link.'
    loading.value = false
    return
  }

  const res = await loadSingleEmployeeTutorial(id, userId, dept)
  missingTable.value = res.missingTable
  categories.value = res.categories
  tutorial.value = res.tutorial
  relatedTutorials.value = res.relatedTutorials
  progress.value = res.progress
  errorMsg.value = res.error ?? ''
  loading.value = false

  if (res.tutorial) {
    void recordTutorialView(res.tutorial.id)
    if (!res.progress || res.progress.status === 'not_started') {
      const updated = await saveTutorialProgress({
        tutorialId: res.tutorial.id,
        userId,
        status: 'in_progress',
        watchedSeconds: res.progress?.watched_seconds ?? 0,
        progressPct: Math.max(5, res.progress?.progress_pct ?? 5),
        existing: res.progress,
      })
      if (updated.progress) progress.value = updated.progress
    }
  }
}

onMounted(loadPage)
watch(tutorialId, () => {
  void loadPage()
})

onBeforeUnmount(() => {
  htmlVideoEl.value?.pause()
})

async function setStatus(status: TutorialStatus) {
  const userId = auth.profile?.id
  if (!tutorial.value || !userId || savingStatus.value) return

  savingStatus.value = true
  statusNotice.value = ''
  const watched = htmlVideoEl.value ? Math.round(htmlVideoEl.value.currentTime) : progress.value?.watched_seconds ?? 0
  const pct =
    status === 'completed'
      ? 100
      : status === 'not_started'
        ? 0
        : Math.max(5, progress.value?.progress_pct ?? 5)

  const { progress: saved, error } = await saveTutorialProgress({
    tutorialId: tutorial.value.id,
    userId,
    status,
    watchedSeconds: watched,
    progressPct: pct,
    existing: progress.value,
  })
  savingStatus.value = false

  if (error) {
    statusNotice.value = error
    return
  }
  if (saved) progress.value = saved
  statusNotice.value = `Marked as ${formatTutorialStatusLabel(status)}.`
}

async function onHtmlTimeUpdate() {
  const el = htmlVideoEl.value
  const userId = auth.profile?.id
  const t = tutorial.value
  if (!el || !userId || !t || !Number.isFinite(el.duration) || el.duration <= 0) return

  const currentSec = Math.floor(el.currentTime)
  const pct = Math.min(100, Math.round((el.currentTime / el.duration) * 100))
  const now = Date.now()

  if (pct >= 90 && currentStatus.value !== 'completed') {
    lastSyncedSecond = currentSec
    lastSyncAt = now
    const res = await saveTutorialProgress({
      tutorialId: t.id,
      userId,
      status: 'completed',
      watchedSeconds: currentSec,
      progressPct: 100,
      existing: progress.value,
    })
    if (res.progress) progress.value = res.progress
    return
  }

  if (currentStatus.value !== 'completed' && currentSec - lastSyncedSecond >= 10 && now - lastSyncAt >= 8000) {
    lastSyncedSecond = currentSec
    lastSyncAt = now
    const res = await saveTutorialProgress({
      tutorialId: t.id,
      userId,
      status: 'in_progress',
      watchedSeconds: currentSec,
      progressPct: Math.max(5, Math.min(99, pct)),
      existing: progress.value,
    })
    if (res.progress) progress.value = res.progress
  }
}

async function onHtmlEnded() {
  if (currentStatus.value !== 'completed') {
    await setStatus('completed')
  }
}

function goBack() {
  router.push('/app/tutorials')
}

function openRelated(id: number) {
  router.push(`/app/tutorials/${id}`)
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <button type="button" class="btn btn-ghost btn-sm" style="margin-bottom: 10px" @click="goBack">
          ← Back to Captain Academy
        </button>
        <h2 v-if="tutorial">{{ tutorial.title }}</h2>
        <h2 v-else>Captain Academy Tutorial</h2>
        <p v-if="tutorial" class="row wrap" style="gap: 8px; margin-top: 4px">
          <span
            class="pill"
            :style="{
              background: categoryInfo?.color || 'var(--accent)',
              color: '#ffffff',
            }"
          >
            {{ categoryInfo?.name || 'Uncategorized' }}
          </span>
          <span class="pill pill-muted tabular">⏱ {{ formatTutorialDuration(tutorial.duration_seconds) }}</span>
          <span class="pill pill-outline">
            👥 {{ tutorial.departments.includes('General') ? 'All Departments' : tutorial.departments.join(', ') }}
          </span>
        </p>
      </div>

      <div v-if="tutorial" class="status-controls-wrap">
        <span class="sub" style="font-size: 12px">Your progress:</span>
        <div class="status-btn-group" role="group" aria-label="Tutorial progress status">
          <button
            v-for="opt in ([
              { id: 'not_started', label: 'Not Started' },
              { id: 'in_progress', label: 'In Progress' },
              { id: 'completed', label: '✓ Completed' },
            ] as const)"
            :key="opt.id"
            type="button"
            class="chip-btn"
            :class="{
              on: currentStatus === opt.id,
              'done-chip': opt.id === 'completed' && currentStatus === 'completed',
            }"
            :disabled="savingStatus"
            @click="setStatus(opt.id)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="loading" class="card" style="padding: 36px; text-align: center">
      <p class="sub">Loading tutorial…</p>
    </div>

    <div v-else-if="missingTable" class="card" style="padding: 24px">
      <h3 style="margin-bottom: 6px">Academy tutorials setup pending</h3>
      <p class="sub">
        Run <code>supabase/migrations/20261125_captain_academy_tutorials.sql</code> in Supabase SQL Editor.
      </p>
    </div>

    <div v-else-if="errorMsg || !tutorial" class="card" style="padding: 28px">
      <h3 style="margin-bottom: 6px">Unable to open tutorial</h3>
      <p class="sub" style="margin-bottom: 14px">{{ errorMsg || 'Tutorial not found.' }}</p>
      <button type="button" class="btn btn-primary btn-sm" @click="goBack">Return to Tutorials</button>
    </div>

    <div v-else class="player-layout">
      <!-- Main Column: Video + Progress + Written Instructions -->
      <div class="player-main">
        <div class="card video-card">
          <div class="video-stage">
            <video
              v-if="videoPlayback?.mode === 'html5'"
              ref="htmlVideoEl"
              :src="videoPlayback.src"
              :poster="resolveTutorialThumbnail(tutorial) ?? undefined"
              controls
              controlsList="nodownload"
              playsinline
              class="video-el"
              @timeupdate="onHtmlTimeUpdate"
              @ended="onHtmlEnded"
            />
            <iframe
              v-else-if="videoPlayback?.mode === 'iframe'"
              :src="videoPlayback.src"
              :title="tutorial.title"
              class="video-el"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
            />
            <div v-else-if="videoPlayback?.mode === 'external_link'" class="video-fallback">
              <p style="margin-bottom: 12px">This external video link opens in a new browser tab.</p>
              <a
                :href="videoPlayback.url"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-primary"
              >
                Open Tutorial Video ↗
              </a>
            </div>
            <div v-else class="video-fallback">
              <p class="sub">No video attached — follow the written instructions below.</p>
            </div>
          </div>

          <div class="video-foot">
            <div class="progress-summary">
              <span
                class="pill"
                :class="
                  currentStatus === 'completed'
                    ? 'pill-teal'
                    : currentStatus === 'in_progress'
                      ? 'pill-brass'
                      : 'pill-muted'
                "
              >
                {{ formatTutorialStatusLabel(currentStatus) }}
              </span>
              <span v-if="statusNotice" class="sub" style="font-size: 12px">{{ statusNotice }}</span>
            </div>

            <button
              v-if="currentStatus !== 'completed'"
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="savingStatus"
              @click="setStatus('completed')"
            >
              ✓ Mark as Completed
            </button>
          </div>
        </div>

        <!-- Written Instructions Card -->
        <div class="card instructions-card">
          <div class="instructions-head">
            <h3>Written Instructions &amp; Guide</h3>
            <span class="sub">Reference steps alongside the video</span>
          </div>

          <p v-if="tutorial.description" class="tut-overview">{{ tutorial.description }}</p>

          <div v-if="instructionBlocks.length > 0" class="instructions-body">
            <template v-for="(block, idx) in instructionBlocks" :key="idx">
              <h4 v-if="block.type === 'heading'" class="inst-heading">{{ block.text }}</h4>
              <div v-else-if="block.type === 'ordered'" class="inst-step">
                <span class="inst-num tabular">{{ block.orderNumber }}</span>
                <span>{{ block.text }}</span>
              </div>
              <div v-else-if="block.type === 'bullet'" class="inst-bullet">
                <span aria-hidden="true">•</span>
                <span>{{ block.text }}</span>
              </div>
              <p v-else class="inst-para">{{ block.text }}</p>
            </template>
          </div>
          <p v-else class="sub">No written instructions were added for this tutorial.</p>
        </div>
      </div>

      <!-- Sidebar: More Tutorials -->
      <aside class="player-side">
        <div class="card side-card">
          <div class="side-head">
            <h4>More in Captain Academy</h4>
            <span class="sub">{{ nextInCategory.length }} available</span>
          </div>

          <div v-if="nextInCategory.length === 0" class="sub" style="padding: 12px 0">
            No additional tutorials yet.
          </div>

          <div v-else class="related-list">
            <button
              v-for="item in nextInCategory"
              :key="item.id"
              type="button"
              class="related-item"
              @click="openRelated(item.id)"
            >
              <div class="related-thumb">
                <img
                  v-if="resolveTutorialThumbnail(item)"
                  :src="resolveTutorialThumbnail(item)!"
                  :alt="item.title"
                />
                <span v-else class="related-play">▶</span>
              </div>
              <div class="related-info">
                <div class="related-title">{{ item.title }}</div>
                <div class="related-dur tabular">{{ formatTutorialDuration(item.duration_seconds) }}</div>
              </div>
            </button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.status-controls-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.status-btn-group {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.done-chip.on {
  background: #059669 !important;
  border-color: #059669 !important;
  color: #ffffff !important;
}

.player-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
  gap: 18px;
  align-items: start;
}
@media (max-width: 960px) {
  .player-layout {
    grid-template-columns: 1fr;
  }
  .status-controls-wrap {
    align-items: flex-start;
  }
}

.player-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.video-card {
  overflow: hidden;
  padding: 0;
}
.video-stage {
  aspect-ratio: 16 / 9;
  width: 100%;
  background: #120e10;
  display: flex;
  align-items: center;
  justify-content: center;
}
.video-el {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.video-fallback {
  padding: 28px;
  text-align: center;
  color: #f6f2f3;
}
.video-foot {
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border);
}
.progress-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.instructions-card {
  padding: 20px;
}
.instructions-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.instructions-head h3 {
  font-size: 18px;
  margin: 0;
}
.tut-overview {
  font-size: 14px;
  color: var(--ink-soft);
  line-height: 1.55;
  margin: 0 0 14px;
  padding: 12px 14px;
  background: var(--surface-sunken);
  border-radius: 11px;
}
.instructions-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 14.5px;
  line-height: 1.6;
}
.inst-heading {
  font-size: 15.5px;
  font-weight: 800;
  margin: 8px 0 2px;
  color: var(--ink);
}
.inst-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.inst-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 800;
  display: grid;
  place-items: center;
  flex: none;
  margin-top: 1px;
}
.inst-bullet {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding-left: 6px;
}
.inst-para {
  margin: 0;
  color: var(--ink);
}

.side-card {
  padding: 16px;
}
.side-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.side-head h4 {
  font-size: 15px;
  margin: 0;
}
.related-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.related-item {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  text-align: left;
  background: var(--paper);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 8px;
  cursor: pointer;
  color: inherit;
  font: inherit;
  transition: border-color 0.15s ease;
}
.related-item:hover {
  border-color: var(--accent);
}
.related-thumb {
  width: 78px;
  aspect-ratio: 16 / 9;
  border-radius: 7px;
  overflow: hidden;
  background: #1a1316;
  display: grid;
  place-items: center;
  flex: none;
}
.related-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.related-play {
  color: #ffffff;
  font-size: 12px;
}
.related-info {
  min-width: 0;
  flex: 1;
}
.related-title {
  font-size: 13px;
  font-weight: 700;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.related-dur {
  font-size: 11px;
  color: var(--ink-soft);
  margin-top: 3px;
}
</style>
