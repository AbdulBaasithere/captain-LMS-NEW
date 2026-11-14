<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { loadTrackData, reachedMilestones, hasPassed, milestoneLabel } from '@/lib/quiz'
import { notifyQuizUnlocked } from '@/lib/notifications'
import { loadYouTubeIframeApi, type YTPlayer } from '@/lib/youtube'
import { documentEmbedUrl, hasAnyVideo, hydrateModuleUploadedVideo } from '@/lib/materials'
import { loadCourses, courseProgress, type CourseVM } from '@/lib/courses'
import PracticeQuiz from '@/components/PracticeQuiz.vue'
import CertificateModal from '@/components/CertificateModal.vue'
import { buildCertificateData, type CertificateData } from '@/lib/certificate'
import { recordLearningActivity } from '@/lib/monitoring'
import type { Module, VideoCompletion } from '@/lib/database.types'

// Real watch-time tracking via the YouTube IFrame Player API: the furthest point actually
// watched (maxWatched) is tracked continuously, progress is checked against it every half
// second, and any attempt to scrub ahead of that point gets snapped straight back — so
// fast-forwarding to the end no longer marks a module complete. Completion fires automatically
// once watched progress crosses 95% of the video's duration.

const CAPTION_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ur', label: 'Urdu' },
]

// Tight enough to catch a skip within well under a second, loose enough that normal playback
// between polls (and the postMessage round-trip to the YouTube iframe) never false-triggers it.
const SEEK_TOLERANCE_SECONDS = 0.75
const COMPLETE_THRESHOLD = 0.95
const SAVE_INTERVAL_MS = 5000
const POLL_INTERVAL_MS = 200

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const module_ = ref<Module | null>(null)
const completed = ref(false)
const ccOn = ref(false)
const ccLang = ref('en')

const playerEl = ref<HTMLDivElement | null>(null)
const player = ref<YTPlayer | null>(null)
const htmlVideoEl = ref<HTMLVideoElement | null>(null)
const maxWatched = ref(0)
const currentTime = ref(0)
const ytDuration = ref(0)
const htmlDuration = ref(0)
const isPlaying = ref(false)
let pollTimer: ReturnType<typeof setInterval> | undefined
let saveTimer: ReturnType<typeof setInterval> | undefined
let lastProgressEventAt = 0

const course = ref<CourseVM | null>(null)
const courseCompletions = ref<VideoCompletion[]>([])
const quizOpen = ref(false)
const showCertModal = ref(false)
const autoOpenedCert = ref(false)
const certData = computed<CertificateData | null>(() => {
  if (!course.value || !progress.value || !auth.profile) return null
  return buildCertificateData(course.value, progress.value, auth.profile, courseCompletions.value)
})

function openCertificate() {
  autoOpenedCert.value = false
  showCertModal.value = true
}

const lessonIndex = computed(() => (course.value && module_.value ? course.value.lessons.findIndex((l) => l.id === module_.value!.id) : -1))
const prevLesson = computed(() => (course.value && lessonIndex.value > 0 ? course.value.lessons[lessonIndex.value - 1] : null))
const nextLesson = computed(() => (course.value && lessonIndex.value >= 0 ? course.value.lessons[lessonIndex.value + 1] ?? null : null))
const progress = computed(() => (course.value ? courseProgress(course.value, courseCompletions.value) : null))
const doneIds = computed(() => new Set(courseCompletions.value.filter((c) => c.completed).map((c) => c.module_id)))

function lessonKind(l: Module) {
  const hasVid = hasAnyVideo(l)
  if (hasVid && l.document_url) return `Video + ${l.document_type?.toUpperCase() ?? 'Doc'}`
  return hasVid ? `Video · ${Math.max(1, Math.round(l.duration_seconds / 60))} min` : l.document_url ? 'Document' : 'Lesson'
}

