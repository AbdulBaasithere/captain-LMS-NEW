<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { loadAudienceColorMap, loadDepartments } from '@/lib/departments'
import { COURSE_COLORS, COURSE_DIFFICULTIES, resolveCourseDifficulty, sortedLessons } from '@/lib/courses'
import { materialType, formatDuration, hydrateModulesUploadedVideos } from '@/lib/materials'
import { isActive } from '@/lib/employees'
import {
  assignCourseToEmployees,
  unassignCourseFromEmployee,
  updateCourseAssignmentDeadline,
} from '@/lib/courseAssignments'
import type { Course, CourseDifficulty, CourseEnrolment, Module, Profile } from '@/lib/database.types'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const courseId = Number(route.params.id)

const course = ref<Course | null>(null)
const lessons = ref<Module[]>([])
const available = ref<Module[]>([])
const categories = ref<string[]>(['General'])
const audienceColors = ref<Record<string, string>>({})
const loading = ref(true)

const title = ref('')
const category = ref('General')
const difficulty = ref<CourseDifficulty>('Beginner')
const description = ref('')
const published = ref(true)
const saving = ref(false)
const saved = ref(false)
const addId = ref<number | ''>('')

const profiles = ref<Profile[]>([])
const enrolments = ref<CourseEnrolment[]>([])
const assignEmpId = ref('')
const assignDeadline = ref('')
const assigningEmp = ref(false)
const assignFeedback = ref<{ ok: boolean; text: string } | null>(null)
const editingDeadlines = ref<Record<number, string>>({})
const busyEnrolId = ref<number | null>(null)

const assignedColor = computed(
  () => audienceColors.value[category.value] ?? course.value?.color ?? COURSE_COLORS[0]!,
)

const profilesById = computed(() => {
  const m = new Map<string, Profile>()
  for (const p of profiles.value) m.set(p.id, p)
  return m
})

const assignableEmployees = computed(() => {
  const enrolledIds = new Set(enrolments.value.map((e) => e.user_id))
  return profiles.value.filter((p) => isActive(p) && p.role === 'employee' && !enrolledIds.has(p.id))
})

async function load() {
  const [{ data: c }, { data: mods }, depts, { data: profData }, { data: enrolData }] = await Promise.all([
    supabase.from('courses').select('*').eq('id', courseId).single(),
    supabase.from('modules').select('*').order('id'),
    loadDepartments(),
    supabase.from('profiles').select('*').order('full_name'),
    supabase.from('course_enrolments').select('*').eq('course_id', courseId).order('enrolled_at', { ascending: false }),
  ])
  course.value = (c as Course | null) ?? null
  const all = await hydrateModulesUploadedVideos((mods ?? []) as Module[])
  lessons.value = sortedLessons(all.filter((m) => m.course_id === courseId))
  available.value = all.filter((m) => m.course_id !== courseId)
  audienceColors.value = await loadAudienceColorMap(depts)
  categories.value = ['General', ...depts.map((d) => d.name)]
  profiles.value = (profData ?? []) as Profile[]
  enrolments.value = (enrolData ?? []) as CourseEnrolment[]
  editingDeadlines.value = Object.fromEntries(enrolments.value.map((e) => [e.id, e.deadline_date ?? '']))
  if (course.value) {
    title.value = course.value.title
    category.value = course.value.category
    difficulty.value = resolveCourseDifficulty(course.value.difficulty, course.value.title, course.value.description, lessons.value)
    description.value = course.value.description ?? ''
    published.value = course.value.is_published
  }
  loading.value = false
}

onMounted(load)

