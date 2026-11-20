<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { downloadCertificatePdf, getCertificatePdfBlobUrl, type CertificateData } from '@/lib/certificate'
import {
  getCertificateConfig,
  syncCertificateConfigFromServer,
  type CertificateCustomization,
} from '@/lib/certificateConfig'

const props = defineProps<{
  certificate: CertificateData
  autoOpened?: boolean
  config?: CertificateCustomization
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const serverConfig = ref<CertificateCustomization>(getCertificateConfig())
const activeConfig = computed<CertificateCustomization>(() => props.config || serverConfig.value)
const usesCustomPdf = computed(
  () => Boolean(activeConfig.value.customPdf?.enabled && activeConfig.value.customPdf?.pdfBase64),
)

const customPdfPreviewUrl = ref<string | null>(null)
const previewLoading = ref(false)
const previewError = ref<string | null>(null)
const downloading = ref(false)
const copied = ref(false)

function revokePreviewUrl() {
  if (customPdfPreviewUrl.value) {
    URL.revokeObjectURL(customPdfPreviewUrl.value)
    customPdfPreviewUrl.value = null
  }
}

async function refreshCustomPreview() {
  if (!usesCustomPdf.value) {
    revokePreviewUrl()
    return
  }
  previewLoading.value = true
  previewError.value = null
  try {
    const nextUrl = await getCertificatePdfBlobUrl(props.certificate, activeConfig.value)
    revokePreviewUrl()
    customPdfPreviewUrl.value = nextUrl
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : 'Unable to render custom PDF preview.'
  } finally {
    previewLoading.value = false
  }
}

onMounted(async () => {
  if (!props.config) {
    serverConfig.value = await syncCertificateConfigFromServer()
  }
  await refreshCustomPreview()
})

watch(
  [() => props.certificate, activeConfig],
  () => {
    void refreshCustomPreview()
  },
  { deep: true },
)

onBeforeUnmount(() => {
  revokePreviewUrl()
})

async function onDownload() {
  downloading.value = true
  try {
    await downloadCertificatePdf(props.certificate, activeConfig.value)
  } finally {
    downloading.value = false
  }
}

async function onPrint() {
  try {
    const url = await getCertificatePdfBlobUrl(props.certificate, activeConfig.value)
    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.right = '0'
    frame.style.bottom = '0'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    frame.src = url
    frame.onload = () => {
      try {
        frame.contentWindow?.focus()
        frame.contentWindow?.print()
      } catch {
        void onDownload()
      }
      setTimeout(() => {
        frame.remove()
        URL.revokeObjectURL(url)
      }, 60000)
    }
    document.body.appendChild(frame)
  } catch {
    await onDownload()
  }
}

async function copyCertId() {
  try {
    await navigator.clipboard.writeText(props.certificate.certificateId)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2500)
  } catch {
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2500)
  }
}
</script>