const hasYoutube = computed(() => !!module_.value?.youtube_id)
const hasUploadedVideo = computed(() => !!module_.value?.video_url)
const hasVideo = computed(() => hasYoutube.value || hasUploadedVideo.value)
const hasDocument = computed(() => !!module_.value?.document_url && !!module_.value?.document_type)
const mediaTabCount = computed(() => [hasYoutube.value, hasUploadedVideo.value, hasDocument.value].filter(Boolean).length)
const activeTab = ref<'youtube' | 'uploaded_video' | 'document'>('youtube')

const activeVideoKind = computed<'youtube' | 'uploaded_video' | null>(() => {
  if (activeTab.value === 'youtube' && hasYoutube.value) return 'youtube'
  if (activeTab.value === 'uploaded_video' && hasUploadedVideo.value) return 'uploaded_video'
  if (activeTab.value === 'document') return null
  if (hasYoutube.value) return 'youtube'
  if (hasUploadedVideo.value) return 'uploaded_video'
  return null
})

const duration = computed(() => {
  if (activeVideoKind.value === 'uploaded_video') return htmlDuration.value
  if (activeVideoKind.value === 'youtube') return ytDuration.value
  return 0
})

const watchedPct = computed(() => (duration.value > 0 ? Math.min(100, Math.round((maxWatched.value / duration.value) * 100)) : 0))
const currentPct = computed(() => (duration.value > 0 ? Math.min(100, Math.round((currentTime.value / duration.value) * 100)) : 0))

