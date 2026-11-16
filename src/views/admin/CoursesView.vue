<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { loadAudienceColorMap, loadDepartments } from '@/lib/departments'
import { COURSE_COLORS, COURSE_DIFFICULTIES, courseCode, resolveCourseDifficulty } from '@/lib/courses'
import { useSort } from '@/composables/useSort'
import type { Course, CourseDifficulty, Module } from '@/lib/database.types'

const auth = useAuthStore()
const router = useRouter()
const courses = ref<Course[]>([])
const lessonCounts = ref<Record<number, number>>({})
const missingTable = ref(false)
const loading = ref(true)

const title = ref('')
const category = ref('General')
const difficulty = ref<CourseDifficulty>('Beginner')
const audienceColors = ref<Record<string, string>>({})
const categories = ref<string[]>(['General'])
const saving = ref(false)
const error = ref('')

const assignedColor = computed(() => audienceColors.value[category.value] ?? COURSE_COLORS[0]!)

async function load() {
  const [{ data, error: err }, { data: mods }, depts] = await Promise.all([
    supabase.from('courses').select('*').order('id', { ascending: false }),
    supabase.from('modules').select('id, course_id'),
    loadDepartments(),
  ])
  audienceColors.value = await loadAudienceColorMap(depts)
  categories.value = ['General', ...depts.map((d) => d.name)]
  if (err) {
    missingTable.value = true
    loading.value = false
    return
  }
  courses.value = (data ?? []) as Course[]
  const counts: Record<number, number> = {}
  for (const m of (mods ?? []) as Pick<Module, 'id' | 'course_id'>[]) if (m.course_id) counts[m.course_id] = (counts[m.course_id] ?? 0) + 1
  lessonCounts.value = counts
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
      <RouterLink class="btn btn-ghost btn-sm" to="/admin/certificates">
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

      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th class="sortable" :aria-sort="ariaSort('title')" @click="toggle('title')">Course <span class="sort-ind">{{ indicator('title') }}</span></th>
              <th class="sortable" :aria-sort="ariaSort('category')" @click="toggle('category')">Category <span class="sort-ind">{{ indicator('category') }}</span></th>
              <th class="sortable" :aria-sort="ariaSort('difficulty')" @click="toggle('difficulty')">Difficulty <span class="sort-ind">{{ indicator('difficulty') }}</span></th>
              <th class="sortable" :aria-sort="ariaSort('lessons')" @click="toggle('lessons')">Lessons <span class="sort-ind">{{ indicator('lessons') }}</span></th>
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
              <td><span :class="['pill', c.is_published ? 'pill-teal' : 'pill-muted']">{{ c.is_published ? 'Published' : 'Hidden' }}</span></td>
              <td style="white-space: nowrap">
                <RouterLink class="btn btn-ghost btn-sm" :to="`/admin/courses/${c.id}`">Open</RouterLink>
                <button class="btn btn-ghost btn-sm" style="margin-left: 4px" @click="togglePublish(c)">{{ c.is_published ? 'Hide' : 'Publish' }}</button>
                <button class="btn btn-ghost btn-sm" style="margin-left: 4px; color: var(--danger)" @click="deleteCourse(c)">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loading && !courses.length" style="padding: 24px; text-align: center; color: var(--ink-soft)">No courses yet — create the first one above.</p>
      </div>
    </template>
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
</style>
