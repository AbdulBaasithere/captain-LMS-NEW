<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { loadCourses, type CourseVM } from '@/lib/courses'
import { isActive, initialsOf } from '@/lib/employees'
import { loadDepartments } from '@/lib/departments'
import { loadIssuedCertificates, type IssuedCertificate } from '@/lib/issuedCertificates'
import {
  loadBadgeCriteria,
  saveBadgeCriterion,
  deleteBadgeCriterion,
  loadCustomBadges,
  saveCustomBadge,
  deleteCustomBadge,
  loadEmployeeBadgeAwards,
  awardCustomBadgeToEmployees,
  revokeEmployeeBadgeAward,
  computeLearnerBadgeMetrics,
  evaluateAllBadges,
  formatDurationMinutes,
  type BadgeCriterion,
  type BadgeCriterionInput,
  type BadgeEvaluation,
  type BadgeMatchMode,
  type CustomBadge,
  type EmployeeBadgeAward,
  type LearnerBadgeMetrics,
} from '@/lib/badges'
import type { Module, Profile, QuizAttempt, VideoCompletion } from '@/lib/database.types'

interface EmployeeEligibilityRow {
  profile: Profile
  metrics: LearnerBadgeMetrics
  evaluations: BadgeEvaluation[]
  unlocked: BadgeEvaluation[]
  nextBadge: BadgeEvaluation | null
}

const ICON_PRESETS = ['🌱', '🥉', '🥈', '🥇', '💎', '🏆', '🎖️', '⭐', '🚀', '🎓']
const DURATION_PRESETS = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '3h', minutes: 180 },
  { label: '5h', minutes: 300 },
  { label: '10h', minutes: 600 },
]

const route = useRoute()
const auth = useAuthStore()
const activeTab = ref<'rules' | 'custom'>(route.query.tab === 'custom' ? 'custom' : 'rules')
const loading = ref(true)
const tableMissing = ref(false)
const customTableMissing = ref(false)
const criteria = ref<BadgeCriterion[]>([])
const customBadges = ref<CustomBadge[]>([])
const badgeAwards = ref<EmployeeBadgeAward[]>([])
const issuedCertificates = ref<IssuedCertificate[]>([])
const employees = ref<Profile[]>([])
const modules = ref<Module[]>([])
const courses = ref<CourseVM[]>([])
const completions = ref<VideoCompletion[]>([])
const attempts = ref<QuizAttempt[]>([])
const departments = ref<string[]>([])

const showForm = ref(false)
const editingId = ref<number | null>(null)
const saving = ref(false)
const deletingId = ref<number | null>(null)
const formError = ref('')
const feedback = ref<{ ok: boolean; text: string } | null>(null)

// Custom badge creation & awarding state
const showCustomForm = ref(false)
const editingCustomId = ref<number | null>(null)
const savingCustom = ref(false)
const deletingCustomId = ref<number | null>(null)
const customFormError = ref('')
const customForm = reactive({
  name: '',
  description: '',
  icon: '🌟',
  category: 'Recognition',
  isActive: true,
})

const awardBadgeTarget = ref<CustomBadge | null>(null)
const awardReason = ref('')
const awardDeptFilter = ref('All')
const awardSearch = ref('')
const selectedAwardUserIds = ref<string[]>([])
const awarding = ref(false)
const awardError = ref('')
const revokingAwardId = ref<number | null>(null)

const search = ref('')
const departmentFilter = ref('All')
const eligibilityFilter = ref<'all' | 'unlocked' | 'pending'>('all')

const form = reactive<BadgeCriterionInput>({
  name: '',
  description: '',
  icon: '🏅',
  tierOrder: 1,
  matchMode: 'all',
  minCourseDurationMinutes: 60,
  minCoursesCompleted: 1,
  minCertificatesEarned: 1,
  isActive: true,
})

function resetForm() {
  editingId.value = null
  form.name = ''
  form.description = ''
  form.icon = '🏅'
  form.tierOrder = (criteria.value.length ? Math.max(...criteria.value.map((b) => b.tierOrder)) : 0) + 1
  form.matchMode = 'all'
  form.minCourseDurationMinutes = 60
  form.minCoursesCompleted = 1
  form.minCertificatesEarned = 1
  form.isActive = true
  formError.value = ''
}

function openCreateForm() {
  resetForm()
  showForm.value = true
}

function openEditForm(b: BadgeCriterion) {
  editingId.value = b.id
  form.name = b.name
  form.description = b.description
  form.icon = b.icon
  form.tierOrder = b.tierOrder
  form.matchMode = b.matchMode
  form.minCourseDurationMinutes = b.minCourseDurationMinutes
  form.minCoursesCompleted = b.minCoursesCompleted
  form.minCertificatesEarned = b.minCertificatesEarned
  form.isActive = b.isActive
  formError.value = ''
  showForm.value = true
}

