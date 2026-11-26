<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import { isActive, initialsOf } from '@/lib/employees'
import { loadDepartments } from '@/lib/departments'
import {
  getCertificateConfig,
  mergeCertificateConfig,
  saveCertificateConfigToServer,
  resetCertificateConfig,
  syncCertificateConfigFromServer,
  DEFAULT_CUSTOM_PDF_CONFIG,
  type CertificateCustomization,
  type CustomPdfTemplateConfig,
} from '@/lib/certificateConfig'
import {
  downloadCertificatePdf,
  getCertificatePdfBlobUrl,
  type CertificateData,
} from '@/lib/certificate'
import {
  decodeBase64ToPdfBytes,
  encodePdfBytesToBase64,
  inspectPdfTemplate,
} from '@/lib/pdfTemplateStamp'
import {
  loadIssuedCertificates,
  issueCertificateToEmployees,
  revokeIssuedCertificate,
  issuedCertToCertificateData,
  type IssuedCertificate,
} from '@/lib/issuedCertificates'
import CertificatePdfAligner from '@/components/CertificatePdfAligner.vue'
import CertificateModal from '@/components/CertificateModal.vue'
import type { Course, Profile } from '@/lib/database.types'

const MAX_PDF_BYTES = 3 * 1024 * 1024 // 3 MB limit for reliable JSONB + fallback persistence

const route = useRoute()
const auth = useAuthStore()
const activeTab = ref<'issue' | 'template'>(route.query.tab === 'template' ? 'template' : 'issue')
const form = reactive<CertificateCustomization>(getCertificateConfig())

const loadingRemote = ref(true)
const saving = ref(false)
const toastMessage = ref<string | null>(null)
const toastKind = ref<'success' | 'warn'>('success')
const uploadError = ref<string | null>(null)
const uploadInfo = ref<{ pageCount: number; widthPt: number; heightPt: number } | null>(null)
const testDownloading = ref(false)
const confirmReset = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)

const previewUrl = ref<string | null>(null)
const previewLoading = ref(false)
const previewError = ref<string | null>(null)
let previewTimer: ReturnType<typeof setTimeout> | null = null

const usesCustomPdf = computed(
  () => Boolean(form.customPdf.enabled && form.customPdf.pdfBase64),
)

type OverlayFieldKey = keyof CustomPdfTemplateConfig['fields']

const selectedOverlayField = ref<OverlayFieldKey>('recipientName')
const previewMode = ref<'aligner' | 'pdf'>('aligner')
const showSampleEditor = ref(false)

const overlayFieldMeta: { key: OverlayFieldKey; label: string; hint: string }[] = [
  { key: 'recipientName', label: 'Employee Full Name', hint: 'Stamped in large bold italic serif' },
  { key: 'courseTitle', label: 'Course Title', hint: 'Completed course or milestone name' },
  { key: 'completedDate', label: 'Completion Date', hint: 'Formatted issue date (e.g. November 12, 2026)' },
  { key: 'certificateId', label: 'Verification ID', hint: 'Unique certificate ID (e.g. ID: CAP-2026-...)' },
  { key: 'department', label: 'Department Label', hint: 'Optional employee department line' },
]

// Live editable sample data for aligning text directly on the certificate
const sampleCertData = reactive<CertificateData>({
  userName: 'Alexander Morgan',
  userDepartment: 'Operations & Safety',
  courseTitle: 'Enterprise Leadership & Compliance',
  courseCategory: 'Executive Development',
  completedDate: new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
  certificateId: 'CAP-2026-8F2A-94B1',
  totalLessons: 8,
  totalMinutes: 145,
})

function showToast(msg: string, kind: 'success' | 'warn' = 'success') {
  toastMessage.value = msg
  toastKind.value = kind
  setTimeout(() => {
    if (toastMessage.value === msg) {
      toastMessage.value = null
    }
  }, 5000)
}

function cloneFields(): CustomPdfTemplateConfig['fields'] {
  return {
    recipientName: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.recipientName },
    courseTitle: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.courseTitle },
    completedDate: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.completedDate },
    certificateId: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.certificateId },
    department: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.department },
  }
}

function assignConfig(next: CertificateCustomization) {
  const merged = mergeCertificateConfig(next)
  Object.assign(form, merged)
}

function revokePreviewUrl() {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = null
  }
}

async function refreshPdfPreview() {
  if (!usesCustomPdf.value) {
    revokePreviewUrl()
    previewError.value = null
    return
  }
  previewLoading.value = true
  previewError.value = null
  try {
    const nextUrl = await getCertificatePdfBlobUrl(sampleCertData, form)
    revokePreviewUrl()
    previewUrl.value = nextUrl
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : 'Unable to generate PDF preview.'
  } finally {
    previewLoading.value = false
  }
}

function schedulePreviewRefresh() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    void refreshPdfPreview()
  }, 240)
}

