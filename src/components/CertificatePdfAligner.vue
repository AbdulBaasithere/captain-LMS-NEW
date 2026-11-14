<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { decodeBase64ToPdfBytes, type PdfOverlayFields, type StampCertificatePayload } from '@/lib/pdfTemplateStamp'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export type OverlayFieldKey = keyof PdfOverlayFields

const FIELD_LABELS: Record<OverlayFieldKey, string> = {
  recipientName: 'Employee Name',
  courseTitle: 'Course Title',
  completedDate: 'Completion Date',
  certificateId: 'Verification ID',
  department: 'Department',
}

const props = defineProps<{
  pdfBase64: string
  fields: PdfOverlayFields
  sampleData: StampCertificatePayload
  selectedField: OverlayFieldKey
}>()

const emit = defineEmits<{
  (e: 'update:selectedField', key: OverlayFieldKey): void
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const stageRef = ref<HTMLDivElement | null>(null)

const pageWidthPt = ref(842)
const pageHeightPt = ref(595)
const stageWidthPx = ref(560)
const renderError = ref<string | null>(null)
const rendering = ref(false)

const showGrid = ref(true)
const snapEnabled = ref(true)
const isExpanded = ref(false)

const draggingKey = ref<OverlayFieldKey | null>(null)
const activeGuideX = ref<number | null>(null)
const activeGuideY = ref<number | null>(null)

let dragStartPointerX = 0
let dragStartPointerY = 0
let dragStartFieldX = 50
let dragStartFieldY = 50
let renderToken = 0
let resizeObserver: ResizeObserver | null = null

const scaleFactor = computed(() => {
  if (!pageWidthPt.value) return 1
  return stageWidthPx.value / pageWidthPt.value
})

const aspectRatioStyle = computed(() => `${pageWidthPt.value} / ${pageHeightPt.value}`)

const visibleFields = computed(() => {
  const list: {
    key: OverlayFieldKey
    label: string
    text: string
    xPct: number
    yPct: number
    fontSize: number
    color: string
    align: 'left' | 'center' | 'right'
    fontFamily: string
    fontWeight: string
    fontStyle: string
  }[] = []

  const textMap: Record<OverlayFieldKey, string> = {
    recipientName: props.sampleData.userName || 'Employee Name',
    courseTitle: props.sampleData.courseTitle || 'Course Title',
    completedDate: props.sampleData.completedDate || 'Completion Date',
    certificateId: `ID: ${props.sampleData.certificateId || 'CAP-2026-XXXX'}`,
    department: props.sampleData.userDepartment ? `Department: ${props.sampleData.userDepartment}` : 'Department: General',
  }

  const keys: OverlayFieldKey[] = [
    'recipientName',
    'courseTitle',
    'completedDate',
    'certificateId',
    'department',
  ]

  for (const key of keys) {
    const style = props.fields[key]
    if (!style?.enabled) continue
    list.push({
      key,
      label: FIELD_LABELS[key],
      text: textMap[key],
      xPct: style.xPct,
      yPct: style.yPct,
      fontSize: style.fontSize,
      color: style.color,
      align: style.align ?? 'center',
      fontFamily: key === 'recipientName' ? "Georgia, 'Times New Roman', serif" : 'Helvetica, Arial, sans-serif',
      fontWeight: key === 'recipientName' || key === 'courseTitle' ? '700' : '400',
      fontStyle: key === 'recipientName' ? 'italic' : 'normal',
    })
  }
  return list
})

const selectedStyle = computed(() => props.fields[props.selectedField])

function getFieldItemStyle(item: (typeof visibleFields.value)[number]) {
  const translateX =
    item.align === 'left' ? '0%' : item.align === 'right' ? '-100%' : '-50%'
  const pxFontSize = Math.max(7, item.fontSize * scaleFactor.value)
  return {
    left: `${item.xPct}%`,
    top: `${item.yPct}%`,
    transform: `translate(${translateX}, -50%)`,
    fontSize: `${pxFontSize.toFixed(2)}px`,
    color: item.color,
    fontFamily: item.fontFamily,
    fontWeight: item.fontWeight,
    fontStyle: item.fontStyle,
    textAlign: item.align,
  }
}

function roundCoord(val: number): number {
  return Math.round(Math.max(1, Math.min(99, val)) * 10) / 10
}

async function renderPdfBackground() {
  if (!props.pdfBase64 || !canvasRef.value) return
  const token = ++renderToken
  rendering.value = true
  renderError.value = null

  try {
    const bytes = decodeBase64ToPdfBytes(props.pdfBase64)
    const loadingTask = pdfjsLib.getDocument({ data: bytes })
    const pdf = await loadingTask.promise
    if (token !== renderToken) return

    const page = await pdf.getPage(1)
    if (token !== renderToken) return

    const baseViewport = page.getViewport({ scale: 1 })
    pageWidthPt.value = baseViewport.width
    pageHeightPt.value = baseViewport.height

    // Render at crisp 2x scale (clamped to keep canvas responsive)
    const desiredScale = Math.min(2.5, Math.max(1.5, 1400 / baseViewport.width))
    const viewport = page.getViewport({ scale: desiredScale })

    const canvas = canvasRef.value
    if (!canvas) return
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    await page.render({
      canvasContext: ctx,
      viewport,
      canvas,
    }).promise
  } catch (err) {
    if (token === renderToken) {
      renderError.value = err instanceof Error ? err.message : 'Unable to render PDF background.'
    }
  } finally {
    if (token === renderToken) {
      rendering.value = false
    }
  }
}

function updateStageMetrics() {
  if (stageRef.value) {
    stageWidthPx.value = stageRef.value.clientWidth || 560
  }
}

onMounted(() => {
  updateStageMetrics()
  if (stageRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateStageMetrics()
    })
    resizeObserver.observe(stageRef.value)
  }
  void renderPdfBackground()
})