async function loadData() {
  loading.value = true
  const [
    badgeRes,
    customRes,
    awardsRes,
    issuedRes,
    { data: profData },
    { data: modData },
    { data: compData },
    { data: attData },
    deptRows,
  ] = await Promise.all([
    loadBadgeCriteria({ includeInactive: true }),
    loadCustomBadges({ includeInactive: true }),
    loadEmployeeBadgeAwards(),
    loadIssuedCertificates(),
    supabase.from('profiles').select('*').order('full_name'),
    supabase.from('modules').select('*').eq('is_draft', false).eq('is_archived', false).order('id'),
    supabase.from('video_completions').select('*'),
    supabase.from('quiz_attempts').select('*').eq('passed', true),
    loadDepartments(),
  ])

  criteria.value = badgeRes.criteria
  tableMissing.value = badgeRes.tableMissing
  customBadges.value = customRes.badges
  customTableMissing.value = customRes.tableMissing || awardsRes.tableMissing
  badgeAwards.value = awardsRes.awards
  issuedCertificates.value = issuedRes.certificates
  employees.value = ((profData ?? []) as Profile[]).filter((p) => isActive(p) && p.role === 'employee')
  modules.value = (modData ?? []) as Module[]
  courses.value = (await loadCourses(modules.value)).filter((c) => c.lessons.length > 0)
  completions.value = (compData ?? []) as VideoCompletion[]
  attempts.value = (attData ?? []) as QuizAttempt[]
  departments.value = ['All', 'General', ...deptRows.map((d) => d.name)]
  loading.value = false
}

onMounted(loadData)

const employeesById = computed(() => {
  const m = new Map<string, Profile>()
  for (const e of employees.value) m.set(e.id, e)
  return m
})

const customBadgesById = computed(() => {
  const m = new Map<number, CustomBadge>()
  for (const b of customBadges.value) m.set(b.id, b)
  return m
})

const filteredAwardPool = computed(() => {
  const q = awardSearch.value.trim().toLowerCase()
  return employees.value.filter((p) => {
    if (awardDeptFilter.value !== 'All' && p.department !== awardDeptFilter.value) return false
    if (q) {
      return p.full_name.toLowerCase().includes(q) || p.department.toLowerCase().includes(q)
    }
    return true
  })
})

function openCreateCustomBadge() {
  editingCustomId.value = null
  customForm.name = ''
  customForm.description = ''
  customForm.icon = '🌟'
  customForm.category = 'Recognition'
  customForm.isActive = true
  customFormError.value = ''
  showCustomForm.value = true
}

function openEditCustomBadge(b: CustomBadge) {
  editingCustomId.value = b.id
  customForm.name = b.name
  customForm.description = b.description
  customForm.icon = b.icon
  customForm.category = b.category
  customForm.isActive = b.isActive
  customFormError.value = ''
  showCustomForm.value = true
}

async function submitCustomBadge() {
  customFormError.value = ''
  feedback.value = null
  if (!customForm.name.trim()) {
    customFormError.value = 'Enter a badge name.'
    return
  }
  savingCustom.value = true
  const existing = editingCustomId.value ? customBadges.value.find((b) => b.id === editingCustomId.value) : null
  const res = await saveCustomBadge(
    {
      id: editingCustomId.value ?? undefined,
      slug: existing?.slug,
      name: customForm.name,
      description: customForm.description,
      icon: customForm.icon,
      category: customForm.category,
      isActive: customForm.isActive,
    },
    auth.profile?.id,
  )
  savingCustom.value = false
  if (!res.ok) {
    customFormError.value = res.error ?? 'Could not save badge.'
    return
  }
  await logActivity(auth.profile?.id, `${editingCustomId.value ? 'Updated' : 'Created'} custom badge "${customForm.name.trim()}"`)
  feedback.value = { ok: true, text: res.error ?? `Saved badge "${customForm.name.trim()}".` }
  showCustomForm.value = false
  await loadData()
}

async function removeCustomBadge(b: CustomBadge) {
  if (!window.confirm(`Delete badge "${b.name}"?\n\nThis also removes any awards granted under this badge.`)) return
  deletingCustomId.value = b.id
  const res = await deleteCustomBadge(b.id)
  deletingCustomId.value = null
  if (!res.ok) {
    feedback.value = { ok: false, text: res.error ?? 'Could not delete badge.' }
    return
  }
  await logActivity(auth.profile?.id, `Deleted custom badge "${b.name}"`)
  if (awardBadgeTarget.value?.id === b.id) awardBadgeTarget.value = null
  feedback.value = { ok: true, text: `Deleted "${b.name}".` }
  await loadData()
}

function openAwardPanel(b: CustomBadge) {
  awardBadgeTarget.value = b
  awardReason.value = ''
  awardSearch.value = ''
  awardDeptFilter.value = 'All'
  selectedAwardUserIds.value = []
  awardError.value = ''
}

function toggleAwardRecipient(uid: string) {
  if (selectedAwardUserIds.value.includes(uid)) {
    selectedAwardUserIds.value = selectedAwardUserIds.value.filter((id) => id !== uid)
  } else {
    selectedAwardUserIds.value = [...selectedAwardUserIds.value, uid]
  }
}

function selectAllAwardPool() {
  const merged = new Set([...selectedAwardUserIds.value, ...filteredAwardPool.value.map((p) => p.id)])
  selectedAwardUserIds.value = [...merged]
}

