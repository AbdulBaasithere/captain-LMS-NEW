<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { loadDepartments } from '@/lib/departments'
import { parseYoutubeId } from '@/lib/youtube'
import {
  uploadModuleMaterial,
  uploadModuleVideo,
  saveModuleUploadedVideo,
  clearModuleUploadedVideo,
  hydrateModuleUploadedVideo,
  probeVideoDurationSeconds,
  documentEmbedUrl,
  deleteMaterialFile,
  formatDuration,
} from '@/lib/materials'
import { MIN_QUESTIONS_TO_PUBLISH, parseBulkQuestions } from '@/lib/quiz'
import { generateQuestions, type GeneratedQuestion } from '@/lib/generateQuestions'
import type { Module, QuizQuestion, Department, Course } from '@/lib/database.types'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const moduleId = computed(() => Number(route.params.id))

const module_ = ref<Module | null>(null)
const questions = ref<QuizQuestion[]>([])
const loading = ref(true)
const loadError = ref('')

const departments = ref<Department[]>([])
const detailTitle = ref('')
const detailDepartment = ref('')
const detailYoutubeId = ref('')
const detailQuizRequired = ref(true)
const detailCourse = ref<number | ''>('')
const courseOptions = ref<Pick<Course, 'id' | 'title'>[]>([])
const savingDetails = ref(false)

const newQuestion = ref('')
const newOptions = ref(['', '', '', ''])
const newCorrect = ref(0)
const savingQuestion = ref(false)

const bulkText = ref('')
const bulkPreview = ref<ReturnType<typeof parseBulkQuestions>>([])
const savingBulk = ref(false)

const publishBusy = ref(false)
const scheduledDate = ref('')
const savingSchedule = ref(false)

const uploadingMaterial = ref(false)
const materialError = ref('')
const uploadingVideo = ref(false)
const videoError = ref('')
const detailsError = ref('')
const docInputEl = ref<HTMLInputElement | null>(null)
const videoInputEl = ref<HTMLInputElement | null>(null)
const activePreviewTab = ref<'youtube' | 'uploaded_video' | 'document'>('youtube')

const editingId = ref<number | null>(null)
const editQuestion = ref('')
const editOptions = ref(['', '', '', ''])
const editCorrect = ref(0)
const savingEdit = ref(false)

const hasYoutube = computed(() => !!module_.value?.youtube_id)
const hasUploadedVideo = computed(() => !!module_.value?.video_url)
const hasDocument = computed(() => !!module_.value?.document_url && !!module_.value?.document_type)
const mediaTabCount = computed(() => [hasYoutube.value, hasUploadedVideo.value, hasDocument.value].filter(Boolean).length)

function pickDefaultPreviewTab(mod: Module | null) {
  if (!mod) return
  if (activePreviewTab.value === 'youtube' && mod.youtube_id) return
  if (activePreviewTab.value === 'uploaded_video' && mod.video_url) return
  if (activePreviewTab.value === 'document' && mod.document_url) return
  if (mod.youtube_id) activePreviewTab.value = 'youtube'
  else if (mod.video_url) activePreviewTab.value = 'uploaded_video'
  else if (mod.document_url) activePreviewTab.value = 'document'
}

