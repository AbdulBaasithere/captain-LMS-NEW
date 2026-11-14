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
  TEMPLATE_METADATA,
  type CertificateCustomization,
  type CertificateTemplateId,
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

const templateKeys: CertificateTemplateId[] = [
  'classic-executive',
  'modern-emerald',
  'royal-elegance',
  'tech-midnight',
]

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

function selectTemplate(id: CertificateTemplateId) {
  form.templateId = id
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
          Upload your company's own PDF certificate template once to use it for all employee certificates, or customize the built-in designs.
        </p>
      </div>

      <div class="row wrap" style="gap: 8px">
        <button class="btn btn-ghost btn-sm" @click="onReset">
          {{ confirmReset ? '⚠️ Click Again to Confirm Reset' : '↺ Reset Defaults' }}
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="testDownloading" @click="downloadSamplePdf">
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
              1. Company Certificate Template (PDF — Used for ALL Certificates)
            </h3>
            <span v-if="usesCustomPdf" class="status-pill active">
              ✓ Active for All Certificates
            </span>
            <span v-else class="status-pill">
              Using Built-in Template
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

    <!-- Built-in Template Selector Cards & Text Editor (only shown when no custom PDF is active) -->
    <div v-if="!usesCustomPdf" class="builtin-section">
      <div class="section-title">
        <h3>2. Select Built-In Certificate Template</h3>
        <span class="sub">
          Choose the graphic style and color palette applied to employee certificates when no custom PDF is uploaded.
        </span>
      </div>

      <div class="templates-grid">
        <div
          v-for="tid in templateKeys"
          :key="tid"
          class="card tpl-card"
          :class="{ active: form.templateId === tid }"
          @click="selectTemplate(tid)"
        >
          <div class="tpl-card-header">
            <span class="tpl-badge">{{ TEMPLATE_METADATA[tid].badgeIcon }}</span>
            <span class="tpl-check" v-if="form.templateId === tid">✓ Selected</span>
          </div>
          <b class="tpl-name">{{ TEMPLATE_METADATA[tid].name }}</b>
          <p class="tpl-desc">{{ TEMPLATE_METADATA[tid].description }}</p>
          <div class="tpl-swatches">
            <span class="swatch" :style="{ background: TEMPLATE_METADATA[tid].primaryColor }" title="Primary" />
            <span class="swatch" :style="{ background: TEMPLATE_METADATA[tid].accentColor }" title="Accent" />
            <span class="swatch" :style="{ background: TEMPLATE_METADATA[tid].bgTint, border: '1px solid #cbd5e1' }" title="Parchment/Canvas" />
          </div>
        </div>
      </div>

      <!-- Customization Form & Live Preview Grid -->
      <div class="editor-grid">
      <!-- Form Controls -->
      <div class="editor-form card">
        <div class="editor-header">
          <h3>2. Customize Certificate Text & Signatories</h3>
          <span class="sub">Fine-tune institutional copy and credential details</span>
        </div>

        <!-- Group: Organization & Headings -->
        <fieldset class="field-group">
          <legend>Organization & Header</legend>
          <div class="field">
            <label>Issuing Institution / Organization</label>
            <input v-model="form.organizationName" type="text" placeholder="e.g. CAPTAIN & COMPANY LEARNING & DEVELOPMENT" />
          </div>

          <div class="row wrap" style="gap: 12px">
            <div class="field grow">
              <label>Certificate Title</label>
              <input v-model="form.certificateTitle" type="text" placeholder="e.g. CERTIFICATE OF COMPLETION" />
            </div>
            <div class="field grow">
              <label>Presentation Kicker</label>
              <input v-model="form.presentationKicker" type="text" placeholder="e.g. THIS IS PROUDLY PRESENTED TO" />
            </div>
          </div>
        </fieldset>

        <!-- Group: Statement -->
        <fieldset class="field-group">
          <legend>Achievement Statement</legend>
          <div class="field">
            <label>Completion Statement</label>
            <textarea
              v-model="form.completionStatement"
              rows="2"
              placeholder="e.g. has successfully completed 100% of the prescribed curriculum, lessons, and evaluations for"
            />
          </div>
        </fieldset>

        <!-- Group: Official Seal -->
        <fieldset class="field-group">
          <legend>Official Medallion Seal</legend>
          <div class="row wrap" style="gap: 12px">
            <div class="field grow">
              <label>Badge Center Text</label>
              <input v-model="form.sealBadgeText" type="text" placeholder="e.g. ★ 100% ★" />
            </div>
            <div class="field grow">
              <label>Seal Subtitle</label>
              <input v-model="form.sealSubtext" type="text" placeholder="e.g. VERIFIED" />
            </div>
          </div>
        </fieldset>

        <!-- Group: Signatories -->
        <fieldset class="field-group">
          <legend>Issuing Authorities & Signatures</legend>

          <div class="sig-section-title">Left Signatory</div>
          <div class="field">
            <label>Full Name & Degree / Honorific</label>
            <input v-model="form.sigLeftName" type="text" placeholder="e.g. Sarah Jenkins, M.Ed." />
          </div>
          <div class="row wrap" style="gap: 12px">
            <div class="field grow">
              <label>Title / Role</label>
              <input v-model="form.sigLeftTitle" type="text" placeholder="e.g. VP of People & Talent Development" />
            </div>
            <div class="field grow">
              <label>Organization / Department</label>
              <input v-model="form.sigLeftOrg" type="text" placeholder="e.g. Captain & Company" />
            </div>
          </div>

          <div class="sig-section-title" style="margin-top: 14px">Right Signatory</div>
          <div class="field">
            <label>Full Name & Degree / Honorific</label>
            <input v-model="form.sigRightName" type="text" placeholder="e.g. David Vance, Ph.D." />
          </div>
          <div class="row wrap" style="gap: 12px">
            <div class="field grow">
              <label>Title / Role</label>
              <input v-model="form.sigRightTitle" type="text" placeholder="e.g. Director of Academy & Curriculum" />
            </div>
            <div class="field grow">
              <label>Organization / Department</label>
              <input v-model="form.sigRightOrg" type="text" placeholder="e.g. Captain LMS Certification Board" />
            </div>
          </div>
        </fieldset>

        <!-- Group: Verification & Toggles -->
        <fieldset class="field-group">
          <legend>Security & Verification</legend>
          <div class="field">
            <label>Verification Registry URL / Instructions</label>
            <input v-model="form.verificationUrl" type="text" placeholder="e.g. captain-lms.internal/verify" />
          </div>

          <div class="toggles-row">
            <label class="toggle-item">
              <input v-model="form.includeDepartment" type="checkbox" />
              <span>Include Employee Department on Certificate</span>
            </label>

            <label class="toggle-item">
              <input v-model="form.includeStats" type="checkbox" />
              <span>Include Course Curriculum Stats (Lessons count, Duration)</span>
            </label>
          </div>
        </fieldset>

        <div style="margin-top: 16px; display: flex; gap: 8px">
          <button class="btn btn-primary grow" @click="onSave">
            💾 Save Certificate Settings
          </button>
        </div>
      </div>

      <!-- Live Preview Column -->
      <div class="preview-col">
        <div class="preview-sticky">
          <div class="preview-bar">
            <div>
              <b style="font-size: 13.5px">Real-Time Certificate Preview</b>
              <span class="sub" style="display: block; font-size: 11px">Updates live as you edit template and details</span>
            </div>
            <button class="btn btn-ghost btn-sm" :disabled="testDownloading" @click="downloadSamplePdf">
              📥 Test PDF
            </button>
          </div>

          <!-- Realistic Preview Canvas -->
          <div class="cert-paper" :class="`tpl-${form.templateId}`">
            <div class="cert-outer-border">
              <div class="cert-inner-border">
                <span class="cert-corner corner-tl">◆</span>
                <span class="cert-corner corner-tr">◆</span>
                <span class="cert-corner corner-bl">◆</span>
                <span class="cert-corner corner-br">◆</span>

                <div class="cert-brand-line">{{ form.organizationName }}</div>
                <div class="cert-main-kicker">{{ form.certificateTitle }}</div>
                <div class="cert-sub-kicker">{{ form.presentationKicker }}</div>

                <div class="cert-recipient">{{ sampleCertData.userName }}</div>
                <div class="cert-line-divider" />

                <div v-if="form.includeDepartment" class="cert-dept-tag">
                  Department of {{ sampleCertData.userDepartment }}
                </div>

                <div class="cert-body-text">
                  {{ form.completionStatement }}
                </div>

                <div class="cert-course-name">{{ sampleCertData.courseTitle }}</div>
                <div v-if="form.includeStats" class="cert-course-meta">
                  {{ sampleCertData.courseCategory }} · {{ sampleCertData.totalLessons }} Lessons · 100% Mastery Verified
                </div>

                <!-- Bottom signatories -->
                <div class="cert-bottom-row">
                  <div class="cert-sig-block">
                    <div class="cert-sig-name">{{ form.sigLeftName.split(',')[0] }}</div>
                    <div class="cert-sig-line" />
                    <div class="cert-sig-title">{{ form.sigLeftName }}</div>
                    <div class="cert-sig-role">{{ form.sigLeftTitle }}</div>
                    <div class="cert-sig-org">{{ form.sigLeftOrg }}</div>
                  </div>

                  <div class="cert-gold-seal">
                    <div class="cert-seal-teeth" />
                    <div class="cert-seal-inner">
                      <span class="cert-seal-star">{{ form.sealBadgeText }}</span>
                      <span class="cert-seal-text">{{ form.sealSubtext }}</span>
                    </div>
                    <div class="cert-seal-ribbon ribbon-left" />
                    <div class="cert-seal-ribbon ribbon-right" />
                  </div>

                  <div class="cert-sig-block">
                    <div class="cert-sig-name">{{ form.sigRightName.split(',')[0] }}</div>
                    <div class="cert-sig-line" />
                    <div class="cert-sig-title">{{ form.sigRightName }}</div>
                    <div class="cert-sig-role">{{ form.sigRightTitle }}</div>
                    <div class="cert-sig-org">{{ form.sigRightOrg }}</div>
                  </div>
                </div>

                <!-- Footer -->
                <div class="cert-foot-row">
                  <span>Issued: {{ sampleCertData.completedDate }}</span>
                  <span class="cert-id-tag">ID: {{ sampleCertData.certificateId }}</span>
                  <span>{{ form.verificationUrl }}</span>
                </div>
              </div>
            </div>
          </div>
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

.section-title {
  margin-bottom: 12px;
}

.section-title h3 {
  font-size: 17px;
  color: var(--ink);
  margin-bottom: 2px;
}

/* Template Cards Grid */
.templates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin-bottom: 28px;
}