async function submitAwardBadge() {
  if (!awardBadgeTarget.value) return
  awardError.value = ''
  if (selectedAwardUserIds.value.length === 0) {
    awardError.value = 'Select at least one employee.'
    return
  }
  awarding.value = true
  const res = await awardCustomBadgeToEmployees({
    badgeId: awardBadgeTarget.value.id,
    badgeName: awardBadgeTarget.value.name,
    userIds: selectedAwardUserIds.value,
    reason: awardReason.value,
    awardedBy: auth.profile?.id,
  })
  awarding.value = false
  if (!res.ok) {
    awardError.value = res.error ?? 'Could not award badge.'
    return
  }
  await logActivity(
    auth.profile?.id,
    `Awarded custom badge "${awardBadgeTarget.value.name}" to ${res.awardedCount} employee(s)`,
  )
  feedback.value = {
    ok: true,
    text: res.error ?? `Awarded "${awardBadgeTarget.value.name}" to ${res.awardedCount} employee(s).`,
  }
  awardBadgeTarget.value = null
  await loadData()
}

async function revokeAward(award: EmployeeBadgeAward) {
  const empName = employeesById.value.get(award.userId)?.full_name ?? 'this employee'
  const badgeName = customBadgesById.value.get(award.badgeId)?.name ?? 'badge'
  if (!window.confirm(`Revoke "${badgeName}" from ${empName}?`)) return
  revokingAwardId.value = award.id
  const res = await revokeEmployeeBadgeAward(award.id)
  revokingAwardId.value = null
  if (!res.ok) {
    feedback.value = { ok: false, text: res.error ?? 'Could not revoke badge award.' }
    return
  }
  await logActivity(auth.profile?.id, `Revoked custom badge "${badgeName}" from ${empName}`)
  feedback.value = { ok: true, text: `Revoked "${badgeName}" from ${empName}.` }
  await loadData()
}

async function submitForm() {
  formError.value = ''
  feedback.value = null

  if (!form.name.trim()) {
    formError.value = 'Enter a badge title.'
    return
  }

  const durationMins = Math.max(0, Number(form.minCourseDurationMinutes) || 0)
  const coursesMin = Math.max(0, Number(form.minCoursesCompleted) || 0)
  const certsMin = Math.max(0, Number(form.minCertificatesEarned) || 0)

  if (durationMins === 0 && coursesMin === 0 && certsMin === 0) {
    formError.value = 'Set at least one non-zero criterion (course completion duration, courses completed, or certificates earned).'
    return
  }

  saving.value = true
  const existing = editingId.value ? criteria.value.find((b) => b.id === editingId.value) : null
  const result = await saveBadgeCriterion(
    {
      id: editingId.value ?? undefined,
      slug: existing?.slug,
      name: form.name.trim(),
      description: form.description.trim(),
      icon: form.icon.trim() || '🏅',
      tierOrder: Math.max(1, Number(form.tierOrder) || 1),
      matchMode: form.matchMode as BadgeMatchMode,
      minCourseDurationMinutes: durationMins,
      minCoursesCompleted: coursesMin,
      minCertificatesEarned: certsMin,
      isActive: form.isActive,
    },
    auth.profile?.id,
  )
  saving.value = false

  if (!result.ok) {
    formError.value = result.error ?? 'Could not save badge rule.'
    return
  }

  await logActivity(
    auth.profile?.id,
    `${editingId.value ? 'Updated' : 'Created'} milestone badge rule "${form.name.trim()}"`,
  )

  feedback.value = {
    ok: true,
    text: result.error ?? `Saved "${form.name.trim()}" badge criteria.`,
  }
  showForm.value = false
  await loadData()
}

async function toggleRuleActive(b: BadgeCriterion) {
  feedback.value = null
  const result = await saveBadgeCriterion(
    {
      id: b.id,
      slug: b.slug,
      name: b.name,
      description: b.description,
      icon: b.icon,
      tierOrder: b.tierOrder,
      matchMode: b.matchMode,
      minCourseDurationMinutes: b.minCourseDurationMinutes,
      minCoursesCompleted: b.minCoursesCompleted,
      minCertificatesEarned: b.minCertificatesEarned,
      isActive: !b.isActive,
    },
    auth.profile?.id,
  )
  if (!result.ok) {
    feedback.value = { ok: false, text: result.error ?? 'Could not update badge status.' }
    return
  }
  await logActivity(auth.profile?.id, `${!b.isActive ? 'Activated' : 'Paused'} badge rule "${b.name}"`)
  await loadData()
}

async function removeRule(b: BadgeCriterion) {
  if (!window.confirm(`Delete the "${b.name}" badge rule?\n\nEmployees will no longer be evaluated against this milestone.`)) {
    return
  }
  deletingId.value = b.id
  feedback.value = null
  const result = await deleteBadgeCriterion(b.id)
  deletingId.value = null
  if (!result.ok) {
    feedback.value = { ok: false, text: result.error ?? 'Could not delete badge rule.' }
    return
  }
  await logActivity(auth.profile?.id, `Deleted milestone badge rule "${b.name}"`)
  feedback.value = { ok: true, text: `Removed "${b.name}".` }
  await loadData()
}

const activeCriteria = computed(() => criteria.value.filter((c) => c.isActive))

