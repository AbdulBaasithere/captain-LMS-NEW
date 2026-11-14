<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { loadCourses, courseProgress, type CourseVM, type CourseProgress } from '@/lib/courses'
import { buildCertificateData, downloadCertificatePdf, type CertificateData } from '@/lib/certificate'
import { syncCertificateConfigFromServer } from '@/lib/certificateConfig'
import CertificateModal from '@/components/CertificateModal.vue'
import type { Module, VideoCompletion } from '@/lib/database.types'

const BADGE_TIERS = [
  { m: '1', icon: '🥉', name: 'Bronze' },
  { m: '2', icon: '🥈', name: 'Silver' },
  { m: '3', icon: '🥇', name: 'Gold' },
  { m: '4', icon: '💎', name: 'Diamond' },
  { m: '5', icon: '💎', name: 'Diamond II' },
]

const auth = useAuthStore()
const passedMilestones = ref<Set<string>>(new Set())
const courses = ref<CourseVM[]>([])
const completions = ref<VideoCompletion[]>([])
const loading = ref(true)

const selectedCert = ref<CertificateData | null>(null)
const downloadingCourseId = ref<string | number | null>(null)

interface CompletedCourseItem {
  course: CourseVM
  progress: CourseProgress
  certData: CertificateData
}

onMounted(async () => {
  if (!auth.profile) return
  const dept = auth.profile.department
  const userId = auth.profile.id

  const [, { data: quizData }, { data: modData }, { data: compData }] = await Promise.all([
    syncCertificateConfigFromServer(),
    supabase.from('quiz_attempts').select('milestone, passed').eq('user_id', userId).eq('passed', true),
    supabase.from('modules').select('*').or(`department.eq.General,department.eq.${dept}`).order('id'),
    supabase.from('video_completions').select('*').eq('user_id', userId),
  ])

  passedMilestones.value = new Set((quizData ?? []).map((r) => r.milestone))
  completions.value = (compData ?? []) as VideoCompletion[]
  courses.value = (await loadCourses((modData ?? []) as Module[])).filter((c) => c.lessons.length > 0)
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

function viewCert(item: CompletedCourseItem) {
  selectedCert.value = item.certData
}

async function quickDownload(item: CompletedCourseItem) {
  downloadingCourseId.value = item.course.id
  try {
    const config = await syncCertificateConfigFromServer()
    await downloadCertificatePdf(item.certData, config)
  } finally {
    downloadingCourseId.value = null
  }
}
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>Certificates & badges</h2>
        <p>Your official verifiable credentials and achievement milestones.</p>
      </div>
    </div>

    <!-- Course Completion Certificates Section (100% Completed Courses) -->
    <section class="cert-section" style="margin-bottom: 32px">
      <div class="row wrap" style="justify-content: space-between; align-items: baseline; margin-bottom: 14px">
        <div>
          <h3 style="font-size: 19px; color: var(--ink); margin-bottom: 2px">🎓 Course Completion Certificates</h3>
          <p class="sub">Automatically earned when you finish 100% of a course's lessons.</p>
        </div>
        <span v-if="!loading" class="pill pill-teal" style="font-size: 12px">
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
              <span class="cert-meta-val">{{ item.progress.total }} Lessons (100% Done)</span>
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
              :disabled="downloadingCourseId === item.course.id"
              @click="quickDownload(item)"
            >
              <span v-if="downloadingCourseId === item.course.id">⏳ Generating…</span>
              <span v-else>📥 Download PDF</span>
            </button>
            <button class="btn btn-ghost btn-sm" @click="viewCert(item)">
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
        <p class="sub">Earned by passing milestone quizzes across the learning curriculum.</p>
      </div>

      <div class="badge-grid">
        <template v-for="t in BADGE_TIERS" :key="t.m">
          <RouterLink v-if="passedMilestones.has(t.m)" :to="`/app/certificate/${t.m}`" class="card badge-tile" style="cursor: pointer">
            <div class="badge-medal">{{ t.icon }}</div>
            <div class="bname">{{ t.name }}</div>
          </RouterLink>
          <div v-else class="card badge-tile locked">
            <div class="badge-medal">{{ t.icon }}</div>
            <div class="bname">{{ t.name }}</div>
          </div>
        </template>
        <RouterLink v-if="passedMilestones.has('final')" to="/app/certificate/final" class="card badge-tile" style="cursor: pointer">
          <div class="badge-medal">🏆</div>
          <div class="bname">Captain Master</div>
        </RouterLink>
        <div v-else class="card badge-tile locked">
          <div class="badge-medal">🏆</div>
          <div class="bname">Captain Master</div>
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

.badge-tile {
  padding: 20px 12px;
  text-align: center;
  transition: all 0.15s ease;
  text-decoration: none;
}

.badge-tile:hover {
  transform: translateY(-2px);
  border-color: var(--brass);
}

.badge-tile.locked {
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
</style>