watch(
  () => props.pdfBase64,
  () => {
    void renderPdfBackground()
  },
)

onBeforeUnmount(() => {
  renderToken++
  resizeObserver?.disconnect()
})

function onFieldPointerDown(key: OverlayFieldKey, event: PointerEvent) {
  event.preventDefault()
  event.stopPropagation()

  emit('update:selectedField', key)
  const target = event.currentTarget as HTMLElement | null
  target?.focus()
  target?.setPointerCapture?.(event.pointerId)

  const style = props.fields[key]
  if (!style) return

  draggingKey.value = key
  dragStartPointerX = event.clientX
  dragStartPointerY = event.clientY
  dragStartFieldX = style.xPct
  dragStartFieldY = style.yPct
}

function computeSnappedCoords(
  key: OverlayFieldKey,
  rawX: number,
  rawY: number,
): { x: number; y: number; guideX: number | null; guideY: number | null } {
  let x = roundCoord(rawX)
  let y = roundCoord(rawY)
  let guideX: number | null = null
  let guideY: number | null = null

  if (!snapEnabled.value) {
    return { x, y, guideX, guideY }
  }

  const threshold = 0.9
  const candidateX: number[] = [50]
  const candidateY: number[] = [50]

  for (const item of visibleFields.value) {
    if (item.key !== key) {
      candidateX.push(item.xPct)
      candidateY.push(item.yPct)
    }
  }

  let bestDx = threshold
  for (const cx of candidateX) {
    const diff = Math.abs(x - cx)
    if (diff <= bestDx) {
      bestDx = diff
      x = cx
      guideX = cx
    }
  }

  let bestDy = threshold
  for (const cy of candidateY) {
    const diff = Math.abs(y - cy)
    if (diff <= bestDy) {
      bestDy = diff
      y = cy
      guideY = cy
    }
  }

  return { x, y, guideX, guideY }
}

function onFieldPointerMove(key: OverlayFieldKey, event: PointerEvent) {
  if (draggingKey.value !== key || !stageRef.value) return
  const rect = stageRef.value.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  const deltaXPct = ((event.clientX - dragStartPointerX) / rect.width) * 100
  const deltaYPct = ((event.clientY - dragStartPointerY) / rect.height) * 100

  const snapped = computeSnappedCoords(
    key,
    dragStartFieldX + deltaXPct,
    dragStartFieldY + deltaYPct,
  )

  const style = props.fields[key]
  if (!style) return
  style.xPct = snapped.x
  style.yPct = snapped.y
  activeGuideX.value = snapped.guideX
  activeGuideY.value = snapped.guideY
}