async function load() {
  loading.value = true
  loadError.value = ''
  const id = moduleId.value
  if (!Number.isFinite(id) || id <= 0) {
    module_.value = null
    loadError.value = 'Invalid module ID.'
    loading.value = false
    return
  }

  try {
    const [{ data: rawMod, error: modErr }, { data: qs }, depts, { data: cs }] = await Promise.all([
      supabase.from('modules').select('*').eq('id', id).maybeSingle(),
      supabase.from('quiz_questions').select('*').eq('module_id', id).order('id'),
      loadDepartments(),
      supabase.from('courses').select('id, title').order('title'),
    ])
    if (modErr) {
      module_.value = null
      loadError.value = modErr.message || 'Could not load module details.'
      return
    }
    if (!rawMod) {
      module_.value = null
      loadError.value = `Module #${id} was not found.`
      return
    }
    const mod = await hydrateModuleUploadedVideo(rawMod as Module)
    courseOptions.value = (cs ?? []) as Pick<Course, 'id' | 'title'>[]
    module_.value = mod
    questions.value = (qs ?? []).map((q) => ({
      ...q,
      options: Array.isArray(q.options) ? q.options : [],
    }))
    scheduledDate.value = mod?.scheduled_date ?? ''
    departments.value = depts
    detailTitle.value = mod?.title ?? ''
    detailDepartment.value = mod?.department ?? 'General'
    detailYoutubeId.value = mod?.youtube_id ?? ''
    detailQuizRequired.value = mod?.quiz_required ?? true
    detailCourse.value = mod?.course_id ?? ''
    pickDefaultPreviewTab(mod)
  } catch (err) {
    module_.value = null
    loadError.value = err instanceof Error ? err.message : 'Unexpected error loading module.'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(moduleId, () => {
  void load()
})

async function saveDetails() {
  if (!detailTitle.value.trim()) return
  detailsError.value = ''
  const rawYoutube = detailYoutubeId.value.trim()
  const youtubeId = rawYoutube ? parseYoutubeId(rawYoutube) : null
  if (rawYoutube && !youtubeId) {
    detailsError.value = "That doesn't look like a YouTube link or ID — paste the video link or its 11-character ID."
    return
  }
  savingDetails.value = true
  await supabase
    .from('modules')
    .update({
      title: detailTitle.value.trim(),
      department: detailDepartment.value,
      youtube_id: youtubeId || null,
      ...(courseOptions.value.length ? { course_id: detailCourse.value || null } : {}),
      // Only meaningful for General modules — department modules always have a quiz via the
      // 5-module grouping, so this is ignored for them either way.
      quiz_required: detailDepartment.value === 'General' ? detailQuizRequired.value : true,
    })
    .eq('id', moduleId.value)
  await logActivity(auth.profile?.id, `Updated details for "${detailTitle.value.trim()}"`)
  savingDetails.value = false
  if (youtubeId) activePreviewTab.value = 'youtube'
  await load()
}

async function onVideoSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const id = moduleId.value
  videoError.value = ''
  uploadingVideo.value = true
  const previousVideoUrl = module_.value?.video_url ?? null
  try {
    const [probedDuration, uploadRes] = await Promise.all([
      probeVideoDurationSeconds(file),
      uploadModuleVideo(id, file),
    ])
    const { url, type, error } = uploadRes
    if (error || !url || !type) {
      videoError.value = error ?? 'Video upload failed.'
      return
    }
    const { error: saveErr } = await saveModuleUploadedVideo(
      id,
      url,
      type,
      probedDuration,
      !module_.value?.youtube_id || module_.value?.duration_seconds === 300,
    )

    if (saveErr) {
      await deleteMaterialFile(url)
      videoError.value = saveErr
      return
    }

    if (previousVideoUrl && previousVideoUrl !== url) {
      await deleteMaterialFile(previousVideoUrl)
    }
    await logActivity(auth.profile?.id, `Uploaded a ${type.toUpperCase()} video to "${module_.value?.title}"`)
    activePreviewTab.value = 'uploaded_video'
    await load()
  } finally {
    uploadingVideo.value = false
    if (videoInputEl.value) videoInputEl.value.value = ''
  }
}

async function removeUploadedVideo() {
  await clearModuleUploadedVideo(moduleId.value, module_.value?.video_url)
  await logActivity(auth.profile?.id, `Removed the uploaded video from "${module_.value?.title}"`)
  if (module_.value?.youtube_id) activePreviewTab.value = 'youtube'
  else if (module_.value?.document_url) activePreviewTab.value = 'document'
  await load()
}

async function onMaterialSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const id = moduleId.value
  materialError.value = ''
  uploadingMaterial.value = true
  const previousDocUrl = module_.value?.document_url ?? null
  try {
    const { url, type, error } = await uploadModuleMaterial(id, file)
    if (error || !url || !type) {
      materialError.value = error ?? 'Upload failed.'
    } else {
      await supabase.from('modules').update({ document_url: url, document_type: type }).eq('id', id)
      if (previousDocUrl && previousDocUrl !== url) {
        await deleteMaterialFile(previousDocUrl)
      }
      await logActivity(auth.profile?.id, `Uploaded a ${type.toUpperCase()} document to "${module_.value?.title}"`)
      activePreviewTab.value = 'document'
      await load()
    }
  } finally {
    uploadingMaterial.value = false
    if (docInputEl.value) docInputEl.value.value = ''
  }
}