async function inspectExistingPdf() {
  if (!form.customPdf.pdfBase64) {
    uploadInfo.value = null
    return
  }
  try {
    const bytes = decodeBase64ToPdfBytes(form.customPdf.pdfBase64)
    const info = await inspectPdfTemplate(bytes)
    if (info.valid) {
      uploadInfo.value = {
        pageCount: info.pageCount,
        widthPt: info.widthPt,
        heightPt: info.heightPt,
      }
    }
  } catch {
    uploadInfo.value = null
  }
}

// ---- Admin-created & issued certificates state ----
const issuedList = ref<IssuedCertificate[]>([])
const issuedTableMissing = ref(false)
const loadingIssued = ref(true)
const profiles = ref<Profile[]>([])
const coursesList = ref<Course[]>([])
const departments = ref<string[]>(['All'])

const issueSearch = ref('')
const issueDeptFilter = ref('All')
const recipientFilterDept = ref('All')
const recipientSearch = ref('')
const selectedRecipientIds = ref<string[]>([])
const issuing = ref(false)
const revokingCertId = ref<number | null>(null)
const issueError = ref('')
const previewCertData = ref<CertificateData | null>(null)

const issueForm = reactive({
  title: '',
  category: 'Special Recognition',
  description: '',
  issuedDate: new Date().toISOString().slice(0, 10),
  totalHours: 2,
  totalLessons: 1,
  courseId: '' as string | number,
})

const activeEmployees = computed(() =>
  profiles.value.filter((p) => isActive(p) && p.role === 'employee'),
)

const profilesById = computed(() => {
  const m = new Map<string, Profile>()
  for (const p of profiles.value) m.set(p.id, p)
  return m
})

const filteredRecipientPool = computed(() => {
  const q = recipientSearch.value.trim().toLowerCase()
  return activeEmployees.value.filter((p) => {
    if (recipientFilterDept.value !== 'All' && p.department !== recipientFilterDept.value) return false
    if (q) {
      return p.full_name.toLowerCase().includes(q) || p.department.toLowerCase().includes(q)
    }
    return true
  })
})

const filteredIssuedList = computed(() => {
  const q = issueSearch.value.trim().toLowerCase()
  return issuedList.value.filter((c) => {
    const rec = profilesById.value.get(c.userId)
    if (issueDeptFilter.value !== 'All' && rec?.department !== issueDeptFilter.value) return false
    if (q) {
      const matchTitle = c.title.toLowerCase().includes(q)
      const matchCode = c.certificateCode.toLowerCase().includes(q)
      const matchName = rec?.full_name.toLowerCase().includes(q) ?? false
      if (!matchTitle && !matchCode && !matchName) return false
    }
    return true
  })
})

function onCourseLinkChange() {
  if (!issueForm.courseId) return
  const c = coursesList.value.find((item) => item.id === Number(issueForm.courseId))
  if (c) {
    if (!issueForm.title.trim()) issueForm.title = c.title
    issueForm.category = c.category
  }
}

function toggleRecipient(uid: string) {
  if (selectedRecipientIds.value.includes(uid)) {
    selectedRecipientIds.value = selectedRecipientIds.value.filter((id) => id !== uid)
  } else {
    selectedRecipientIds.value = [...selectedRecipientIds.value, uid]
  }
}

function selectAllVisibleRecipients() {
  const visibleIds = filteredRecipientPool.value.map((p) => p.id)
  const merged = new Set([...selectedRecipientIds.value, ...visibleIds])
  selectedRecipientIds.value = [...merged]
}

function clearSelectedRecipients() {
  selectedRecipientIds.value = []
}

async function loadIssuedData() {
  loadingIssued.value = true
  const [certRes, { data: profData }, { data: courseData }, depts] = await Promise.all([
    loadIssuedCertificates(),
    supabase.from('profiles').select('*').order('full_name'),
    supabase.from('courses').select('*').order('title'),
    loadDepartments(),
  ])
  issuedList.value = certRes.certificates
  issuedTableMissing.value = certRes.tableMissing
  profiles.value = (profData ?? []) as Profile[]
  coursesList.value = (courseData ?? []) as Course[]
  departments.value = ['All', 'General', ...depts.map((d) => d.name)]
  loadingIssued.value = false
}

async function submitIssueCertificate() {
  issueError.value = ''
  if (!issueForm.title.trim()) {
    issueError.value = 'Enter a certificate title.'
    return
  }
  if (selectedRecipientIds.value.length === 0) {
    issueError.value = 'Select at least one employee to receive this certificate.'
    return
  }

  issuing.value = true
  const result = await issueCertificateToEmployees(
    {
      title: issueForm.title,
      category: issueForm.category,
      description: issueForm.description,
      issuedDate: issueForm.issuedDate,
      totalHours: issueForm.totalHours,
      totalLessons: issueForm.totalLessons,
      courseId: issueForm.courseId ? Number(issueForm.courseId) : null,
    },
    selectedRecipientIds.value,
    auth.profile?.id,
  )
  issuing.value = false

  if (!result.ok) {
    issueError.value = result.error ?? 'Could not create certificate.'
    return
  }

  await logActivity(
    auth.profile?.id,
    `Issued certificate "${issueForm.title.trim()}" to ${result.issued.length} employee(s)`,
  )

  showToast(
    result.error ?? `Certificate "${issueForm.title.trim()}" issued to ${result.issued.length} employee(s)!`,
    result.syncedRemote ? 'success' : 'warn',
  )
  issueForm.title = ''
  issueForm.description = ''
  issueForm.courseId = ''
  selectedRecipientIds.value = []
  await loadIssuedData()
}