async function saveDetails() {
  if (!title.value.trim()) return
  saving.value = true
  saved.value = false
  const nextColor = assignedColor.value
  const { error } = await supabase
    .from('courses')
    .update({
      title: title.value.trim(),
      category: category.value,
      difficulty: difficulty.value,
      description: description.value.trim() || null,
      color: nextColor,
      is_published: published.value,
    })
    .eq('id', courseId)
  if (error && error.message.toLowerCase().includes('difficulty')) {
    await supabase
      .from('courses')
      .update({
        title: title.value.trim(),
        category: category.value,
        description: description.value.trim() || null,
        color: nextColor,
        is_published: published.value,
      })
      .eq('id', courseId)
  }
  await logActivity(auth.profile?.id, `Updated course "${title.value.trim()}"`)
  saving.value = false
  saved.value = true
  await load()
}

async function addLesson() {
  if (!addId.value) return
  const nextOrder = (lessons.value[lessons.value.length - 1]?.lesson_order ?? 0) + 1
  await supabase.from('modules').update({ course_id: courseId, lesson_order: nextOrder }).eq('id', addId.value)
  addId.value = ''
  await load()
}

async function removeLesson(m: Module) {
  await supabase.from('modules').update({ course_id: null }).eq('id', m.id)
  await load()
}

// Renumber 1..n after a swap so ordering stays unambiguous even if some lessons shared a value.
async function move(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= lessons.value.length) return
  const order = [...lessons.value]
  const [item] = order.splice(index, 1)
  order.splice(target, 0, item!)
  await Promise.all(order.map((m, i) => supabase.from('modules').update({ lesson_order: i + 1 }).eq('id', m.id)))
  await load()
}

const assignable = computed(() => available.value)

async function deleteCourse() {
  if (!course.value) return
  if (!window.confirm(`Delete the course "${course.value.title}"?\n\nIts lessons are kept (they just stop belonging to a course).`)) return
  await supabase.from('courses').delete().eq('id', courseId)
  await logActivity(auth.profile?.id, `Deleted course "${course.value.title}"`)
  router.push('/admin/courses')
}

async function assignEmployee() {
  if (!course.value || !assignEmpId.value) return
  assigningEmp.value = true
  assignFeedback.value = null
  const res = await assignCourseToEmployees({
    courseId: course.value.id,
    courseTitle: course.value.title,
    userIds: [assignEmpId.value],
    deadlineDate: assignDeadline.value || null,
    assignedBy: auth.profile?.id,
    profilesById: profilesById.value,
  })
  assigningEmp.value = false
  if (!res.ok) {
    assignFeedback.value = { ok: false, text: res.error ?? 'Could not assign employee.' }
    return
  }
  const empName = profilesById.value.get(assignEmpId.value)?.full_name ?? 'employee'
  await logActivity(auth.profile?.id, `Assigned course "${course.value.title}" to ${empName}`)
  assignFeedback.value = { ok: true, text: `Assigned "${course.value.title}" to ${empName}.` }
  assignEmpId.value = ''
  await load()
}

async function saveEnrolmentDeadline(e: CourseEnrolment) {
  busyEnrolId.value = e.id
  const nextDate = editingDeadlines.value[e.id] ?? ''
  const res = await updateCourseAssignmentDeadline({
    enrolmentId: e.id,
    deadlineDate: nextDate || null,
    isCompleted: e.status === 'completed' || Boolean(e.completed_at),
    hasStarted: e.status === 'in_progress' || e.progress_pct > 0 || Boolean(e.started_at),
  })
  busyEnrolId.value = null
  if (!res.ok) {
    assignFeedback.value = { ok: false, text: res.error ?? 'Could not update deadline.' }
    return
  }
  assignFeedback.value = { ok: true, text: 'Updated deadline.' }
  await load()
}

async function removeEnrolment(e: CourseEnrolment) {
  const empName = profilesById.value.get(e.user_id)?.full_name ?? 'employee'
  if (!window.confirm(`Unassign ${empName} from "${course.value?.title}"?`)) return
  busyEnrolId.value = e.id
  const res = await unassignCourseFromEmployee(e.id)
  busyEnrolId.value = null
  if (!res.ok) {
    assignFeedback.value = { ok: false, text: res.error ?? 'Could not unassign employee.' }
    return
  }
  await logActivity(auth.profile?.id, `Unassigned ${empName} from course "${course.value?.title}"`)
  assignFeedback.value = { ok: true, text: `Unassigned ${empName}.` }
  await load()
}
</script>