async function removeMaterial() {
  if (module_.value?.document_url) {
    await deleteMaterialFile(module_.value.document_url)
  }
  await supabase.from('modules').update({ document_url: null, document_type: null }).eq('id', moduleId.value)
  await logActivity(auth.profile?.id, `Removed the uploaded document from "${module_.value?.title}"`)
  if (module_.value?.youtube_id) activePreviewTab.value = 'youtube'
  else if (module_.value?.video_url) activePreviewTab.value = 'uploaded_video'
  await load()
}

const quizExempt = computed(() => module_.value?.department === 'General' && !module_.value.quiz_required)
const canPublish = computed(() => quizExempt.value || questions.value.length >= MIN_QUESTIONS_TO_PUBLISH)
const isScheduledFuture = computed(
  () => !!module_.value?.scheduled_date && module_.value.scheduled_date > new Date().toISOString().slice(0, 10),
)

async function addQuestion() {
  if (!newQuestion.value.trim() || newOptions.value.some((o) => !o.trim())) return
  savingQuestion.value = true
  await supabase.from('quiz_questions').insert({
    module_id: moduleId.value,
    question: newQuestion.value.trim(),
    options: newOptions.value.map((o) => o.trim()),
    correct_index: newCorrect.value,
  })
  newQuestion.value = ''
  newOptions.value = ['', '', '', '']
  newCorrect.value = 0
  savingQuestion.value = false
  await load()
}

async function removeQuestion(id: number) {
  await supabase.from('quiz_questions').delete().eq('id', id)
  await load()
}

function startEdit(q: QuizQuestion) {
  editingId.value = q.id
  editQuestion.value = q.question
  editOptions.value = [...q.options]
  editCorrect.value = q.correct_index
}

function cancelEdit() {
  editingId.value = null
}

async function saveEdit() {
  if (!editingId.value || !editQuestion.value.trim() || editOptions.value.some((o) => !o.trim())) return
  savingEdit.value = true
  await supabase
    .from('quiz_questions')
    .update({
      question: editQuestion.value.trim(),
      options: editOptions.value.map((o) => o.trim()),
      correct_index: editCorrect.value,
    })
    .eq('id', editingId.value)
  savingEdit.value = false
  editingId.value = null
  await load()
}

function previewBulk() {
  bulkPreview.value = parseBulkQuestions(bulkText.value)
}

async function saveBulk() {
  if (!bulkPreview.value.length) return
  savingBulk.value = true
  await supabase.from('quiz_questions').insert(
    bulkPreview.value.map((q) => ({
      module_id: moduleId.value,
      question: q.question,
      options: q.options,
      correct_index: q.correct_index,
    })),
  )
  await logActivity(auth.profile?.id, `Added ${bulkPreview.value.length} questions to "${module_.value?.title}"`)
  bulkText.value = ''
  bulkPreview.value = []
  savingBulk.value = false
  await load()
}

interface DraftQuestion extends GeneratedQuestion {
  keep: boolean
  editing: boolean
}
const generating = ref(false)
const genError = ref('')
const needTranscript = ref(false)
const transcript = ref('')
const drafts = ref<DraftQuestion[]>([])
const genMode = ref<'add' | 'replace'>('add')
const addingDrafts = ref(false)
const showGeneratePrompt = ref(route.query.generate === '1')
const aiCard = ref<HTMLElement | null>(null)

const hasMaterial = computed(() => hasYoutube.value || hasUploadedVideo.value || hasDocument.value)
const keptCount = computed(() => drafts.value.filter((d) => d.keep).length)
const answerSpread = computed(() => {
  const spread = [0, 0, 0, 0]
  for (const d of drafts.value) spread[d.correct_index] = (spread[d.correct_index] ?? 0) + 1
  return spread
})

