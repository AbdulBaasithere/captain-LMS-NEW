import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument, rgb } from 'pdf-lib'
import {
  decodeBase64ToPdfBytes,
  encodePdfBytesToBase64,
  hexToPdfRgb,
  inspectPdfTemplate,
  sanitizeWinAnsiText,
  stampCertificateOnPdfTemplate,
  type PdfOverlayFields,
} from '../src/lib/pdfTemplateStamp.ts'

async function createSampleLandscapeTemplateBytes(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([842, 595]) // A4 landscape
    page.drawRectangle({
      x: 20,
      y: 20,
      width: 802,
      height: 555,
      borderColor: rgb(0.1, 0.2, 0.4),
      borderWidth: 2,
    })
  }
  return await doc.save()
}

const sampleFields: PdfOverlayFields = {
  recipientName: { enabled: true, xPct: 50, yPct: 47, fontSize: 28, color: '#0f172a' },
  courseTitle: { enabled: true, xPct: 50, yPct: 60, fontSize: 18, color: '#1e3a8a' },
  completedDate: { enabled: true, xPct: 24, yPct: 82, fontSize: 11, color: '#334155' },
  certificateId: { enabled: true, xPct: 76, yPct: 82, fontSize: 10, color: '#475569' },
  department: { enabled: true, xPct: 50, yPct: 53, fontSize: 11, color: '#64748b' },
}

test('base64 roundtrip preserves uploaded PDF template bytes cleanly', async () => {
  const original = await createSampleLandscapeTemplateBytes(1)
  const b64 = encodePdfBytesToBase64(original)
  const restored = decodeBase64ToPdfBytes(b64)

  assert.equal(restored.length, original.length)
  assert.deepEqual(restored, original)

  const info = await inspectPdfTemplate(restored)
  assert.equal(info.valid, true)
  assert.equal(info.pageCount, 1)
  assert.equal(info.widthPt, 842)
  assert.equal(info.heightPt, 595)
})

test('stampCertificateOnPdfTemplate stamps single-page output and preserves template dimensions', async () => {
  const templateBytes = await createSampleLandscapeTemplateBytes(2)
  const stamped = await stampCertificateOnPdfTemplate(
    templateBytes,
    {
      userName: 'Elena Rostova — ★',
      courseTitle: 'Maritime Safety & Compliance “2026”',
      completedDate: 'November 12, 2026',
      certificateId: 'CAP-2026-AB12-CD34',
      userDepartment: 'Operations',
    },
    sampleFields,
  )

  const header = new TextDecoder().decode(stamped.subarray(0, 5))
  assert.equal(header, '%PDF-')

  const parsed = await PDFDocument.load(stamped)
  assert.equal(parsed.getPageCount(), 1)
  const size = parsed.getPage(0).getSize()
  assert.equal(Math.round(size.width), 842)
  assert.equal(Math.round(size.height), 595)
})

test('sanitizeWinAnsiText normalizes smart quotes/dashes and strips unsupported emojis', () => {
  assert.equal(
    sanitizeWinAnsiText('“Leader’s — Guide” 🚀…'),
    '"Leader\'s - Guide" ...',
  )
})

test('hexToPdfRgb parses 6-digit, 3-digit, and invalid hex codes safely', () => {
  const c6 = hexToPdfRgb('#1e3a8a')
  assert.ok(Math.abs(c6.r - 30 / 255) < 1e-6)
  assert.ok(Math.abs(c6.g - 58 / 255) < 1e-6)
  assert.ok(Math.abs(c6.b - 138 / 255) < 1e-6)

  const c3 = hexToPdfRgb('#fff')
  assert.deepEqual(c3, { r: 1, g: 1, b: 1 })

  const fallback = hexToPdfRgb('not-a-color')
  assert.deepEqual(fallback, { r: 15 / 255, g: 23 / 255, b: 42 / 255 })
})

test('inspectPdfTemplate gracefully rejects corrupt bytes', async () => {
  const res = await inspectPdfTemplate(new Uint8Array([1, 2, 3, 4, 5]))
  assert.equal(res.valid, false)
  assert.ok(res.error && res.error.length > 0)
})

test('stampCertificateOnPdfTemplate supports left, center, and right alignment anchors cleanly', async () => {
  const templateBytes = await createSampleLandscapeTemplateBytes(1)
  const alignedFields: PdfOverlayFields = {
    recipientName: { enabled: true, xPct: 10, yPct: 40, fontSize: 24, color: '#0f172a', align: 'left' },
    courseTitle: { enabled: true, xPct: 50, yPct: 55, fontSize: 18, color: '#1e3a8a', align: 'center' },
    completedDate: { enabled: true, xPct: 90, yPct: 80, fontSize: 11, color: '#334155', align: 'right' },
    certificateId: { enabled: false, xPct: 76, yPct: 82, fontSize: 10, color: '#475569', align: 'center' },
    department: { enabled: false, xPct: 50, yPct: 53, fontSize: 11, color: '#64748b', align: 'center' },
  }

  const stamped = await stampCertificateOnPdfTemplate(
    templateBytes,
    {
      userName: 'Jordan Taylor',
      courseTitle: 'Safety Leadership',
      completedDate: 'November 12, 2026',
      certificateId: 'CAP-2026-TEST',
    },
    alignedFields,
  )

  const parsed = await PDFDocument.load(stamped)
  assert.equal(parsed.getPageCount(), 1)
})
