<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { courseProgress, type CourseVM, type CourseProgress } from '@/lib/courses'
import { loadEmployeeCoursesAndEnrolments } from '@/lib/courseAssignments'
import { buildCertificateData, downloadCertificatePdf, type CertificateData } from '@/lib/certificate'
import { syncCertificateConfigFromServer } from '@/lib/certificateConfig'
import {
  loadIssuedCertificates,
  issuedCertToCertificateData,
  type IssuedCertificate,
} from '@/lib/issuedCertificates'
import {
  loadBadgeCriteria,
  loadCustomBadges,
  loadEmployeeBadgeAwards,
  computeLearnerBadgeMetrics,
  evaluateAllBadges,
  formatDurationMinutes,
  type BadgeCriterion,
  type BadgeEvaluation,
  type CustomBadge,
  type EmployeeBadgeAward,
} from '@/lib/badges'
import {
  orderedTrack,
  moduleChunkForMilestone,
  milestoneLabel,
  QUESTIONS_PER_QUIZ,
  PASS_THRESHOLD,
} from '@/lib/quiz'
import CertificateModal from '@/components/CertificateModal.vue'
import type { Module, QuizAttempt, VideoCompletion } from '@/lib/database.types'

const BADGE_TIERS = [
  { m: '1', icon: '🥉', name: 'Bronze' },
  { m: '2', icon: '🥈', name: 'Silver' },
  { m: '3', icon: '🥇', name: 'Gold' },
  { m: '4', icon: '💎', name: 'Diamond' },
  { m: '5', icon: '💎', name: 'Diamond II' },
]

const auth = useAuthStore()
const allAttempts = ref<QuizAttempt[]>([])
const passedMilestones = ref<Set<string>>(new Set())
const passedAttempts = ref<QuizAttempt[]>([])
const track = ref<Module[]>([])
const courses = ref<CourseVM[]>([])
const completions = ref<VideoCompletion[]>([])
const badgeCriteria = ref<BadgeCriterion[]>([])
const customBadges = ref<CustomBadge[]>([])
const customBadgeAwards = ref<EmployeeBadgeAward[]>([])
const issuedCertificates = ref<IssuedCertificate[]>([])
const badgeFilter = ref<'all' | 'unlocked' | 'in_progress'>('all')
const loading = ref(true)
const tooltipAlign = ref<Record<string, 'left' | 'center' | 'right'>>({})

const selectedCert = ref<CertificateData | null>(null)
const downloadingKey = ref<string | null>(null)

interface CompletedCourseItem {
  course: CourseVM
  progress: CourseProgress
  certData: CertificateData
}

interface AwardedCustomBadgeItem {
  award: EmployeeBadgeAward
  badge: CustomBadge
  awardedDateLabel: string
}

interface IssuedCertDisplayItem {
  cert: IssuedCertificate
  certData: CertificateData
}

interface MilestoneBadgeCard {
  milestone: string
  icon: string
  name: string
  unlocked: boolean
  isFinal: boolean
  quizLabel: string
  chunkCount: number
  requiredLessons: number
  doneCount: number
  lessonPct: number
  remainingLessonTitles: string[]
  passPctRequired: number
  passTargetCount: number
  passedAttempt: QuizAttempt | null
  passedScorePct: number | null
  earnedDateLabel: string | null
  attemptsUsed: number
  bestFailedScoreLabel: string | null
  readyToAttempt: boolean
  unlockSummary: string
}

onMounted(async () => {
  if (!auth.profile) return
  const dept = auth.profile.department
  const userId = auth.profile.id

  const [, { data: quizData }, assignedData, { data: compData }, badgeRes, customRes, awardsRes, issuedRes] =
    await Promise.all([
      syncCertificateConfigFromServer(),
      supabase.from('quiz_attempts').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
      loadEmployeeCoursesAndEnrolments(userId, dept),
      supabase.from('video_completions').select('*').eq('user_id', userId),
      loadBadgeCriteria({ includeInactive: false }),
      loadCustomBadges({ includeInactive: false }),
      loadEmployeeBadgeAwards({ userId }),
      loadIssuedCertificates({ userId }),
    ])

  allAttempts.value = (quizData ?? []) as QuizAttempt[]
  passedAttempts.value = allAttempts.value.filter((r) => r.passed)
  passedMilestones.value = new Set(passedAttempts.value.map((r) => r.milestone))
  track.value = orderedTrack(assignedData.modules)
  completions.value = (compData ?? []) as VideoCompletion[]
  courses.value = assignedData.courses
  badgeCriteria.value = badgeRes.criteria
  customBadges.value = customRes.badges
  customBadgeAwards.value = awardsRes.awards
  issuedCertificates.value = issuedRes.certificates
  loading.value = false
})

