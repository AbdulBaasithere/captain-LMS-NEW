<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { materialType, formatDuration, hasAnyVideo, hydrateModulesUploadedVideos } from '@/lib/materials'
import { loadEmployeeCoursesAndEnrolments } from '@/lib/courseAssignments'
import { useSort } from '@/composables/useSort'
import type { Module, VideoCompletion } from '@/lib/database.types'

const auth = useAuthStore()
const router = useRouter()
const modules = ref<Module[]>([])
const assignedCourseIds = ref<Set<number>>(new Set())
const completions = ref<VideoCompletion[]>([])
const audienceFilter = ref('All')

onMounted(async () => {
  const dept = auth.profile?.department
  const userId = auth.profile?.id
  if (!dept || !userId) return
  const [assignedData, { data: compData }] = await Promise.all([
    loadEmployeeCoursesAndEnrolments(userId, dept),
    supabase.from('video_completions').select('*').eq('user_id', userId),
  ])
  assignedCourseIds.value = new Set(
    assignedData.enrolments.filter((e) => e.assigned_by !== null).map((e) => e.course_id),
  )
  modules.value = await hydrateModulesUploadedVideos(assignedData.modules)
  completions.value = compData ?? []
})

function isDone(moduleId: number) {
  return completions.value.some((c) => c.module_id === moduleId && c.completed)
}

const availableAudiences = computed(() => {
  const set = new Set<string>(['General'])
  if (auth.profile?.department) set.add(auth.profile.department)
  for (const m of modules.value) {
    if (m.department) set.add(m.department)
  }
  return Array.from(set)
})

const filteredModules = computed(() => {
  if (audienceFilter.value === 'All') return modules.value
  if (audienceFilter.value === 'Assigned') {
    return modules.value.filter((m) => typeof m.course_id === 'number' && assignedCourseIds.value.has(m.course_id))
  }
  return modules.value.filter((m) => m.department === audienceFilter.value)
})

const { sorted: sortedModules, toggle, indicator, ariaSort } = useSort(filteredModules, {
  title: (m) => m.title,
  audience: (m) => m.department,
  type: (m) => materialType(m),
  duration: (m) => (hasAnyVideo(m) ? m.duration_seconds : null),
  status: (m) => (isDone(m.id) ? 0 : 1),
})
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>My Modules</h2>
        <p>General training, your department's track, and any courses assigned to you.</p>
      </div>
    </div>

    <div style="display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap">
      <button
        class="btn btn-sm"
        :class="audienceFilter === 'All' ? 'btn-primary' : 'btn-ghost'"
        @click="audienceFilter = 'All'"
      >
        All
      </button>
      <button
        v-if="assignedCourseIds.size > 0"
        class="btn btn-sm"
        :class="audienceFilter === 'Assigned' ? 'btn-primary' : 'btn-ghost'"
        @click="audienceFilter = 'Assigned'"
      >
        Assigned
      </button>
      <button
        v-for="aud in availableAudiences"
        :key="aud"
        class="btn btn-sm"
        :class="audienceFilter === aud ? 'btn-primary' : 'btn-ghost'"
        @click="audienceFilter = aud"
      >
        {{ aud }}
      </button>
    </div>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th class="sortable" :aria-sort="ariaSort('title')" @click="toggle('title')">
              Title <span class="sort-ind">{{ indicator('title') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('audience')" @click="toggle('audience')">
              Audience <span class="sort-ind">{{ indicator('audience') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('type')" @click="toggle('type')">
              Type <span class="sort-ind">{{ indicator('type') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('duration')" @click="toggle('duration')">
              Duration <span class="sort-ind">{{ indicator('duration') }}</span>
            </th>
            <th class="sortable" :aria-sort="ariaSort('status')" @click="toggle('status')">
              Status <span class="sort-ind">{{ indicator('status') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in sortedModules" :key="m.id" style="cursor: pointer" @click="router.push(`/app/modules/${m.id}`)">
            <td style="font-weight: 600">
              <RouterLink :to="`/app/modules/${m.id}`" style="text-decoration: none">{{ m.title }}</RouterLink>
            </td>
            <td><span class="pill pill-outline">{{ m.department }}</span></td>
            <td style="color: var(--ink-soft)">{{ materialType(m) }}</td>
            <td style="color: var(--ink-soft)">{{ formatDuration(m) }}</td>
            <td>
              <span :class="['pill', isDone(m.id) ? 'pill-teal' : 'pill-outline']">
                {{ isDone(m.id) ? '✓ Completed' : 'Not started' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!filteredModules.length" style="padding: 24px; text-align: center; color: var(--ink-soft)">
        No modules match this filter.
      </p>
    </div>
  </div>
</template>
