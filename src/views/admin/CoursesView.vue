<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { loadAudienceColorMap, loadDepartments } from '@/lib/departments'
import { COURSE_COLORS, COURSE_DIFFICULTIES, courseCode, resolveCourseDifficulty } from '@/lib/courses'
import { assignCourseToEmployees } from '@/lib/courseAssignments'
import { isActive, initialsOf } from '@/lib/employees'
import { useSort } from '@/composables/useSort'
import type { Course, CourseDifficulty, CourseEnrolment, Module, Profile } from '@/lib/database.types'

const auth = useAuthStore()
const router = useRouter()
const courses = ref<Course[]>([])
const lessonCounts = ref<Record<number, number>>({})
const enrolmentCounts = ref<Record<number, number>>({})
const existingAssigneeIdsByCourse = ref<Record<number, string[]>>({})
const employees = ref<Profile[]>([])
const missingTable = ref(false)
const loading = ref(true)

const title = ref('')
const category = ref('General')
const difficulty = ref<CourseDifficulty>('Beginner')
const audienceColors = ref<Record<string, string>>({})
const categories = ref<string[]>(['General'])
const saving = ref(false)
const error = ref('')

// Assign modal state
const assignTarget = ref<Course | null>(null)
const assignSelectedIds = ref<string[]>([])
const assignDeadline = ref('')
const assignSearch = ref('')
const assignDept = ref('All')
const assigning = ref(false)
const assignErr = ref('')
const assignSuccess = ref('')

const assignedColor = computed(() => audienceColors.value[category.value] ?? COURSE_COLORS[0]!)

const activeEmployees = computed(() =>
  employees.value.filter((p) => isActive(p) && p.role === 'employee'),
)