function onFieldPointerUp(key: OverlayFieldKey, event: PointerEvent) {
  if (draggingKey.value !== key) return
  const target = event.currentTarget as HTMLElement | null
  if (target?.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }
  draggingKey.value = null
  activeGuideX.value = null
  activeGuideY.value = null
}

function onStageKeyDown(event: KeyboardEvent) {
  const style = props.fields[props.selectedField]
  if (!style || !style.enabled) return

  const step = event.shiftKey ? 2 : event.altKey ? 0.1 : 0.5
  let handled = true

  if (event.key === 'ArrowLeft') {
    style.xPct = roundCoord(style.xPct - step)
  } else if (event.key === 'ArrowRight') {
    style.xPct = roundCoord(style.xPct + step)
  } else if (event.key === 'ArrowUp') {
    style.yPct = roundCoord(style.yPct - step)
  } else if (event.key === 'ArrowDown') {
    style.yPct = roundCoord(style.yPct + step)
  } else {
    handled = false
  }

  if (handled) {
    event.preventDefault()
  }
}

function centerSelectedHorizontally() {
  const style = props.fields[props.selectedField]
  if (!style) return
  style.align = 'center'
  style.xPct = 50
}

function setSelectedAlign(align: 'left' | 'center' | 'right') {
  const style = props.fields[props.selectedField]
  if (!style) return
  style.align = align
}

function nudgeSelected(dx: number, dy: number) {
  const style = props.fields[props.selectedField]
  if (!style) return
  style.xPct = roundCoord(style.xPct + dx)
  style.yPct = roundCoord(style.yPct + dy)
}
</script>