function openIssuedPreview(cert: IssuedCertificate) {
  const rec = profilesById.value.get(cert.userId)
  previewCertData.value = issuedCertToCertificateData(cert, {
    full_name: rec?.full_name ?? 'Employee',
    email: rec?.email,
    department: rec?.department,
  })
}

async function handleRevokeCertificate(cert: IssuedCertificate) {
  const rec = profilesById.value.get(cert.userId)
  const label = rec ? `${cert.title} for ${rec.full_name}` : cert.title
  if (!window.confirm(`Revoke certificate "${label}"?\n\nThis removes the certificate from the employee's credentials.`)) {
    return
  }
  revokingCertId.value = cert.id
  const res = await revokeIssuedCertificate(cert.id)
  revokingCertId.value = null
  if (!res.ok) {
    showToast(res.error ?? 'Could not revoke certificate.', 'warn')
    return
  }
  await logActivity(auth.profile?.id, `Revoked issued certificate "${label}"`)
  showToast(`Revoked "${label}".`)
  await loadIssuedData()
}

onMounted(async () => {
  try {
    const [synced] = await Promise.all([syncCertificateConfigFromServer(), loadIssuedData()])
    assignConfig(synced)
    await inspectExistingPdf()
    await refreshPdfPreview()
  } finally {
    loadingRemote.value = false
  }
})

watch(
  [() => form.customPdf, () => sampleCertData.userName, () => sampleCertData.courseTitle, () => sampleCertData.userDepartment],
  () => {
    schedulePreviewRefresh()
  },
  { deep: true },
)

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
  revokePreviewUrl()
})

async function handleTemplateFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  uploadError.value = null
  if (!file) return

  const lower = file.name.toLowerCase()
  if (lower.endsWith('.ppt') || lower.endsWith('.pptx')) {
    uploadError.value =
      'PowerPoint files (.ppt/.pptx) lose custom fonts and shapes in browser renderers. Please choose File → Save As / Export → PDF in PowerPoint (or Canva / Google Slides) and upload that .pdf file here.'
    input.value = ''
    return
  }

  if (!lower.endsWith('.pdf') && file.type !== 'application/pdf') {
    uploadError.value = 'Please select a valid .pdf certificate template file.'
    input.value = ''
    return
  }

  if (file.size > MAX_PDF_BYTES) {
    uploadError.value = `File is ${(file.size / (1024 * 1024)).toFixed(2)} MB. Maximum supported template size is 3.0 MB.`
    input.value = ''
    return
  }

  try {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const info = await inspectPdfTemplate(bytes)
    if (!info.valid) {
      uploadError.value = info.error || 'Could not read this PDF file. Please export a standard unencrypted PDF.'
      input.value = ''
      return
    }

    const base64 = encodePdfBytesToBase64(bytes)
    form.customPdf.enabled = true
    form.customPdf.fileName = file.name
    form.customPdf.pdfBase64 = base64
    uploadInfo.value = {
      pageCount: info.pageCount,
      widthPt: info.widthPt,
      heightPt: info.heightPt,
    }
    showToast(`Loaded "${file.name}". Adjust field positions if needed, then click Save Changes!`)
  } catch (err) {
    uploadError.value = err instanceof Error ? err.message : 'Failed to process PDF template.'
  } finally {
    input.value = ''
  }
}

function removeCustomPdfTemplate() {
  form.customPdf.enabled = false
  form.customPdf.fileName = null
  form.customPdf.pdfBase64 = null
  uploadInfo.value = null
  uploadError.value = null
  revokePreviewUrl()
}

function resetOverlayFields() {
  form.customPdf.fields = cloneFields()
}

async function onSave() {
  saving.value = true
  try {
    const snapshot = mergeCertificateConfig(JSON.parse(JSON.stringify(form)) as CertificateCustomization)
    const res = await saveCertificateConfigToServer(snapshot, auth.profile?.id)
    if (res.syncedRemote) {
      showToast(
        snapshot.customPdf.enabled
          ? 'Saved! Your uploaded PDF template is now active for ALL certificates across the LMS.'
          : 'Certificate template & details saved and synced for all employees!',
      )
    } else {
      showToast(
        'Saved in this browser. Run the certificate_settings SQL migration in Supabase to sync across all employee devices.',
        'warn',
      )
    }
  } finally {
    saving.value = false
  }
}

async function onReset() {
  if (!confirmReset.value) {
    confirmReset.value = true
    setTimeout(() => {
      confirmReset.value = false
    }, 4000)
    return
  }
  confirmReset.value = false
  const def = resetCertificateConfig()
  assignConfig(def)
  uploadInfo.value = null
  uploadError.value = null
  revokePreviewUrl()
  await saveCertificateConfigToServer(def, auth.profile?.id)
  showToast('Certificate settings reset to defaults.')
}