const filteredAssignEmployees = computed(() => {
  const q = assignSearch.value.trim().toLowerCase()
  return activeEmployees.value.filter((p) => {
    if (assignDept.value !== 'All' && p.department !== assignDept.value) return false
    if (q) {
      return (
        p.full_name.toLowerCase().includes(q) ||
        p.department.toLowerCase().includes(q) ||
        (p.email ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })
})

function openAssignModal(c: Course) {
  assignTarget.value = c
  assignSelectedIds.value = [...(existingAssigneeIdsByCourse.value[c.id] ?? [])]
  assignDeadline.value = ''
  assignSearch.value = ''
  assignDept.value = 'All'
  assignErr.value = ''
}

function toggleAssignEmployee(uid: string) {
  if (assignSelectedIds.value.includes(uid)) {
    assignSelectedIds.value = assignSelectedIds.value.filter((id) => id !== uid)
  } else {
    assignSelectedIds.value = [...assignSelectedIds.value, uid]
  }
}

function selectAllVisibleForAssign() {
  const merged = new Set([...assignSelectedIds.value, ...filteredAssignEmployees.value.map((p) => p.id)])
  assignSelectedIds.value = [...merged]
}

async function submitAssignModal() {
  if (!assignTarget.value) return
  assignErr.value = ''
  if (assignSelectedIds.value.length === 0) {
    assignErr.value = 'Select at least one employee.'
    return
  }
  assigning.value = true
  const profilesMap = new Map<string, Profile>()
  for (const e of employees.value) profilesMap.set(e.id, e)
  const res = await assignCourseToEmployees({
    courseId: assignTarget.value.id,
    courseTitle: assignTarget.value.title,
    userIds: assignSelectedIds.value,
    deadlineDate: assignDeadline.value || null,
    assignedBy: auth.profile?.id,
    profilesById: profilesMap,
  })
  assigning.value = false
  if (!res.ok) {
    assignErr.value = res.error ?? 'Could not assign course.'
    return
  }
  await logActivity(
    auth.profile?.id,
    `Assigned course "${assignTarget.value.title}" to ${res.assignedCount} employee(s)`,
  )
  assignSuccess.value = `Assigned "${assignTarget.value.title}" to ${res.assignedCount} employee(s).`
  assignTarget.value = null
  await load()
}

async function load() {
  const [{ data, error: err }, { data: mods }, depts, { data: profs }, { data: enrols }] = await Promise.all([
    supabase.from('courses').select('*').order('id', { ascending: false }),
    supabase.from('modules').select('id, course_id'),
    loadDepartments(),
    supabase.from('profiles').select('*').order('full_name'),
    supabase.from('course_enrolments').select('course_id, user_id'),
  ])
  audienceColors.value = await loadAudienceColorMap(depts)
  categories.value = ['General', ...depts.map((d) => d.name)]
  employees.value = (profs ?? []) as Profile[]
  if (err) {
    missingTable.value = true
    loading.value = false
    return
  }
  courses.value = (data ?? []) as Course[]
  const counts: Record<number, number> = {}
  for (const m of (mods ?? []) as Pick<Module, 'id' | 'course_id'>[]) if (m.course_id) counts[m.course_id] = (counts[m.course_id] ?? 0) + 1
  lessonCounts.value = counts

  const eCounts: Record<number, number> = {}
  const eUsers: Record<number, string[]> = {}
  for (const en of (enrols ?? []) as Pick<CourseEnrolment, 'course_id' | 'user_id'>[]) {
    eCounts[en.course_id] = (eCounts[en.course_id] ?? 0) + 1
    eUsers[en.course_id] = [...(eUsers[en.course_id] ?? []), en.user_id]
  }
  enrolmentCounts.value = eCounts
  existingAssigneeIdsByCourse.value = eUsers
  loading.value = false
}

onMounted(load)

const { sorted: sortedCourses, toggle, indicator, ariaSort } = useSort(courses, {
  title: (c) => c.title,
  category: (c) => c.category,
  difficulty: (c) => resolveCourseDifficulty(c.difficulty, c.title, c.description, []),
  lessons: (c) => lessonCounts.value[c.id] ?? 0,
  status: (c) => (c.is_published ? 0 : 1),
})

async function createCourse() {
  if (!title.value.trim()) return
  saving.value = true
  error.value = ''
  let { data, error: err } = await supabase
    .from('courses')
    .insert({ title: title.value.trim(), category: category.value, difficulty: difficulty.value, color: assignedColor.value })
    .select()
    .single()
  if (err && err.message.toLowerCase().includes('difficulty')) {
    const fallback = await supabase
      .from('courses')
      .insert({ title: title.value.trim(), category: category.value, color: assignedColor.value })
      .select()
      .single()
    data = fallback.data
    err = fallback.error
  }
  saving.value = false
  if (err || !data) {
    error.value = err?.message ?? 'Could not create the course.'
    return
  }
  await logActivity(auth.profile?.id, `Created course "${title.value.trim()}"`)
  title.value = ''
  router.push(`/admin/courses/${(data as Course).id}`)
}

async function togglePublish(c: Course) {
  await supabase.from('courses').update({ is_published: !c.is_published }).eq('id', c.id)
  await logActivity(auth.profile?.id, `${c.is_published ? 'Unpublished' : 'Published'} course "${c.title}"`)
  await load()
}

async function deleteCourse(c: Course) {
  if (!window.confirm(`Delete the course "${c.title}"?\n\nIts lessons are kept (they just stop belonging to a course) — only the course itself is removed.`)) return
  await supabase.from('courses').delete().eq('id', c.id)
  await logActivity(auth.profile?.id, `Deleted course "${c.title}"`)
  await load()
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>Courses</h2>
        <p>A course groups lessons (modules) into one learning path.</p>
      </div>
      <RouterLink class="btn btn-ghost btn-sm" to="/admin/certificates?tab=template">
        📜 Certificate Template & Settings →
      </RouterLink>
    </div>

    <div v-if="missingTable" class="card" style="padding: 20px; max-width: 640px">
      <h3 style="font-size: 18px; margin-bottom: 6px">One-time setup needed</h3>
      <p class="hint" style="font-size: 13.5px; margin-top: 0">
        Courses need a small database update. In Supabase → SQL Editor, run the contents of
        <code>supabase/revamp-v4.sql</code> (it's safe to run more than once), then refresh this page. Until then the
        catalog shows one automatic course per audience.
      </p>
    </div>

    <template v-else>
      <div class="card" style="padding: 18px; margin-bottom: 20px; max-width: 620px">
        <div class="panel-title" style="padding: 0 0 8px"><h3>New course</h3></div>
        <div class="field"><label>Course title</label><input v-model="title" type="text" placeholder="e.g. Odoo Sales Order Flow" /></div>
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
        <button class="btn btn-primary btn-sm" :disabled="saving || !title.trim()" @click="createCourse">{{ saving ? 'Creating…' : 'Create course' }}</button>
        <p v-if="error" class="hint" style="color: var(--danger)">{{ error }}</p>
      </div>

      <p v-if="assignSuccess" class="hint" style="color: var(--teal); font-weight: 600; margin-bottom: 12px">
        ✓ {{ assignSuccess }}
      </p>

      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th class="sortable" :aria-sort="ariaSort('title')" @click="toggle('title')">Course <span class="sort-ind">{{ indicator('title') }}</span></th>
              <th class="sortable" :aria-sort="ariaSort('category')" @click="toggle('category')">Category <span class="sort-ind">{{ indicator('category') }}</span></th>
              <th class="sortable" :aria-sort="ariaSort('difficulty')" @click="toggle('difficulty')">Difficulty <span class="sort-ind">{{ indicator('difficulty') }}</span></th>
              <th class="sortable" :aria-sort="ariaSort('lessons')" @click="toggle('lessons')">Lessons <span class="sort-ind">{{ indicator('lessons') }}</span></th>
              <th>Assigned</th>
              <th class="sortable" :aria-sort="ariaSort('status')" @click="toggle('status')">Status <span class="sort-ind">{{ indicator('status') }}</span></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in sortedCourses" :key="c.id">
              <td>
                <RouterLink :to="`/admin/courses/${c.id}`" class="row" style="text-decoration: none; font-weight: 700">
                  <span class="tile" :style="{ background: c.color, width: '36px', height: '36px', fontSize: '12px', borderRadius: '10px' }">{{ courseCode(c.title) }}</span>
                  {{ c.title }}
                </RouterLink>
              </td>
              <td><span class="pill pill-outline">{{ c.category }}</span></td>
              <td><span class="pill pill-muted">{{ resolveCourseDifficulty(c.difficulty, c.title, c.description, []) }}</span></td>
              <td>{{ lessonCounts[c.id] ?? 0 }}</td>
              <td style="font-variant-numeric: tabular-nums">{{ enrolmentCounts[c.id] ?? 0 }}</td>
              <td><span :class="['pill', c.is_published ? 'pill-teal' : 'pill-muted']">{{ c.is_published ? 'Published' : 'Hidden' }}</span></td>
              <td style="white-space: nowrap">
                <button class="btn btn-primary btn-sm" @click="openAssignModal(c)">Assign</button>
                <RouterLink class="btn btn-ghost btn-sm" style="margin-left: 4px" :to="`/admin/courses/${c.id}`">Open</RouterLink>
                <button class="btn btn-ghost btn-sm" style="margin-left: 4px" @click="togglePublish(c)">{{ c.is_published ? 'Hide' : 'Publish' }}</button>
                <button class="btn btn-ghost btn-sm" style="margin-left: 4px; color: var(--danger)" @click="deleteCourse(c)">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loading && !courses.length" style="padding: 24px; text-align: center; color: var(--ink-soft)">No courses yet — create the first one above.</p>
      </div>
    </template>

    <!-- Assign Course to Employees Modal -->
    <div v-if="assignTarget" class="modal-backdrop" @click.self="assignTarget = null">
      <div class="modal modal-wide">
        <div class="modal-head">
          <div>
            <h3 style="font-size: 18px; margin-bottom: 2px">Assign "{{ assignTarget.title }}"</h3>
            <p class="sub" style="margin: 0">
              Assigned employees will see this course in their dashboard and catalog, regardless of department.
            </p>
          </div>
          <button class="modal-close" type="button" @click="assignTarget = null">✕</button>
        </div>

        <div class="field">
          <label>Course completion deadline (optional)</label>
          <input v-model="assignDeadline" type="date" style="max-width: 210px" />
        </div>

        <div class="field">
          <div class="row wrap" style="justify-content: space-between; align-items: center; margin-bottom: 6px">
            <label style="margin: 0">
              Select employees ({{ assignSelectedIds.length }} selected)
            </label>
            <div class="row" style="gap: 8px">
              <button type="button" class="btn btn-ghost btn-sm" @click="selectAllVisibleForAssign">
                Select visible ({{ filteredAssignEmployees.length }})
              </button>
              <button
                v-if="assignSelectedIds.length"
                type="button"
                class="btn btn-ghost btn-sm"
                @click="assignSelectedIds = []"
              >
                Clear
              </button>
            </div>
          </div>

          <div class="row wrap" style="gap: 8px; margin-bottom: 8px">
            <input v-model="assignSearch" type="search" placeholder="Search employees…" style="flex: 1; min-width: 180px" />
            <select v-model="assignDept" style="width: 170px">
              <option value="All">All departments</option>
              <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }}</option>
            </select>
          </div>

          <div class="assign-emp-list">
            <label
              v-for="emp in filteredAssignEmployees"
              :key="emp.id"
              class="assign-emp-item"
              :class="{ selected: assignSelectedIds.includes(emp.id) }"
            >
              <input
                type="checkbox"
                :checked="assignSelectedIds.includes(emp.id)"
                @change="toggleAssignEmployee(emp.id)"
              />
              <span class="avatar" style="width: 26px; height: 26px; font-size: 11px">{{ initialsOf(emp.full_name) }}</span>
              <div class="grow">
                <div style="font-weight: 600; font-size: 13px">{{ emp.full_name }}</div>
                <div class="sub">{{ emp.department }}{{ emp.email ? ` · ${emp.email}` : '' }}</div>
              </div>
              <span
                v-if="(existingAssigneeIdsByCourse[assignTarget.id] ?? []).includes(emp.id)"
                class="sub"
                style="font-weight: 600; color: var(--teal)"
              >
                Enrolled
              </span>
            </label>
            <div v-if="!filteredAssignEmployees.length" class="sub" style="padding: 16px; text-align: center">
              No active employees match your filter.
            </div>
          </div>
        </div>

        <p v-if="assignErr" class="hint" style="color: var(--danger); margin-bottom: 10px">{{ assignErr }}</p>

        <div class="row wrap" style="gap: 8px; justify-content: flex-end">
          <button class="btn btn-ghost btn-sm" type="button" @click="assignTarget = null">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="assigning" @click="submitAssignModal">
            {{ assigning ? 'Assigning…' : `Assign to ${assignSelectedIds.length} employee(s)` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
  border: 1px solid var(--border);
}
.aud-settings-link {
  margin-left: auto;
  color: var(--accent-text);
  font-weight: 600;
  text-decoration: none;
}
.aud-settings-link:hover {
  text-decoration: underline;
}
.assign-emp-list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunken);
}
.assign-emp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.assign-emp-item:last-child {
  border-bottom: none;
}
.assign-emp-item.selected {
  background: var(--accent-soft);
}
.assign-emp-item input[type='checkbox'] {
  width: 16px;
  height: 16px;
  flex: none;
}
</style>