<template>
  <div v-if="isExpanded" class="expanded-backdrop" @click="isExpanded = false" />

  <div class="aligner-shell" :class="{ 'is-expanded': isExpanded }">
    <!-- Top Alignment Toolbar -->
    <div class="aligner-toolbar">
      <div class="aligner-field-badge">
        <span class="dot" />
        <strong>{{ FIELD_LABELS[selectedField] }}</strong>
        <code class="coords-pill">
          X: {{ selectedStyle?.xPct.toFixed(1) }}% · Y: {{ selectedStyle?.yPct.toFixed(1) }}%
        </code>
      </div>

      <div class="aligner-tools">
        <div class="btn-group" title="Text anchor alignment">
          <button
            type="button"
            class="tool-btn"
            :class="{ active: (selectedStyle?.align ?? 'center') === 'left' }"
            @click="setSelectedAlign('left')"
          >
            ⬅ Left
          </button>
          <button
            type="button"
            class="tool-btn"
            :class="{ active: (selectedStyle?.align ?? 'center') === 'center' }"
            @click="setSelectedAlign('center')"
          >
            ↔ Center
          </button>
          <button
            type="button"
            class="tool-btn"
            :class="{ active: (selectedStyle?.align ?? 'center') === 'right' }"
            @click="setSelectedAlign('right')"
          >
            Right ➡
          </button>
        </div>

        <button
          type="button"
          class="tool-btn"
          title="Snap selected field horizontally to exact 50% center"
          @click="centerSelectedHorizontally"
        >
          ⌖ Center X=50%
        </button>

        <button
          type="button"
          class="tool-btn"
          :class="{ active: showGrid }"
          @click="showGrid = !showGrid"
        >
          # Grid
        </button>

        <button
          type="button"
          class="tool-btn"
          :class="{ active: snapEnabled }"
          @click="snapEnabled = !snapEnabled"
        >
          🧲 Snap
        </button>

        <button
          type="button"
          class="tool-btn expand-btn"
          @click="isExpanded = !isExpanded"
        >
          {{ isExpanded ? '✕ Exit Large View' : '⛶ Expand to Align' }}
        </button>
      </div>
    </div>

    <!-- Expanded Quick Fine-Tune Strip (shown when in Large View for effortless live editing) -->
    <div v-if="isExpanded && selectedStyle" class="expanded-controls-strip">
      <div class="strip-field-pills">
        <button
          v-for="item in visibleFields"
          :key="item.key"
          type="button"
          class="tool-btn"
          :class="{ active: selectedField === item.key }"
          @click="emit('update:selectedField', item.key)"
        >
          {{ item.label }}
        </button>
      </div>

      <div class="strip-sliders">
        <label class="strip-control">
          <span>X %</span>
          <input v-model.number="selectedStyle.xPct" type="range" min="2" max="98" step="0.5" />
          <input v-model.number="selectedStyle.xPct" type="number" min="0" max="100" step="0.5" class="mini-num" />
        </label>
        <label class="strip-control">
          <span>Y %</span>
          <input v-model.number="selectedStyle.yPct" type="range" min="2" max="98" step="0.5" />
          <input v-model.number="selectedStyle.yPct" type="number" min="0" max="100" step="0.5" class="mini-num" />
        </label>
        <label class="strip-control">
          <span>Size</span>
          <input v-model.number="selectedStyle.fontSize" type="range" min="6" max="56" step="1" />
          <input v-model.number="selectedStyle.fontSize" type="number" min="6" max="60" step="1" class="mini-num" />
        </label>
        <label class="strip-control">
          <span>Color</span>
          <input v-model="selectedStyle.color" type="color" class="mini-color" />
        </label>
      </div>
    </div>

    <!-- Interactive Certificate Canvas Stage -->
    <div class="stage-viewport">
      <div
        ref="stageRef"
        class="pdf-stage"
        :style="{ aspectRatio: aspectRatioStyle }"
        tabindex="0"
        @keydown="onStageKeyDown"
      >
        <canvas ref="canvasRef" class="pdf-bg-canvas" />

        <div v-if="rendering" class="stage-overlay-msg">
          Rendering certificate template…
        </div>
        <div v-else-if="renderError" class="stage-overlay-msg error">
          {{ renderError }}
        </div>

        <!-- Optional Alignment Grid & Center Crosshair -->
        <div v-if="showGrid" class="grid-overlay" aria-hidden="true">
          <div class="grid-center-v" />
          <div class="grid-center-h" />
        </div>

        <!-- Live Smart Snap Guide Lines -->
        <div
          v-if="activeGuideX !== null"
          class="snap-guide-v"
          :style="{ left: `${activeGuideX}%` }"
        />
        <div
          v-if="activeGuideY !== null"
          class="snap-guide-h"
          :style="{ top: `${activeGuideY}%` }"
        />

        <!-- Draggable Certificate Text Fields -->
        <div
          v-for="item in visibleFields"
          :key="item.key"
          class="drag-field"
          :class="{
            selected: selectedField === item.key,
            dragging: draggingKey === item.key,
          }"
          :style="getFieldItemStyle(item)"
          tabindex="0"
          :title="`Drag to move ${item.label} (or use Arrow keys to nudge)`"
          @pointerdown="onFieldPointerDown(item.key, $event)"
          @pointermove="onFieldPointerMove(item.key, $event)"
          @pointerup="onFieldPointerUp(item.key, $event)"
          @pointercancel="onFieldPointerUp(item.key, $event)"
          @keydown="onStageKeyDown"
        >
          <span class="drag-tag">{{ item.label }}</span>
          <span class="drag-text">{{ item.text }}</span>
        </div>
      </div>
    </div>

    <!-- Bottom Helper & Nudge Bar -->
    <div class="aligner-footer">
      <span class="sub" style="font-size: 11px">
        💡 Drag any text directly on your template, or click a field and press <b>Arrow keys</b> (hold <b>Shift</b> for big steps, <b>Alt</b> for micro steps).
      </span>

      <div v-if="selectedStyle" class="nudge-pad">
        <button type="button" class="nudge-btn" title="Nudge Left 0.5%" @click="nudgeSelected(-0.5, 0)">◀</button>
        <button type="button" class="nudge-btn" title="Nudge Up 0.5%" @click="nudgeSelected(0, -0.5)">▲</button>
        <button type="button" class="nudge-btn" title="Nudge Down 0.5%" @click="nudgeSelected(0, 0.5)">▼</button>
        <button type="button" class="nudge-btn" title="Nudge Right 0.5%" @click="nudgeSelected(0.5, 0)">▶</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.expanded-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1190;
  background: rgba(6, 9, 17, 0.85);
  backdrop-filter: blur(6px);
}

.aligner-shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: rgba(15, 23, 42, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  padding: 12px;
}

.aligner-shell.is-expanded {
  position: fixed;
  inset: 20px;
  z-index: 1200;
  background: #0b1120;
  border: 1px solid rgba(212, 175, 55, 0.45);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.75);
  padding: 16px 20px;
  overflow: auto;
}