function scrollToGenerator() {
  aiCard.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function runGenerate() {
  generating.value = true
  genError.value = ''
  showGeneratePrompt.value = false
  const result = await generateQuestions(moduleId.value, transcript.value)
  generating.value = false
  if (result.questions) {
    needTranscript.value = false
    drafts.value = result.questions.map((q) => ({ ...q, keep: true, editing: false }))
    return
  }
  genError.value = result.error ?? 'Could not generate questions.'
  needTranscript.value = result.code === 'need_transcript'
}

async function addDrafts() {
  const chosen = drafts.value.filter((d) => d.keep)
  if (!chosen.length) return
  if (chosen.some((d) => !d.question.trim() || d.options.some((o) => !o.trim()))) {
    genError.value = 'Fill in every question and option (or untick the ones you don’t want).'
    return
  }
  const id = moduleId.value
  addingDrafts.value = true
  if (genMode.value === 'replace') await supabase.from('quiz_questions').delete().eq('module_id', id)
  await supabase.from('quiz_questions').insert(
    chosen.map((d) => ({
      module_id: id,
      question: d.question.trim(),
      options: d.options.map((o) => o.trim()),
      correct_index: d.correct_index,
    })),
  )
  await logActivity(auth.profile?.id, `Generated ${chosen.length} questions with AI for "${module_.value?.title}"`)
  drafts.value = []
  genError.value = ''
  addingDrafts.value = false
  await load()
}

async function togglePublish() {
  if (!module_.value) return
  if (module_.value.is_draft && !canPublish.value) return
  publishBusy.value = true
  const nowPublishing = module_.value.is_draft
  await supabase
    .from('modules')
    .update({ is_draft: !module_.value.is_draft })
    .eq('id', moduleId.value)
  await logActivity(
    auth.profile?.id,
    `${nowPublishing ? 'Published' : 'Unpublished'} "${module_.value.title}"`,
  )
  publishBusy.value = false
  await load()
}

const deleting = ref(false)
async function deleteModule() {
  if (!module_.value) return
  const id = moduleId.value
  const ok = window.confirm(
    `Delete "${module_.value.title}" permanently?

This also removes its questions, its uploaded file, and every employee's completion record for it. This cannot be undone. (To just hide it from employees, use Unpublish instead.)`,
  )
  if (!ok) return
  deleting.value = true
  const title = module_.value.title
  const { error } = await supabase.from('modules').delete().eq('id', id)
  if (error) {
    deleting.value = false
    window.alert(`Could not delete: ${error.message}`)
    return
  }
  await Promise.all([
    deleteMaterialFile(module_.value.document_url),
    clearModuleUploadedVideo(id, module_.value.video_url),
  ])
  await logActivity(auth.profile?.id, `Deleted module "${title}"`)
  router.push('/admin/modules')
}

async function saveSchedule() {
  savingSchedule.value = true
  await supabase
    .from('modules')
    .update({ scheduled_date: scheduledDate.value || null })
    .eq('id', moduleId.value)
  await logActivity(
    auth.profile?.id,
    scheduledDate.value
      ? `Scheduled "${module_.value?.title}" to appear on ${scheduledDate.value}`
      : `Cleared the publish schedule for "${module_.value?.title}"`,
  )
  savingSchedule.value = false
  await load()
}
</script>

<template>
  <div v-if="loading" style="color: var(--ink-soft)">Loading…</div>
  <div v-else-if="module_">
    <div class="topline">
      <div>
        <h2 style="font-size: 20px">{{ module_.title }}</h2>
        <p>{{ module_.department }} · {{ quizExempt ? 'no quiz required' : `${questions.length} of ${MIN_QUESTIONS_TO_PUBLISH} questions` }}</p>
      </div>
      <div style="display: flex; gap: 8px">
        <button class="btn btn-ghost btn-sm" @click="router.push('/admin/modules')">Back to modules</button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="publishBusy || (module_.is_draft && !canPublish)"
          :title="module_.is_draft && !canPublish ? `Needs at least ${MIN_QUESTIONS_TO_PUBLISH} questions` : quizExempt ? 'No quiz required for this module' : ''"
          @click="togglePublish"
        >
          {{ module_.is_draft ? 'Publish' : 'Unpublish' }}
        </button>
        <button class="btn btn-ghost btn-sm" style="color: var(--danger)" :disabled="deleting" @click="deleteModule">
          {{ deleting ? 'Deleting…' : 'Delete' }}
        </button>
      </div>
    </div>

    <span :class="['pill', module_.is_draft ? 'pill-danger' : isScheduledFuture ? 'pill-outline' : 'pill-teal']" style="margin-bottom: 16px; display: inline-block">
      {{
        module_.is_draft
          ? quizExempt
            ? 'Draft · no quiz required'
            : `Draft · ${questions.length} of ${MIN_QUESTIONS_TO_PUBLISH}`
          : isScheduledFuture
            ? `Scheduled for ${module_.scheduled_date}`
            : 'Published'
      }}
    </span>

    <div class="card" style="padding: 16px; margin-bottom: 20px" :style="{ maxWidth: hasDocument && activePreviewTab === 'document' ? '100%' : '680px' }">
      <!-- Media switcher tabs whenever 2+ media types are attached -->
      <div v-if="mediaTabCount > 1" class="row wrap" style="gap: 8px; margin-bottom: 12px; align-items: center">
        <button
          v-if="hasYoutube"
          class="chip-btn"
          :class="{ on: activePreviewTab === 'youtube' }"
          @click="activePreviewTab = 'youtube'"
        >
          ▶ YouTube Video
        </button>
        <button
          v-if="hasUploadedVideo"
          class="chip-btn"
          :class="{ on: activePreviewTab === 'uploaded_video' }"
          @click="activePreviewTab = 'uploaded_video'"
        >
          🎬 Uploaded Video ({{ module_.video_type?.toUpperCase() ?? 'VIDEO' }})
        </button>
        <button
          v-if="hasDocument"
          class="chip-btn"
          :class="{ on: activePreviewTab === 'document' }"
          @click="activePreviewTab = 'document'"
        >
          📄 Document Preview ({{ module_.document_type?.toUpperCase() }})
        </button>
        <a
          v-if="activePreviewTab === 'document' && module_.document_url"
          :href="module_.document_url"
          target="_blank"
          class="btn btn-ghost btn-sm"
          style="margin-left: auto; font-size: 11px"
        >
          Open Document in New Tab ↗
        </a>
        <a
          v-else-if="activePreviewTab === 'uploaded_video' && module_.video_url"
          :href="module_.video_url"
          target="_blank"
          class="btn btn-ghost btn-sm"
          style="margin-left: auto; font-size: 11px"
        >
          Open Video in New Tab ↗
        </a>
      </div>

      <div v-if="hasYoutube && (activePreviewTab === 'youtube' || (!hasUploadedVideo && !hasDocument))" class="video-box">
        <iframe
          :src="`https://www.youtube-nocookie.com/embed/${module_.youtube_id}?rel=0&modestbranding=1&iv_load_policy=3`"
          style="width: 100%; height: 100%; border: 0"
          allowfullscreen
        />
      </div>
      <div v-else-if="hasUploadedVideo && (activePreviewTab === 'uploaded_video' || (!hasYoutube && !hasDocument))" class="video-box">
        <video
          :src="module_.video_url!"
          controls
          playsinline
          preload="metadata"
          style="width: 100%; height: 100%; display: block; background: #000"
        />
      </div>
      <!-- Documents get a viewport-scaled box instead of a fixed 16:9 one -->
      <div v-else-if="hasDocument && (activePreviewTab === 'document' || (!hasYoutube && !hasUploadedVideo))" class="document-box">
        <iframe
          :src="documentEmbedUrl(module_.document_url!, module_.document_type!)"
          style="width: 100%; height: 100%; border: 0"
        />
      </div>
      <div v-else class="video-box video-placeholder">▶ No learning material attached yet</div>
    </div>

    <div class="media-upload-grid">
      <div class="card" style="padding: 18px">
        <div class="panel-title"><h3>🎬 Uploaded Video</h3></div>
        <p class="hint" style="margin-bottom: 8px">
          Upload a video file (MP4, WebM, MOV, M4V, or OGG — max 50MB). Can be used alone or alongside a YouTube video and document.
        </p>
        <input
          ref="videoInputEl"
          type="file"
          accept=".mp4,.webm,.mov,.m4v,.ogg,video/mp4,video/webm,video/quicktime,video/ogg"
          :disabled="uploadingVideo"
          @change="onVideoSelected"
        />
        <p v-if="uploadingVideo" class="hint" style="margin-top: 6px">Uploading video…</p>
        <p v-if="videoError" class="hint" style="color: var(--danger); margin-top: 6px">{{ videoError }}</p>
        <div v-if="module_.video_url" style="margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
          <span class="pill pill-outline">🎬 {{ module_.video_type?.toUpperCase() ?? 'VIDEO' }} · {{ formatDuration(module_) }}</span>
          <a :href="module_.video_url" target="_blank" class="btn btn-ghost btn-sm" style="font-size: 11px">Open ↗</a>
          <button class="btn btn-ghost btn-sm" style="color: var(--danger)" @click="removeUploadedVideo">Remove</button>
        </div>
      </div>

      <div class="card" style="padding: 18px">
        <div class="panel-title"><h3>📄 Document / Presentation</h3></div>
        <p class="hint" style="margin-bottom: 8px">
          Upload a PDF, PPTX, or DOCX reference document or slide deck. Preserved alongside any YouTube or uploaded video.
        </p>
        <input
          ref="docInputEl"
          type="file"
          accept=".pdf,.pptx,.ppt,.docx,.doc"
          :disabled="uploadingMaterial"
          @change="onMaterialSelected"
        />
        <p v-if="uploadingMaterial" class="hint" style="margin-top: 6px">Uploading document…</p>
        <p v-if="materialError" class="hint" style="color: var(--danger); margin-top: 6px">{{ materialError }}</p>
        <div v-if="module_.document_url" style="margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
          <span class="pill pill-outline">📄 {{ module_.document_type?.toUpperCase() }} attached</span>
          <a :href="module_.document_url" target="_blank" class="btn btn-ghost btn-sm" style="font-size: 11px">Open ↗</a>
          <button class="btn btn-ghost btn-sm" style="color: var(--danger)" @click="removeMaterial">Remove</button>
        </div>
        <p v-if="module_.document_type === 'pptx' || module_.document_type === 'ppt' || module_.document_type === 'docx' || module_.document_type === 'doc'" class="hint" style="margin-top: 6px">
          PPTX/DOCX preview uses Microsoft's free Office Online Viewer, which needs the file reachable at a public URL —
          it won't preview from a local dev server, only once deployed.
        </p>
      </div>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 420px">
      <div class="panel-title"><h3>Module details</h3></div>
      <div class="field">
        <label>Title</label>
        <input v-model="detailTitle" type="text" />
      </div>
      <div class="field">
        <label>YouTube video ID (optional)</label>
        <input v-model="detailYoutubeId" type="text" placeholder="e.g. dQw4w9WgXcQ" />
      </div>
      <div v-if="courseOptions.length" class="field">
        <label>Course</label>
        <select v-model="detailCourse">
          <option value="">No course</option>
          <option v-for="c in courseOptions" :key="c.id" :value="c.id">{{ c.title }}</option>
        </select>
      </div>
      <div class="field">
        <label>Audience</label>
        <select v-model="detailDepartment">
          <option value="General">General</option>
          <option v-for="d in departments" :key="d.id" :value="d.name">{{ d.name }}</option>
        </select>
      </div>
      <div v-if="detailDepartment === 'General'" class="field">
        <label style="display: flex; align-items: center; gap: 6px; font-weight: 400">
          <input v-model="detailQuizRequired" type="checkbox" style="width: auto" />
          Quiz required for this module
        </label>
        <p class="hint" style="margin-top: 4px">
          Department modules always have a quiz (grouped every 5 into a milestone). For General modules only, you can
          turn this off for something purely informational — it publishes without needing any questions.
        </p>
      </div>
      <button class="btn btn-ghost btn-sm" :disabled="savingDetails" @click="saveDetails">
        {{ savingDetails ? 'Saving…' : 'Save details' }}
      </button>
      <p v-if="detailsError" class="hint" style="color: var(--danger); margin-top: 8px">{{ detailsError }}</p>
      <p class="hint" style="margin-top: 10px">
        Created {{ new Date(module_.created_at).toLocaleDateString() }} · {{ questions.length }} question(s) in bank
      </p>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 360px">
      <div class="panel-title"><h3>Publish schedule</h3></div>
      <p class="hint" style="margin-bottom: 8px">
        Leave blank to show immediately once published. Set a future date to keep it hidden from employees until then.
      </p>
      <div class="field">
        <label>Publish on</label>
        <input v-model="scheduledDate" type="date" />
      </div>
      <button class="btn btn-ghost btn-sm" :disabled="savingSchedule" @click="saveSchedule">
        {{ savingSchedule ? 'Saving…' : 'Save schedule' }}
      </button>
    </div>

    <div v-if="showGeneratePrompt && hasMaterial" class="card" style="padding: 14px 18px; margin-bottom: 16px; border-color: var(--brass); background: var(--brass-soft)">
      <strong>Module saved.</strong> Want questions drafted automatically from the uploaded material?
      <button class="btn btn-primary btn-sm" style="margin-left: 8px" @click="scrollToGenerator">✨ Generate questions</button>
      <button class="btn btn-ghost btn-sm" style="margin-left: 4px" @click="showGeneratePrompt = false">Not now</button>
    </div>

    <div ref="aiCard" class="card" style="padding: 18px; margin-bottom: 20px; border: 1.5px solid var(--brass)">
      <div class="panel-title" style="padding: 0 0 6px">
        <h3>✨ Generate questions from this material</h3>
        <span class="pill pill-teal">Google Gemini · free tier</span>
      </div>
      <p class="hint" style="margin-bottom: 10px">
        <template v-if="module_.youtube_id && module_.document_url">The AI generates questions using both the YouTube video content and the uploaded {{ module_.document_type?.toUpperCase() }} text.</template>
        <template v-else-if="module_.youtube_id">The AI watches the YouTube video (its captions) and drafts questions from it.</template>
        <template v-else-if="module_.document_url">The AI reads the uploaded {{ module_.document_type?.toUpperCase() }} and drafts questions from its text.</template>
        <template v-else-if="module_.video_url">For an uploaded video without captions/document, click Generate to paste the video transcript below.</template>
        <template v-else>Attach a video or document above first — the questions are drafted from it.</template>
        Always review them before adding — nothing reaches employees until you publish.
      </p>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
        <span class="pill pill-teal">5 easy</span>
        <span class="pill pill-brass">6 medium</span>
        <span class="pill pill-danger">4 hard</span>
        <span class="hint">15 questions · 4 options each · one correct answer</span>
      </div>

      <div v-if="needTranscript" class="field" style="margin-top: 12px">
        <label>Paste the video transcript (YouTube: ⋯ → Show transcript → copy)</label>
        <textarea v-model="transcript" rows="5" style="width: 100%" placeholder="Paste transcript here…" />
      </div>

      <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center">
        <button class="btn btn-primary btn-sm" :disabled="generating || !hasMaterial || (needTranscript && !transcript.trim())" @click="runGenerate">
          {{ generating ? 'Reading the material…' : drafts.length ? '↻ Regenerate' : '✨ Generate questions' }}
        </button>
        <select v-model="genMode" style="width: auto">
          <option value="add">Add to existing questions</option>
          <option value="replace">Replace existing questions</option>
        </select>
      </div>
      <p v-if="generating" class="hint" style="margin-top: 8px">This can take 10–30 seconds.</p>
      <p v-if="genError" class="hint" style="color: var(--danger); margin-top: 8px">{{ genError }}</p>

      <div v-if="drafts.length" style="margin-top: 16px">
        <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px">
          <span class="pill pill-outline">Correct answers: A {{ answerSpread[0] }} · B {{ answerSpread[1] }} · C {{ answerSpread[2] }} · D {{ answerSpread[3] }}</span>
        </div>
        <div
          v-for="(d, i) in drafts"
          :key="i"
          class="card"
          style="padding: 12px 14px; margin-bottom: 8px"
          :style="{ opacity: d.keep ? 1 : 0.45 }"
        >
          <div style="display: flex; gap: 10px; align-items: flex-start">
            <input v-model="d.keep" type="checkbox" style="width: auto; margin-top: 4px" />
            <div style="flex: 1">
              <input v-if="d.editing" v-model="d.question" type="text" />
              <div v-else style="font-weight: 600">{{ i + 1 }}. {{ d.question }}</div>
            </div>
            <span :class="['pill', d.difficulty === 'easy' ? 'pill-teal' : d.difficulty === 'hard' ? 'pill-danger' : 'pill-brass']">{{ d.difficulty }}</span>
            <button class="btn btn-ghost btn-sm" @click="d.editing = !d.editing">{{ d.editing ? 'Done' : 'Edit' }}</button>
          </div>
          <div style="margin: 8px 0 0 26px; display: grid; gap: 4px">
            <div v-for="(opt, oi) in d.options" :key="oi" style="display: flex; align-items: center; gap: 6px; font-size: 13px">
              <template v-if="d.editing">
                <input type="radio" :checked="d.correct_index === oi" @change="d.correct_index = oi" />
                <input v-model="d.options[oi]" type="text" style="flex: 1" />
              </template>
              <template v-else>
                <span :style="{ fontWeight: oi === d.correct_index ? 700 : 400, color: oi === d.correct_index ? 'var(--teal)' : 'inherit' }">
                  {{ ['A', 'B', 'C', 'D'][oi] }}) {{ opt }}{{ oi === d.correct_index ? ' ✓' : '' }}
                </span>
              </template>
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; margin-top: 10px">
          <button class="btn btn-primary btn-sm" :disabled="addingDrafts || !keptCount" @click="addDrafts">
            {{ addingDrafts ? 'Adding…' : `Add ${keptCount} to question bank` }}
          </button>
          <span class="hint">{{ keptCount }} of {{ drafts.length }} selected</span>
        </div>
      </div>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px">
      <div class="panel-title"><h3>Add a question</h3></div>
      <div class="field">
        <label>Question</label>
        <input v-model="newQuestion" type="text" placeholder="What should you do first when…?" />
      </div>
      <div class="field" v-for="(_, i) in newOptions" :key="i">
        <label>
          <input type="radio" :checked="newCorrect === i" @change="newCorrect = i" style="margin-right: 6px" />
          Option {{ ['A', 'B', 'C', 'D'][i] }} {{ newCorrect === i ? '(correct)' : '' }}
        </label>
        <input v-model="newOptions[i]" type="text" />
      </div>
      <button class="btn btn-primary btn-sm" :disabled="savingQuestion" @click="addQuestion">
        {{ savingQuestion ? 'Adding…' : 'Add question' }}
      </button>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px">
      <div class="panel-title"><h3>Bulk paste questions</h3></div>
      <p class="hint" style="margin-bottom: 8px">
        One block per question, separated by a blank line:<br />
        <code>Q: question text</code><br />
        <code>A) option&nbsp;&nbsp;B) option&nbsp;&nbsp;C) option&nbsp;&nbsp;D) option</code> (one per line)<br />
        <code>Correct: B</code>
      </p>
      <textarea v-model="bulkText" rows="8" style="width: 100%; font-family: 'IBM Plex Mono', monospace; font-size: 12px" />
      <div style="display: flex; gap: 8px; margin-top: 8px">
        <button class="btn btn-ghost btn-sm" @click="previewBulk">Preview</button>
        <button class="btn btn-primary btn-sm" :disabled="!bulkPreview.length || savingBulk" @click="saveBulk">
          {{ savingBulk ? 'Saving…' : `Add ${bulkPreview.length} question(s)` }}
        </button>
      </div>
      <p v-if="bulkText && !bulkPreview.length" class="hint" style="color: var(--danger); margin-top: 6px">
        No valid question blocks found — check the format above.
      </p>
    </div>

    <div class="card">
      <div class="panel-title"><h3>Question bank ({{ questions.length }})</h3></div>
      <div v-for="(q, i) in questions" :key="q.id" class="row-item" style="cursor: default; align-items: flex-start">
        <div class="row-num">{{ i + 1 }}</div>

        <div v-if="editingId === q.id" class="row-info">
          <input v-model="editQuestion" type="text" style="margin-bottom: 8px" />
          <div v-for="(_, oi) in editOptions" :key="oi" style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px">
            <input type="radio" :checked="editCorrect === oi" @change="editCorrect = oi" />
            <input v-model="editOptions[oi]" type="text" style="flex: 1" />
          </div>
          <div style="display: flex; gap: 8px; margin-top: 6px">
            <button class="btn btn-primary btn-sm" :disabled="savingEdit" @click="saveEdit">
              {{ savingEdit ? 'Saving…' : 'Save' }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="cancelEdit">Cancel</button>
          </div>
        </div>

        <template v-else>
          <div class="row-info">
            <div class="t">{{ q.question }}</div>
            <div class="m">
              <span v-for="(opt, oi) in q.options" :key="oi" :style="{ fontWeight: oi === q.correct_index ? 700 : 400 }">
                {{ ['A', 'B', 'C', 'D'][oi] }}) {{ opt }}{{ oi < q.options.length - 1 ? ' · ' : '' }}
              </span>
            </div>
          </div>
          <div style="display: flex; gap: 6px">
            <button class="btn btn-ghost btn-sm" @click="startEdit(q)">Edit</button>
            <button class="btn btn-ghost btn-sm" @click="removeQuestion(q.id)">Delete</button>
          </div>
        </template>
      </div>
      <p v-if="!questions.length" style="padding: 24px; text-align: center; color: var(--ink-soft)">
        No questions yet — add some above.
      </p>
    </div>
  </div>
  <div v-else class="card" style="padding: 24px; max-width: 520px">
    <h3 style="margin-bottom: 6px">Could not open module</h3>
    <p class="hint" style="margin-bottom: 14px">{{ loadError || 'This module could not be loaded.' }}</p>
    <div style="display: flex; gap: 8px">
      <button class="btn btn-primary btn-sm" @click="load">Retry</button>
      <button class="btn btn-ghost btn-sm" @click="router.push('/admin/modules')">Back to modules</button>
    </div>
  </div>
</template>

<style scoped>
.media-upload-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
  max-width: 860px;
}
.video-box {
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(150deg, #1a1d2b, #0d0f18);
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
</style>