<template>
  <div class="cert-modal-backdrop" @click.self="emit('close')">
    <div class="cert-modal-container">
      <!-- Close button -->
      <button class="cert-modal-close" title="Close" @click="emit('close')">✕</button>

      <!-- Celebration Header -->
      <div class="cert-header">
        <div class="cert-trophy-badge">🏆</div>
        <div class="cert-kicker">
          {{ autoOpened ? 'Course Completed 100% · Achievement Unlocked' : 'Verified Credential · 100% Course Completion' }}
        </div>
        <h2 class="cert-title">
          {{ autoOpened ? 'Congratulations, ' + certificate.userName + '!' : activeConfig.certificateTitle }}
        </h2>
        <p class="cert-subtitle">
          You have successfully completed 100% of the curriculum in
          <strong>{{ certificate.courseTitle }}</strong>.
        </p>
      </div>

      <!-- Custom PDF Preview OR Built-in Certificate Preview Card -->
      <div class="cert-preview-wrapper">
        <div v-if="usesCustomPdf" class="custom-pdf-preview-box">
          <div v-if="previewLoading" class="custom-pdf-status">
            Rendering your personalized PDF certificate…
          </div>
          <div v-else-if="previewError" class="custom-pdf-status error">
            {{ previewError }}
          </div>
          <iframe
            v-else-if="customPdfPreviewUrl"
            :src="`${customPdfPreviewUrl}#toolbar=0&navpanes=0`"
            class="custom-pdf-iframe"
            title="Official Certificate Preview"
          />
        </div>

        <div v-else class="cert-paper" :class="`tpl-${activeConfig.templateId}`">
          <!-- Outer border -->
          <div class="cert-outer-border">
            <div class="cert-inner-border">
              <!-- Corner ornaments -->
              <span class="cert-corner corner-tl">◆</span>
              <span class="cert-corner corner-tr">◆</span>
              <span class="cert-corner corner-bl">◆</span>
              <span class="cert-corner corner-br">◆</span>

              <img
                src="/assets/aistudio/captain-logo_d6af1701.png"
                alt="Captain — We create bonds"
                class="cert-brand-logo"
              />
              <div class="cert-brand-line">{{ activeConfig.organizationName }}</div>
              <div class="cert-main-kicker">{{ activeConfig.certificateTitle }}</div>
              <div class="cert-sub-kicker">{{ activeConfig.presentationKicker }}</div>

              <div class="cert-recipient">{{ certificate.userName }}</div>
              <div class="cert-line-divider" />

              <div v-if="activeConfig.includeDepartment && certificate.userDepartment" class="cert-dept-tag">
                Department of {{ certificate.userDepartment }}
              </div>

              <div class="cert-body-text">
                {{ activeConfig.completionStatement }}
              </div>

              <div class="cert-course-name">{{ certificate.courseTitle }}</div>
              <div v-if="activeConfig.includeStats" class="cert-course-meta">
                {{ certificate.courseCategory }} · {{ certificate.totalLessons }} {{ certificate.totalLessons === 1 ? 'Lesson' : 'Lessons' }} · 100% Mastery Verified
              </div>

              <!-- Seal and Signatures Row -->
              <div class="cert-bottom-row">
                <div class="cert-sig-block">
                  <div class="cert-sig-name">{{ activeConfig.sigLeftName.split(',')[0] }}</div>
                  <div class="cert-sig-line" />
                  <div class="cert-sig-title">{{ activeConfig.sigLeftName }}</div>
                  <div class="cert-sig-role">{{ activeConfig.sigLeftTitle }}</div>
                  <div class="cert-sig-org">{{ activeConfig.sigLeftOrg }}</div>
                </div>

                <div class="cert-gold-seal">
                  <div class="cert-seal-teeth" />
                  <div class="cert-seal-inner">
                    <span class="cert-seal-star">{{ activeConfig.sealBadgeText }}</span>
                    <span class="cert-seal-text">{{ activeConfig.sealSubtext }}</span>
                  </div>
                  <div class="cert-seal-ribbon ribbon-left" />
                  <div class="cert-seal-ribbon ribbon-right" />
                </div>

                <div class="cert-sig-block">
                  <div class="cert-sig-name">{{ activeConfig.sigRightName.split(',')[0] }}</div>
                  <div class="cert-sig-line" />
                  <div class="cert-sig-title">{{ activeConfig.sigRightName }}</div>
                  <div class="cert-sig-role">{{ activeConfig.sigRightTitle }}</div>
                  <div class="cert-sig-org">{{ activeConfig.sigRightOrg }}</div>
                </div>
              </div>

              <!-- Verification footer -->
              <div class="cert-foot-row">
                <span>Issued: {{ certificate.completedDate }}</span>
                <span class="cert-id-tag">ID: {{ certificate.certificateId }}</span>
                <span>{{ activeConfig.verificationUrl }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Action Toolbar -->
      <div class="cert-actions">
        <button
          class="btn btn-primary cert-download-btn"
          :disabled="downloading"
          @click="onDownload"
        >
          <span v-if="!downloading">📥 Download PDF Certificate</span>
          <span v-else>⏳ Generating PDF…</span>
        </button>

        <button class="btn btn-ghost" :disabled="downloading" @click="onPrint">
          🖨️ Print PDF
        </button>

        <button class="btn btn-ghost" @click="copyCertId">
          {{ copied ? '✓ ID Copied' : '📋 Copy ID' }}
        </button>

        <button class="btn btn-ghost" style="margin-left: auto" @click="emit('close')">
          Done
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cert-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(8, 11, 20, 0.82);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  overflow-y: auto;
}

