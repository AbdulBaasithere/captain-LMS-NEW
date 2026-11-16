import { jsPDF } from 'jspdf'
import { supabase } from '@/lib/supabase'
import {
  downloadCsvFile,
  exportTableToCsv,
  serializeSectionsToCsv,
  type CsvColumn,
  type CsvSection,
} from '@/lib/csv'
import type { KpiReportFormat, KpiReportScope, Role } from '@/lib/database.types'
import type {
  CourseKpiMetric,
  DepartmentKpiMetric,
  EmployeeKpiMetric,
  FilteredKpiSnapshot,
  KpiFilterState,
  MonthlyTrendMetric,
} from '@/lib/analyticsKpi'

export type KpiCsvDataset = 'employees' | 'departments' | 'courses' | 'trends' | 'all'

export const EMPLOYEE_KPI_CSV_COLUMNS: CsvColumn<EmployeeKpiMetric>[] = [
  { header: 'Rank (Overall)', value: (e) => e.rankOverall },
  { header: 'Rank (Department)', value: (e) => e.rankInDepartment },
  { header: 'Employee Name', value: (e) => e.fullName },
  { header: 'Email', value: (e) => e.email ?? '' },
  { header: 'Department', value: (e) => e.department },
  { header: 'Due Date', value: (e) => e.dueDate ?? '' },
  { header: 'Compliance Status', value: (e) => e.complianceStatus },
  { header: 'Assigned Lessons', value: (e) => e.assignedLessons },
  { header: 'Completed Lessons', value: (e) => e.completedLessons },
  { header: 'In-Progress Lessons', value: (e) => e.inProgressLessons },
  { header: 'Pending Lessons', value: (e) => e.pendingLessons },
  { header: 'Overdue Lessons', value: (e) => e.overdueLessons },
  { header: 'Completion Rate (%)', value: (e) => e.completionRatePct },
  { header: 'Learning Hours', value: (e) => e.learningHours },
  { header: 'Active Study Days', value: (e) => e.activeStudyDays },
  { header: 'Quiz Attempts', value: (e) => e.quizAttemptsCount },
  { header: 'Quiz Passes', value: (e) => e.quizPassesCount },
  { header: 'Avg Quiz Score (%)', value: (e) => e.avgQuizScorePct ?? '' },
  { header: 'Quiz Pass Rate (%)', value: (e) => e.quizPassRatePct ?? '' },
  { header: 'First-Attempt Pass Rate (%)', value: (e) => e.firstAttemptPassRatePct ?? '' },
  { header: 'Effectiveness Index', value: (e) => e.effectivenessIndex },
  { header: 'Last Active', value: (e) => (e.lastActiveAt ? new Date(e.lastActiveAt).toISOString().slice(0, 10) : '') },
]

export const DEPARTMENT_KPI_CSV_COLUMNS: CsvColumn<DepartmentKpiMetric>[] = [
  { header: 'Department', value: (d) => d.department },
  { header: 'Employees', value: (d) => d.employeeCount },
  { header: 'Participating', value: (d) => d.participatingEmployees },
  { header: 'Active (30d)', value: (d) => d.activeLearners30d },
  { header: 'Participation Rate (%)', value: (d) => d.participationRatePct },
  { header: 'Avg Completion Rate (%)', value: (d) => d.avgCompletionRatePct },
  { header: 'Total Learning Hours', value: (d) => d.totalLearningHours },
  { header: 'Avg Learning Hours', value: (d) => d.avgLearningHours },
  { header: 'Quiz Attempts', value: (d) => d.quizAttemptsCount },
  { header: 'Avg Quiz Score (%)', value: (d) => d.avgQuizScorePct ?? '' },
  { header: 'Quiz Pass Rate (%)', value: (d) => d.quizPassRatePct ?? '' },
  { header: 'Compliant', value: (d) => d.compliantCount },
  { header: 'Pending', value: (d) => d.pendingCount },
  { header: 'Overdue', value: (d) => d.overdueCount },
  { header: 'Compliance Rate (%)', value: (d) => d.complianceRatePct },
  { header: 'Training Effectiveness Score', value: (d) => d.trainingEffectivenessScore },
]