const completedCourses = computed<CompletedCourseItem[]>(() => {
  if (!auth.profile) return []
  const list: CompletedCourseItem[] = []
  for (const c of courses.value) {
    const p = courseProgress(c, completions.value)
    if (p.status === 'completed') {
      list.push({
        course: c,
        progress: p,
        certData: buildCertificateData(c, p, auth.profile, completions.value),
      })
    }
  }
  return list
})

const issuedCertItems = computed<IssuedCertDisplayItem[]>(() => {
  if (!auth.profile) return []
  return issuedCertificates.value.map((cert) => ({
    cert,
    certData: issuedCertToCertificateData(cert, auth.profile!),
  }))
})

const awardedCustomBadges = computed<AwardedCustomBadgeItem[]>(() => {
  const badgeMap = new Map(customBadges.value.map((b) => [b.id, b]))
  const list: AwardedCustomBadgeItem[] = []
  for (const award of customBadgeAwards.value) {
    const badge = badgeMap.get(award.badgeId)
    if (!badge) continue
    list.push({
      award,
      badge,
      awardedDateLabel: new Date(award.awardedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    })
  }
  return list
})

const learnerMetrics = computed(() =>
  computeLearnerBadgeMetrics({
    courses: courses.value,
    completions: completions.value,
    passedAttempts: passedAttempts.value,
    extraCertificatesCount: issuedCertificates.value.length,
  }),
)

const badgeEvaluations = computed<BadgeEvaluation[]>(() =>
  evaluateAllBadges(badgeCriteria.value, learnerMetrics.value),
)

const unlockedBadgesCount = computed(() => badgeEvaluations.value.filter((b) => b.eligible).length)

const filteredBadgeEvaluations = computed(() => {
  if (badgeFilter.value === 'unlocked') return badgeEvaluations.value.filter((b) => b.eligible)
  if (badgeFilter.value === 'in_progress') return badgeEvaluations.value.filter((b) => !b.eligible)
  return badgeEvaluations.value
})

const milestoneBadgeCards = computed<MilestoneBadgeCard[]>(() => {
  const defs = [
    ...BADGE_TIERS.map((t) => ({ milestone: t.m, icon: t.icon, name: t.name })),
    { milestone: 'final', icon: '🏆', name: 'Captain Master' },
  ]
  const doneIds = new Set(completions.value.filter((c) => c.completed).map((c) => c.module_id))
  const passPctRequired = Math.round(PASS_THRESHOLD * 100)
  const passTargetCount = Math.ceil(QUESTIONS_PER_QUIZ * PASS_THRESHOLD)

  return defs.map((d) => {
    const isFinal = d.milestone === 'final'
    const chunk = moduleChunkForMilestone(track.value, d.milestone)
    const requiredLessons = isFinal ? track.value.length : QUESTIONS_PER_QUIZ
    const doneCount = chunk.filter((mod) => doneIds.has(mod.id)).length
    const lessonPct = requiredLessons > 0 ? Math.min(100, Math.round((doneCount / requiredLessons) * 100)) : 0
    const remainingLessonTitles = chunk.filter((mod) => !doneIds.has(mod.id)).map((mod) => mod.title)
    const quizLabel = milestoneLabel(d.milestone, track.value)

    const attemptsForM = allAttempts.value.filter((a) => a.milestone === d.milestone)
    const passedAttempt = [...attemptsForM].reverse().find((a) => a.passed) ?? null
    const unlocked = passedAttempt !== null || passedMilestones.value.has(d.milestone)

    const passedScorePct =
      passedAttempt && passedAttempt.total > 0
        ? Math.round((passedAttempt.score / passedAttempt.total) * 100)
        : unlocked
          ? passPctRequired
          : null

    const earnedDateLabel = passedAttempt
      ? new Date(passedAttempt.created_at).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : null

    const bestFailed = attemptsForM.reduce<QuizAttempt | null>((best, cur) => {
      const curRatio = cur.score / (cur.total || 1)
      const bestRatio = best ? best.score / (best.total || 1) : -1
      return curRatio > bestRatio ? cur : best
    }, null)

    const bestFailedScoreLabel = bestFailed
      ? `${bestFailed.score}/${bestFailed.total} (${Math.round((bestFailed.score / (bestFailed.total || 1)) * 100)}%)`
      : null

    const readyToAttempt = isFinal
      ? track.value.length > 0 && doneCount === track.value.length
      : chunk.length === QUESTIONS_PER_QUIZ && doneCount === QUESTIONS_PER_QUIZ

    const unlockSummary = isFinal
      ? `Completed all ${chunk.length || requiredLessons} curriculum lessons and passed the Final Assessment.`
      : `Completed ${chunk.length || QUESTIONS_PER_QUIZ} department lessons (Block ${d.milestone}) and passed ${quizLabel}.`

    return {
      milestone: d.milestone,
      icon: d.icon,
      name: d.name,
      unlocked,
      isFinal,
      quizLabel,
      chunkCount: chunk.length,
      requiredLessons,
      doneCount,
      lessonPct,
      remainingLessonTitles,
      passPctRequired,
      passTargetCount,
      passedAttempt,
      passedScorePct,
      earnedDateLabel,
      attemptsUsed: attemptsForM.length,
      bestFailedScoreLabel,
      readyToAttempt,
      unlockSummary,
    }
  })
})

function updateTooltipAlign(event: Event, milestone: string) {
  const el = event.currentTarget as HTMLElement | null
  if (!el || typeof window === 'undefined') return
  const rect = el.getBoundingClientRect()
  const halfTooltip = 145
  if (rect.left + rect.width / 2 < halfTooltip + 16) {
    tooltipAlign.value[milestone] = 'left'
  } else if (window.innerWidth - (rect.left + rect.width / 2) < halfTooltip + 16) {
    tooltipAlign.value[milestone] = 'right'
  } else {
    tooltipAlign.value[milestone] = 'center'
  }
}

function viewCertData(certData: CertificateData) {
  selectedCert.value = certData
}

async function quickDownloadCert(key: string, certData: CertificateData) {
  downloadingKey.value = key
  try {
    const config = await syncCertificateConfigFromServer()
    await downloadCertificatePdf(certData, config)
  } finally {
    downloadingKey.value = null
  }
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>Certificates &amp; badges</h2>
        <p>Your official verifiable credentials, milestone achievements, and badge eligibility progress.</p>
      </div>
    </div>

    <!-- Criteria Eligibility Metrics Strip -->
    <div class="metrics-strip">
      <div class="card metric-cell">
        <div class="lbl">Course completion duration</div>
        <div class="val tabular">{{ formatDurationMinutes(learnerMetrics.completedCourseDurationMinutes) }}</div>
        <div class="sub tabular">across completed courses ({{ formatDurationMinutes(learnerMetrics.watchedMinutes) }} watched)</div>
      </div>
      <div class="card metric-cell">
        <div class="lbl">Courses completed</div>
        <div class="val tabular">{{ learnerMetrics.coursesCompleted }}</div>
        <div class="sub tabular">of {{ courses.length }} available courses</div>
      </div>
      <div class="card metric-cell">
        <div class="lbl">Certificates earned</div>
        <div class="val tabular">{{ learnerMetrics.certificatesEarned }}</div>
        <div class="sub tabular">
          {{ learnerMetrics.courseCertificatesEarned }} course · {{ learnerMetrics.milestoneCertificatesEarned }} milestone quiz<template v-if="issuedCertificates.length"> · {{ issuedCertificates.length }} awarded</template>
        </div>
      </div>
    </div>

    <!-- Criteria-Based Milestone & Achievement Badges -->
    <section class="milestone-section" style="margin-bottom: 32px">
      <div class="row wrap" style="justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px">
        <div>
          <h3 style="font-size: 19px; color: var(--ink); margin-bottom: 2px">🏅 Milestone &amp; Achievement Badges</h3>
          <p class="sub">
            Eligibility is calculated from your completed course duration, courses completed, and certificates earned.
            <template v-if="!loading">
              · <b class="tabular">{{ unlockedBadgesCount }} / {{ badgeEvaluations.length }} unlocked</b>
            </template>
          </p>
        </div>
        <div class="seg">
          <button :class="{ on: badgeFilter === 'all' }" @click="badgeFilter = 'all'">All ({{ badgeEvaluations.length }})</button>
          <button :class="{ on: badgeFilter === 'unlocked' }" @click="badgeFilter = 'unlocked'">Unlocked ({{ unlockedBadgesCount }})</button>
          <button :class="{ on: badgeFilter === 'in_progress' }" @click="badgeFilter = 'in_progress'">
            In progress ({{ badgeEvaluations.length - unlockedBadgesCount }})
          </button>
        </div>
      </div>

      <div v-if="loading" class="sub">Evaluating badge eligibility…</div>
      <div v-else-if="!filteredBadgeEvaluations.length" class="card cert-empty-card">
        <b style="font-size: 14px; color: var(--ink)">
          {{ badgeFilter === 'unlocked' ? 'No milestone badges unlocked yet' : 'Every active milestone badge has been unlocked' }}
        </b>
        <p class="sub" style="margin: 6px auto 0; max-width: 440px">
          Complete courses and earn certificates to advance through your milestone badge tiers.
        </p>
      </div>
      <div v-else class="criteria-badge-grid">
        <div
          v-for="ev in filteredBadgeEvaluations"
          :key="ev.badge.id"
          class="card criteria-badge-card"
          :class="{ unlocked: ev.eligible }"
        >
          <div class="cb-head">
            <div class="cb-medal" :class="{ locked: !ev.eligible }" aria-hidden="true">{{ ev.badge.icon }}</div>
            <div class="grow">
              <div class="cb-status-row">
                <b class="cb-title">{{ ev.badge.name }}</b>
                <span class="cb-status tabular" :class="ev.eligible ? 'ok' : 'pending'">
                  {{ ev.eligible ? '✓ Unlocked' : `${ev.overallPct}%` }}
                </span>
              </div>
              <p v-if="ev.badge.description" class="sub" style="margin-top: 2px">{{ ev.badge.description }}</p>
            </div>
          </div>

          <div class="cb-rule-meta">
            {{ ev.badge.matchMode === 'all' ? 'All criteria required' : 'Meet any 1 criterion' }} ·
            <span class="tabular">{{ ev.metCount }} / {{ ev.totalChecks }} met</span>
          </div>

          <div class="cb-checks">
            <div v-for="chk in ev.checks" :key="chk.key" class="cb-check-item">
              <div class="cb-check-top">
                <span>{{ chk.label }}</span>
                <span class="tabular" :class="{ 'chk-met': chk.met }">
                  {{ chk.currentFormatted }} / {{ chk.targetFormatted }}
                </span>
              </div>
              <div class="progress" style="height: 6px">
                <span
                  :style="{
                    width: `${chk.pct}%`,
                    background: chk.met ? 'var(--teal)' : 'var(--blue)',
                  }"
                />
              </div>
            </div>
          </div>

          <div class="cb-foot sub">
            {{ ev.summaryHint }}
          </div>
        </div>
      </div>
    </section>

    <!-- Admin-Awarded Custom Badges Section (when awarded) -->
    <section v-if="awardedCustomBadges.length > 0" class="milestone-section" style="margin-bottom: 32px">
      <div class="row wrap" style="justify-content: space-between; align-items: baseline; margin-bottom: 14px">
        <div>
          <h3 style="font-size: 19px; color: var(--ink); margin-bottom: 2px">🌟 Special Recognition Badges</h3>
          <p class="sub">Custom badges awarded directly by your training administrator.</p>
        </div>
        <span class="sub tabular" style="font-weight: 700; color: var(--teal)">
          {{ awardedCustomBadges.length }} awarded
        </span>
      </div>

      <div class="criteria-badge-grid">
        <div
          v-for="item in awardedCustomBadges"
          :key="item.award.id"
          class="card criteria-badge-card unlocked"
        >
          <div class="cb-head">
            <div class="cb-medal" aria-hidden="true">{{ item.badge.icon }}</div>
            <div class="grow">
              <div class="cb-status-row">
                <b class="cb-title">{{ item.badge.name }}</b>
                <span class="cb-status ok">{{ item.badge.category }}</span>
              </div>
              <p v-if="item.badge.description" class="sub" style="margin-top: 2px">{{ item.badge.description }}</p>
            </div>
          </div>
          <div v-if="item.award.reason" class="award-reason-box">
            "{{ item.award.reason }}"
          </div>
          <div class="cb-foot sub">
            Awarded on {{ item.awardedDateLabel }}
          </div>
        </div>
      </div>
    </section>

    <!-- Admin-Issued Certificates Section (when issued) -->
    <section v-if="issuedCertItems.length > 0" class="cert-section" style="margin-bottom: 32px">
      <div class="row wrap" style="justify-content: space-between; align-items: baseline; margin-bottom: 14px">
        <div>
          <h3 style="font-size: 19px; color: var(--ink); margin-bottom: 2px">📜 Awarded Certificates</h3>
          <p class="sub">Official certificates issued directly by your administrator.</p>
        </div>
        <span class="sub tabular" style="font-weight: 700; color: var(--teal)">
          {{ issuedCertItems.length }} awarded
        </span>
      </div>

      <div class="course-cert-grid">
        <div
          v-for="item in issuedCertItems"
          :key="item.cert.id"
          class="card course-cert-card"
        >
          <div class="cert-card-header">
            <span class="cert-gold-icon">📜</span>
            <div class="grow">
              <span class="cert-cat-pill">{{ item.cert.category }}</span>
              <h4 class="cert-course-title">{{ item.cert.title }}</h4>
            </div>
          </div>

          <div class="cert-card-body">
            <p v-if="item.cert.description" class="sub" style="margin: 0 0 6px; line-height: 1.45">
              {{ item.cert.description }}
            </p>
            <div v-if="item.cert.totalLessons > 0 || item.cert.totalHours > 0" class="cert-meta-row">
              <span class="cert-meta-label">Credit:</span>
              <span class="cert-meta-val tabular">
                <template v-if="item.cert.totalLessons > 0">{{ item.cert.totalLessons }} Lessons</template>
                <template v-if="item.cert.totalLessons > 0 && item.cert.totalHours > 0"> · </template>
                <template v-if="item.cert.totalHours > 0">{{ item.cert.totalHours }}h</template>
              </span>
            </div>
            <div class="cert-meta-row">
              <span class="cert-meta-label">Issued On:</span>
              <span class="cert-meta-val">{{ item.certData.completedDate }}</span>
            </div>
            <div class="cert-meta-row">
              <span class="cert-meta-label">Credential ID:</span>
              <code class="cert-id-snippet">{{ item.certData.certificateId }}</code>
            </div>
          </div>

          <div class="cert-card-actions">
            <button
              class="btn btn-primary btn-sm grow"
              :disabled="downloadingKey === `issued:${item.cert.id}`"
              @click="quickDownloadCert(`issued:${item.cert.id}`, item.certData)"
            >
              <span v-if="downloadingKey === `issued:${item.cert.id}`">⏳ Generating…</span>
              <span v-else>📥 Download PDF</span>
            </button>
            <button class="btn btn-ghost btn-sm" @click="viewCertData(item.certData)">
              👁️ View
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Course Completion Certificates Section (100% Completed Courses) -->
    <section class="cert-section" style="margin-bottom: 32px">
      <div class="row wrap" style="justify-content: space-between; align-items: baseline; margin-bottom: 14px">
        <div>
          <h3 style="font-size: 19px; color: var(--ink); margin-bottom: 2px">🎓 Course Completion Certificates</h3>
          <p class="sub">Automatically earned when you finish 100% of a course's lessons.</p>
        </div>
        <span v-if="!loading" class="sub tabular" style="font-weight: 700; color: var(--teal)">
          {{ completedCourses.length }} earned
        </span>
      </div>

      <div v-if="loading" class="sub">Loading your credentials…</div>

      <div v-else-if="completedCourses.length > 0" class="course-cert-grid">
        <div
          v-for="item in completedCourses"
          :key="item.course.id"
          class="card course-cert-card"
        >
          <div class="cert-card-header" :style="{ borderTopColor: item.course.color }">
            <span class="cert-gold-icon">🏆</span>
            <div class="grow">
              <span class="cert-cat-pill">{{ item.course.category }}</span>
              <h4 class="cert-course-title">{{ item.course.title }}</h4>
            </div>
          </div>

          <div class="cert-card-body">
            <div class="cert-meta-row">
              <span class="cert-meta-label">Curriculum:</span>
              <span class="cert-meta-val tabular">{{ item.progress.total }} Lessons (100% Done)</span>
            </div>
            <div class="cert-meta-row">
              <span class="cert-meta-label">Issued On:</span>
              <span class="cert-meta-val">{{ item.certData.completedDate }}</span>
            </div>
            <div class="cert-meta-row">
              <span class="cert-meta-label">Credential ID:</span>
              <code class="cert-id-snippet">{{ item.certData.certificateId }}</code>
            </div>
          </div>

          <div class="cert-card-actions">
            <button
              class="btn btn-primary btn-sm grow"
              :disabled="downloadingKey === `course:${item.course.id}`"
              @click="quickDownloadCert(`course:${item.course.id}`, item.certData)"
            >
              <span v-if="downloadingKey === `course:${item.course.id}`">⏳ Generating…</span>
              <span v-else>📥 Download PDF</span>
            </button>
            <button class="btn btn-ghost btn-sm" @click="viewCertData(item.certData)">
              👁️ View
            </button>
          </div>
        </div>
      </div>

      <div v-else class="card cert-empty-card">
        <div style="font-size: 32px; margin-bottom: 8px">📜</div>
        <b style="font-size: 15px; color: var(--ink)">No course certificates earned yet</b>
        <p class="sub" style="max-width: 480px; margin: 6px auto 14px">
          Complete 100% of all lessons in any course from the Course Catalog to automatically unlock and download your official PDF Certificate of Completion.
        </p>
        <RouterLink to="/app/catalog" class="btn btn-primary btn-sm">
          Browse Course Catalog →
        </RouterLink>
      </div>
    </section>

    <!-- Milestone Quiz Badges Section -->
    <section>
      <div style="margin-bottom: 12px">
        <h3 style="font-size: 19px; color: var(--ink); margin-bottom: 2px">🎖️ Milestone Quiz Badges</h3>
        <p class="sub">Hover any badge to inspect unlock requirements or how you earned it.</p>
      </div>

      <div class="badge-grid">
        <div
          v-for="mb in milestoneBadgeCards"
          :key="mb.milestone"
          class="badge-tile-wrap"
          @mouseenter="updateTooltipAlign($event, mb.milestone)"
          @focusin="updateTooltipAlign($event, mb.milestone)"
        >
          <RouterLink
            v-if="mb.unlocked"
            :to="`/app/certificate/${mb.milestone}`"
            class="card badge-tile unlocked"
            :aria-label="`${mb.name} — Unlocked. ${mb.unlockSummary}`"
          >
            <div class="badge-medal">{{ mb.icon }}</div>
            <div class="bname">{{ mb.name }}</div>
          </RouterLink>
          <div
            v-else
            tabindex="0"
            class="card badge-tile locked"
            :aria-label="`${mb.name} — Locked. Complete lessons and pass ${mb.quizLabel} to unlock.`"
          >
            <div class="badge-medal">{{ mb.icon }}</div>
            <div class="bname">{{ mb.name }}</div>
          </div>

          <div
            class="badge-tooltip"
            :class="`align-${tooltipAlign[mb.milestone] ?? 'center'}`"
            role="tooltip"
          >
            <div class="bt-head">
              <b>{{ mb.icon }} {{ mb.name }}</b>
              <span class="bt-state tabular" :class="mb.unlocked ? 'ok' : 'locked'">
                {{ mb.unlocked ? '✓ Unlocked' : '🔒 Locked' }}
              </span>
            </div>

            <template v-if="mb.unlocked">
              <p class="bt-desc">{{ mb.unlockSummary }}</p>
              <div class="bt-facts">
                <div v-if="mb.passedAttempt" class="bt-row">
                  <span>Passing score</span>
                  <b class="tabular">
                    {{ mb.passedAttempt.score }}/{{ mb.passedAttempt.total }} ({{ mb.passedScorePct }}%)
                  </b>
                </div>
                <div v-if="mb.passedAttempt" class="bt-row">
                  <span>Attempt</span>
                  <b class="tabular">#{{ mb.passedAttempt.attempt_number }}</b>
                </div>
                <div v-if="mb.earnedDateLabel" class="bt-row">
                  <span>Unlocked on</span>
                  <b>{{ mb.earnedDateLabel }}</b>
                </div>
              </div>
              <div class="bt-foot ok">Click badge to view certificate →</div>
            </template>

            <template v-else>
              <p class="bt-desc">To unlock this badge:</p>
              <div class="bt-steps">
                <div class="bt-step">
                  <template v-if="!mb.isFinal && mb.chunkCount < mb.requiredLessons">
                    <span>
                      1. Requires <b class="tabular">{{ mb.requiredLessons }}</b> department lessons in Block {{ mb.milestone }}
                      (<span class="tabular">{{ mb.chunkCount }}/{{ mb.requiredLessons }}</span> published).
                    </span>
                  </template>
                  <template v-else-if="mb.requiredLessons === 0">
                    <span>1. Complete all assigned curriculum lessons.</span>
                  </template>
                  <template v-else>
                    <div class="bt-row">
                      <span>1. Complete {{ mb.isFinal ? 'all track' : `Block ${mb.milestone}` }} lessons</span>
                      <b class="tabular">{{ mb.doneCount }}/{{ mb.requiredLessons }}</b>
                    </div>
                    <div class="progress bt-bar">
                      <span
                        :style="{
                          width: `${mb.lessonPct}%`,
                          background: mb.doneCount >= mb.requiredLessons ? 'var(--teal)' : 'var(--blue)',
                        }"
                      />
                    </div>
                    <div v-if="mb.remainingLessonTitles.length" class="bt-next">
                      Next: {{ mb.remainingLessonTitles.slice(0, 2).join(', ')
                      }}{{ mb.remainingLessonTitles.length > 2 ? ` (+${mb.remainingLessonTitles.length - 2} more)` : '' }}
                    </div>
                  </template>
                </div>

                <div class="bt-step">
                  2. Pass <b>{{ mb.quizLabel }}</b> with ≥<b class="tabular">{{ mb.passPctRequired }}%</b>
                  (<span class="tabular">{{ mb.passTargetCount }}/{{ QUESTIONS_PER_QUIZ }}</span>).
                </div>
              </div>

              <div v-if="mb.readyToAttempt" class="bt-foot ready">
                ✓ Lessons complete — ready to take quiz!
              </div>
              <div v-else-if="mb.attemptsUsed > 0 && mb.bestFailedScoreLabel" class="bt-foot muted tabular">
                Best attempt: {{ mb.bestFailedScoreLabel }} · {{ mb.attemptsUsed }} used
              </div>
            </template>
          </div>
        </div>
      </div>
    </section>

    <CertificateModal
      v-if="selectedCert"
      :certificate="selectedCert"
      @close="selectedCert = null"
    />
  </div>