.tpl-card {
  padding: 16px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.15s ease;
  position: relative;
  display: flex;
  flex-direction: column;
}

.tpl-card:hover {
  transform: translateY(-2px);
  border-color: rgba(212, 175, 55, 0.4);
}

.tpl-card.active {
  border-color: #2563eb;
  background: rgba(37, 99, 235, 0.08);
  box-shadow: 0 0 15px rgba(37, 99, 235, 0.2);
}

.tpl-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.tpl-badge {
  font-size: 24px;
}

.tpl-check {
  font-size: 11px;
  font-weight: 700;
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.15);
  padding: 2px 8px;
  border-radius: 99px;
}

.tpl-name {
  font-size: 14px;
  color: var(--ink);
  margin-bottom: 4px;
}

.tpl-desc {
  font-size: 11.5px;
  color: var(--ink-soft);
  margin-bottom: 12px;
  line-height: 1.4;
  flex: 1;
}

.tpl-swatches {
  display: flex;
  gap: 6px;
  align-items: center;
}

.swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-block;
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

.field-group {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 16px 18px;
  margin-bottom: 18px;
}

.field-group legend {
  font-size: 12.5px;
  font-weight: 700;
  color: #d4af37;
  padding: 0 6px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.sig-section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--ink-soft);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 8px;
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

