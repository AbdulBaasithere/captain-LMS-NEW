<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { loadDepartments } from '@/lib/departments'
import { parseYoutubeId } from '@/lib/youtube'
import { useSort } from '@/composables/useSort'
import {
  uploadModuleMaterial,
  uploadModuleVideo,
  saveModuleUploadedVideo,
  clearModuleUploadedVideo,
  hydrateModulesUploadedVideos,
  probeVideoDurationSeconds,
  inferDocumentType,
  inferVideoType,
  hasAnyVideo,
  formatDuration,
  deleteMaterialFile,
  MAX_MATERIAL_SIZE_BYTES,
} from '@/lib/materials'
import { logActivity } from '@/lib/activity'
import { MIN_QUESTIONS_TO_PUBLISH } from '@/lib/quiz'
import type { Module, Department, Course } from '@/lib/database.types'

const auth = useAuthStore()
const router = useRouter()
const modules = ref<Module[]>([])
const questionCounts = ref<Record<number, number>>({})
const title = ref('')
const department = ref('')
const youtubeId = ref('')
const videoFile = ref<File | null>(null)
const documentFile = ref<File | null>(null)
const videoInputEl = ref<HTMLInputElement | null>(null)
const docInputEl = ref<HTMLInputElement | null>(null)
const quizRequired = ref(true)
const courseId = ref<number | ''>('')
const courseOptions = ref<Pick<Course, 'id' | 'title'>[]>([])
const saving = ref(false)
const createError = ref('')

const departments = ref<Department[]>([])

const todayIso = new Date().toISOString().slice(0, 10)
const statusRank = (m: Module) => (m.is_draft ? 2 : m.scheduled_date && m.scheduled_date > todayIso ? 1 : 0)
const { sorted: sortedModules, toggle, indicator, ariaSort } = useSort(modules, {
  title: (m) => m.title,
  type: (m) => materialTypeLabel(m),
  duration: (m) => (hasAnyVideo(m) ? m.duration_seconds : null),
  audience: (m) => m.department,
  status: (m) => statusRank(m),
})

async function loadModules() {
  const [{ data: modData }, { data: qData }] = await Promise.all([
    supabase.from('modules').select('*').order('id', { ascending: false }),
    supabase.from('quiz_questions').select('module_id'),
  ])
  modules.value = await hydrateModulesUploadedVideos((modData ?? []) as Module[])
  const counts: Record<number, number> = {}
  for (const q of qData ?? []) counts[q.module_id] = (counts[q.module_id] ?? 0) + 1
  questionCounts.value = counts
}

onMounted(async () => {
  const [, depts] = await Promise.all([loadModules(), loadDepartments()])
  departments.value = depts
  const { data: cs } = await supabase.from('courses').select('id, title').order('title')
  courseOptions.value = (cs ?? []) as Pick<Course, 'id' | 'title'>[]
  if (!department.value) department.value = 'General'
})

const today = new Date().toISOString().slice(0, 10)
function isScheduledFuture(m: Module) {
  return !!m.scheduled_date && m.scheduled_date > today
}

function materialTypeLabel(m: Module) {
  const parts: string[] = []
  if (m.youtube_id) parts.push('▶ YouTube')
  if (m.video_url) parts.push(`🎬 Video (${m.video_type?.toUpperCase() ?? 'MP4'})`)
  if (m.document_url && m.document_type) parts.push(`📄 ${m.document_type.toUpperCase()}`)
  return parts.length ? parts.join(' + ') : '—'
}