export const COURSE_KPI_CSV_COLUMNS: CsvColumn<CourseKpiMetric>[] = [
  { header: 'Course Title', value: (c) => c.courseTitle },
  { header: 'Audience / Category', value: (c) => c.category },
  { header: 'Lessons', value: (c) => c.lessonCount },
  { header: 'Target Learners', value: (c) => c.targetLearners },
  { header: 'Started Learners', value: (c) => c.startedLearners },
  { header: 'Completed Learners', value: (c) => c.completedLearners },
  { header: 'Participation Rate (%)', value: (c) => c.participationRatePct },
  { header: 'Completion Rate (%)', value: (c) => c.completionRatePct },
  { header: 'Learning Hours', value: (c) => c.learningHours },
  { header: 'Avg Quiz Score (%)', value: (c) => c.avgQuizScorePct ?? '' },
  { header: 'Quiz Pass Rate (%)', value: (c) => c.quizPassRatePct ?? '' },
  { header: 'Overdue Learners', value: (c) => c.overdueLearners },
  { header: 'Drop-off Rate (%)', value: (c) => c.dropOffRatePct },
  { header: 'Training Effectiveness Score', value: (c) => c.trainingEffectivenessScore },
]

export const MONTHLY_TREND_CSV_COLUMNS: CsvColumn<MonthlyTrendMetric>[] = [
  { header: 'Month', value: (t) => t.monthLabel },
  { header: 'Active Users', value: (t) => t.activeUsers },
  { header: 'Lesson Completions', value: (t) => t.lessonCompletions },
  { header: 'Monthly Completion Share (%)', value: (t) => t.completionRatePct },
  { header: 'Cumulative Completion Rate (%)', value: (t) => t.cumulativeCompletionRatePct },
  { header: 'Learning Hours', value: (t) => t.learningHours },
  { header: 'Quiz Attempts', value: (t) => t.quizAttempts },
  { header: 'Avg Quiz Score (%)', value: (t) => t.avgQuizScorePct ?? '' },
  { header: 'Quiz Pass Rate (%)', value: (t) => t.quizPassRatePct ?? '' },
]

function buildSection<T>(title: string, columns: readonly CsvColumn<T>[], rows: readonly T[]): CsvSection {
  return {
    title,
    headers: columns.map((c) => c.header),
    rows: rows.map((r) => columns.map((c) => c.value(r))),
  }
}

async function recordExportAudit(params: {
  userId?: string
  role: Role
  scope: KpiReportScope
  format: KpiReportFormat
  filters: KpiFilterState
  rowCount: number
}) {
  if (!params.userId) return
  try {
    await supabase.from('kpi_report_exports').insert({
      exported_by: params.userId,
      exporter_role: params.role,
      report_scope: params.scope,
      format: params.format,
      filters: {
        dateRange: params.filters.dateRange,
        startDate: params.filters.startDate,
        endDate: params.filters.endDate,
        department: params.filters.department,
        courseId: params.filters.courseId,
        status: params.filters.status,
        search: params.filters.search,
      },
      row_count: params.rowCount,
    })
  } catch {
    // Non-fatal: audit table may not be migrated yet
  }
}

