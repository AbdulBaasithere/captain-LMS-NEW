<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useAuthStore } from '@/stores/auth'
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
import CertificatePdfAligner from '@/components/CertificatePdfAligner.vue'

const MAX_PDF_BYTES = 3 * 1024 * 1024 // 3 MB limit for reliable JSONB + fallback persistence

const auth = useAuthStore()
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

onMounted(async () => {
  try {
    const synced = await syncCertificateConfigFromServer()
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
        <h2>Certificate Template & Details</h2>
        <p>
          Upload your company's sample PDF certificate template once to use it for all employee certificates across the LMS, and align details live.
        </p>
      </div>

      <div class="row wrap" style="gap: 8px">
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

    <!-- Toast notification -->
    <div v-if="toastMessage" class="save-toast" :class="{ warn: toastKind === 'warn' }">
      <span>{{ toastKind === 'warn' ? '⚠️' : '✓' }}</span>
      <span>{{ toastMessage }}</span>
    </div>

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
  accent-color: #3b82f6;
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
  border-color: #3b82f6;
  color: #93c5fd;
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
  background: rgba(37, 99, 235, 0.3);
  color: #93c5fd;
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
  background: #2563eb;
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
  border: 1.5px dashed rgba(59, 130, 246, 0.35);
  background: rgba(59, 130, 246, 0.04);
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
</style>