</template>

<style scoped>
.tabular {
  font-variant-numeric: tabular-nums;
}
.metrics-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 24px;
}
@media (max-width: 760px) {
  .metrics-strip {
    grid-template-columns: 1fr;
  }
}
.metric-cell {
  padding: 16px 18px;
}
.metric-cell .lbl {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--ink-soft);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.metric-cell .val {
  font-size: 28px;
  font-weight: 800;
  margin: 4px 0 2px;
  color: var(--ink);
}
.criteria-badge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.criteria-badge-card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.criteria-badge-card.unlocked {
  border-color: var(--teal);
}
.cb-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.cb-medal {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  font-size: 22px;
  background: var(--brass-soft);
  border: 1px solid var(--border);
  flex: none;
}
.cb-medal.locked {
  background: var(--surface-sunken);
  filter: grayscale(1);
  opacity: 0.65;
}
.cb-status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.cb-title {
  font-size: 15px;
  color: var(--ink);
}
.cb-status {
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.cb-status.ok {
  color: var(--teal);
}
.cb-status.pending {
  color: var(--accent-text);
}
.cb-rule-meta {
  font-size: 12px;
  color: var(--ink-soft);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.cb-checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cb-check-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cb-check-top {
  display: flex;
  justify-content: space-between;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.chk-met {
  color: var(--teal);
  font-weight: 700;
}
.cb-foot {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.award-reason-box {
  font-size: 12.5px;
  font-style: italic;
  color: var(--ink);
  background: var(--surface-sunken);
  border-left: 3px solid var(--teal);
  border-radius: 6px;
  padding: 8px 10px;
  line-height: 1.45;
}
.course-cert-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 16px;
}

.course-cert-card {
  padding: 18px;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(212, 175, 55, 0.28);
  background: linear-gradient(175deg, rgba(212, 175, 55, 0.05), var(--surface));
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.course-cert-card:hover {
  transform: translateY(-2px);
  border-color: rgba(212, 175, 55, 0.45);
  box-shadow: 0 10px 24px -6px rgba(0, 0, 0, 0.4);
}

.cert-card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.cert-gold-icon {
  font-size: 26px;
  line-height: 1;
}

.cert-cat-pill {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #d4af37;
  display: block;
  margin-bottom: 3px;
}

.cert-course-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
  line-height: 1.3;
}

.cert-card-body {
  font-size: 12px;
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cert-meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cert-meta-label {
  color: var(--ink-soft);
}

.cert-meta-val {
  color: var(--ink);
  font-weight: 500;
}

.cert-id-snippet {
  font-family: monospace;
  font-size: 10.5px;
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 6px;
  border-radius: 4px;
  color: #cbd5e1;
}

.cert-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}

.cert-empty-card {
  padding: 32px 20px;
  text-align: center;
  border: 1px dashed rgba(255, 255, 255, 0.14);
}

.badge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;
}

.badge-tile-wrap {
  position: relative;
}

.badge-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px 12px;
  text-align: center;
  transition: transform 0.15s ease, border-color 0.15s ease;
  text-decoration: none;
  height: 100%;
}

.badge-tile.unlocked {
  cursor: pointer;
}

.badge-tile.locked {
  cursor: help;
}

.badge-tile:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.badge-tile-wrap:hover .badge-tile,
.badge-tile-wrap:focus-within .badge-tile {
  transform: translateY(-2px);
  border-color: var(--brass);
}

.badge-tile.locked .badge-medal,
.badge-tile.locked .bname {
  opacity: 0.45;
  filter: grayscale(1);
}

.badge-medal {
  font-size: 32px;
  margin-bottom: 6px;
}

.bname {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.badge-tooltip {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  width: 276px;
  max-width: min(276px, 84vw);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.28);
  text-align: left;
  z-index: 40;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.15s ease, transform 0.15s ease, visibility 0.15s ease;
}

.badge-tooltip.align-left {
  left: 0;
  transform: translateX(0) translateY(4px);
}

.badge-tooltip.align-right {
  left: auto;
  right: 0;
  transform: translateX(0) translateY(4px);
}

.badge-tile-wrap:hover .badge-tooltip,
.badge-tile-wrap:focus-within .badge-tooltip {
  opacity: 1;
  visibility: visible;
  transform: translateX(-50%) translateY(0);
}

.badge-tile-wrap:hover .badge-tooltip.align-left,
.badge-tile-wrap:focus-within .badge-tooltip.align-left,
.badge-tile-wrap:hover .badge-tooltip.align-right,
.badge-tile-wrap:focus-within .badge-tooltip.align-right {
  transform: translateX(0) translateY(0);
}

.bt-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  color: var(--ink);
}

.bt-state {
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}

.bt-state.ok {
  color: var(--teal);
}

.bt-state.locked {
  color: var(--ink-soft);
}

.bt-desc {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink-soft);
}

.bt-facts,
.bt-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--ink);
}

.bt-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.bt-row span {
  color: var(--ink-soft);
}

.bt-step {
  font-size: 12px;
  line-height: 1.4;
  color: var(--ink-soft);
}

.bt-step b {
  color: var(--ink);
}

.bt-bar {
  height: 5px;
  margin-top: 4px;
}

.bt-next {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--ink-soft);
  line-height: 1.35;
}

.bt-foot {
  margin-top: 9px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 600;
}

.bt-foot.ok,
.bt-foot.ready {
  color: var(--teal);
}

.bt-foot.muted {
  color: var(--ink-soft);
  font-weight: 500;
}
</style>