const employeeEligibilityRows = computed<EmployeeEligibilityRow[]>(() => {
  const compByUser = new Map<string, VideoCompletion[]>()
  for (const c of completions.value) {
    compByUser.set(c.user_id, [...(compByUser.get(c.user_id) ?? []), c])
  }
  const attByUser = new Map<string, QuizAttempt[]>()
  for (const a of attempts.value) {
    attByUser.set(a.user_id, [...(attByUser.get(a.user_id) ?? []), a])
  }

  const issuedByUser = new Map<string, number>()
  for (const cert of issuedCertificates.value) {
    issuedByUser.set(cert.userId, (issuedByUser.get(cert.userId) ?? 0) + 1)
  }

  return employees.value.map((profile) => {
    const deptCourses = courses.value.filter((c) => {
      const cat = c.category
      return cat === 'General' || cat === profile.department || c.lessons.some((l) => l.department === 'General' || l.department === profile.department)
    })
    const metrics = computeLearnerBadgeMetrics({
      courses: deptCourses,
      completions: compByUser.get(profile.id) ?? [],
      passedAttempts: attByUser.get(profile.id) ?? [],
      extraCertificatesCount: issuedByUser.get(profile.id) ?? 0,
    })
    const evaluations = evaluateAllBadges(activeCriteria.value, metrics)
    const unlocked = evaluations.filter((e) => e.eligible)
    const nextBadge = evaluations.find((e) => !e.eligible) ?? null
    return {
      profile,
      metrics,
      evaluations,
      unlocked,
      nextBadge,
    }
  })
})

const qualifiedCountByBadgeId = computed(() => {
  const map = new Map<number, number>()
  for (const row of employeeEligibilityRows.value) {
    for (const u of row.unlocked) {
      map.set(u.badge.id, (map.get(u.badge.id) ?? 0) + 1)
    }
  }
  return map
})

const filteredEmployees = computed(() => {
  const q = search.value.trim().toLowerCase()
  return employeeEligibilityRows.value.filter((row) => {
    if (departmentFilter.value !== 'All' && row.profile.department !== departmentFilter.value) return false
    if (eligibilityFilter.value === 'unlocked' && row.unlocked.length === 0) return false
    if (eligibilityFilter.value === 'pending' && row.unlocked.length > 0) return false
    if (q) {
      const matchName = row.profile.full_name.toLowerCase().includes(q)
      const matchDept = row.profile.department.toLowerCase().includes(q)
      if (!matchName && !matchDept) return false
    }
    return true
  })
})

const summaryStats = computed(() => {
  const totalRules = activeCriteria.value.length
  const totalEmployees = employeeEligibilityRows.value.length
  const totalUnlocks = employeeEligibilityRows.value.reduce((s, r) => s + r.unlocked.length, 0)
  const qualifiedLearners = employeeEligibilityRows.value.filter((r) => r.unlocked.length > 0).length
  const avgAttainment =
    totalEmployees > 0 && totalRules > 0
      ? Math.round(
          employeeEligibilityRows.value.reduce((sum, r) => {
            const avgRow = r.evaluations.reduce((s, e) => s + e.overallPct, 0) / totalRules
            return sum + avgRow
          }, 0) / totalEmployees,
        )
      : 0

  return { totalRules, totalEmployees, totalUnlocks, qualifiedLearners, avgAttainment }
})