.field input,
.field textarea {
  width: 100%;
}

.toggles-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
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

/* Certificate Preview Canvas */
.cert-paper {
  background: #fdfbf7;
  color: #0f172a;
  border-radius: 12px;
  padding: 14px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45);
  transition: all 0.2s ease;
}

/* Template Themes */
.cert-paper.tpl-classic-executive {
  background: #fdfcf8;
}
.cert-paper.tpl-classic-executive .cert-outer-border { border-color: #0f172a; }
.cert-paper.tpl-classic-executive .cert-inner-border { border-color: #c5a059; }
.cert-paper.tpl-classic-executive .cert-corner { color: #c5a059; }
.cert-paper.tpl-classic-executive .cert-line-divider { background: #c5a059; }
.cert-paper.tpl-classic-executive .cert-seal-teeth { background: #d4af37; }

.cert-paper.tpl-modern-emerald {
  background: #ffffff;
}
.cert-paper.tpl-modern-emerald .cert-outer-border { border-color: #0f172a; border-width: 2px; }
.cert-paper.tpl-modern-emerald .cert-inner-border { border-color: #059669; }
.cert-paper.tpl-modern-emerald .cert-corner { color: #059669; }
.cert-paper.tpl-modern-emerald .cert-line-divider { background: #059669; }
.cert-paper.tpl-modern-emerald .cert-course-name { color: #065f46; }
.cert-paper.tpl-modern-emerald .cert-seal-teeth { background: #059669; }
.cert-paper.tpl-modern-emerald .cert-seal-ribbon { background: #059669; }

.cert-paper.tpl-royal-elegance {
  background: #faf7f2;
}
.cert-paper.tpl-royal-elegance .cert-outer-border { border-color: #581c26; }
.cert-paper.tpl-royal-elegance .cert-inner-border { border-color: #c5a059; }
.cert-paper.tpl-royal-elegance .cert-corner { color: #c5a059; }
.cert-paper.tpl-royal-elegance .cert-line-divider { background: #c5a059; }
.cert-paper.tpl-royal-elegance .cert-main-kicker { color: #581c26; }
.cert-paper.tpl-royal-elegance .cert-course-name { color: #581c26; }
.cert-paper.tpl-royal-elegance .cert-seal-teeth { background: #b91c1c; }
.cert-paper.tpl-royal-elegance .cert-seal-inner { background: #581c26; }

.cert-paper.tpl-tech-midnight {
  background: #f8fafc;
}
.cert-paper.tpl-tech-midnight .cert-outer-border { border-color: #0b0f19; }
.cert-paper.tpl-tech-midnight .cert-inner-border { border-color: #0284c7; }
.cert-paper.tpl-tech-midnight .cert-corner { color: #0284c7; }
.cert-paper.tpl-tech-midnight .cert-line-divider { background: #0284c7; }
.cert-paper.tpl-tech-midnight .cert-course-name { color: #0369a1; }
.cert-paper.tpl-tech-midnight .cert-seal-teeth { background: #0284c7; }
.cert-paper.tpl-tech-midnight .cert-seal-ribbon { background: #0284c7; }

.cert-outer-border {
  border: 3px solid #0f172a;
  padding: 6px;
}

.cert-inner-border {
  position: relative;
  border: 1px solid #c5a059;
  padding: 18px 18px 14px;
  text-align: center;
}

.cert-corner {
  position: absolute;
  color: #c5a059;
  font-size: 9px;
  line-height: 1;
}

.corner-tl { top: 3px; left: 3px; }
.corner-tr { top: 3px; right: 3px; }
.corner-bl { bottom: 3px; left: 3px; }
.corner-br { bottom: 3px; right: 3px; }

.cert-brand-line {
  font-size: 8px;
  letter-spacing: 0.18em;
  color: #64748b;
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.cert-main-kicker {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 18px;
  font-weight: bold;
  letter-spacing: 0.05em;
  color: #0f172a;
  margin-bottom: 2px;
}

.cert-sub-kicker {
  font-size: 7.5px;
  letter-spacing: 0.16em;
  color: #94a3b8;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.cert-recipient {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 21px;
  font-weight: bold;
  font-style: italic;
  color: #1e293b;
  margin-bottom: 3px;
}

.cert-line-divider {
  width: 120px;
  height: 2px;
  background: #c5a059;
  margin: 0 auto 6px;
}

.cert-dept-tag {
  font-size: 8px;
  color: #64748b;
  margin-bottom: 4px;
  font-style: italic;
}

.cert-body-text {
  font-size: 9.5px;
  color: #475569;
  margin-bottom: 6px;
  line-height: 1.35;
}

.cert-course-name {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 15px;
  font-weight: bold;
  color: #1e3a8a;
  margin-bottom: 2px;
}

.cert-course-meta {
  font-size: 8px;
  color: #64748b;
  margin-bottom: 12px;
}

.cert-bottom-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: 10px;
  padding: 0 8px;
}

.cert-sig-block {
  text-align: center;
  width: 120px;
}

.cert-sig-name {
  font-family: Georgia, 'Times New Roman', cursive, serif;
  font-style: italic;
  font-size: 12px;
  color: #0f172a;
  margin-bottom: 1px;
}

.cert-sig-line {
  width: 100%;
  height: 1px;
  background: #0f172a;
  margin-bottom: 3px;
}

.cert-sig-title {
  font-size: 7.5px;
  font-weight: bold;
  color: #1e293b;
}

.cert-sig-role {
  font-size: 6.5px;
  color: #64748b;
}

.cert-sig-org {
  font-size: 6px;
  color: #94a3b8;
}

.cert-gold-seal {
  position: relative;
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
}

.cert-seal-teeth {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: #d4af37;
  box-shadow: 0 0 8px rgba(212, 175, 55, 0.4);
}

.cert-seal-inner {
  position: relative;
  z-index: 2;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: #0f172a;
  border: 1px solid #ffffff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  text-align: center;
}

.cert-seal-star {
  font-size: 6px;
  color: #ffd700;
  font-weight: bold;
}

.cert-seal-text {
  font-size: 4.5px;
  letter-spacing: 0.1em;
  color: #ffffff;
}

.cert-seal-ribbon {
  position: absolute;
  bottom: -8px;
  width: 8px;
  height: 11px;
  background: #c5a059;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 75%, 0 100%);
  z-index: 1;
}

.ribbon-left {
  left: 14px;
  transform: rotate(-10deg);
}

.ribbon-right {
  right: 14px;
  transform: rotate(10deg);
}

.cert-foot-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 6.5px;
  color: #94a3b8;
  margin-top: 10px;
  padding-top: 5px;
  border-top: 1px dashed #cbd5e1;
}

.cert-id-tag {
  font-family: monospace;
  font-weight: bold;
  color: #64748b;
}
</style>