function onVideoSelected(e: Event) {
  videoFile.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

function clearVideoFile() {
  videoFile.value = null
  if (videoInputEl.value) videoInputEl.value.value = ''
}

function onDocumentSelected(e: Event) {
  documentFile.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

function clearDocumentFile() {
  documentFile.value = null
  if (docInputEl.value) docInputEl.value.value = ''
}

async function createDraft() {
  if (!title.value.trim()) return
  const rawYoutube = youtubeId.value.trim()
  const parsedYoutubeId = rawYoutube ? parseYoutubeId(rawYoutube) : null
  if (rawYoutube && !parsedYoutubeId) {
    createError.value = "That doesn't look like a YouTube link or ID — paste the video link or its 11-character ID."
    return
  }
  if (videoFile.value) {
    if (!inferVideoType(videoFile.value.name)) {
      createError.value = 'Only MP4, WebM, MOV, M4V, or OGG video files are supported.'
      return
    }
    if (videoFile.value.size > MAX_MATERIAL_SIZE_BYTES) {
      createError.value = 'Video file is too large (50MB max).'
      return
    }
  }
  if (documentFile.value) {
    if (!inferDocumentType(documentFile.value.name)) {
      createError.value = 'Only PDF, PPTX, or DOCX files are supported.'
      return
    }
    if (documentFile.value.size > MAX_MATERIAL_SIZE_BYTES) {
      createError.value = 'Document file is too large (50MB max).'
      return
    }
  }

  createError.value = ''
  saving.value = true

  const probedDuration = videoFile.value ? await probeVideoDurationSeconds(videoFile.value) : null

  const { data: inserted, error: insertError } = await supabase
    .from('modules')
    .insert({
      title: title.value.trim(),
      department: department.value,
      youtube_id: parsedYoutubeId,
      ...(probedDuration ? { duration_seconds: probedDuration } : {}),
      quiz_required: department.value === 'General' ? quizRequired.value : true,
      is_draft: true,
      ...(courseId.value ? { course_id: courseId.value } : {}),
      created_by: auth.profile?.id,
    })
    .select()
    .single()

  if (insertError || !inserted) {
    createError.value = insertError?.message ?? 'Could not create the module.'
    saving.value = false
    return
  }

  const errors: string[] = []
  const selectedVideo = videoFile.value
  const selectedDoc = documentFile.value

  if (selectedVideo) {
    const { url, type, error } = await uploadModuleVideo(inserted.id, selectedVideo)
    if (error || !url || !type) {
      errors.push(error ?? 'Video upload failed — try uploading it from the module page.')
    } else {
      const { error: saveErr } = await saveModuleUploadedVideo(inserted.id, url, type, probedDuration, true)
      if (saveErr) {
        await deleteMaterialFile(url)
        errors.push(saveErr)
      }
    }
  }

  if (selectedDoc) {
    const { url, type, error } = await uploadModuleMaterial(inserted.id, selectedDoc)
    if (error || !url || !type) {
      errors.push(error ?? 'Document upload failed — try uploading it from the module page.')
    } else {
      const { error: updateErr } = await supabase
        .from('modules')
        .update({ document_url: url, document_type: type })
        .eq('id', inserted.id)
      if (updateErr) {
        await deleteMaterialFile(url)
        errors.push(updateErr.message)
      }
    }
  }

  if (errors.length) {
    createError.value = errors.join(' ')
  }

  const hasMaterial = !!parsedYoutubeId || !!selectedDoc || !!selectedVideo
  const needsQuiz = department.value !== 'General' || quizRequired.value
  title.value = ''
  youtubeId.value = ''
  clearVideoFile()
  clearDocumentFile()
  quizRequired.value = true
  courseId.value = ''
  saving.value = false
  if (hasMaterial && needsQuiz && !createError.value) {
    await router.push(`/admin/modules/${inserted.id}?generate=1`)
    return
  }
  await loadModules()
}

async function togglePublish(m: Module) {
  if (m.is_draft) {
    const exempt = m.department === 'General' && !m.quiz_required
    if (!exempt && (questionCounts.value[m.id] ?? 0) < MIN_QUESTIONS_TO_PUBLISH) {
      window.alert(`Needs at least ${MIN_QUESTIONS_TO_PUBLISH} questions before it can be published.`)
      return
    }
  }
  await supabase.from('modules').update({ is_draft: !m.is_draft }).eq('id', m.id)
  await logActivity(auth.profile?.id, `${m.is_draft ? 'Published' : 'Unpublished'} "${m.title}"`)
  await loadModules()
}

async function deleteModule(m: Module) {
  const ok = window.confirm(
    `Delete "${m.title}" permanently?

This also removes its questions, any uploaded video or document files, and every employee's completion record for it. This cannot be undone. (To just hide it from employees, use Unpublish instead.)`,
  )
  if (!ok) return
  const { error } = await supabase.from('modules').delete().eq('id', m.id)
  if (error) {
    window.alert(`Could not delete: ${error.message}`)
    return
  }
  await Promise.all([deleteMaterialFile(m.document_url), clearModuleUploadedVideo(m.id, m.video_url)])
  await logActivity(auth.profile?.id, `Deleted module "${m.title}"`)
  await loadModules()
}
</script>

<template>
  <div>
    <div class="topline">
      <div><h2>Modules</h2></div>
    </div>

    <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 780px">
      <div class="field">
        <label>Module title</label>
        <input v-model="title" type="text" placeholder="e.g. Handling Refund Requests" />
      </div>

      <label style="display: block; font-size: 13px; font-weight: 700; margin-bottom: 2px">Learning material</label>
      <p class="hint" style="margin-bottom: 10px">
        Attach a YouTube video, upload a video file (MP4, WebM, MOV), upload a document/presentation (PDF, PPTX, DOCX), or combine all three.
      </p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-bottom: 14px">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px">
            ▶ YouTube video (optional)
          </label>
          <input
            v-model="youtubeId"
            type="text"
            placeholder="YouTube link or ID (e.g. dQw4w9WgXcQ)"
          />
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px">
            🎬 Upload video file (optional)
          </label>
          <input
            ref="videoInputEl"
            type="file"
            accept=".mp4,.webm,.mov,.m4v,.ogg,video/mp4,video/webm,video/quicktime,video/ogg"
            @change="onVideoSelected"
          />
          <div v-if="videoFile" class="hint" style="margin-top: 4px; display: flex; align-items: center; gap: 6px">
            <span>{{ videoFile.name }} ({{ (videoFile.size / (1024 * 1024)).toFixed(1) }} MB)</span>
            <button type="button" class="btn btn-ghost btn-sm" style="padding: 1px 6px; font-size: 11px" @click="clearVideoFile">✕</button>
          </div>
        </div>
        <div>
          <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px">
            📄 Document / presentation (optional)
          </label>
          <input
            ref="docInputEl"
            type="file"
            accept=".pdf,.pptx,.ppt,.docx,.doc"
            @change="onDocumentSelected"
          />
          <div v-if="documentFile" class="hint" style="margin-top: 4px; display: flex; align-items: center; gap: 6px">
            <span>{{ documentFile.name }}</span>
            <button type="button" class="btn btn-ghost btn-sm" style="padding: 1px 6px; font-size: 11px" @click="clearDocumentFile">✕</button>
          </div>
        </div>
      </div>

      <div class="field">
        <label>
          Audience
          <RouterLink to="/admin/audiences" style="float: right; font-weight: 400; font-size: 12px">Manage audiences →</RouterLink>
        </label>
        <select v-model="department">
          <option value="General">General</option>
          <option v-for="d in departments" :key="d.id" :value="d.name">{{ d.name }}</option>
        </select>
      </div>
      <div v-if="courseOptions.length" class="field">
        <label>Course (optional)</label>
        <select v-model="courseId">
          <option value="">No course yet</option>
          <option v-for="c in courseOptions" :key="c.id" :value="c.id">{{ c.title }}</option>
        </select>
      </div>
      <div v-if="department === 'General'" class="field">
        <label style="display: flex; align-items: center; gap: 6px; font-weight: 400">
          <input v-model="quizRequired" type="checkbox" style="width: auto" />
          Quiz required for this module
        </label>
      </div>
      <button class="btn btn-primary" :disabled="saving" @click="createDraft">
        {{ saving ? 'Saving…' : 'Save as draft' }}
      </button>
      <p v-if="createError" class="hint" style="color: var(--danger); margin-top: 8px">{{ createError }}</p>
      <p class="hint">Open a module below to add its question bank — {{ MIN_QUESTIONS_TO_PUBLISH }} questions are required before it can be published.</p>
    </div>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th class="sortable" :aria-sort="ariaSort('title')" @click="toggle('title')">
              Title <span class="sort-ind">{{ indicator('title') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('type')" @click="toggle('type')">
              Type <span class="sort-ind">{{ indicator('type') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('duration')" @click="toggle('duration')">
              Duration <span class="sort-ind">{{ indicator('duration') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('audience')" @click="toggle('audience')">
              Audience <span class="sort-ind">{{ indicator('audience') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('status')" @click="toggle('status')">
              Status <span class="sort-ind">{{ indicator('status') }}</span>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in sortedModules" :key="m.id">
            <td style="font-weight: 600">
              <RouterLink :to="`/admin/modules/${m.id}`" style="text-decoration: none">{{ m.title }}</RouterLink>
            </td>
            <td style="color: var(--ink-soft)">{{ materialTypeLabel(m) }}</td>
            <td style="color: var(--ink-soft)">{{ formatDuration(m) }}</td>
            <td><span class="pill pill-outline">{{ m.department }}</span></td>
            <td>
              <span :class="['pill', m.is_draft ? 'pill-danger' : isScheduledFuture(m) ? 'pill-outline' : 'pill-teal']">
                {{
                  m.is_draft
                    ? m.department === 'General' && !m.quiz_required
                      ? 'Draft · no quiz required'
                      : `Draft · ${questionCounts[m.id] ?? 0} of ${MIN_QUESTIONS_TO_PUBLISH}`
                    : isScheduledFuture(m)
                      ? `Scheduled for ${m.scheduled_date}`
                      : 'Published'
                }}
              </span>
            </td>
            <td style="white-space: nowrap">
              <RouterLink class="btn btn-ghost btn-sm" :to="`/admin/modules/${m.id}`">Open</RouterLink>
              <button class="btn btn-ghost btn-sm" style="margin-left: 4px" @click="togglePublish(m)">
                {{ m.is_draft ? 'Publish' : 'Unpublish' }}
              </button>
              <button class="btn btn-ghost btn-sm" style="margin-left: 4px; color: var(--danger)" @click="deleteModule(m)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