function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}:${String(rem).padStart(2, '0')}`
}

onMounted(async () => {
  const id = Number(route.params.id)
  const [{ data: rawMod }, { data: comp }] = await Promise.all([
    supabase.from('modules').select('*').eq('id', id).single(),
    supabase
      .from('video_completions')
      .select('*')
      .eq('module_id', id)
      .eq('user_id', auth.profile?.id ?? '')
      .maybeSingle(),
  ])
  module_.value = await hydrateModuleUploadedVideo((rawMod as Module | null) ?? null)
  completed.value = comp?.completed ?? false
  maxWatched.value = comp?.watched_seconds ?? 0
  void loadCourseContext()

  if (module_.value?.youtube_id) {
    activeTab.value = 'youtube'
    await loadYouTubeIframeApi()
    initPlayer()
  } else if (module_.value?.video_url) {
    activeTab.value = 'uploaded_video'
  } else if (module_.value?.document_url) {
    activeTab.value = 'document'
  }
  window.addEventListener('keydown', onKeydown)
})

function onKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (e.key === 'ArrowLeft' || e.key === 'j') {
    e.preventDefault()
    rewindVideo(10)
  }
}

async function loadCourseContext() {
  const dept = auth.profile?.department
  const userId = auth.profile?.id
  if (!dept || !userId || !module_.value) return
  const [{ data: mods }, { data: comps }] = await Promise.all([
    supabase.from('modules').select('*').or(`department.eq.General,department.eq.${dept}`).order('id'),
    supabase.from('video_completions').select('*').eq('user_id', userId),
  ])
  courseCompletions.value = (comps ?? []) as VideoCompletion[]
  const all = await loadCourses((mods ?? []) as Module[])
  course.value = all.find((c) => c.lessons.some((l) => l.id === module_.value!.id)) ?? null

  const activeCourseId = course.value?.dbId ?? module_.value.course_id ?? null
  void recordLearningActivity({
    userId,
    courseId: activeCourseId,
    moduleId: module_.value.id,
    eventType: 'lesson_view',
    progressPct: progress.value?.pct ?? null,
    metadata: { lesson_title: module_.value.title },
  })
}

function goLesson(l: Module | null | undefined) {
  if (l) router.push(`/app/modules/${l.id}`)
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  stopTimers()
  void saveProgress()
  htmlVideoEl.value?.pause()
  player.value?.destroy()
})

function switchTab(nextTab: 'youtube' | 'uploaded_video' | 'document') {
  if (activeTab.value === nextTab) return
  player.value?.pauseVideo()
  htmlVideoEl.value?.pause()
  isPlaying.value = false
  activeTab.value = nextTab
  if (nextTab === 'youtube' && player.value) {
    currentTime.value = player.value.getCurrentTime()
  } else if (nextTab === 'uploaded_video' && htmlVideoEl.value) {
    currentTime.value = htmlVideoEl.value.currentTime
  }
}

function initPlayer() {
  if (!playerEl.value || !module_.value?.youtube_id || !window.YT) return
  player.value = new window.YT.Player(playerEl.value, {
    videoId: module_.value.youtube_id,
    // Privacy-enhanced (youtube-nocookie.com) host — doesn't tie playback to whatever Google
    // account the viewer happens to be signed into, so no personalized related-video suggestions.
    host: 'https://www.youtube-nocookie.com',
    playerVars: {
      enablejsapi: 1,
      rel: 0, // no related videos on pause/end
      modestbranding: 1,
      iv_load_policy: 3, // no video annotations/cards
      disablekb: 1, // no keyboard seeking/speed shortcuts
      fs: 0, // no fullscreen button
      controls: 0, // no native control bar at all — no scrubber, no speed menu, no skip-10s
      playsinline: 1,
    },
    events: {
      onReady: (e) => {
        ytDuration.value = e.target.getDuration()
        if (maxWatched.value > 0 && ytDuration.value > 0) {
          e.target.seekTo(Math.min(maxWatched.value, ytDuration.value), true)
        }
        applyCaptions()
        startTimers()
        void cacheRealDuration(ytDuration.value)
      },
      onStateChange: (e) => {
        if (activeVideoKind.value === 'youtube') {
          isPlaying.value = e.data === 1 // YT.PlayerState.PLAYING
        }
      },
    },
  })
}

function onHtmlVideoMetadata() {
  const el = htmlVideoEl.value
  if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
  htmlDuration.value = el.duration
  if (maxWatched.value > 0) {
    el.currentTime = Math.min(maxWatched.value, el.duration)
  }
  if (activeVideoKind.value === 'uploaded_video') {
    currentTime.value = el.currentTime
  }
  startTimers()
  if (!hasYoutube.value || module_.value?.duration_seconds === 300) {
    void cacheRealDuration(el.duration)
  }
}

function onHtmlVideoPlay() {
  if (activeVideoKind.value === 'uploaded_video') {
    isPlaying.value = true
    startTimers()
  }
}

function onHtmlVideoPause() {
  if (activeVideoKind.value === 'uploaded_video') {
    isPlaying.value = false
  }
}

function onHtmlVideoSeeking() {
  const el = htmlVideoEl.value
  if (!el || completed.value) return
  if (el.currentTime > maxWatched.value + SEEK_TOLERANCE_SECONDS) {
    el.currentTime = maxWatched.value
  }
}

function onHtmlVideoEnded() {
  if (activeVideoKind.value === 'uploaded_video') {
    isPlaying.value = false
  }
  if (!completed.value && htmlDuration.value > 0) {
    maxWatched.value = Math.max(maxWatched.value, htmlDuration.value)
    void markComplete()
  }
}

// YouTube/HTML5 video knows the real length; the DB only has a 300s placeholder until played once.
async function cacheRealDuration(realSeconds: number) {
  if (!module_.value || realSeconds <= 0) return
  const real = Math.round(realSeconds)
  if (Math.abs(real - module_.value.duration_seconds) < 3) return
  // A narrow RPC rather than a direct table update — employees have no general write access to
  // modules, and this function only ever touches duration_seconds.
  await supabase.rpc('cache_module_duration', { p_module_id: module_.value.id, p_seconds: real })
  module_.value.duration_seconds = real
}

function togglePlayback() {
  if (activeVideoKind.value === 'youtube' && player.value) {
    if (isPlaying.value) player.value.pauseVideo()
    else player.value.playVideo()
  } else if (activeVideoKind.value === 'uploaded_video' && htmlVideoEl.value) {
    if (htmlVideoEl.value.paused) void htmlVideoEl.value.play()
    else htmlVideoEl.value.pause()
  }
}

function restartVideo() {
  if (activeVideoKind.value === 'youtube' && player.value) {
    // Rewinding is always allowed — only skipping ahead is blocked — so this just jumps back to 0
    // and resumes play; it doesn't touch maxWatched or the completion state already earned.
    player.value.seekTo(0, true)
    player.value.playVideo()
    currentTime.value = 0
  } else if (activeVideoKind.value === 'uploaded_video' && htmlVideoEl.value) {
    htmlVideoEl.value.currentTime = 0
    void htmlVideoEl.value.play()
    currentTime.value = 0
  }
}

function rewindVideo(seconds = 10) {
  if (activeVideoKind.value === 'youtube' && player.value) {
    const current = player.value.getCurrentTime()
    const target = Math.max(0, current - seconds)
    player.value.seekTo(target, true)
    currentTime.value = target
  } else if (activeVideoKind.value === 'uploaded_video' && htmlVideoEl.value) {
    const target = Math.max(0, htmlVideoEl.value.currentTime - seconds)
    htmlVideoEl.value.currentTime = target
    currentTime.value = target
  }
}

function seekBackTo(event: MouseEvent) {
  if (duration.value <= 0) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const clickFraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const targetTime = clickFraction * duration.value
  // Rewind capability: Allow jumping backward freely to any point up to maxWatched (or anywhere once completed)
  const ceiling = completed.value ? duration.value : maxWatched.value
  const allowed = Math.min(targetTime, ceiling)
  if (activeVideoKind.value === 'youtube' && player.value) {
    player.value.seekTo(allowed, true)
    currentTime.value = allowed
  } else if (activeVideoKind.value === 'uploaded_video' && htmlVideoEl.value) {
    htmlVideoEl.value.currentTime = allowed
    currentTime.value = allowed
  }
}

function startTimers() {
  if (pollTimer && saveTimer) return
  stopTimers()
  pollTimer = setInterval(checkProgress, POLL_INTERVAL_MS)
  saveTimer = setInterval(() => {
    void saveProgress()
    void logStudyTick()
  }, SAVE_INTERVAL_MS)
}

function stopTimers() {
  if (pollTimer) clearInterval(pollTimer)
  if (saveTimer) clearInterval(saveTimer)
  pollTimer = undefined
  saveTimer = undefined
}

function checkProgress() {
  if (activeVideoKind.value === 'youtube' && player.value) {
    const current = player.value.getCurrentTime()
    currentTime.value = current
    if (completed.value) return

    if (current > maxWatched.value + SEEK_TOLERANCE_SECONDS) {
      // Tried to skip ahead — snap back to the furthest point actually watched.
      player.value.seekTo(maxWatched.value, true)
      return
    }
    if (current > maxWatched.value) maxWatched.value = current

    if (ytDuration.value > 0 && maxWatched.value >= ytDuration.value * COMPLETE_THRESHOLD) {
      void markComplete()
    }
  } else if (activeVideoKind.value === 'uploaded_video' && htmlVideoEl.value) {
    const current = htmlVideoEl.value.currentTime
    currentTime.value = current
    if (completed.value) return

    if (current > maxWatched.value + SEEK_TOLERANCE_SECONDS) {
      htmlVideoEl.value.currentTime = maxWatched.value
      return
    }
    if (current > maxWatched.value) maxWatched.value = current

    if (htmlDuration.value > 0 && maxWatched.value >= htmlDuration.value * COMPLETE_THRESHOLD) {
      void markComplete()
    }
  }
}

// The revamp adds last_watched_at; until that SQL has been run, fall back to the original columns.
async function upsertCompletion(row: Record<string, unknown>) {
  const withStamp = { ...row, last_watched_at: new Date().toISOString() }
  const { error } = await supabase.from('video_completions').upsert(withStamp, { onConflict: 'user_id,module_id' })
  if (error) await supabase.from('video_completions').upsert(row, { onConflict: 'user_id,module_id' })
}

async function saveProgress() {
  if (!module_.value || !auth.profile || completed.value || maxWatched.value <= 0) return
  await upsertCompletion({
    user_id: auth.profile.id,
    module_id: module_.value.id,
    watched_seconds: Math.floor(maxWatched.value),
    completed: false,
  })
  const now = Date.now()
  if (now - lastProgressEventAt >= 30_000) {
    lastProgressEventAt = now
    void recordLearningActivity({
      userId: auth.profile.id,
      courseId: course.value?.dbId ?? module_.value.course_id ?? null,
      moduleId: module_.value.id,
      eventType: 'progress_update',
      progressPct: progress.value?.pct ?? null,
      metadata: { watched_seconds: Math.floor(maxWatched.value) },
    })
  }
}

async function logStudyTick() {
  if (!isPlaying.value) return
  // Feeds the streak and weekly-goal widgets; silently ignored if the revamp SQL isn't in place yet.
  await supabase.rpc('log_study_seconds', { p_seconds: Math.round(SAVE_INTERVAL_MS / 1000) })
}

async function markComplete() {
  if (!module_.value || !auth.profile || completed.value) return
  const wasAlreadyCompletedCourse = progress.value?.status === 'completed'
  completed.value = true // set first so the poll loop and any re-entry stop immediately
  stopTimers()
  await upsertCompletion({
    user_id: auth.profile.id,
    module_id: module_.value.id,
    watched_seconds: Math.floor(duration.value || module_.value.duration_seconds),
    completed: true,
    completed_at: new Date().toISOString(),
  })
  await refreshCompletions()

  if (!wasAlreadyCompletedCourse && progress.value?.status === 'completed') {
    autoOpenedCert.value = true
    showCertModal.value = true
  }

  void recordLearningActivity({
    userId: auth.profile.id,
    courseId: course.value?.dbId ?? module_.value.course_id ?? null,
    moduleId: module_.value.id,
    eventType: progress.value?.status === 'completed' ? 'course_completed' : 'lesson_completed',
    progressPct: progress.value?.pct ?? 100,
    metadata: { lesson_title: module_.value.title },
  })

  const { track, completions, attempts } = await loadTrackData(auth.profile.id, auth.profile.department)
  for (const m of reachedMilestones(track, completions)) {
    if (!hasPassed(m, attempts)) await notifyQuizUnlocked(auth.profile.id, m, milestoneLabel(m, track))
  }
}

// Fallback for modules with no video attached yet — nothing to auto-track, so let the employee
// mark it complete manually.
async function markCompleteManually() {
  if (!module_.value || !auth.profile) return
  const wasAlreadyCompletedCourse = progress.value?.status === 'completed'
  completed.value = true
  await upsertCompletion({
    user_id: auth.profile.id,
    module_id: module_.value.id,
    watched_seconds: module_.value.duration_seconds,
    completed: true,
    completed_at: new Date().toISOString(),
  })
  await refreshCompletions()

  if (!wasAlreadyCompletedCourse && progress.value?.status === 'completed') {
    autoOpenedCert.value = true
    showCertModal.value = true
  }

  void recordLearningActivity({
    userId: auth.profile.id,
    courseId: course.value?.dbId ?? module_.value.course_id ?? null,
    moduleId: module_.value.id,
    eventType: progress.value?.status === 'completed' ? 'course_completed' : 'lesson_completed',
    progressPct: progress.value?.pct ?? 100,
    metadata: { lesson_title: module_.value.title, manual_review: true },
  })

  const { track, completions, attempts } = await loadTrackData(auth.profile.id, auth.profile.department)
  for (const m of reachedMilestones(track, completions)) {
    if (!hasPassed(m, attempts)) await notifyQuizUnlocked(auth.profile.id, m, milestoneLabel(m, track))
  }
}

function applyCaptions() {
  if (!player.value) return
  if (ccOn.value) {
    player.value.loadModule('captions')
    player.value.setOption('captions', 'track', { languageCode: ccLang.value })
  } else {
    player.value.unloadModule('captions')
  }
}

async function refreshCompletions() {
  if (!auth.profile) return
  const { data } = await supabase.from('video_completions').select('*').eq('user_id', auth.profile.id)
  courseCompletions.value = (data ?? []) as VideoCompletion[]
}

watch([ccOn, ccLang], applyCaptions)
</script>

<template>
  <div v-if="module_">
    <RouterLink class="back-link" to="/app/catalog">← Course catalog</RouterLink>
    <div class="topline" style="margin-top: 6px">
      <div>
        <h2>{{ course?.title ?? module_.title }}</h2>
        <p v-if="course">Lesson {{ lessonIndex + 1 }} of {{ course.lessons.length }} · {{ module_.title }}</p>
        <p v-else>{{ module_.department }}</p>
      </div>
      <div v-if="progress" class="card" style="padding: 10px 16px; min-width: 230px">
        <div class="row"><div class="bar"><i :style="{ width: progress.pct + '%' }" /></div><b style="white-space: nowrap">{{ progress.pct }}% complete</b></div>
        <button
          v-if="progress.pct === 100"
          class="btn btn-primary btn-sm"
          style="margin-top: 8px; width: 100%; font-size: 11.5px; background: linear-gradient(135deg, #10b981, #059669); border: none"
          @click="openCertificate"
        >
          🏆 Download PDF Certificate
        </button>
      </div>
    </div>

    <div class="player-grid" :class="{ single: !course }">
      <div>
        <div class="card" style="padding: 16px">
          <!-- Multi-Media Tab Selector (YouTube + Uploaded Video + Document/Presentation) -->
          <div v-if="mediaTabCount > 1" class="row wrap" style="gap: 8px; margin-bottom: 14px; align-items: center">
            <button
              v-if="hasYoutube"
              class="chip-btn"
              :class="{ on: activeTab === 'youtube' }"
              @click="switchTab('youtube')"
            >
              ▶ YouTube Video
            </button>
            <button
              v-if="hasUploadedVideo"
              class="chip-btn"
              :class="{ on: activeTab === 'uploaded_video' }"
              @click="switchTab('uploaded_video')"
            >
              🎬 Uploaded Video ({{ module_.video_type?.toUpperCase() ?? 'VIDEO' }})
            </button>
            <button
              v-if="hasDocument"
              class="chip-btn"
              :class="{ on: activeTab === 'document' }"
              @click="switchTab('document')"
            >
              📄 Reading Material ({{ module_.document_type?.toUpperCase() }})
            </button>
            <a
              v-if="hasDocument && activeTab === 'document'"
              :href="module_.document_url as string"
              target="_blank"
              class="btn btn-ghost btn-sm"
              style="margin-left: auto; font-size: 11.5px"
            >
              Open Document ↗
            </a>
          </div>

          <div
            v-if="hasYoutube"
            v-show="activeVideoKind === 'youtube'"
            class="video-box"
          >
            <div ref="playerEl" style="width: 100%; height: 100%" />
            <div class="video-cover" :class="{ paused: !isPlaying }" @click="togglePlayback">
              <span v-if="!isPlaying" class="video-cover-play">▶</span>
            </div>
          </div>

          <div
            v-if="hasUploadedVideo"
            v-show="activeVideoKind === 'uploaded_video'"
            class="video-box"
          >
            <video
              ref="htmlVideoEl"
              :src="module_.video_url!"
              playsinline
              preload="metadata"
              disablepictureinpicture
              controlslist="nodownload noplaybackrate"
              style="width: 100%; height: 100%; display: block; object-fit: contain; background: #000"
              @contextmenu.prevent
              @loadedmetadata="onHtmlVideoMetadata"
              @play="onHtmlVideoPlay"
              @pause="onHtmlVideoPause"
              @seeking="onHtmlVideoSeeking"
              @ended="onHtmlVideoEnded"
            />
            <div class="video-cover" :class="{ paused: !isPlaying }" @click="togglePlayback">
              <span v-if="!isPlaying" class="video-cover-play">▶</span>
            </div>
          </div>

          <div v-if="hasDocument && activeTab === 'document'" class="document-box">
            <iframe
              :src="documentEmbedUrl(module_.document_url as string, module_.document_type as string)"
              style="width: 100%; height: 100%; border: 0"
            />
          </div>
          <div v-if="!hasVideo && !hasDocument" class="video-box video-placeholder">▶ No learning material attached yet</div>

          <div v-if="activeVideoKind" class="row wrap" style="margin-top: 12px; gap: 8px; align-items: center">
            <button class="btn btn-primary btn-sm" @click="togglePlayback">{{ isPlaying ? '⏸ Pause' : '▶ Play' }}</button>
            <button class="btn btn-ghost btn-sm" title="Rewind 10 seconds" @click="rewindVideo(10)">⏪ 10s</button>
            <button class="btn btn-ghost btn-sm" title="Rewind 30 seconds" @click="rewindVideo(30)">⏪ 30s</button>
            <button class="btn btn-ghost btn-sm" title="Restart video from beginning" @click="restartVideo">⟲ Start over</button>
            <button
              v-if="activeVideoKind === 'youtube'"
              class="btn btn-ghost btn-sm"
              :class="{ 'btn-primary': ccOn }"
              title="Toggle captions"
              @click="ccOn = !ccOn"
            >
              CC {{ ccOn ? 'on' : 'off' }}
            </button>
            <select v-if="activeVideoKind === 'youtube' && ccOn" v-model="ccLang" style="width: auto">
              <option v-for="l in CAPTION_LANGUAGES" :key="l.code" :value="l.code">{{ l.label }}</option>
            </select>
            <span class="lock-note" style="margin-left: auto">🔒 Rewind enabled · Skip ahead locked</span>
          </div>

          <div v-if="activeVideoKind" style="margin-top: 12px">
            <div class="row" style="align-items: center; gap: 10px">
              <span class="sub" style="font-size: 12px; font-variant-numeric: tabular-nums; min-width: 38px; text-align: right">
                {{ formatSeconds(currentTime) }}
              </span>
              <div
                class="bar video-progress-track"
                title="Click anywhere to jump back in video"
                style="cursor: pointer; flex: 1; position: relative; height: 10px; border-radius: 99px; overflow: hidden; background: rgba(255, 255, 255, 0.08)"
                @click="seekBackTo"
              >
                <!-- Max watched ceiling boundary -->
                <i
                  style="position: absolute; left: 0; top: 0; bottom: 0; background: rgba(59, 130, 246, 0.35); pointer-events: none"
                  :style="{ width: watchedPct + '%' }"
                />
                <!-- Current playback position -->
                <i
                  style="position: absolute; left: 0; top: 0; bottom: 0; background: #2563eb; pointer-events: none"
                  :style="{ width: currentPct + '%' }"
                />
              </div>
              <span class="sub" style="font-size: 12px; font-variant-numeric: tabular-nums; min-width: 38px">
                {{ formatSeconds(duration) }}
              </span>
            </div>
            <p v-if="!completed" class="hint" style="margin-top: 4px">
              You can freely rewind or jump back to review. Skipping ahead is locked until watched. Completes automatically at 95%.
            </p>
          </div>

          <div class="row wrap" style="margin-top: 16px">
            <button v-if="!completed && !hasVideo" class="btn btn-primary" @click="markCompleteManually">
              Mark as reviewed
            </button>
            <span v-if="completed" class="pill pill-teal">✓ Completed</span>
            <span class="sp" />
            <button v-if="prevLesson" class="btn btn-ghost" @click="goLesson(prevLesson)">Previous</button>
            <button v-if="nextLesson" class="btn btn-primary" @click="goLesson(nextLesson)">Next lesson</button>
            <RouterLink v-if="!course" class="btn btn-ghost btn-sm" to="/app/modules">Back to modules</RouterLink>
          </div>
        </div>
      </div>

      <aside v-if="course">
        <div class="card" style="padding: 18px">
          <div class="row" style="margin-bottom: 8px"><h3 style="font-size: 19px">Lessons</h3><span class="sub sp">{{ progress?.done }} of {{ progress?.total }} done</span></div>
          <button
            v-for="(l, i) in course.lessons"
            :key="l.id"
            class="lesson"
            :class="{ on: l.id === module_.id }"
            @click="goLesson(l)"
          >
            <span class="num" :class="{ done: doneIds.has(l.id) }">{{ doneIds.has(l.id) ? '✓' : i + 1 }}</span>
            <span style="text-align: left">
              <b>{{ l.title }}</b>
              <span class="sub" style="display: block">Lesson {{ i + 1 }} · {{ lessonKind(l) }}</span>
            </span>
          </button>
        </div>

        <!-- 100% Course Completion Certificate Badge -->
        <div
          v-if="progress?.status === 'completed'"
          class="card"
          style="padding: 16px; margin-bottom: 16px; border: 1px solid rgba(212, 175, 55, 0.4); background: linear-gradient(145deg, rgba(212, 175, 55, 0.12), rgba(15, 23, 42, 0.8))"
        >
          <div class="row" style="gap: 10px; align-items: center">
            <span style="font-size: 26px">🏆</span>
            <div>
              <b style="display: block; font-size: 13px; color: #f8fafc">100% Completed!</b>
              <span class="sub" style="font-size: 11px; color: #cbd5e1">Official certificate unlocked</span>
            </div>
          </div>
          <button
            class="btn btn-primary btn-sm"
            style="margin-top: 10px; width: 100%; font-size: 12px"
            @click="openCertificate"
          >
            📥 Download PDF Certificate
          </button>
        </div>

        <div class="quiz-card">
          <div class="kicker" style="color: var(--brass)">Check your understanding</div>
          <h3>Practice quiz from this course's question banks</h3>
          <button class="btn quiz-btn" @click="quizOpen = true">Start practice quiz</button>
        </div>
      </aside>
    </div>

    <PracticeQuiz
      v-if="quizOpen && course"
      :course-id="course.dbId"
      :course-title="course.title"
      :lesson-ids="course.lessons.map((l) => l.id)"
      @close="quizOpen = false"
    />
    <CertificateModal v-if="showCertModal && certData" :certificate="certData" :auto-opened="autoOpenedCert" @close="showCertModal = false" />
  </div>
</template>

<style scoped>
.video-box {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: 16px;
  overflow: hidden;
  background: linear-gradient(150deg, #1a1d2b, #0d0f18);
}
.video-cover {
  position: absolute;
  inset: 0;
  cursor: pointer;
  display: grid;
  place-items: center;
  background: transparent;
  transition: background 0.15s ease;
}
.video-cover.paused {
  background: rgba(13, 15, 24, 0.88);
}
.video-cover-play {
  width: 56px;
  height: 56px;
  border-radius: 999px;
  background: var(--blue);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 20px;
}
.video-placeholder {
  display: grid;
  place-items: center;
  color: #cfd3e6;
  font-size: 13px;
}
.document-box {
  width: 100%;
  height: min(85vh, 1100px);
  min-height: 420px;
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(150deg, #1a1d2b, #0d0f18);
}
@media (max-width: 760px) {
  .document-box {
    height: 70vh;
  }
}
.player-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 18px;
  align-items: start;
}
.player-grid.single {
  grid-template-columns: minmax(0, 760px);
}
@media (max-width: 1000px) {
  .player-grid {
    grid-template-columns: 1fr;
  }
}
.back-link {
  color: var(--blue);
  font-weight: 700;
  text-decoration: none;
}
.lock-note {
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-soft);
}
.lesson {
  display: flex;
  gap: 12px;
  align-items: center;
  width: 100%;
  padding: 10px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.lesson:hover {
  background: var(--surface-sunken);
}
.lesson.on {
  background: var(--blue-soft);
}
.num {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 13px;
  background: var(--surface-sunken);
  flex: none;
}
.num.done {
  background: var(--teal);
  color: #fff;
}
.lesson.on .num {
  background: var(--blue);
  color: #fff;
}
.quiz-card {
  background: #0f1b33;
  color: #fff;
  border-radius: 20px;
  padding: 22px;
  margin-top: 16px;
}
.quiz-card h3 {
  font-size: 19px;
  margin: 6px 0 16px;
}
.quiz-btn {
  width: 100%;
  justify-content: center;
  background: var(--brass);
  color: #1a1000;
}
</style>