async function downloadSamplePdf() {
  testDownloading.value = true
  try {
    await downloadCertificatePdf(sampleCertData, form)
  } finally {
    testDownloading.value = false
  }
}
</script>

<template>
  <div class="cert-admin-page">
    <div class="topline">
      <div>
        <h2>Certificates</h2>
        <p>
          Create and issue custom certificates directly to employees, or customize your organization's certificate template.
        </p>
      </div>

      <div v-if="activeTab === 'template'" class="row wrap" style="gap: 8px">
        <button class="btn btn-ghost btn-sm" @click="onReset">
          {{ confirmReset ? '⚠️ Click Again to Confirm Reset' : '↺ Reset Defaults' }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="testDownloading || !usesCustomPdf" @click="downloadSamplePdf">
          <span v-if="!testDownloading">📥 Sample PDF</span>
          <span v-else>⏳ Generating…</span>
        </button>
        <button class="btn btn-primary btn-sm" :disabled="saving" @click="onSave">
          <span v-if="saving">⏳ Saving…</span>
          <span v-else>💾 Save Changes</span>
        </button>
      </div>
    </div>

    <div class="seg" style="margin-bottom: 18px">
      <button :class="{ on: activeTab === 'issue' }" @click="activeTab = 'issue'">
        📜 Create &amp; Issue Certificates ({{ issuedList.length }})
      </button>
      <button :class="{ on: activeTab === 'template' }" @click="activeTab = 'template'">
        🎨 Template &amp; PDF Settings
      </button>
    </div>

    <!-- Toast notification -->
    <div v-if="toastMessage" class="save-toast" :class="{ warn: toastKind === 'warn' }">
      <span>{{ toastKind === 'warn' ? '⚠️' : '✓' }}</span>
      <span>{{ toastMessage }}</span>
    </div>

    <!-- TAB 1: Create & Issue Custom Certificates -->
    <template v-if="activeTab === 'issue'">
      <div v-if="issuedTableMissing" class="card notice-bar">
        <strong>Database migration pending:</strong>
        <span>
          Run <code>supabase/migrations/20261116_admin_certificates_badges_assignments.sql</code> in Supabase SQL Editor to store
          admin-issued certificates globally across devices.
        </span>
      </div>

      <div class="issue-layout">
        <!-- Create & Issue Form -->
        <div class="card issue-form-card">
          <div style="margin-bottom: 14px">
            <h3 style="font-size: 17px; margin-bottom: 4px">Create &amp; Issue Certificate</h3>
            <p class="sub" style="margin: 0">
              Creates an official verifiable certificate using your active template and delivers it to selected employees.
            </p>
          </div>

          <div class="field">
            <label>Certificate title *</label>
            <input v-model="issueForm.title" type="text" placeholder="e.g. Leadership Excellence Award" />
          </div>

          <div class="issue-two-col">
            <div class="field">
              <label>Category / Track label</label>
              <input v-model="issueForm.category" type="text" placeholder="e.g. Special Recognition" />
            </div>
            <div class="field">
              <label>Link to course (optional)</label>
              <select v-model="issueForm.courseId" @change="onCourseLinkChange">
                <option value="">Standalone certificate (no linked course)</option>
                <option v-for="c in coursesList" :key="c.id" :value="c.id">
                  {{ c.title }} ({{ c.category }})
                </option>
              </select>
            </div>
          </div>

          <div class="issue-three-col">
            <div class="field">
              <label>Issued date</label>
              <input v-model="issueForm.issuedDate" type="date" />
            </div>
            <div class="field">
              <label>Credit hours</label>
              <input v-model.number="issueForm.totalHours" type="number" min="0" step="0.5" class="tabular" />
            </div>
            <div class="field">
              <label>Lessons / Modules</label>
              <input v-model.number="issueForm.totalLessons" type="number" min="0" step="1" class="tabular" />
            </div>
          </div>

          <div class="field">
            <label>Citation / Notes (optional)</label>
            <input
              v-model="issueForm.description"
              type="text"
              placeholder="Reason for recognition or program summary"
            />
          </div>

          <div class="field">
            <div class="row wrap" style="justify-content: space-between; align-items: center; margin-bottom: 6px">
              <label style="margin: 0">
                Select recipients * (<span class="tabular">{{ selectedRecipientIds.length }}</span> selected)
              </label>
              <div class="row" style="gap: 8px">
                <button type="button" class="btn btn-ghost btn-sm" @click="selectAllVisibleRecipients">
                  Select visible ({{ filteredRecipientPool.length }})
                </button>
                <button
                  v-if="selectedRecipientIds.length"
                  type="button"
                  class="btn btn-ghost btn-sm"
                  @click="clearSelectedRecipients"
                >
                  Clear
                </button>
              </div>
            </div>

            <div class="picker-filters">
              <input v-model="recipientSearch" type="search" placeholder="Search employees…" />
              <select v-model="recipientFilterDept">
                <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
              </select>
            </div>

            <div class="recipient-list">
              <label
                v-for="emp in filteredRecipientPool"
                :key="emp.id"
                class="recipient-item"
                :class="{ selected: selectedRecipientIds.includes(emp.id) }"
              >
                <input
                  type="checkbox"
                  :checked="selectedRecipientIds.includes(emp.id)"
                  @change="toggleRecipient(emp.id)"
                />
                <div class="avatar-xs">{{ initialsOf(emp.full_name) }}</div>
                <div class="grow" style="min-width: 0">
                  <div class="emp-nm">{{ emp.full_name }}</div>
                  <div class="sub">{{ emp.department }}{{ emp.email ? ` · ${emp.email}` : '' }}</div>
                </div>
              </label>
              <div v-if="!filteredRecipientPool.length" class="sub" style="padding: 14px; text-align: center">
                No matching active employees.
              </div>
            </div>
          </div>

          <p v-if="issueError" class="hint" style="color: var(--danger); margin-bottom: 10px">{{ issueError }}</p>

          <button class="btn btn-primary btn-sm" :disabled="issuing" @click="submitIssueCertificate">
            {{
              issuing
                ? 'Issuing…'
                : `Create & Issue Certificate${selectedRecipientIds.length > 1 ? ` (${selectedRecipientIds.length})` : ''}`
            }}
          </button>
        </div>

        <!-- Issued Certificates History -->
        <div class="card" style="overflow: hidden">
          <div class="panel-title">
            <div>
              <h3>Issued Custom Certificates</h3>
              <p class="sub" style="margin: 2px 0 0">Preview official PDFs or revoke issued credentials.</p>
            </div>
            <div class="row wrap" style="gap: 8px">
              <input v-model="issueSearch" type="search" placeholder="Search title, employee, ID…" style="width: 210px" />
              <select v-model="issueDeptFilter" style="width: 150px">
                <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
              </select>
            </div>
          </div>

          <div v-if="loadingIssued" class="sub" style="padding: 20px">Loading issued certificates…</div>
          <div v-else-if="!filteredIssuedList.length" class="sub" style="padding: 28px 18px; text-align: center">
            No custom certificates issued yet. Use the form to create and award one to employees.
          </div>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Certificate</th>
                  <th>Issued</th>
                  <th>Code</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="cert in filteredIssuedList" :key="cert.id">
                  <td>
                    <div style="font-weight: 600">{{ profilesById.get(cert.userId)?.full_name ?? 'Employee' }}</div>
                    <div class="sub">{{ profilesById.get(cert.userId)?.department ?? '—' }}</div>
                  </td>
                  <td>
                    <div style="font-weight: 600">{{ cert.title }}</div>
                    <div class="sub">
                      {{ cert.category }}
                      <template v-if="cert.totalHours > 0"> · {{ cert.totalHours }}h</template>
                    </div>
                  </td>
                  <td class="tabular">{{ cert.issuedDate }}</td>
                  <td>
                    <code class="cert-code">{{ cert.certificateCode }}</code>
                  </td>
                  <td>
                    <div class="row" style="gap: 6px">
                      <button class="btn btn-ghost btn-sm" @click="openIssuedPreview(cert)">View / PDF</button>
                      <button
                        class="btn btn-ghost btn-sm"
                        style="color: var(--danger)"
                        :disabled="revokingCertId === cert.id"
                        @click="handleRevokeCertificate(cert)"
                      >
                        {{ revokingCertId === cert.id ? '…' : 'Revoke' }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

    <!-- TAB 2: Template & PDF Settings (existing customizer preserved intact) -->
    <template v-else>
    <!-- Primary Company PDF Template Section -->
    <div class="card custom-pdf-card">
      <div class="custom-pdf-header">
        <div>
          <div class="row wrap" style="gap: 10px; align-items: center; margin-bottom: 4px">
            <h3 style="font-size: 17px; color: var(--ink); margin: 0">
              1. Company Sample PDF Template (Used for ALL Certificates)
            </h3>
            <span v-if="usesCustomPdf" class="status-pill active">
              ✓ Active for All Certificates
            </span>
            <span v-else class="status-pill">
              {{ form.customPdf.pdfBase64 ? 'Disabled' : 'No PDF Uploaded' }}
            </span>
          </div>
          <p class="sub" style="margin: 0; max-width: 780px">
            <strong>PDF (.pdf) is recommended over PowerPoint (.ppt/.pptx):</strong> exporting your PowerPoint, Canva, or Google Slides certificate design to PDF preserves 100% of custom fonts, logos, borders, and exact layout without distortion. Once uploaded and saved, this single template generates every employee certificate across the LMS.
          </p>
        </div>

        <div class="row wrap" style="gap: 8px">
          <input
            ref="fileInputRef"
            type="file"
            accept=".pdf,application/pdf,.ppt,.pptx"
            style="display: none"
            @change="handleTemplateFileChange"
          />
          <button class="btn btn-primary btn-sm" @click="fileInputRef?.click()">
            📄 {{ form.customPdf.pdfBase64 ? 'Replace PDF Template' : 'Upload PDF Template' }}
          </button>
          <button
            v-if="form.customPdf.pdfBase64"
            class="btn btn-ghost btn-sm"
            @click="removeCustomPdfTemplate"
          >
            🗑️ Remove Template
          </button>
        </div>
      </div>

      <div v-if="loadingRemote" class="sub" style="margin-top: 10px">
        Checking shared company template settings…
      </div>

      <div v-if="uploadError" class="upload-error-box">
        ⚠️ {{ uploadError }}
      </div>

      <div v-if="form.customPdf.pdfBase64" class="uploaded-meta-bar">
        <div class="uploaded-file-info">
          <span style="font-size: 18px">📑</span>
          <div>
            <b style="font-size: 13.5px; color: var(--ink)">{{ form.customPdf.fileName || 'custom-certificate.pdf' }}</b>
            <div class="sub" style="font-size: 11.5px">
              <template v-if="uploadInfo">
                {{ uploadInfo.widthPt }} × {{ uploadInfo.heightPt }} pt
                <span v-if="uploadInfo.pageCount > 1">
                  · {{ uploadInfo.pageCount }} pages detected (Page 1 will be stamped)
                </span>
              </template>
              <template v-else>Ready to stamp dynamic recipient details</template>
            </div>
          </div>
        </div>

        <label class="toggle-item" style="margin: 0">
          <input v-model="form.customPdf.enabled" type="checkbox" />
          <span>Use this PDF template for ALL certificates</span>
        </label>
      </div>

      <div v-else-if="!loadingRemote" class="empty-upload-box">
        <span style="font-size: 28px">📄</span>
        <div>
          <b style="font-size: 14px; color: var(--ink); display: block; margin-bottom: 2px">
            Upload a Sample Certificate PDF to Get Started
          </b>
          <span class="sub" style="font-size: 12.5px">
            Once uploaded, you can drag and align Employee Name, Course Title, Completion Date, Verification ID, and Department directly on your PDF.
          </span>
        </div>
        <button class="btn btn-primary btn-sm" @click="fileInputRef?.click()">
          Upload Sample PDF
        </button>
      </div>
    </div>

    <!-- Custom PDF Stamp Positioning & Interactive Live Visual Aligner -->
    <div v-if="usesCustomPdf" class="editor-grid aligner-editor-grid" style="margin-bottom: 28px">
      <div class="editor-form card">
        <div class="editor-header" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px">
          <div>
            <h3>2. Align & Style Certificate Details Live</h3>
            <span class="sub">
              Drag any label directly on the template preview, or fine-tune exact position, alignment, size, and color below.
            </span>
          </div>
          <button class="btn btn-ghost btn-sm" @click="resetOverlayFields">
            ↺ Default Positions
          </button>
        </div>

        <div class="overlay-fields-list">
          <div
            v-for="meta in overlayFieldMeta"
            :key="meta.key"
            class="overlay-field-card"
            :class="{ selected: selectedOverlayField === meta.key }"
            @click="selectedOverlayField = meta.key"
          >
            <div class="overlay-field-head">
              <label class="toggle-item" @click.stop>
                <input v-model="form.customPdf.fields[meta.key].enabled" type="checkbox" />
                <b>{{ meta.label }}</b>
              </label>
              <div class="row" style="gap: 6px; align-items: center">
                <span v-if="selectedOverlayField === meta.key" class="selected-badge">Editing</span>
                <span class="sub" style="font-size: 11px">{{ meta.hint }}</span>
              </div>
            </div>

            <div v-if="form.customPdf.fields[meta.key].enabled" class="overlay-sliders-panel">
              <div class="slider-row">
                <label>X %</label>
                <input
                  v-model.number="form.customPdf.fields[meta.key].xPct"
                  type="range"
                  min="1"
                  max="99"
                  step="0.5"
                />
                <input
                  v-model.number="form.customPdf.fields[meta.key].xPct"
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  class="compact-num"
                />
                <button
                  type="button"
                  class="mini-action-btn"
                  title="Center horizontally at 50%"
                  @click.stop="form.customPdf.fields[meta.key].xPct = 50; form.customPdf.fields[meta.key].align = 'center'"
                >
                  50%
                </button>
              </div>

              <div class="slider-row">
                <label>Y %</label>
                <input
                  v-model.number="form.customPdf.fields[meta.key].yPct"
                  type="range"
                  min="1"
                  max="99"
                  step="0.5"
                />
                <input
                  v-model.number="form.customPdf.fields[meta.key].yPct"
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  class="compact-num"
                />
                <span class="sub" style="font-size: 10.5px; text-align: center">top→btm</span>
              </div>

              <div class="slider-row">
                <label>Size</label>
                <input
                  v-model.number="form.customPdf.fields[meta.key].fontSize"
                  type="range"
                  min="6"
                  max="56"
                  step="1"
                />
                <input
                  v-model.number="form.customPdf.fields[meta.key].fontSize"
                  type="number"
                  min="6"
                  max="60"
                  step="1"
                  class="compact-num"
                />
                <input
                  v-model="form.customPdf.fields[meta.key].color"
                  type="color"
                  class="color-input-compact"
                  title="Text color"
                />
              </div>

              <div class="align-row">
                <span class="sub" style="font-size: 11px">Anchor:</span>
                <div class="align-seg">
                  <button
                    type="button"
                    :class="{ active: (form.customPdf.fields[meta.key].align ?? 'center') === 'left' }"
                    @click.stop="form.customPdf.fields[meta.key].align = 'left'"
                  >
                    Left
                  </button>
                  <button
                    type="button"
                    :class="{ active: (form.customPdf.fields[meta.key].align ?? 'center') === 'center' }"
                    @click.stop="form.customPdf.fields[meta.key].align = 'center'"
                  >
                    Center
                  </button>
                  <button
                    type="button"
                    :class="{ active: (form.customPdf.fields[meta.key].align ?? 'center') === 'right' }"
                    @click.stop="form.customPdf.fields[meta.key].align = 'right'"
                  >
                    Right
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style="margin-top: 16px; display: flex; gap: 8px">
          <button class="btn btn-primary grow" :disabled="saving" @click="onSave">
            <span v-if="saving">⏳ Saving…</span>
            <span v-else>💾 Save Company PDF Template</span>
          </button>
        </div>
      </div>

      <div class="preview-col">
        <div class="preview-sticky">
          <div class="preview-bar wrap" style="gap: 8px">
            <div>
              <b style="font-size: 14px">Interactive Visual Certificate Aligner</b>
              <span class="sub" style="display: block; font-size: 11px">
                Drag details directly onto your template or switch to Verify Final PDF
              </span>
            </div>

            <div class="row wrap" style="gap: 6px; align-items: center">
              <div class="mode-tabs">
                <button
                  type="button"
                  class="mode-tab"
                  :class="{ active: previewMode === 'aligner' }"
                  @click="previewMode = 'aligner'"
                >
                  🎯 Live Drag & Align
                </button>
                <button
                  type="button"
                  class="mode-tab"
                  :class="{ active: previewMode === 'pdf' }"
                  @click="previewMode = 'pdf'"
                >
                  📄 Verify Final PDF
                </button>
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                @click="showSampleEditor = !showSampleEditor"
              >
                ✏️ {{ showSampleEditor ? 'Hide Test Text' : 'Test Long/Custom Text' }}
              </button>
            </div>
          </div>

          <div v-if="showSampleEditor" class="card sample-text-bar">
            <div class="sample-inputs-grid">
              <div class="field">
                <label>Test Employee Name</label>
                <input v-model="sampleCertData.userName" type="text" placeholder="e.g. Alexander Morgan" />
              </div>
              <div class="field">
                <label>Test Course Title</label>
                <input v-model="sampleCertData.courseTitle" type="text" placeholder="Course name" />
              </div>
              <div class="field">
                <label>Test Department</label>
                <input v-model="sampleCertData.userDepartment" type="text" placeholder="Department" />
              </div>
            </div>
          </div>

          <CertificatePdfAligner
            v-if="previewMode === 'aligner' && form.customPdf.pdfBase64"
            v-model:selected-field="selectedOverlayField"
            :pdf-base64="form.customPdf.pdfBase64"
            :fields="form.customPdf.fields"
            :sample-data="sampleCertData"
          />

          <div v-else class="custom-pdf-preview-frame card">
            <div v-if="previewLoading && !previewUrl" class="pdf-preview-placeholder">
              Rendering stamped PDF preview…
            </div>
            <div v-else-if="previewError" class="pdf-preview-placeholder error">
              {{ previewError }}
            </div>
            <iframe
              v-else-if="previewUrl"
              :src="`${previewUrl}#toolbar=0&navpanes=0`"
              class="pdf-preview-iframe"
              title="Custom PDF Certificate Live Preview"
            />
          </div>
        </div>
      </div>
    </div>
    </template>

    <CertificateModal
      v-if="previewCertData"
      :certificate="previewCertData"
      @close="previewCertData = null"
    />
  </div>
</template>

<style scoped>
.cert-admin-page {
  padding-bottom: 40px;
}

.save-toast {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid #10b981;
  color: #34d399;
  padding: 10px 16px;
  border-radius: 8px;
  margin-bottom: 18px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: fadeIn 0.2s ease;
}

.save-toast.warn {
  background: rgba(245, 158, 11, 0.14);
  border-color: #f59e0b;
  color: #fbbf24;
}

.custom-pdf-card {
  padding: 20px 22px;
  margin-bottom: 24px;
  border: 1px solid rgba(59, 130, 246, 0.35);
}

.custom-pdf-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}

.status-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 99px;
  background: rgba(148, 163, 184, 0.15);
  color: var(--ink-soft);
}