function ruleCriteriaLine(b: BadgeCriterion): string {
  const parts: string[] = []
  if (b.minCourseDurationMinutes > 0) parts.push(`${formatDurationMinutes(b.minCourseDurationMinutes)} coursework`)
  if (b.minCoursesCompleted > 0) parts.push(`${b.minCoursesCompleted} ${b.minCoursesCompleted === 1 ? 'course' : 'courses'}`)
  if (b.minCertificatesEarned > 0) parts.push(`${b.minCertificatesEarned} ${b.minCertificatesEarned === 1 ? 'certificate' : 'certificates'}`)
  return parts.join(' · ')
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>Badges &amp; Milestones</h2>
        <p>Create custom badges to award directly to employees, or manage automated milestone badge eligibility rules.</p>
      </div>
      <div class="row wrap" style="gap: 8px">
        <button
          v-if="activeTab === 'rules'"
          class="btn btn-primary btn-sm"
          @click="showForm ? (showForm = false) : openCreateForm()"
        >
          {{ showForm ? 'Cancel' : '+ New badge rule' }}
        </button>
        <button
          v-else
          class="btn btn-primary btn-sm"
          @click="showCustomForm ? (showCustomForm = false) : openCreateCustomBadge()"
        >
          {{ showCustomForm ? 'Cancel' : '+ Create custom badge' }}
        </button>
      </div>
    </div>

    <div class="seg" style="margin-bottom: 18px">
      <button :class="{ on: activeTab === 'rules' }" @click="activeTab = 'rules'">
        🎯 Milestone Eligibility Rules ({{ criteria.length }})
      </button>
      <button :class="{ on: activeTab === 'custom' }" @click="activeTab = 'custom'">
        🏅 Custom Badges &amp; Direct Awards ({{ customBadges.length }})
      </button>
    </div>

    <p v-if="feedback" class="feedback-line" :style="{ color: feedback.ok ? 'var(--teal)' : 'var(--danger)' }">
      {{ feedback.text }}
    </p>

    <template v-if="activeTab === 'rules'">
      <div v-if="tableMissing" class="card notice-bar">
        <strong>Database migration pending:</strong>
        <span>
          Run <code>supabase/migrations/20261116_milestone_badge_criteria.sql</code> in Supabase SQL Editor to persist custom
          badge rules globally. Changes currently fall back to browser storage until the table exists.
        </span>
      </div>

    <!-- Summary Strip -->
    <div class="kpi-strip">
      <div class="card kpi-cell">
        <div class="lbl">Active badge rules</div>
        <div class="val tabular">{{ summaryStats.totalRules }}</div>
        <div class="sub">{{ criteria.length }} total configured</div>
      </div>
      <div class="card kpi-cell">
        <div class="lbl">Qualified learners</div>
        <div class="val tabular">{{ summaryStats.qualifiedLearners }}</div>
        <div class="sub">of {{ summaryStats.totalEmployees }} active employees</div>
      </div>
      <div class="card kpi-cell">
        <div class="lbl">Total badge unlocks</div>
        <div class="val tabular">{{ summaryStats.totalUnlocks }}</div>
        <div class="sub">across active rules</div>
      </div>
      <div class="card kpi-cell">
        <div class="lbl">Avg. milestone attainment</div>
        <div class="val tabular">{{ summaryStats.avgAttainment }}%</div>
        <div class="sub">mean rule progress</div>
      </div>
    </div>

    <!-- Create / Edit Rule Panel -->
    <div v-if="showForm" class="card editor-card">
      <div class="editor-head">
        <h3>{{ editingId ? 'Edit badge eligibility rule' : 'Create milestone badge rule' }}</h3>
        <span class="sub">Employees unlock the badge automatically when live metrics satisfy these criteria.</span>
      </div>

      <div class="editor-grid">
        <div class="field">
          <label>Badge name</label>
          <input v-model="form.name" type="text" placeholder="e.g. Gold Specialist" />
        </div>
        <div class="field">
          <label>Tier order</label>
          <input v-model.number="form.tierOrder" type="number" min="1" max="99" class="tabular" />
        </div>
        <div class="field">
          <label>Medal icon</label>
          <div class="icon-row">
            <input v-model="form.icon" type="text" maxlength="4" style="width: 64px; text-align: center" />
            <button
              v-for="ic in ICON_PRESETS"
              :key="ic"
              type="button"
              class="icon-pick"
              :class="{ on: form.icon === ic }"
              @click="form.icon = ic"
            >
              {{ ic }}
            </button>
          </div>
        </div>
      </div>

      <div class="field">
        <label>Description</label>
        <input
          v-model="form.description"
          type="text"
          placeholder="Explain what achievement this milestone badge recognizes"
        />
      </div>

      <div class="criteria-inputs">
        <div class="field">
          <label>Min. course completion duration (minutes)</label>
          <input v-model.number="form.minCourseDurationMinutes" type="number" min="0" step="5" class="tabular" />
          <div class="preset-row">
            <button
              v-for="p in DURATION_PRESETS"
              :key="p.minutes"
              type="button"
              class="preset-btn"
              :class="{ on: form.minCourseDurationMinutes === p.minutes }"
              @click="form.minCourseDurationMinutes = p.minutes"
            >
              {{ p.label }}
            </button>
          </div>
          <p class="hint">
            {{ form.minCourseDurationMinutes > 0 ? `Requires ${formatDurationMinutes(form.minCourseDurationMinutes)} of completed courses` : '0 disables duration requirement' }}
          </p>
        </div>

        <div class="field">
          <label>Min. number of courses completed</label>
          <input v-model.number="form.minCoursesCompleted" type="number" min="0" step="1" class="tabular" />
          <p class="hint">
            {{ form.minCoursesCompleted > 0 ? `Requires ${form.minCoursesCompleted} completed course(s)` : '0 disables course count requirement' }}
          </p>
        </div>

        <div class="field">
          <label>Min. certificates earned</label>
          <input v-model.number="form.minCertificatesEarned" type="number" min="0" step="1" class="tabular" />
          <p class="hint">
            {{ form.minCertificatesEarned > 0 ? `Includes course & milestone quiz certificates` : '0 disables certificate requirement' }}
          </p>
        </div>
      </div>

      <div class="editor-grid">
        <div class="field">
          <label>Eligibility evaluation logic</label>
          <select v-model="form.matchMode">
            <option value="all">Require ALL active criteria (AND)</option>
            <option value="any">Meet ANY single active criterion (OR)</option>
          </select>
        </div>
        <div class="field">
          <label>Rule status</label>
          <select v-model="form.isActive">
            <option :value="true">Active (visible and evaluated for employees)</option>
            <option :value="false">Paused (hidden from eligibility evaluation)</option>
          </select>
        </div>
      </div>

      <p v-if="formError" class="hint" style="color: var(--danger); margin-bottom: 10px">{{ formError }}</p>

      <div class="row wrap" style="gap: 8px">
        <button class="btn btn-primary btn-sm" :disabled="saving" @click="submitForm">
          {{ saving ? 'Saving…' : editingId ? 'Save changes' : 'Create badge rule' }}
        </button>
        <button class="btn btn-ghost btn-sm" type="button" @click="showForm = false">Cancel</button>
      </div>
    </div>

    <!-- Configured Rules List -->
    <div class="card section-card">
      <div class="section-head">
        <div>
          <h3>Configured Milestone Badges</h3>
          <p class="sub">Ordered by progression tier. Set a threshold to 0 to exclude that metric from a badge.</p>
        </div>
      </div>

      <div v-if="loading" class="empty-state sub">Loading badge rules…</div>
      <div v-else-if="!criteria.length" class="empty-state">
        <p class="sub">No badge criteria configured yet.</p>
        <button class="btn btn-primary btn-sm" style="margin-top: 10px" @click="openCreateForm">Create first badge rule</button>
      </div>

      <div v-else class="rules-list">
        <div v-for="b in criteria" :key="b.id" class="rule-row" :class="{ paused: !b.isActive }">
          <div class="rule-medal" aria-hidden="true">{{ b.icon }}</div>
          <div class="grow">
            <div class="rule-title-line">
              <b>{{ b.tierOrder }}. {{ b.name }}</b>
              <span class="meta-line">
                {{ b.isActive ? 'Active' : 'Paused' }} ·
                {{ b.matchMode === 'all' ? 'All criteria (AND)' : 'Any criterion (OR)' }} ·
                <span class="tabular">{{ qualifiedCountByBadgeId.get(b.id) ?? 0 }} / {{ employeeEligibilityRows.length }} employees eligible</span>
              </span>
            </div>
            <p v-if="b.description" class="sub" style="margin: 2px 0 4px">{{ b.description }}</p>
            <div class="criteria-line tabular">
              <span>Duration: <b>{{ b.minCourseDurationMinutes > 0 ? formatDurationMinutes(b.minCourseDurationMinutes) : 'Optional' }}</b></span>
              <span aria-hidden="true">·</span>
              <span>Courses: <b>{{ b.minCoursesCompleted > 0 ? b.minCoursesCompleted : 'Optional' }}</b></span>
              <span aria-hidden="true">·</span>
              <span>Certificates: <b>{{ b.minCertificatesEarned > 0 ? b.minCertificatesEarned : 'Optional' }}</b></span>
              <span v-if="ruleCriteriaLine(b)" class="sr-only">{{ ruleCriteriaLine(b) }}</span>
            </div>
          </div>
          <div class="row" style="gap: 6px; flex-shrink: 0">
            <button class="btn btn-ghost btn-sm" @click="openEditForm(b)">Edit</button>
            <button class="btn btn-ghost btn-sm" @click="toggleRuleActive(b)">
              {{ b.isActive ? 'Pause' : 'Activate' }}
            </button>
            <button
              class="btn btn-ghost btn-sm"
              style="color: var(--danger)"
              :disabled="deletingId === b.id"
              @click="removeRule(b)"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Employee Eligibility Matrix -->
    <div class="card section-card">
      <div class="section-head">
        <div>
          <h3>Employee Eligibility Matrix</h3>
          <p class="sub">Real-time evaluation against completed course duration, courses completed, and certificates earned.</p>
        </div>
        <div class="filter-bar">
          <input v-model="search" type="search" placeholder="Search employee…" style="width: 190px" />
          <select v-model="departmentFilter" style="width: auto">
            <option v-for="d in departments" :key="d" :value="d">{{ d === 'All' ? 'All departments' : d }}</option>
          </select>
          <select v-model="eligibilityFilter" style="width: auto">
            <option value="all">All learners</option>
            <option value="unlocked">Has unlocked badges</option>
            <option value="pending">No badges unlocked yet</option>
          </select>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th class="num-col">Course Duration</th>
              <th class="num-col">Courses Done</th>
              <th class="num-col">Certificates</th>
              <th>Unlocked Badges</th>
              <th>Next Milestone</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filteredEmployees" :key="row.profile.id">
              <td>
                <RouterLink :to="`/admin/employees/${row.profile.id}`" class="emp-link">
                  <span class="avatar" style="width: 26px; height: 26px; font-size: 11px">{{ initialsOf(row.profile.full_name) }}</span>
                  <span>{{ row.profile.full_name }}</span>
                </RouterLink>
              </td>
              <td>{{ row.profile.department }}</td>
              <td class="num-col tabular">{{ formatDurationMinutes(row.metrics.completedCourseDurationMinutes) }}</td>
              <td class="num-col tabular">{{ row.metrics.coursesCompleted }}</td>
              <td class="num-col tabular">
                {{ row.metrics.certificatesEarned }}
                <span class="sub">({{ row.metrics.courseCertificatesEarned }}c/{{ row.metrics.milestoneCertificatesEarned }}m)</span>
              </td>
              <td>
                <span v-if="row.unlocked.length" class="unlocked-text">
                  {{ row.unlocked.map((u) => `${u.badge.icon} ${u.badge.name}`).join(', ') }}
                </span>
                <span v-else class="sub">None yet</span>
              </td>
              <td>
                <span v-if="row.nextBadge" class="tabular">
                  {{ row.nextBadge.badge.icon }} {{ row.nextBadge.badge.name }} · {{ row.nextBadge.overallPct }}%
                </span>
                <span v-else-if="activeCriteria.length" style="color: var(--teal); font-weight: 600">All milestones achieved</span>
                <span v-else class="sub">—</span>
              </td>
            </tr>
            <tr v-if="!loading && !filteredEmployees.length">
              <td colspan="7" class="empty-cell">No employees match the selected filters.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    </template>

    <!-- TAB 2: Custom Admin Badges & Direct Employee Awards -->
    <template v-else>
      <div v-if="customTableMissing" class="card notice-bar">
        <strong>Database migration pending:</strong>
        <span>
          Run <code>supabase/migrations/20261116_admin_certificates_badges_assignments.sql</code> in Supabase SQL Editor to persist
          custom badges and awards across devices.
        </span>
      </div>

      <!-- Create / Edit Custom Badge Form -->
      <div v-if="showCustomForm" class="card editor-card">
        <div class="editor-head">
          <h3>{{ editingCustomId ? 'Edit custom badge' : 'Create custom badge' }}</h3>
          <span class="sub">Design a recognition or achievement badge and award it directly to employees.</span>
        </div>

        <div class="editor-grid">
          <div class="field">
            <label>Badge name *</label>
            <input v-model="customForm.name" type="text" placeholder="e.g. Safety Champion" />
          </div>
          <div class="field">
            <label>Category</label>
            <input v-model="customForm.category" type="text" placeholder="e.g. Recognition, Leadership, Safety" />
          </div>
          <div class="field">
            <label>Status</label>
            <select v-model="customForm.isActive">
              <option :value="true">Active</option>
              <option :value="false">Archived</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label>Badge icon</label>
          <div class="icon-row">
            <input v-model="customForm.icon" type="text" maxlength="4" style="width: 64px; text-align: center" />
            <button
              v-for="ic in ICON_PRESETS"
              :key="ic"
              type="button"
              class="icon-pick"
              :class="{ on: customForm.icon === ic }"
              @click="customForm.icon = ic"
            >
              {{ ic }}
            </button>
          </div>
        </div>

        <div class="field">
          <label>Description</label>
          <input
            v-model="customForm.description"
            type="text"
            placeholder="Describe what this badge recognizes"
          />
        </div>

        <p v-if="customFormError" class="hint" style="color: var(--danger); margin-bottom: 10px">{{ customFormError }}</p>

        <div class="row wrap" style="gap: 8px">
          <button class="btn btn-primary btn-sm" :disabled="savingCustom" @click="submitCustomBadge">
            {{ savingCustom ? 'Saving…' : editingCustomId ? 'Save badge' : 'Create badge' }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="showCustomForm = false">Cancel</button>
        </div>
      </div>

      <!-- Award Badge Modal / Panel -->
      <div v-if="awardBadgeTarget" class="card editor-card" style="border-color: var(--blue)">
        <div class="editor-head" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px">
          <div>
            <h3>{{ awardBadgeTarget.icon }} Award "{{ awardBadgeTarget.name }}" to Employees</h3>
            <span class="sub">Employees receive an immediate notification and see this badge in their Badges view.</span>
          </div>
          <button class="btn btn-ghost btn-sm" @click="awardBadgeTarget = null">Close</button>
        </div>

        <div class="field">
          <label>Citation / Award reason (optional)</label>
          <input v-model="awardReason" type="text" placeholder="e.g. Completed Q4 safety leadership workshop" />
        </div>

        <div class="field">
          <div class="row wrap" style="justify-content: space-between; align-items: center; margin-bottom: 6px">
            <label style="margin: 0">
              Select employees (<span class="tabular">{{ selectedAwardUserIds.length }}</span> selected)
            </label>
            <div class="row" style="gap: 8px">
              <button type="button" class="btn btn-ghost btn-sm" @click="selectAllAwardPool">
                Select visible ({{ filteredAwardPool.length }})
              </button>
              <button
                v-if="selectedAwardUserIds.length"
                type="button"
                class="btn btn-ghost btn-sm"
                @click="selectedAwardUserIds = []"
              >
                Clear
              </button>
            </div>
          </div>

          <div class="filter-bar" style="margin-bottom: 8px">
            <input v-model="awardSearch" type="search" placeholder="Search employees…" style="flex: 1; min-width: 180px" />
            <select v-model="awardDeptFilter" style="width: 160px">
              <option v-for="d in departments" :key="d" :value="d">{{ d === 'All' ? 'All departments' : d }}</option>
            </select>
          </div>

          <div class="award-emp-list">
            <label
              v-for="emp in filteredAwardPool"
              :key="emp.id"
              class="award-emp-row"
              :class="{ selected: selectedAwardUserIds.includes(emp.id) }"
            >
              <input
                type="checkbox"
                :checked="selectedAwardUserIds.includes(emp.id)"
                @change="toggleAwardRecipient(emp.id)"
              />
              <span class="avatar" style="width: 26px; height: 26px; font-size: 11px">{{ initialsOf(emp.full_name) }}</span>
              <span style="font-weight: 600">{{ emp.full_name }}</span>
              <span class="sub">· {{ emp.department }}</span>
            </label>
          </div>
        </div>

        <p v-if="awardError" class="hint" style="color: var(--danger); margin-bottom: 10px">{{ awardError }}</p>

        <div class="row wrap" style="gap: 8px">
          <button class="btn btn-primary btn-sm" :disabled="awarding" @click="submitAwardBadge">
            {{ awarding ? 'Awarding…' : `Award Badge (${selectedAwardUserIds.length})` }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="awardBadgeTarget = null">Cancel</button>
        </div>
      </div>

      <!-- Custom Badges Catalog -->
      <div class="card section-card">
        <div class="section-head">
          <div>
            <h3>Custom Badges</h3>
            <p class="sub">Admin-created badges you can award to individuals or teams at any time.</p>
          </div>
          <button class="btn btn-ghost btn-sm" @click="openCreateCustomBadge">+ Create badge</button>
        </div>

        <div v-if="loading" class="empty-state sub">Loading custom badges…</div>
        <div v-else-if="!customBadges.length" class="empty-state">
          <p class="sub">No custom badges created yet.</p>
          <button class="btn btn-primary btn-sm" style="margin-top: 10px" @click="openCreateCustomBadge">
            Create first custom badge
          </button>
        </div>

        <div v-else class="rules-list">
          <div v-for="b in customBadges" :key="b.id" class="rule-row" :class="{ paused: !b.isActive }">
            <div class="rule-medal" aria-hidden="true">{{ b.icon }}</div>
            <div class="grow">
              <div class="rule-title-line">
                <b>{{ b.name }}</b>
                <span class="meta-line">
                  {{ b.category }} · {{ b.isActive ? 'Active' : 'Archived' }} ·
                  <span class="tabular">{{ badgeAwards.filter((a) => a.badgeId === b.id).length }} awarded</span>
                </span>
              </div>
              <p v-if="b.description" class="sub" style="margin: 2px 0 0">{{ b.description }}</p>
            </div>
            <div class="row wrap" style="gap: 6px; flex-shrink: 0">
              <button class="btn btn-primary btn-sm" @click="openAwardPanel(b)">Award to employees</button>
              <button class="btn btn-ghost btn-sm" @click="openEditCustomBadge(b)">Edit</button>
              <button
                class="btn btn-ghost btn-sm"
                style="color: var(--danger)"
                :disabled="deletingCustomId === b.id"
                @click="removeCustomBadge(b)"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Awarded Badges History -->
      <div class="card section-card">
        <div class="section-head">
          <div>
            <h3>Direct Badge Awards History</h3>
            <p class="sub">Every custom badge awarded directly by administrators.</p>
          </div>
        </div>

        <div v-if="!badgeAwards.length" class="empty-state sub">
          No custom badges have been awarded yet. Click "Award to employees" on any custom badge above.
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Badge</th>
                <th>Reason / Citation</th>
                <th>Awarded On</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="aw in badgeAwards" :key="aw.id">
                <td>
                  <RouterLink :to="`/admin/employees/${aw.userId}`" class="emp-link">
                    <span>{{ employeesById.get(aw.userId)?.full_name ?? 'Employee' }}</span>
                  </RouterLink>
                  <div class="sub">{{ employeesById.get(aw.userId)?.department ?? '—' }}</div>
                </td>
                <td>
                  <b>{{ customBadgesById.get(aw.badgeId)?.icon }} {{ customBadgesById.get(aw.badgeId)?.name ?? 'Badge' }}</b>
                </td>
                <td>{{ aw.reason || '—' }}</td>
                <td class="tabular">{{ new Date(aw.awardedAt).toLocaleDateString() }}</td>
                <td>
                  <button
                    class="btn btn-ghost btn-sm"
                    style="color: var(--danger)"
                    :disabled="revokingAwardId === aw.id"
                    @click="revokeAward(aw)"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tabular {
  font-variant-numeric: tabular-nums;
}
.notice-bar {
  padding: 14px 18px;
  margin-bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  color: var(--ink);
  border-color: var(--brass);
}
.feedback-line {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
@media (max-width: 900px) {
  .kpi-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.kpi-cell {
  padding: 16px 18px;
}
.kpi-cell .lbl {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--ink-soft);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.kpi-cell .val {
  font-size: 28px;
  font-weight: 800;
  margin: 4px 0 2px;
  color: var(--ink);
}
.editor-card {
  padding: 20px;
  margin-bottom: 18px;
}
.editor-head {
  margin-bottom: 14px;
}
.editor-head h3 {
  font-size: 17px;
  margin-bottom: 2px;
}
.editor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 14px;
}
.criteria-inputs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  padding-top: 12px;
  margin-top: 4px;
  border-top: 1px solid var(--border);
}
.icon-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.icon-pick {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--paper);
  cursor: pointer;
  font-size: 16px;
}
.icon-pick.on {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.preset-btn {
  padding: 3px 9px;
  font-size: 11.5px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--paper);
  color: var(--ink-soft);
  cursor: pointer;
}
.preset-btn.on {
  border-color: var(--blue);
  color: var(--blue);
  background: var(--blue-soft);
}
.section-card {
  margin-bottom: 18px;
  overflow: hidden;
}
.section-head {
  padding: 18px 20px 14px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
}
.section-head h3 {
  font-size: 17px;
  margin-bottom: 2px;
}
.filter-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.rules-list {
  display: flex;
  flex-direction: column;
}
.rule-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}
.rule-row:first-child {
  border-top: none;
}
.rule-row.paused {
  opacity: 0.6;
}
.rule-medal {
  width: 42px;
  height: 42px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  font-size: 22px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  flex: none;
}
.rule-title-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.meta-line {
  font-size: 12px;
  color: var(--ink-soft);
}
.criteria-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.criteria-line b {
  color: var(--ink);
}
.num-col {
  text-align: right;
  white-space: nowrap;
}
.emp-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  font-weight: 600;
  color: var(--ink);
}
.emp-link:hover {
  color: var(--blue);
}
.unlocked-text {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--teal);
}
.empty-state {
  padding: 28px 20px;
  text-align: center;
}
.empty-cell {
  text-align: center;
  padding: 24px;
  color: var(--ink-soft);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
@media (max-width: 720px) {
  .rule-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
.award-emp-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunken);
}
.award-emp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  font-size: 13px;
}
.award-emp-row:last-child {
  border-bottom: none;
}
.award-emp-row.selected {
  background: rgba(59, 130, 246, 0.1);
}
.award-emp-row input[type='checkbox'] {
  width: 16px;
  height: 16px;
}
</style>