export async function exportKpiCsv(params: {
  dataset: KpiCsvDataset
  snapshot: FilteredKpiSnapshot
  filters: KpiFilterState
  role: Role
  userId?: string
}) {
  const { dataset, snapshot, filters, role, userId } = params
  const dateStamp = new Date().toISOString().slice(0, 10)
  let scope: KpiReportScope = 'employee'
  let rowCount = 0

  if (dataset === 'employees') {
    scope = 'employee'
    rowCount = exportTableToCsv({
      filename: `captain-lms-employees-kpi-${dateStamp}.csv`,
      columns: EMPLOYEE_KPI_CSV_COLUMNS,
      rows: snapshot.employees,
    })
  } else if (dataset === 'departments') {
    scope = 'department'
    rowCount = exportTableToCsv({
      filename: `captain-lms-departments-kpi-${dateStamp}.csv`,
      columns: DEPARTMENT_KPI_CSV_COLUMNS,
      rows: snapshot.departments,
    })
  } else if (dataset === 'courses') {
    scope = 'course'
    rowCount = exportTableToCsv({
      filename: `captain-lms-courses-kpi-${dateStamp}.csv`,
      columns: COURSE_KPI_CSV_COLUMNS,
      rows: snapshot.courses,
    })
  } else if (dataset === 'trends') {
    scope = 'company'
    rowCount = exportTableToCsv({
      filename: `captain-lms-trends-kpi-${dateStamp}.csv`,
      columns: MONTHLY_TREND_CSV_COLUMNS,
      rows: snapshot.monthlyTrends,
    })
  } else {
    scope = role === 'employee' ? 'employee' : filters.department !== 'All' ? 'department' : 'company'
    const s = snapshot.summary
    const sections: CsvSection[] = [
      {
        title: `Captain LMS Offline KPI Report (Scope: ${role.toUpperCase()} | Generated: ${new Date().toISOString()})`,
        headers: [
          'Total Employees',
          'Participating Employees',
          'Participation Rate (%)',
          'Avg Completion Rate (%)',
          'Total Learning Hours',
          'Avg Quiz Score (%)',
          'Quiz Pass Rate (%)',
          'Compliance Rate (%)',
          'Training Effectiveness Score',
        ],
        rows: [
          [
            s.totalEmployees,
            s.participatingEmployees,
            s.participationRatePct,
            s.avgCompletionRatePct,
            s.totalLearningHours,
            s.avgQuizScorePct ?? '',
            s.quizPassRatePct ?? '',
            s.complianceRatePct,
            s.trainingEffectivenessScore,
          ],
        ],
      },
    ]

    if (role !== 'employee' && snapshot.departments.length) {
      sections.push(buildSection('Department Breakdown', DEPARTMENT_KPI_CSV_COLUMNS, snapshot.departments))
    }
    if (snapshot.courses.length) {
      sections.push(buildSection('Course Effectiveness Breakdown', COURSE_KPI_CSV_COLUMNS, snapshot.courses))
    }
    if (snapshot.employees.length) {
      sections.push(
        buildSection(
          role === 'employee' ? 'Personal Scorecard' : 'Employee KPI Rankings',
          EMPLOYEE_KPI_CSV_COLUMNS,
          snapshot.employees,
        ),
      )
    }
    if (snapshot.monthlyTrends.length) {
      sections.push(buildSection('Monthly Learning & Activity Trends', MONTHLY_TREND_CSV_COLUMNS, snapshot.monthlyTrends))
    }

    const combinedCsv = serializeSectionsToCsv(sections, { includeBom: true })
    downloadCsvFile(combinedCsv, `captain-lms-full-kpi-report-${dateStamp}.csv`)
    rowCount = snapshot.employees.length + snapshot.departments.length + snapshot.courses.length + snapshot.monthlyTrends.length
  }

  await recordExportAudit({
    userId,
    role,
    scope,
    format: 'csv',
    filters,
    rowCount,
  })
}

async function svgElementToPngDataUrl(svgEl: SVGSVGElement): Promise<{ dataUrl: string; ratio: number } | null> {
  try {
    const rect = svgEl.getBoundingClientRect()
    const width = Math.max(300, Math.round(rect.width || Number(svgEl.getAttribute('width')) || 640))
    const height = Math.max(160, Math.round(rect.height || Number(svgEl.getAttribute('height')) || 280))

    const clone = svgEl.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(width))
    clone.setAttribute('height', String(height))

    // Resolve CSS custom properties cleanly so offscreen SVG renders with crisp colors
    const cs = getComputedStyle(document.documentElement)
    const resolveVars = (raw: string) =>
      raw
        .replace(/var\(--ink\)/g, cs.getPropertyValue('--ink').trim() || '#0f1a2e')
        .replace(/var\(--ink-soft\)/g, cs.getPropertyValue('--ink-soft').trim() || '#55607a')
        .replace(/var\(--border\)/g, cs.getPropertyValue('--border').trim() || '#e3e6ef')
        .replace(/var\(--surface\)/g, cs.getPropertyValue('--surface').trim() || '#ffffff')
        .replace(/var\(--surface-sunken\)/g, cs.getPropertyValue('--surface-sunken').trim() || '#eef0f7')
        .replace(/var\(--blue\)/g, cs.getPropertyValue('--blue').trim() || '#2f5be8')
        .replace(/var\(--teal\)/g, cs.getPropertyValue('--teal').trim() || '#15803d')
        .replace(/var\(--brass\)/g, cs.getPropertyValue('--brass').trim() || '#f08a24')
        .replace(/var\(--danger\)/g, cs.getPropertyValue('--danger').trim() || '#c0392b')

    const serialized = resolveVars(new XMLSerializer().serializeToString(clone))
    const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' })
    const svgUrl = URL.createObjectURL(svgBlob)

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = svgUrl
    })

    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      URL.revokeObjectURL(svgUrl)
      return null
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, width, height)
    URL.revokeObjectURL(svgUrl)

    return { dataUrl: canvas.toDataURL('image/png'), ratio: width / height }
  } catch {
    return null
  }
}