.status-pill.active {
  background: rgba(16, 185, 129, 0.16);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.4);
}

.upload-error-box {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5;
  font-size: 13px;
}

.uploaded-meta-bar {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.09);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.uploaded-file-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.overlay-fields-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.overlay-field-card {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.overlay-field-card.selected {
  border-color: #3b82f6;
  background: rgba(37, 99, 235, 0.08);
}

.selected-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 7px;
  border-radius: 99px;
  background: rgba(59, 130, 246, 0.25);
  color: #93c5fd;
}

.overlay-field-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.overlay-sliders-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.slider-row {
  display: grid;
  grid-template-columns: 38px 1fr 64px 48px;
  gap: 8px;
  align-items: center;
}

.slider-row label {
  font-size: 11.5px;
  color: var(--ink-soft);
  font-weight: 600;
}

.slider-row input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}

.compact-num {
  width: 100%;
  padding: 4px 6px;
  font-size: 12px;
}

.mini-action-btn {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: var(--ink);
  font-size: 10.5px;
  font-weight: 600;
  border-radius: 5px;
  padding: 4px 6px;
  cursor: pointer;
}

.mini-action-btn:hover {
  border-color: var(--accent);
  color: var(--accent-text);
}

.color-input-compact {
  width: 100%;
  height: 28px;
  padding: 1px 2px;
  cursor: pointer;
}

