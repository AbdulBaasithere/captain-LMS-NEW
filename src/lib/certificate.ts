import { jsPDF } from 'jspdf'
import type { CourseVM, CourseProgress } from './courses'
import type { VideoCompletion } from './database.types'
import { getCertificateConfig, type CertificateCustomization } from './certificateConfig'
import { decodeBase64ToPdfBytes, stampCertificateOnPdfTemplate } from './pdfTemplateStamp'

export interface CertificateData {
  userName: string
  userEmail?: string
  userDepartment?: string
  courseTitle: string
  courseCategory?: string
  completedDate: string
  certificateId: string
  totalLessons: number
  totalMinutes: number
}

/**
 * Generate a deterministic verification code for a course completion.
 */
export function generateCertificateId(userId: string, courseId: string | number): string {
  const seed = `${userId}:${courseId}`
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  const hex = Math.abs(hash).toString(16).toUpperCase().padStart(8, '0')
  const year = new Date().getFullYear()
  return `CAP-${year}-${hex.slice(0, 4)}-${hex.slice(4, 8)}`
}

/**
 * Extract completion date for a course from its lessons' video_completions.
 */
export function getCourseCompletionDate(course: CourseVM, completions: VideoCompletion[]): string {
  const lessonIds = new Set(course.lessons.map((l) => l.id))
  const courseComps = completions.filter((c) => lessonIds.has(c.module_id) && c.completed)

  let latest = 0
  for (const c of courseComps) {
    const t = c.completed_at ? new Date(c.completed_at).getTime() : 0
    if (t > latest) latest = t
  }

  const d = latest > 0 ? new Date(latest) : new Date()
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * Builds certificate data from course VM and profile.
 */
export function buildCertificateData(
  course: CourseVM,
  progress: CourseProgress,
  profile: { id: string; full_name?: string | null; email?: string | null; department?: string | null },
  completions: VideoCompletion[] = [],
): CertificateData {
  const userName = profile.full_name?.trim() || profile.email?.split('@')[0] || 'Learner'
  const certId = generateCertificateId(profile.id, course.id)
  const completedDate = getCourseCompletionDate(course, completions)

  return {
    userName,
    userEmail: profile.email ?? undefined,
    userDepartment: profile.department ?? undefined,
    courseTitle: course.title,
    courseCategory: course.category || 'General Training',
    completedDate,
    certificateId: certId,
    totalLessons: progress.total || course.lessons.length,
    totalMinutes: progress.minutes,
  }
}



/**
 * Draws a high-fidelity vector PDF Certificate of Completion using jsPDF according to the active configuration.
 */
export function createCertificateDoc(data: CertificateData, customConfig?: CertificateCustomization): jsPDF {
  const config = customConfig || getCertificateConfig()

  // A4 Landscape: 297mm x 210mm
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  })

  const pageWidth = 297
  const pageHeight = 210

  // Palette resolution based on templateId
  let primaryRgb: [number, number, number] = [15, 23, 42]
  let accentRgb: [number, number, number] = [197, 160, 89]
  let bgRgb: [number, number, number] = [253, 252, 248]

  if (config.templateId === 'modern-emerald') {
    primaryRgb = [15, 23, 42]
    accentRgb = [5, 150, 105] // #059669
    bgRgb = [255, 255, 255]
  } else if (config.templateId === 'royal-elegance') {
    primaryRgb = [88, 28, 38] // #581C26 Burgundy
    accentRgb = [197, 160, 89] // #C5A059 Gold
    bgRgb = [250, 247, 242]
  } else if (config.templateId === 'tech-midnight') {
    primaryRgb = [11, 15, 25] // #0B0F19
    accentRgb = [2, 132, 199] // #0284C7 Sky/Cyan
    bgRgb = [248, 250, 252]
  }

  // 1. Background Fill
  doc.setFillColor(...bgRgb)
  doc.rect(0, 0, pageWidth, pageHeight, 'F')

  // 2. Decorative Outer Borders
  doc.setDrawColor(...primaryRgb)
  doc.setLineWidth(1.6)
  doc.rect(9, 9, pageWidth - 18, pageHeight - 18, 'S')

  // Inner rich accent frame
  doc.setDrawColor(...accentRgb)
  doc.setLineWidth(0.6)
  doc.rect(12.5, 12.5, pageWidth - 25, pageHeight - 25, 'S')

  // Third subtle hairline border
  doc.setDrawColor(226, 232, 240)
  doc.setLineWidth(0.25)
  doc.rect(14.5, 14.5, pageWidth - 29, pageHeight - 29, 'S')

  // 3. Ornate Corner Embellishments
  const drawCorner = (x: number, y: number, xFlip: number, yFlip: number) => {
    doc.setDrawColor(...accentRgb)
    doc.setFillColor(...accentRgb)
    doc.setLineWidth(0.8)

    // Corner L-lines
    doc.line(x, y, x + 12 * xFlip, y)
    doc.line(x, y, x, y + 12 * yFlip)

    // Corner diamond / geometric accent
    const dx = x + 3 * xFlip
    const dy = y + 3 * yFlip
    doc.triangle(dx, dy - 1.5 * yFlip, dx + 1.5 * xFlip, dy, dx - 1.5 * xFlip, dy, 'FD')
    doc.triangle(dx, dy + 1.5 * yFlip, dx + 1.5 * xFlip, dy, dx - 1.5 * xFlip, dy, 'FD')
  }

  drawCorner(15.5, 15.5, 1, 1)
  drawCorner(pageWidth - 15.5, 15.5, -1, 1)
  drawCorner(15.5, pageHeight - 15.5, 1, -1)
  drawCorner(pageWidth - 15.5, pageHeight - 15.5, -1, -1)

  // 4. Header Branding
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(100, 116, 139)
  doc.text(config.organizationName, pageWidth / 2, 25, {
    align: 'center',
  })

  // Accent horizontal divider under brand
  doc.setDrawColor(...accentRgb)
  doc.setLineWidth(0.4)
  doc.line(pageWidth / 2 - 38, 28, pageWidth / 2 + 38, 28)

  // Star in middle of line
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7)
  doc.setTextColor(...accentRgb)
  doc.text('★   ★   ★', pageWidth / 2, 27.5, { align: 'center' })

  // 5. Main Title
  doc.setFont('times', 'bold')
  doc.setFontSize(26)
  doc.setTextColor(...primaryRgb)
  doc.text(config.certificateTitle, pageWidth / 2, 42, { align: 'center' })

  // Kicker
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(148, 163, 184)
  doc.text(config.presentationKicker, pageWidth / 2, 53, { align: 'center' })

  // 6. Recipient Name
  doc.setFont('times', 'bolditalic')
  doc.setFontSize(27)
  doc.setTextColor(20, 30, 55)
  doc.text(data.userName, pageWidth / 2, 70, { align: 'center' })

  // Underline for recipient name
  const nameWidth = Math.min(180, Math.max(90, doc.getTextWidth(data.userName) + 20))
  doc.setDrawColor(...accentRgb)
  doc.setLineWidth(0.6)
  doc.line(pageWidth / 2 - nameWidth / 2, 73, pageWidth / 2 + nameWidth / 2, 73)

  // Department tag if enabled
  if (config.includeDepartment && data.userDepartment) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(100, 116, 139)
    doc.text(`Department: ${data.userDepartment}`, pageWidth / 2, 78, { align: 'center' })
  }

  // 7. Statement of Completion
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10.5)
  doc.setTextColor(51, 65, 85)
  doc.text(config.completionStatement, pageWidth / 2, 88, { align: 'center' })

  // 8. Course Title (Framed Banner)
  doc.setFillColor(241, 245, 249)
  doc.setDrawColor(203, 213, 225)
  doc.setLineWidth(0.3)
  const courseBoxWidth = 200
  const courseBoxX = (pageWidth - courseBoxWidth) / 2
  doc.roundedRect(courseBoxX, 94, courseBoxWidth, 20, 2, 2, 'FD')

  // Course title text
  doc.setFont('times', 'bold')
  doc.setFontSize(19)
  doc.setTextColor(...primaryRgb)
  doc.text(data.courseTitle, pageWidth / 2, 104, { align: 'center' })

  // Course meta text under title
  if (config.includeStats) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(100, 116, 139)
    const lessonText = `${data.totalLessons} ${data.totalLessons === 1 ? 'Lesson' : 'Lessons'}`
    const timeText = data.totalMinutes > 0 ? ` · ${data.totalMinutes} Minutes` : ''
    doc.text(`${data.courseCategory} · ${lessonText}${timeText} · 100% Mastery Verified`, pageWidth / 2, 110.5, {
      align: 'center',
    })
  }

  // 9. Official Medallion Seal (Center)
  const sealX = pageWidth / 2
  const sealY = 138

  // Outer gold/accent scalloped ring
  doc.setDrawColor(...accentRgb)
  doc.setFillColor(...accentRgb)
  doc.circle(sealX, sealY, 14, 'FD')

  // Inner ring
  doc.setDrawColor(255, 255, 255)
  doc.setLineWidth(0.5)
  doc.circle(sealX, sealY, 12, 'S')

  // Inner medallion core
  doc.setFillColor(...primaryRgb)
  doc.circle(sealX, sealY, 10.5, 'F')

  // Seal text & badge
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(245, 208, 95)
  doc.text(config.sealBadgeText, sealX, sealY + 0.8, { align: 'center' })

  doc.setFontSize(5.5)
  doc.setTextColor(255, 255, 255)
  doc.text(config.sealSubtext, sealX, sealY + 4.5, { align: 'center' })
  doc.text('CAPTAIN LMS', sealX, sealY - 3.8, { align: 'center' })

  // Ribbon tails
  doc.setFillColor(...accentRgb)
  doc.triangle(sealX - 7, sealY + 13, sealX - 2, sealY + 13, sealX - 5, sealY + 23, 'F')
  doc.triangle(sealX + 2, sealY + 13, sealX + 7, sealY + 13, sealX + 5, sealY + 23, 'F')

  // 10. Signatures & Issuing Authorities
  // Left Signer
  const sigLeftX = 58
  const sigLineY = 166

  doc.setDrawColor(30, 41, 59)
  doc.setLineWidth(0.6)
  doc.line(sigLeftX - 32, sigLineY, sigLeftX + 32, sigLineY)

  doc.setFont('times', 'italic')
  doc.setFontSize(14)
  doc.setTextColor(...primaryRgb)
  doc.text(config.sigLeftName.split(',')[0] ?? '', sigLeftX, sigLineY - 3, { align: 'center' })

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(30, 41, 59)
  doc.text(config.sigLeftName, sigLeftX, sigLineY + 5, { align: 'center' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(100, 116, 139)
  doc.text(config.sigLeftTitle, sigLeftX, sigLineY + 9, { align: 'center' })
  doc.text(config.sigLeftOrg, sigLeftX, sigLineY + 12.5, { align: 'center' })

  // Right Signer
  const sigRightX = pageWidth - 58

  doc.setDrawColor(30, 41, 59)
  doc.setLineWidth(0.6)
  doc.line(sigRightX - 32, sigLineY, sigRightX + 32, sigLineY)

  doc.setFont('times', 'italic')
  doc.setFontSize(14)
  doc.setTextColor(...primaryRgb)
  doc.text(config.sigRightName.split(',')[0] ?? '', sigRightX, sigLineY - 3, { align: 'center' })

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(30, 41, 59)
  doc.text(config.sigRightName, sigRightX, sigLineY + 5, { align: 'center' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(100, 116, 139)
  doc.text(config.sigRightTitle, sigRightX, sigLineY + 9, { align: 'center' })
  doc.text(config.sigRightOrg, sigRightX, sigLineY + 12.5, { align: 'center' })

  // 11. Security & Verification Bottom Bar
  const footerY = 192
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(100, 116, 139)

  doc.text(`Issue Date: ${data.completedDate}`, 20, footerY)
  doc.text(`Certificate ID: ${data.certificateId}`, pageWidth / 2, footerY, { align: 'center' })
  doc.text(`Verification: ${config.verificationUrl}`, pageWidth - 20, footerY, { align: 'right' })

  doc.setFontSize(6.5)
  doc.setTextColor(148, 163, 184)
  doc.text(
    'This electronic credential confirms the recipient has satisfied all instructional modules and curriculum competencies for this course.',
    pageWidth / 2,
    footerY + 4,
    { align: 'center' },
  )

  return doc
}

/**
 * Generates final certificate PDF bytes:
 * - If the admin has uploaded a custom PDF template, stamps recipient details onto that template
 *   so it is used as the single template for ALL certificates.
 * - Otherwise falls back to the built-in vector generator.
 */
export async function generateCertificatePdfBytes(
  data: CertificateData,
  customConfig?: CertificateCustomization,
): Promise<Uint8Array> {
  const config = customConfig || getCertificateConfig()

  if (config.customPdf?.enabled && config.customPdf?.pdfBase64) {
    const templateBytes = decodeBase64ToPdfBytes(config.customPdf.pdfBase64)
    return await stampCertificateOnPdfTemplate(
      templateBytes,
      {
        userName: data.userName,
        courseTitle: data.courseTitle,
        completedDate: data.completedDate,
        certificateId: data.certificateId,
        userDepartment: data.userDepartment,
      },
      config.customPdf.fields,
    )
  }

  const doc = createCertificateDoc(data, config)
  return new Uint8Array(doc.output('arraybuffer'))
}

/**
 * Download the generated certificate directly as a PDF file.
 */
export async function downloadCertificatePdf(
  data: CertificateData,
  customConfig?: CertificateCustomization,
): Promise<void> {
  const bytes = await generateCertificatePdfBytes(data, customConfig)
  const cleanTitle = data.courseTitle
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 30)
  const cleanName = data.userName
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 20)
  const filename = `Certificate_${cleanTitle}_${cleanName}.pdf`

  const copy = new Uint8Array(bytes)
  const blob = new Blob([copy], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/**
 * Generate a Blob URL for printing or in-browser preview.
 */
export async function getCertificatePdfBlobUrl(
  data: CertificateData,
  customConfig?: CertificateCustomization,
): Promise<string> {
  const bytes = await generateCertificatePdfBytes(data, customConfig)
  const copy = new Uint8Array(bytes)
  const blob = new Blob([copy], { type: 'application/pdf' })
  return URL.createObjectURL(blob)
}