.cert-modal-container {
  position: relative;
  width: 100%;
  max-width: 820px;
  background: #0f1422;
  border: 1px solid rgba(212, 175, 55, 0.28);
  border-radius: 20px;
  padding: 28px 32px;
  box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 30px rgba(212, 175, 55, 0.12);
  color: #f1f5f9;
  animation: modalPop 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes modalPop {
  0% {
    opacity: 0;
    transform: scale(0.94) translateY(12px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.cert-modal-close {
  position: absolute;
  top: 20px;
  right: 20px;
  background: rgba(255, 255, 255, 0.08);
  border: none;
  color: #94a3b8;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  font-size: 14px;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: all 0.15s ease;
}

.cert-modal-close:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.cert-header {
  text-align: center;
  margin-bottom: 22px;
}

.cert-trophy-badge {
  font-size: 40px;
  line-height: 1;
  margin-bottom: 8px;
  filter: drop-shadow(0 4px 12px rgba(212, 175, 55, 0.35));
}

.cert-kicker {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #d4af37;
  margin-bottom: 4px;
}

.cert-title {
  font-size: 24px;
  font-weight: 700;
  color: #f8fafc;
  margin-bottom: 6px;
}

.cert-subtitle {
  font-size: 13.5px;
  color: #94a3b8;
  max-width: 580px;
  margin: 0 auto;
}

.cert-subtitle strong {
  color: #e2e8f0;
}

/* Realistic Preview Canvas Paper */
.cert-preview-wrapper {
  margin: 0 auto 24px;
  perspective: 1000px;
}

.custom-pdf-preview-box {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: #0b1120;
  min-height: 430px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.custom-pdf-iframe {
  width: 100%;
  height: 440px;
  border: none;
  display: block;
  background: #ffffff;
}

.custom-pdf-status {
  padding: 24px;
  font-size: 13.5px;
  color: #94a3b8;
  text-align: center;
}

.custom-pdf-status.error {
  color: #f87171;
}

.cert-paper {
  background: #fdfbf7;
  color: #0f172a;
  border-radius: 12px;
  padding: 16px;
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
  padding: 22px 24px 18px;
  text-align: center;
}

.cert-corner {
  position: absolute;
  color: #c5a059;
  font-size: 10px;
  line-height: 1;
}

.corner-tl { top: 4px; left: 4px; }
.corner-tr { top: 4px; right: 4px; }
.corner-bl { bottom: 4px; left: 4px; }
.corner-br { bottom: 4px; right: 4px; }

.cert-brand-logo {
  display: block;
  height: 28px;
  width: auto;
  margin: 0 auto 6px;
  object-fit: contain;
}

.cert-brand-line {
  font-size: 9px;
  letter-spacing: 0.18em;
  color: #64748b;
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.cert-main-kicker {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 21px;
  font-weight: bold;
  letter-spacing: 0.05em;
  color: #0f172a;
  margin-bottom: 4px;
}

.cert-sub-kicker {
  font-size: 8.5px;
  letter-spacing: 0.16em;
  color: #94a3b8;
  text-transform: uppercase;
  margin-bottom: 10px;
}

.cert-recipient {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 25px;
  font-weight: bold;
  font-style: italic;
  color: #1e293b;
  margin-bottom: 4px;
}

.cert-line-divider {
  width: 140px;
  height: 2px;
  background: #c5a059;
  margin: 0 auto 8px;
}

.cert-dept-tag {
  font-size: 9px;
  color: #64748b;
  margin-bottom: 6px;
  font-style: italic;
}

.cert-body-text {
  font-size: 11px;
  color: #475569;
  margin-bottom: 8px;
  max-width: 520px;
  margin-left: auto;
  margin-right: auto;
}

.cert-course-name {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 17px;
  font-weight: bold;
  color: #1e3a8a;
  margin-bottom: 3px;
}

.cert-course-meta {
  font-size: 9px;
  color: #64748b;
  margin-bottom: 16px;
}

/* Bottom elements */
.cert-bottom-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: 14px;
  padding: 0 14px;
}

.cert-sig-block {
  text-align: center;
  width: 155px;
}

.cert-sig-name {
  font-family: Georgia, 'Times New Roman', cursive, serif;
  font-style: italic;
  font-size: 14px;
  color: #0f172a;
  margin-bottom: 2px;
}

.cert-sig-line {
  width: 100%;
  height: 1px;
  background: #0f172a;
  margin-bottom: 4px;
}

.cert-sig-title {
  font-size: 8.5px;
  font-weight: bold;
  color: #1e293b;
}

.cert-sig-role {
  font-size: 7.5px;
  color: #64748b;
}

.cert-sig-org {
  font-size: 7px;
  color: #94a3b8;
}

/* Gold Seal Emblem */
.cert-gold-seal {
  position: relative;
  width: 60px;
  height: 60px;
  display: grid;
  place-items: center;
}

.cert-seal-teeth {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: #d4af37;
  box-shadow: 0 0 10px rgba(212, 175, 55, 0.4);
}

.cert-seal-inner {
  position: relative;
  z-index: 2;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #0f172a;
  border: 1.5px solid #ffffff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  text-align: center;
}

.cert-seal-star {
  font-size: 7.5px;
  color: #ffd700;
  font-weight: bold;
}

.cert-seal-text {
  font-size: 5.5px;
  letter-spacing: 0.1em;
  color: #ffffff;
}

.cert-seal-ribbon {
  position: absolute;
  bottom: -10px;
  width: 10px;
  height: 14px;
  background: #c5a059;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 75%, 0 100%);
  z-index: 1;
}

.ribbon-left {
  left: 17px;
  transform: rotate(-10deg);
}

.ribbon-right {
  right: 17px;
  transform: rotate(10deg);
}

.cert-foot-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 7.5px;
  color: #94a3b8;
  margin-top: 14px;
  padding-top: 6px;
  border-top: 1px dashed #cbd5e1;
}

.cert-id-tag {
  font-family: monospace;
  font-weight: bold;
  color: #64748b;
}

/* Toolbar actions */
.cert-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.cert-download-btn {
  font-weight: 600;
  background: linear-gradient(135deg, #dd3333, #b91c1c);
  box-shadow: 0 4px 14px rgba(221, 51, 51, 0.36);
}

@media (max-width: 680px) {
  .cert-modal-container {
    padding: 20px 16px;
  }
  .cert-bottom-row {
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .cert-gold-seal {
    order: -1;
    margin-bottom: 8px;
  }
}
</style>