export async function exportKpiPdf(params: {
  snapshot: FilteredKpiSnapshot
  filters: KpiFilterState
  role: Role
  viewerName: string
  userId?: string
  chartContainers?: Array<{ title: string; el: HTMLElement | null }>
}) {
  const { snapshot, filters, role, viewerName, userId, chartContainers = [] } = params
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 40
  const maxW = pageW - margin * 2
  let y = 44

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - 44) {
      doc.addPage()
      y = 44
    }
  }

  // Title banner
  doc.setFillColor(15, 27, 51)
  doc.roundedRect(margin, y, maxW, 64, 8, 8, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('Captain LMS — Analytics & KPI Performance Report', margin + 16, y + 26)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(185, 195, 220)
  const rangeText =
    filters.dateRange === 'custom'
      ? `Range: ${filters.startDate || 'Start'} to ${filters.endDate || 'Today'}`
      : `Range: ${filters.dateRange === 'all' ? 'All time' : filters.dateRange}`
  const filterDesc = [
    `Scope: ${role.toUpperCase()}`,
    rangeText,
    `Dept: ${filters.department}`,
    `Status: ${filters.status}`,
  ].join('  ·  ')
  doc.text(filterDesc, margin + 16, y + 45)
  y += 78

  doc.setTextColor(85, 96, 122)
  doc.setFontSize(9)
  doc.text(`Generated by ${viewerName} on ${new Date().toLocaleString()}`, margin, y)
  y += 20

  // Executive KPI Summary grid
  const s = snapshot.summary
  const kpiCards = [
    { label: 'Active Employees', value: `${s.participatingEmployees} / ${s.totalEmployees}` },
    { label: 'Avg Completion', value: `${s.avgCompletionRatePct}%` },
    { label: 'Learning Hours', value: `${s.totalLearningHours}h` },
    { label: 'Participation Rate', value: `${s.participationRatePct}%` },
    { label: 'Avg Quiz Score', value: s.avgQuizScorePct === null ? '—' : `${s.avgQuizScorePct}%` },
    { label: 'Quiz Pass Rate', value: s.quizPassRatePct === null ? '—' : `${s.quizPassRatePct}%` },
    { label: 'Compliance Rate', value: `${s.complianceRatePct}%` },
    { label: 'Effectiveness Score', value: `${s.trainingEffectivenessScore}/100` },
  ]

  const cardW = (maxW - 24) / 4
  kpiCards.forEach((c, idx) => {
    const col = idx % 4
    const row = Math.floor(idx / 4)
    const cx = margin + col * (cardW + 8)
    const cy = y + row * 50
    doc.setFillColor(244, 245, 249)
    doc.setDrawColor(227, 230, 239)
    doc.roundedRect(cx, cy, cardW, 42, 6, 6, 'FD')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(85, 96, 122)
    doc.text(c.label.toUpperCase(), cx + 8, cy + 15)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(15, 26, 46)
    doc.text(c.value, cx + 8, cy + 33)
  })
  y += 112

  // Embed live Recharts SVGs if present
  for (const ch of chartContainers) {
    const svg = ch.el?.querySelector('svg.recharts-surface') as SVGSVGElement | null
    if (!svg) continue
    const png = await svgElementToPngDataUrl(svg)
    if (!png) continue
    const imgW = maxW
    const imgH = Math.min(200, imgW / png.ratio)
    ensureSpace(imgH + 34)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(15, 26, 46)
    doc.text(ch.title, margin, y)
    y += 10
    doc.addImage(png.dataUrl, 'PNG', margin, y, imgW, imgH)
    y += imgH + 18
  }

  // Helper to draw crisp tables
  const drawTable = (title: string, columns: { label: string; width: number; align?: 'left' | 'right' }[], bodyRows: string[][]) => {
    if (!bodyRows.length) return
    ensureSpace(46)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(15, 26, 46)
    doc.text(title, margin, y)
    y += 12

    const drawHeader = () => {
      doc.setFillColor(238, 240, 247)
      doc.rect(margin, y, maxW, 20, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8.5)
      doc.setTextColor(85, 96, 122)
      let x = margin + 6
      for (const col of columns) {
        if (col.align === 'right') doc.text(col.label, x + col.width - 10, y + 13, { align: 'right' })
        else doc.text(col.label, x, y + 13)
        x += col.width
      }
      y += 22
    }

    drawHeader()
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)

    for (const row of bodyRows) {
      if (y + 18 > pageH - 42) {
        doc.addPage()
        y = 44
        drawHeader()
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8.5)
      }
      let x = margin + 6
      doc.setTextColor(15, 26, 46)
      columns.forEach((col, i) => {
        const text = (row[i] ?? '').slice(0, 34)
        if (col.align === 'right') doc.text(text, x + col.width - 10, y + 12, { align: 'right' })
        else doc.text(text, x, y + 12)
        x += col.width
      })
      doc.setDrawColor(232, 235, 242)
      doc.line(margin, y + 17, margin + maxW, y + 17)
      y += 18
    }
    y += 14
  }

  if (snapshot.departments.length && role !== 'employee') {
    drawTable(
      'Department Performance Summary',
      [
        { label: 'Department', width: 135 },
        { label: 'Staff', width: 50, align: 'right' },
        { label: 'Completion', width: 72, align: 'right' },
        { label: 'Hours', width: 58, align: 'right' },
        { label: 'Quiz Avg', width: 65, align: 'right' },
        { label: 'Compliance', width: 72, align: 'right' },
        { label: 'Effect.', width: 63, align: 'right' },
      ],
      snapshot.departments.map((d) => [
        d.department,
        String(d.employeeCount),
        `${d.avgCompletionRatePct}%`,
        `${d.totalLearningHours}h`,
        d.avgQuizScorePct === null ? '—' : `${d.avgQuizScorePct}%`,
        `${d.complianceRatePct}%`,
        `${d.trainingEffectivenessScore}`,
      ]),
    )
  }

  if (snapshot.courses.length) {
    drawTable(
      'Course Effectiveness & Completion',
      [
        { label: 'Course', width: 165 },
        { label: 'Audience', width: 80 },
        { label: 'Comp.', width: 60, align: 'right' },
        { label: 'Drop-off', width: 60, align: 'right' },
        { label: 'Quiz Pass', width: 70, align: 'right' },
        { label: 'Effect.', width: 80, align: 'right' },
      ],
      snapshot.courses.map((c) => [
        c.courseTitle,
        c.category,
        `${c.completionRatePct}%`,
        `${c.dropOffRatePct}%`,
        c.quizPassRatePct === null ? '—' : `${c.quizPassRatePct}%`,
        `${c.trainingEffectivenessScore}`,
      ]),
    )
  }

  if (snapshot.employees.length) {
    drawTable(
      role === 'employee' ? 'Personal Training Scorecard' : 'Employee KPI Rankings',
      [
        { label: '#', width: 28 },
        { label: 'Employee', width: 132 },
        { label: 'Dept', width: 82 },
        { label: 'Comp.', width: 56, align: 'right' },
        { label: 'Hours', width: 50, align: 'right' },
        { label: 'Quiz', width: 54, align: 'right' },
        { label: 'Status', width: 68 },
        { label: 'Score', width: 45, align: 'right' },
      ],
      snapshot.employees.slice(0, 80).map((e) => [
        String(e.rankOverall),
        e.fullName,
        e.department,
        `${e.completionRatePct}%`,
        `${e.learningHours}h`,
        e.avgQuizScorePct === null ? '—' : `${e.avgQuizScorePct}%`,
        e.complianceStatus,
        `${e.effectivenessIndex}`,
      ]),
    )
  }

  const totalPages = doc.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFontSize(8)
    doc.setTextColor(130, 140, 160)
    doc.text(`Captain LMS KPI Report · Page ${p} of ${totalPages}`, margin, pageH - 18)
  }

  const dateStamp = new Date().toISOString().slice(0, 10)
  doc.save(`captain-lms-kpi-report-${dateStamp}.pdf`)

  await recordExportAudit({
    userId,
    role,
    scope: role === 'employee' ? 'employee' : filters.department !== 'All' ? 'department' : 'company',
    format: 'pdf',
    filters,
    rowCount: snapshot.employees.length,
  })
}
