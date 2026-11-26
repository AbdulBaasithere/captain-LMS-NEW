import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export interface PdfFieldStyle {
  enabled: boolean
  xPct: number
  yPct: number
  fontSize: number
  color: string
  align?: 'left' | 'center' | 'right'
}

export interface PdfOverlayFields {
  recipientName: PdfFieldStyle
  courseTitle: PdfFieldStyle
  completedDate: PdfFieldStyle
  certificateId: PdfFieldStyle
  department: PdfFieldStyle
}

export interface StampCertificatePayload {
  userName: string
  courseTitle: string
  completedDate: string
  certificateId: string
  userDepartment?: string
}

export function encodePdfBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

export function decodeBase64ToPdfBytes(base64: string): Uint8Array {
  const clean = base64.replace(/^data:application\/pdf;base64,/, '').trim()
  const binary = atob(clean)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function hexToPdfRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim()
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return {
      r: parseInt(clean.slice(0, 2), 16) / 255,
      g: parseInt(clean.slice(2, 4), 16) / 255,
      b: parseInt(clean.slice(4, 6), 16) / 255,
    }
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return {
      r: parseInt(clean[0]! + clean[0]!, 16) / 255,
      g: parseInt(clean[1]! + clean[1]!, 16) / 255,
      b: parseInt(clean[2]! + clean[2]!, 16) / 255,
    }
  }
  return { r: 15 / 255, g: 23 / 255, b: 42 / 255 }
}

/**
 * Standard PDF fonts in pdf-lib use WinAnsi encoding (Latin-1 + Windows-1252).
 * Strip/map unsupported symbols cleanly so arbitrary user/course names never throw.
 */
export function sanitizeWinAnsiText(input: string): string {
  return input
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
    .trim()
}

export async function inspectPdfTemplate(bytes: Uint8Array): Promise<{
  valid: boolean
  pageCount: number
  widthPt: number
  heightPt: number
  error?: string
}> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
    const pages = doc.getPages()
    if (!pages.length) {
      return { valid: false, pageCount: 0, widthPt: 0, heightPt: 0, error: 'PDF has no pages.' }
    }
    const { width, height } = pages[0]!.getSize()
    return {
      valid: true,
      pageCount: pages.length,
      widthPt: Math.round(width),
      heightPt: Math.round(height),
    }
  } catch (err) {
    return {
      valid: false,
      pageCount: 0,
      widthPt: 0,
      heightPt: 0,
      error: err instanceof Error ? err.message : 'Invalid PDF file.',
    }
  }
}

export async function stampCertificateOnPdfTemplate(
  templateBytes: Uint8Array,
  payload: StampCertificatePayload,
  fields: PdfOverlayFields,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true })
  const pages = pdfDoc.getPages()
  const page = pages[0]
  if (!page) {
    throw new Error('Uploaded PDF template does not contain any pages.')
  }

  // Keep only the first slide/page if user uploaded a multi-page deck exported to PDF
  while (pdfDoc.getPageCount() > 1) {
    pdfDoc.removePage(pdfDoc.getPageCount() - 1)
  }

  const { width, height } = page.getSize()
  const fontName = await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const entries: {
    key: keyof PdfOverlayFields
    text: string
    font: typeof fontName
  }[] = [
    { key: 'recipientName', text: payload.userName, font: fontName },
    { key: 'courseTitle', text: payload.courseTitle, font: fontBold },
    { key: 'completedDate', text: payload.completedDate, font: fontRegular },
    { key: 'certificateId', text: `ID: ${payload.certificateId}`, font: fontRegular },
    {
      key: 'department',
      text: payload.userDepartment ? `Department: ${payload.userDepartment}` : '',
      font: fontRegular,
    },
  ]

  const maxLineWidth = Math.max(80, width * 0.84)

  for (const entry of entries) {
    const style = fields[entry.key]
    if (!style?.enabled) continue
    const cleanText = sanitizeWinAnsiText(entry.text)
    if (!cleanText) continue

    let fontSize = Math.max(6, Math.min(72, style.fontSize || 14))
    let textWidth = entry.font.widthOfTextAtSize(cleanText, fontSize)
    while (textWidth > maxLineWidth && fontSize > 7) {
      fontSize -= 0.5
      textWidth = entry.font.widthOfTextAtSize(cleanText, fontSize)
    }

    const anchorX = (Math.max(0, Math.min(100, style.xPct)) / 100) * width
    const align = style.align ?? 'center'
    const rawX =
      align === 'left'
        ? anchorX
        : align === 'right'
          ? anchorX - textWidth
          : anchorX - textWidth / 2
    const x = Math.max(12, Math.min(width - textWidth - 12, rawX))
    const yFromTop = (Math.max(0, Math.min(100, style.yPct)) / 100) * height
    const y = Math.max(12, Math.min(height - fontSize, height - yFromTop - fontSize * 0.35))

    const colorRgb = hexToPdfRgb(style.color)
    page.drawText(cleanText, {
      x,
      y,
      size: fontSize,
      font: entry.font,
      color: rgb(colorRgb.r, colorRgb.g, colorRgb.b),
    })
  }

  return await pdfDoc.save()
}