.align-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.align-seg {
  display: inline-flex;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.align-seg button {
  background: rgba(255, 255, 255, 0.05);
  border: none;
  border-right: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--ink-soft);
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  cursor: pointer;
}

.align-seg button:last-child {
  border-right: none;
}

.align-seg button.active {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.mode-tabs {
  display: inline-flex;
  border-radius: 7px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.mode-tab {
  background: rgba(255, 255, 255, 0.04);
  border: none;
  color: var(--ink-soft);
  font-size: 11.5px;
  font-weight: 600;
  padding: 5px 10px;
  cursor: pointer;
}

.mode-tab.active {
  background: var(--accent);
  color: #ffffff;
}

.sample-text-bar {
  padding: 12px 14px;
  margin-bottom: 10px;
}

.sample-inputs-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.sample-inputs-grid .field {
  margin-bottom: 0;
}

.aligner-editor-grid {
  grid-template-columns: minmax(340px, 0.9fr) 1.35fr;
}

.custom-pdf-preview-frame {
  padding: 0;
  overflow: hidden;
  min-height: 460px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pdf-preview-iframe {
  width: 100%;
  height: 480px;
  border: none;
  display: block;
  background: #ffffff;
}

.pdf-preview-placeholder {
  padding: 24px;
  color: var(--ink-soft);
  font-size: 13px;
  text-align: center;
}

.pdf-preview-placeholder.error {
  color: #f87171;
}

@media (max-width: 720px) {
  .sample-inputs-grid {
    grid-template-columns: 1fr;
  }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.empty-upload-box {
  margin-top: 16px;
  padding: 20px;
  border-radius: 10px;
  border: 1.5px dashed rgba(221, 51, 51, 0.4);
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

/* Editor layout */
.editor-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  align-items: start;
}

@media (max-width: 1100px) {
  .editor-grid {
    grid-template-columns: 1fr;
  }
}

.editor-form {
  padding: 24px;
}

.editor-header {
  margin-bottom: 18px;
}

.editor-header h3 {
  font-size: 17px;
  margin-bottom: 2px;
}

.field {
  margin-bottom: 12px;
}

.field label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-soft);
  margin-bottom: 4px;
}

.field input {
  width: 100%;
}

.toggle-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
  color: var(--ink);
}

.toggle-item input[type='checkbox'] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

/* Preview Sticky Column */
.preview-col {
  position: relative;
}

.preview-sticky {
  position: sticky;
  top: 20px;
}

.preview-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.notice-bar {
  padding: 12px 16px;
  margin-bottom: 16px;
  font-size: 13px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: baseline;
  border-color: var(--brass);
}

.issue-layout {
  display: grid;
  grid-template-columns: minmax(340px, 470px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

@media (max-width: 1080px) {
  .issue-layout {
    grid-template-columns: 1fr;
  }
}

.issue-form-card {
  padding: 18px;
}

.issue-two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.issue-three-col {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 600px) {
  .issue-two-col,
  .issue-three-col {
    grid-template-columns: 1fr;
  }
}

.picker-filters {
  display: grid;
  grid-template-columns: 1fr 140px;
  gap: 8px;
  margin-bottom: 8px;
}

.recipient-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunken);
  display: flex;
  flex-direction: column;
}

.recipient-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 0.12s ease;
}

.recipient-item:last-child {
  border-bottom: none;
}

.recipient-item.selected {
  background: var(--accent-soft);
}

.recipient-item input[type='checkbox'] {
  width: 16px;
  height: 16px;
  flex: none;
}

.avatar-xs {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  background: var(--brass-soft);
  color: var(--brass-strong);
  flex: none;
}

.emp-nm {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cert-code {
  font-family: monospace;
  font-size: 11.5px;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--surface-sunken);
}

.tabular {
  font-variant-numeric: tabular-nums;
}
</style>