<template>
  <div v-if="loading" style="color: var(--ink-soft)">Loading…</div>
  <div v-else-if="course">
    <div class="topline">
      <div>
        <h2>{{ course.title }}</h2>
        <p>{{ course.category }} · {{ lessons.length }} lesson{{ lessons.length === 1 ? '' : 's' }}</p>
      </div>
      <div class="row">
        <button class="btn btn-ghost btn-sm" @click="router.push('/admin/courses')">Back to courses</button>
        <button class="btn btn-ghost btn-sm" style="color: var(--danger)" @click="deleteCourse">Delete</button>
      </div>
    </div>

    <div class="cols">
      <div class="card" style="padding: 18px">
        <div class="panel-title" style="padding: 0 0 8px"><h3>Details</h3></div>
        <div class="field"><label>Title</label><input v-model="title" type="text" /></div>
        <div class="field">
          <label>Audience / Category</label>
          <select v-model="category">
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
          <div class="audience-color-info">
            <span class="aud-dot" :style="{ background: assignedColor }" aria-hidden="true" />
            <span>
              Colour automatically assigned from <b>{{ category }}</b> audience
            </span>
            <RouterLink to="/admin/audiences" class="aud-settings-link">
              Change in Audiences &rarr;
            </RouterLink>
          </div>
        </div>
        <div class="field">
          <label>Difficulty level</label>
          <select v-model="difficulty">
            <option v-for="d in COURSE_DIFFICULTIES" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>
        <div class="field"><label>Description (optional)</label><textarea v-model="description" rows="3" /></div>
        <label class="row" style="gap: 8px; font-weight: 400"><input v-model="published" type="checkbox" style="width: auto" /> Published (visible in the catalog)</label>
        <div class="row" style="margin-top: 12px">
          <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveDetails">{{ saving ? 'Saving…' : 'Save details' }}</button>
          <span v-if="saved" class="hint" style="color: var(--teal)">Saved.</span>
        </div>
      </div>

      <div class="card" style="padding: 18px">
        <div class="panel-title" style="padding: 0 0 8px"><h3>Lessons</h3></div>
        <p class="hint" style="margin: 0 0 10px">Learners see these in this order. Use the arrows to reorder.</p>
        <div v-for="(m, i) in lessons" :key="m.id" class="lesson-row">
          <span class="num">{{ i + 1 }}</span>
          <div class="grow">
            <RouterLink :to="`/admin/modules/${m.id}`" style="font-weight: 700; text-decoration: none">{{ m.title }}</RouterLink>
            <div class="sub">{{ materialType(m) }} · {{ formatDuration(m) }}{{ m.is_draft ? ' · Draft' : '' }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" :disabled="i === 0" @click="move(i, -1)">↑</button>
          <button class="btn btn-ghost btn-sm" :disabled="i === lessons.length - 1" @click="move(i, 1)">↓</button>
          <button class="btn btn-ghost btn-sm" @click="removeLesson(m)">Remove</button>
        </div>
        <p v-if="!lessons.length" class="hint">No lessons yet — add one below.</p>
        <div class="row" style="margin-top: 14px">
          <select v-model="addId" style="flex: 1">
            <option value="">Add a lesson (module)…</option>
            <option v-for="m in assignable" :key="m.id" :value="m.id">{{ m.title }} · {{ m.department }}{{ m.course_id ? ' (in another course)' : '' }}</option>
          </select>
          <button class="btn btn-primary btn-sm" :disabled="!addId" @click="addLesson">Add</button>
        </div>
      </div>
    </div>

    <!-- Assigned Employees Section -->
    <div class="card" style="margin-top: 20px; overflow: hidden">
      <div class="panel-title">
        <div>
          <h3>Assigned Employees</h3>
          <p class="sub" style="margin: 2px 0 0">
            Assign this course to specific employees (including across departments) with optional deadlines.
          </p>
        </div>
        <span class="sub tabular" style="font-weight: 700">{{ enrolments.length }} enrolled</span>
      </div>

      <div style="padding: 12px 18px 16px; border-bottom: 1px solid var(--border)">
        <div class="row wrap" style="gap: 10px; align-items: flex-end">
          <div class="field" style="flex: 2; min-width: 220px; margin: 0">
            <label>Assign to employee</label>
            <select v-model="assignEmpId">
              <option value="">Select employee…</option>
              <option v-for="emp in assignableEmployees" :key="emp.id" :value="emp.id">
                {{ emp.full_name }} · {{ emp.department }}
              </option>
            </select>
          </div>
          <div class="field" style="width: 170px; margin: 0">
            <label>Deadline (optional)</label>
            <input v-model="assignDeadline" type="date" />
          </div>
          <button class="btn btn-primary btn-sm" :disabled="assigningEmp || !assignEmpId" @click="assignEmployee">
            {{ assigningEmp ? 'Assigning…' : '+ Assign employee' }}
          </button>
        </div>
        <p
          v-if="assignFeedback"
          class="hint"
          style="margin-top: 8px; margin-bottom: 0"
          :style="{ color: assignFeedback.ok ? 'var(--teal)' : 'var(--danger)' }"
        >
          {{ assignFeedback.text }}
        </p>
      </div>

      <div v-if="!enrolments.length" class="sub" style="padding: 18px">
        No employees explicitly assigned yet.
      </div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Deadline</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in enrolments" :key="e.id">
              <td>
                <RouterLink
                  :to="`/admin/employees/${e.user_id}`"
                  style="font-weight: 600; text-decoration: none; color: var(--ink)"
                >
                  {{ profilesById.get(e.user_id)?.full_name ?? 'Employee' }}
                </RouterLink>
              </td>
              <td>{{ profilesById.get(e.user_id)?.department ?? '—' }}</td>
              <td>
                <span
                  :class="[
                    'pill',
                    e.status === 'completed'
                      ? 'pill-teal'
                      : e.status === 'overdue'
                        ? 'pill-danger'
                        : e.status === 'in_progress'
                          ? 'pill-brass'
                          : 'pill-muted',
                  ]"
                >
                  {{ e.status.replace('_', ' ') }}
                </span>
              </td>
              <td style="font-variant-numeric: tabular-nums">{{ e.progress_pct }}%</td>
              <td>
                <div class="row" style="gap: 6px">
                  <input v-model="editingDeadlines[e.id]" type="date" style="width: 145px" />
                  <button
                    class="btn btn-ghost btn-sm"
                    :disabled="busyEnrolId === e.id"
                    @click="saveEnrolmentDeadline(e)"
                  >
                    Save
                  </button>
                </div>
              </td>
              <td>
                <button
                  class="btn btn-ghost btn-sm"
                  style="color: var(--danger)"
                  :disabled="busyEnrolId === e.id"
                  @click="removeEnrolment(e)"
                >
                  Unassign
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
  <div v-else class="hint">Course not found.</div>
</template>

<style scoped>
.cols {
  display: grid;
  grid-template-columns: 1fr 1.3fr;
  gap: 18px;
  align-items: start;
}
@media (max-width: 980px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
.audience-color-info {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.aud-dot {
  width: 12px;
  height: 12px;
  border-radius: 4px;
  flex: none;
  border: 1px solid rgba(15, 26, 46, 0.16);
}
.aud-settings-link {
  margin-left: auto;
  color: var(--blue);
  font-weight: 600;
  text-decoration: none;
}
.aud-settings-link:hover {
  text-decoration: underline;
}
.lesson-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.num {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 12.5px;
  background: var(--surface-sunken);
  flex: none;
}
</style>