.aligner-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.aligner-field-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: #f8fafc;
}

.aligner-field-badge .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #38bdf8;
  box-shadow: 0 0 8px #38bdf8;
}

.coords-pill {
  font-family: monospace;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #bae6fd;
}

.aligner-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.btn-group {
  display: inline-flex;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.btn-group .tool-btn {
  border: none;
  border-radius: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.12);
}

.btn-group .tool-btn:last-child {
  border-right: none;
}

.tool-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #cbd5e1;
  font-size: 11px;
  font-weight: 600;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.tool-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #ffffff;
}

.tool-btn.active {
  background: rgba(37, 99, 235, 0.28);
  border-color: #3b82f6;
  color: #93c5fd;
}

.expand-btn {
  border-color: rgba(212, 175, 55, 0.45);
  color: #fde68a;
}

.expanded-controls-strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.strip-field-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.strip-sliders {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
}

.strip-control {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: #cbd5e1;
}

.strip-control input[type='range'] {
  width: 110px;
}

.mini-num {
  width: 62px;
  padding: 3px 6px;
  font-size: 12px;
}

.mini-color {
  width: 34px;
  height: 26px;
  padding: 1px;
  cursor: pointer;
}

.stage-viewport {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  flex: 1;
  min-height: 0;
}

.pdf-stage {
  position: relative;
  width: 100%;
  max-width: 100%;
  background: #ffffff;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.48);
  user-select: none;
  outline: none;
}

.aligner-shell.is-expanded .pdf-stage {
  max-width: 1040px;
  max-height: calc(100vh - 230px);
}

.pdf-bg-canvas {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.stage-overlay-msg {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.72);
  color: #e2e8f0;
  font-size: 13px;
  z-index: 10;
}

.stage-overlay-msg.error {
  color: #fca5a5;
}

.grid-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(37, 99, 235, 0.12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(37, 99, 235, 0.12) 1px, transparent 1px);
  background-size: 10% 10%;
  z-index: 2;
}

.grid-center-v {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  border-left: 1px dashed rgba(37, 99, 235, 0.45);
}

.grid-center-h {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  border-top: 1px dashed rgba(37, 99, 235, 0.45);
}

.snap-guide-v {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  border-left: 1.5px dashed #0ea5e9;
  box-shadow: 0 0 6px rgba(14, 165, 233, 0.7);
  pointer-events: none;
  z-index: 4;
}

.snap-guide-h {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  border-top: 1.5px dashed #0ea5e9;
  box-shadow: 0 0 6px rgba(14, 165, 233, 0.7);
  pointer-events: none;
  z-index: 4;
}

.drag-field {
  position: absolute;
  z-index: 5;
  cursor: grab;
  white-space: nowrap;
  line-height: 1.15;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px dashed rgba(14, 165, 233, 0.35);
  touch-action: none;
  transition: border-color 0.1s ease, background-color 0.1s ease;
}

.drag-field:hover {
  border-color: rgba(14, 165, 233, 0.85);
  background: rgba(14, 165, 233, 0.08);
}

.drag-field.selected {
  border: 1.5px solid #2563eb;
  background: rgba(37, 99, 235, 0.12);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.22);
  z-index: 6;
}

.drag-field.dragging {
  cursor: grabbing;
  background: rgba(37, 99, 235, 0.18);
  z-index: 8;
}

.drag-tag {
  position: absolute;
  top: -17px;
  left: 50%;
  transform: translateX(-50%);
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 9.5px;
  font-weight: 700;
  font-style: normal;
  background: #1d4ed8;
  color: #ffffff;
  padding: 1px 6px;
  border-radius: 4px;
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
}

.drag-field.selected .drag-tag,
.drag-field:hover .drag-tag {
  opacity: 1;
}

.aligner-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.nudge-pad {
  display: inline-flex;
  gap: 4px;
}

.nudge-btn {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #e2e8f0;
  font-size: 11px;
  width: 26px;
  height: 24px;
  border-radius: 5px;
  cursor: pointer;
  display: grid;
  place-items: center;
}

.nudge-btn:hover {
  background: rgba(59, 130, 246, 0.35);
  border-color: #60a5fa;
}
</style>
