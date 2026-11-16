import { supabase } from '@/lib/supabase'
import { isActive } from '@/lib/employees'
import { loadCourses, type CourseVM } from '@/lib/courses'
import { isoDay, type StudyDay } from '@/lib/learning'
import { loadDepartments } from '@/lib/departments'
import type {
  CourseEnrolment,
  Module,
  Profile,
  QuizAttempt,
  Role,
  TrainingKpiTarget,
  VideoCompletion,
} from '@/lib/database.types'

export type KpiDateRange = '30d' | '90d' | '6m' | '12m' | 'all' | 'custom'
export type ComplianceStatus = 'Compliant' | 'In Progress' | 'At Risk' | 'Overdue'

export interface KpiFilterState {
  dateRange: KpiDateRange
  startDate: string
  endDate: string
  department: string
  courseId: string // 'All' or course.id
  status: 'All' | ComplianceStatus
  search: string
}

export interface KpiTargetsConfig {
  scope: string
  targetCompletionPct: number
  targetPassRatePct: number
  targetCompliancePct: number
  targetLearningHoursMonthly: number
  passThresholdPct: number
}

export const DEFAULT_KPI_TARGETS: KpiTargetsConfig = {
  scope: 'company',
  targetCompletionPct: 85,
  targetPassRatePct: 80,
  targetCompliancePct: 95,
  targetLearningHoursMonthly: 4,
  passThresholdPct: 70,
}

export interface EmployeeKpiMetric {
  userId: string
  fullName: string
  email: string | null
  department: string
  dueDate: string | null
  assignedLessons: number
  completedLessons: number
  inProgressLessons: number
  pendingLessons: number
  overdueLessons: number
  completionRatePct: number
  learningHours: number
  activeStudyDays: number
  quizAttemptsCount: number
  quizPassesCount: number
  avgQuizScorePct: number | null
  quizPassRatePct: number | null
  firstAttemptPassRatePct: number | null
  complianceStatus: ComplianceStatus
  isCompliant: boolean
  lastActiveAt: string | null
  effectivenessIndex: number
  rankOverall: number
  rankInDepartment: number
}

export interface DepartmentKpiMetric {
  department: string
  employeeCount: number
  participatingEmployees: number
  activeLearners30d: number
  participationRatePct: number
  avgCompletionRatePct: number
  totalLearningHours: number
  avgLearningHours: number
  quizAttemptsCount: number
  avgQuizScorePct: number | null
  quizPassRatePct: number | null
  compliantCount: number
  pendingCount: number
  overdueCount: number
  complianceRatePct: number
  trainingEffectivenessScore: number
}

export interface CourseKpiMetric {
  courseId: string
  courseTitle: string
  category: string
  color: string
  lessonCount: number
  targetLearners: number
  startedLearners: number
  completedLearners: number
  participationRatePct: number
  completionRatePct: number
  learningHours: number
  avgQuizScorePct: number | null
  quizPassRatePct: number | null
  overdueLearners: number
  dropOffRatePct: number
  trainingEffectivenessScore: number
}

export interface MonthlyTrendMetric {
  monthKey: string
  monthLabel: string
  activeUsers: number
  lessonCompletions: number
  learningHours: number
  quizAttempts: number
  avgQuizScorePct: number | null
  quizPassRatePct: number | null
  completionRatePct: number
  cumulativeCompletionRatePct: number
}

export interface CompanyKpiSummary {
  totalEmployees: number
  participatingEmployees: number
  participationRatePct: number
  avgCompletionRatePct: number
  totalLearningHours: number
  avgQuizScorePct: number | null
  quizPassRatePct: number | null
  compliantEmployees: number
  pendingEmployees: number
  overdueEmployees: number
  complianceRatePct: number
  trainingEffectivenessScore: number
}

export interface KpiDataset {
  role: Role
  viewerId: string
  viewerDepartment: string
  sqlViewsReady: boolean
  targets: KpiTargetsConfig
  departmentNames: string[]
  people: Profile[]
  modules: Module[]
  courses: CourseVM[]
  completions: VideoCompletion[]
  attempts: QuizAttempt[]
  studyLogs: Array<StudyDay & { user_id: string }>
  enrolments: CourseEnrolment[]
  sqlBaseline: {
    summary: CompanyKpiSummary | null
    employees: EmployeeKpiMetric[]
    departments: DepartmentKpiMetric[]
    courses: CourseKpiMetric[]
    trends: MonthlyTrendMetric[]
  }
}

export interface FilteredKpiSnapshot {
  summary: CompanyKpiSummary
  employees: EmployeeKpiMetric[]
  departments: DepartmentKpiMetric[]
  courses: CourseKpiMetric[]
  monthlyTrends: MonthlyTrendMetric[]
  availableDepartments: string[]
  targets: KpiTargetsConfig
  sqlViewsReady: boolean
}

function round1(val: number): number {
  return Math.round(val * 10) / 10
}

function round2(val: number): number {
  return Math.round(val * 100) / 100
}

function resolveDateWindow(filters: KpiFilterState): {
  startIso: string | null
  endIso: string | null
  startDay: string | null
  endDay: string | null
} {
  if (filters.dateRange === 'custom') {
    let startDay = filters.startDate.trim() || null
    let endDay = filters.endDate.trim() || null
    if (startDay && endDay && startDay > endDay) {
      ;[startDay, endDay] = [endDay, startDay]
    }
    return {
      startIso: startDay ? `${startDay}T00:00:00.000Z` : null,
      endIso: endDay ? `${endDay}T23:59:59.999Z` : null,
      startDay,
      endDay,
    }
  }
  if (filters.dateRange === 'all') {
    return { startIso: null, endIso: null, startDay: null, endDay: null }
  }
  const d = new Date()
  if (filters.dateRange === '30d') d.setDate(d.getDate() - 30)
  else if (filters.dateRange === '90d') d.setDate(d.getDate() - 90)
  else if (filters.dateRange === '6m') d.setMonth(d.getMonth() - 6)
  else d.setMonth(d.getMonth() - 12)
  const startIso = d.toISOString()
  return {
    startIso,
    endIso: null,
    startDay: startIso.slice(0, 10),
    endDay: null,
  }
}

function monthKeysForFilters(
  filters: KpiFilterState,
  window: { startDay: string | null; endDay: string | null },
  completions: VideoCompletion[],
  attempts: QuizAttempt[],
  studyLogs: Array<StudyDay & { user_id: string }>,
): string[] {
  const now = new Date()
  const toMonthDate = (ym: string) => {
    const [yStr, mStr] = ym.split('-')
    const y = Number(yStr) || now.getFullYear()
    const m = (Number(mStr) || 1) - 1
    return new Date(y, m, 1)
  }

  let endDt = new Date(now.getFullYear(), now.getMonth(), 1)
  if (filters.dateRange === 'custom' && window.endDay) {
    endDt = toMonthDate(window.endDay.slice(0, 7))
  }

  let startDt: Date
  if (filters.dateRange === 'custom' && window.startDay) {
    startDt = toMonthDate(window.startDay.slice(0, 7))
  } else if (filters.dateRange === '30d') {
    startDt = new Date(endDt.getFullYear(), endDt.getMonth() - 2, 1)
  } else if (filters.dateRange === '90d') {
    startDt = new Date(endDt.getFullYear(), endDt.getMonth() - 3, 1)
  } else if (filters.dateRange === '6m') {
    startDt = new Date(endDt.getFullYear(), endDt.getMonth() - 5, 1)
  } else if (filters.dateRange === '12m') {
    startDt = new Date(endDt.getFullYear(), endDt.getMonth() - 11, 1)
  } else {
    // 'all' or custom without startDate: span from earliest observed activity (at least 6, at most 12 months)
    let earliestYm: string | null = null
    const considerYm = (isoOrDay: string | null | undefined) => {
      if (!isoOrDay || isoOrDay.length < 7) return
      const ym = isoOrDay.slice(0, 7)
      if (!earliestYm || ym < earliestYm) earliestYm = ym
    }
    for (const c of completions) considerYm(c.completed_at ?? c.last_watched_at)
    for (const a of attempts) considerYm(a.created_at)
    for (const s of studyLogs) considerYm(s.day)

    const minStart = new Date(endDt.getFullYear(), endDt.getMonth() - 5, 1)
    const maxStart = new Date(endDt.getFullYear(), endDt.getMonth() - 11, 1)
    if (earliestYm) {
      const candidate = toMonthDate(earliestYm)
      if (candidate < maxStart) startDt = maxStart
      else if (candidate > minStart) startDt = minStart
      else startDt = candidate
    } else {
      startDt = minStart
    }
  }

  if (startDt > endDt) startDt = new Date(endDt.getFullYear(), endDt.getMonth(), 1)

  const keys: string[] = []
  const cursor = new Date(startDt.getFullYear(), startDt.getMonth(), 1)
  let guard = 0
  while (cursor <= endDt && guard < 24) {
    keys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
    cursor.setMonth(cursor.getMonth() + 1)
    guard++
  }
  return keys
}

function mapSqlTarget(row: TrainingKpiTarget | null): KpiTargetsConfig {
  if (!row) return { ...DEFAULT_KPI_TARGETS }
  return {
    scope: row.scope,
    targetCompletionPct: Number(row.target_completion_pct) || 85,
    targetPassRatePct: Number(row.target_pass_rate_pct) || 80,
    targetCompliancePct: Number(row.target_compliance_pct) || 95,
    targetLearningHoursMonthly: Number(row.target_learning_hours_monthly) || 4,
    passThresholdPct: Number(row.pass_threshold_pct) || 70,
  }
}

export async function loadKpiDataset(role: Role, viewerId: string, viewerDepartment: string): Promise<KpiDataset> {
  const [
    profRes,
    modRes,
    compRes,
    attRes,
    studyRes,
    enrolRes,
    targetRes,
    depts,
    sqlSummaryRes,
    sqlEmpRes,
    sqlDeptRes,
    sqlCourseRes,
    sqlTrendRes,
  ] = await Promise.all([
    supabase.from('profiles').select('*'),
    supabase.from('modules').select('*').eq('is_draft', false).eq('is_archived', false),
    supabase.from('video_completions').select('*'),
    supabase.from('quiz_attempts').select('*'),
    supabase.from('study_log').select('user_id, day, seconds'),
    supabase.from('course_enrolments').select('*'),
    supabase.from('training_kpi_targets').select('*').eq('scope', 'company').maybeSingle(),
    loadDepartments(),
    supabase.from('v_kpi_company_summary' as never).select('*').maybeSingle(),
    supabase.from('v_kpi_employee_metrics' as never).select('*'),
    supabase.from('v_kpi_department_metrics' as never).select('*'),
    supabase.from('v_kpi_course_metrics' as never).select('*'),
    supabase.from('v_kpi_monthly_trends' as never).select('*'),
  ])

  const rawProfiles = (profRes.data ?? []) as Profile[]
  const modules = (modRes.data ?? []) as Module[]
  const courses = (await loadCourses(modules)).filter((c) => c.lessons.length > 0)

  // Strict client-side RBAC alignment matching SQL RLS
  let scopedPeople = rawProfiles.filter((p) => p.role === 'employee' && isActive(p))
  if (role === 'employee') {
    scopedPeople = scopedPeople.filter((p) => p.id === viewerId)
  } else if (role === 'manager') {
    scopedPeople = scopedPeople.filter((p) => p.department === viewerDepartment || p.manager_id === viewerId)
  }

  const allowedUserIds = new Set(scopedPeople.map((p) => p.id))

  const completions = ((compRes.data ?? []) as VideoCompletion[]).filter((c) => allowedUserIds.has(c.user_id))
  const attempts = ((attRes.data ?? []) as QuizAttempt[]).filter((a) => allowedUserIds.has(a.user_id))
  const studyLogs = (studyRes.error ? [] : ((studyRes.data ?? []) as Array<StudyDay & { user_id: string }>)).filter(
    (s) => allowedUserIds.has(s.user_id),
  )
  const enrolments = (enrolRes.error ? [] : ((enrolRes.data ?? []) as CourseEnrolment[])).filter((e) =>
    allowedUserIds.has(e.user_id),
  )

  const sqlViewsReady =
    !sqlSummaryRes.error &&
    !sqlEmpRes.error &&
    !sqlDeptRes.error &&
    !sqlCourseRes.error &&
    !sqlTrendRes.error

  const sqlEmployees: EmployeeKpiMetric[] = ((sqlEmpRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    userId: String(r.user_id),
    fullName: String(r.full_name ?? ''),
    email: r.email ? String(r.email) : null,
    department: String(r.department ?? 'General'),
    dueDate: r.due_date ? String(r.due_date) : null,
    assignedLessons: Number(r.assigned_lessons ?? 0),
    completedLessons: Number(r.completed_lessons ?? 0),
    inProgressLessons: Number(r.in_progress_lessons ?? 0),
    pendingLessons: Number(r.pending_lessons ?? 0),
    overdueLessons: Number(r.overdue_lessons ?? 0),
    completionRatePct: Number(r.completion_rate_pct ?? 0),
    learningHours: Number(r.learning_hours ?? 0),
    activeStudyDays: Number(r.active_study_days ?? 0),
    quizAttemptsCount: Number(r.quiz_attempts_count ?? 0),
    quizPassesCount: Number(r.quiz_passes_count ?? 0),
    avgQuizScorePct: r.avg_quiz_score_pct === null || r.avg_quiz_score_pct === undefined ? null : Number(r.avg_quiz_score_pct),
    quizPassRatePct: r.quiz_pass_rate_pct === null || r.quiz_pass_rate_pct === undefined ? null : Number(r.quiz_pass_rate_pct),
    firstAttemptPassRatePct:
      r.first_attempt_pass_rate_pct === null || r.first_attempt_pass_rate_pct === undefined
        ? null
        : Number(r.first_attempt_pass_rate_pct),
    complianceStatus: (r.compliance_status as ComplianceStatus) ?? 'In Progress',
    isCompliant: Boolean(r.is_compliant),
    lastActiveAt: r.last_active_at ? String(r.last_active_at) : null,
    effectivenessIndex: Number(r.effectiveness_index ?? 0),
    rankOverall: Number(r.rank_overall ?? 0),
    rankInDepartment: Number(r.rank_in_department ?? 0),
  }))

  const sqlDepartments: DepartmentKpiMetric[] = ((sqlDeptRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    department: String(r.department ?? 'General'),
    employeeCount: Number(r.employee_count ?? 0),
    participatingEmployees: Number(r.participating_employees ?? 0),
    activeLearners30d: Number(r.active_learners_30d ?? 0),
    participationRatePct: Number(r.participation_rate_pct ?? 0),
    avgCompletionRatePct: Number(r.avg_completion_rate_pct ?? 0),
    totalLearningHours: Number(r.total_learning_hours ?? 0),
    avgLearningHours: Number(r.avg_learning_hours ?? 0),
    quizAttemptsCount: Number(r.quiz_attempts_count ?? 0),
    avgQuizScorePct: r.avg_quiz_score_pct === null || r.avg_quiz_score_pct === undefined ? null : Number(r.avg_quiz_score_pct),
    quizPassRatePct: r.quiz_pass_rate_pct === null || r.quiz_pass_rate_pct === undefined ? null : Number(r.quiz_pass_rate_pct),
    compliantCount: Number(r.compliant_count ?? 0),
    pendingCount: Number(r.pending_count ?? 0),
    overdueCount: Number(r.overdue_count ?? 0),
    complianceRatePct: Number(r.compliance_rate_pct ?? 0),
    trainingEffectivenessScore: Number(r.training_effectiveness_score ?? 0),
  }))

  const sqlCourses: CourseKpiMetric[] = ((sqlCourseRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    courseId: String(r.course_id),
    courseTitle: String(r.course_title ?? ''),
    category: String(r.category ?? 'General'),
    color: String(r.color ?? '#2f5be8'),
    lessonCount: Number(r.lesson_count ?? 0),
    targetLearners: Number(r.target_learners ?? 0),
    startedLearners: Number(r.started_learners ?? 0),
    completedLearners: Number(r.completed_learners ?? 0),
    participationRatePct: Number(r.participation_rate_pct ?? 0),
    completionRatePct: Number(r.completion_rate_pct ?? 0),
    learningHours: Number(r.learning_hours ?? 0),
    avgQuizScorePct: r.avg_quiz_score_pct === null || r.avg_quiz_score_pct === undefined ? null : Number(r.avg_quiz_score_pct),
    quizPassRatePct: r.quiz_pass_rate_pct === null || r.quiz_pass_rate_pct === undefined ? null : Number(r.quiz_pass_rate_pct),
    overdueLearners: Number(r.overdue_learners ?? 0),
    dropOffRatePct: Number(r.drop_off_rate_pct ?? 0),
    trainingEffectivenessScore: Number(r.training_effectiveness_score ?? 0),
  }))

  const sqlTrends: MonthlyTrendMetric[] = ((sqlTrendRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    monthKey: String(r.month_key ?? ''),
    monthLabel: String(r.month_label ?? ''),
    activeUsers: Number(r.active_users ?? 0),
    lessonCompletions: Number(r.lesson_completions ?? 0),
    learningHours: Number(r.learning_hours ?? 0),
    quizAttempts: Number(r.quiz_attempts ?? 0),
    avgQuizScorePct: r.avg_quiz_score_pct === null || r.avg_quiz_score_pct === undefined ? null : Number(r.avg_quiz_score_pct),
    quizPassRatePct: r.quiz_pass_rate_pct === null || r.quiz_pass_rate_pct === undefined ? null : Number(r.quiz_pass_rate_pct),
    completionRatePct: 0,
    cumulativeCompletionRatePct: 0,
  }))

  const sr = sqlSummaryRes.data as Record<string, unknown> | null
  const sqlSummary: CompanyKpiSummary | null = sr
    ? {
        totalEmployees: Number(sr.total_employees ?? 0),
        participatingEmployees: Number(sr.participating_employees ?? 0),
        participationRatePct: Number(sr.participation_rate_pct ?? 0),
        avgCompletionRatePct: Number(sr.avg_completion_rate_pct ?? 0),
        totalLearningHours: Number(sr.total_learning_hours ?? 0),
        avgQuizScorePct: sr.avg_quiz_score_pct === null || sr.avg_quiz_score_pct === undefined ? null : Number(sr.avg_quiz_score_pct),
        quizPassRatePct: sr.quiz_pass_rate_pct === null || sr.quiz_pass_rate_pct === undefined ? null : Number(sr.quiz_pass_rate_pct),
        compliantEmployees: Number(sr.compliant_employees ?? 0),
        pendingEmployees: Number(sr.pending_employees ?? 0),
        overdueEmployees: Number(sr.overdue_employees ?? 0),
        complianceRatePct: Number(sr.compliance_rate_pct ?? 0),
        trainingEffectivenessScore: Number(sr.training_effectiveness_score ?? 0),
      }
    : null

  return {
    role,
    viewerId,
    viewerDepartment,
    sqlViewsReady,
    targets: mapSqlTarget((targetRes.error ? null : targetRes.data) as TrainingKpiTarget | null),
    departmentNames: depts.map((d) => d.name),
    people: scopedPeople,
    modules,
    courses,
    completions,
    attempts,
    studyLogs,
    enrolments,
    sqlBaseline: {
      summary: sqlSummary,
      employees: sqlEmployees,
      departments: sqlDepartments,
      courses: sqlCourses,
      trends: sqlTrends,
    },
  }
}

function isBaselineUnfiltered(dataset: KpiDataset, filters: KpiFilterState): boolean {
  return (
    dataset.sqlViewsReady &&
    filters.dateRange === 'all' &&
    !filters.startDate.trim() &&
    !filters.endDate.trim() &&
    filters.department === 'All' &&
    filters.courseId === 'All' &&
    filters.status === 'All' &&
    !filters.search.trim()
  )
}

export function computeFilteredKpiSnapshot(dataset: KpiDataset, filters: KpiFilterState): FilteredKpiSnapshot {
  const deptSet = new Set(dataset.people.map((p) => p.department))
  if (dataset.role === 'admin' || dataset.role === 'hr') {
    for (const d of dataset.departmentNames) deptSet.add(d)
  }
  const availableDepartments = Array.from(deptSet).filter(Boolean).sort()

  // Fast path: when SQL views are active and unfiltered, enrich directly from PostgreSQL view outputs
  if (isBaselineUnfiltered(dataset, filters) && dataset.sqlBaseline.summary) {
    const denom = Math.max(1, dataset.sqlBaseline.summary.totalEmployees * Math.max(1, dataset.modules.length))
    let runningCompletions = 0
    const monthlyTrends = dataset.sqlBaseline.trends.map((t) => {
      runningCompletions += t.lessonCompletions
      const monthlyPct =
        dataset.sqlBaseline.summary && dataset.sqlBaseline.summary.totalEmployees > 0
          ? Math.min(100, round1((t.lessonCompletions / denom) * 100))
          : 0
      const cumPct =
        dataset.sqlBaseline.summary && dataset.sqlBaseline.summary.totalEmployees > 0
          ? Math.min(100, round1((runningCompletions / denom) * 100))
          : 0
      return {
        ...t,
        completionRatePct: monthlyPct,
        cumulativeCompletionRatePct: cumPct,
      }
    })
    return {
      summary: dataset.sqlBaseline.summary,
      employees: dataset.sqlBaseline.employees,
      departments: dataset.sqlBaseline.departments,
      courses: dataset.sqlBaseline.courses,
      monthlyTrends,
      availableDepartments,
      targets: dataset.targets,
      sqlViewsReady: true,
    }
  }

  const window = resolveDateWindow(filters)
  const today = isoDay(new Date())
  const nowMs = Date.now()

  const selectedCourse =
    filters.courseId === 'All' ? null : dataset.courses.find((c) => c.id === filters.courseId) ?? null
  const selectedLessonIds = selectedCourse ? new Set(selectedCourse.lessons.map((l) => l.id)) : null

  const filteredPeople = dataset.people.filter((p) => {
    if (filters.department !== 'All' && p.department !== filters.department) return false
    if (selectedCourse && selectedCourse.category !== 'General' && selectedCourse.category !== p.department) {
      return false
    }
    const q = filters.search.trim().toLowerCase()
    if (q && !p.full_name.toLowerCase().includes(q) && !(p.email ?? '').toLowerCase().includes(q) && !p.department.toLowerCase().includes(q)) {
      return false
    }
    return true
  })

  const filteredCompletions = dataset.completions.filter((c) => {
    if (selectedLessonIds && !selectedLessonIds.has(c.module_id)) return false
    if (window.startIso || window.endIso) {
      const ts = c.completed_at ?? c.last_watched_at
      if (!ts) return false
      if (window.startIso && ts < window.startIso) return false
      if (window.endIso && ts > window.endIso) return false
    }
    return true
  })

  const filteredAttempts = dataset.attempts.filter((a) => {
    if (selectedCourse && a.milestone !== selectedCourse.id && a.milestone !== 'final') {
      // Allow milestone attempts for employees eligible for the selected course
      const person = dataset.people.find((p) => p.id === a.user_id)
      if (!person || (selectedCourse.category !== 'General' && selectedCourse.category !== person.department)) {
        return false
      }
    }
    if (window.startIso && a.created_at < window.startIso) return false
    if (window.endIso && a.created_at > window.endIso) return false
    return true
  })

  const filteredStudy = dataset.studyLogs.filter(
    (s) =>
      (!window.startDay || s.day >= window.startDay) &&
      (!window.endDay || s.day <= window.endDay) &&
      s.seconds > 0,
  )

  const relevantModules = selectedCourse
    ? selectedCourse.lessons
    : dataset.modules

  // 1. Employee-wise metrics
  const rawEmployeeRows: EmployeeKpiMetric[] = filteredPeople.map((p) => {
    const assigned = relevantModules.filter((m) => m.department === 'General' || m.department === p.department)
    const assignedIds = new Set(assigned.map((m) => m.id))

    const pComps = filteredCompletions.filter((c) => c.user_id === p.id && assignedIds.has(c.module_id))
    const doneIds = new Set(pComps.filter((c) => c.completed).map((c) => c.module_id))
    const inProgressCount = pComps.filter((c) => !c.completed && c.watched_seconds > 0).length
    const completedCount = assigned.filter((m) => doneIds.has(m.id)).length
    const pendingCount = Math.max(0, assigned.length - completedCount)
    const isPastDue = Boolean(p.due_date && p.due_date < today)
    const overdueCount = isPastDue ? pendingCount : 0
    const completionRatePct = assigned.length > 0 ? round1((completedCount / assigned.length) * 100) : 0

    const watchedSeconds = pComps.reduce((sum, c) => sum + (c.watched_seconds || 0), 0)
    const pStudy = filteredStudy.filter((s) => s.user_id === p.id)
    const studySeconds = filters.courseId === 'All' ? pStudy.reduce((sum, s) => sum + (s.seconds || 0), 0) : 0
    const learningHours = round2(Math.max(studySeconds, watchedSeconds) / 3600)

    const pAttempts = filteredAttempts.filter((a) => a.user_id === p.id)
    const quizAttemptsCount = pAttempts.length
    const quizPassesCount = pAttempts.filter((a) => a.passed).length
    const avgQuizScorePct = quizAttemptsCount
      ? round1(pAttempts.reduce((sum, a) => sum + (a.total > 0 ? (a.score / a.total) * 100 : 0), 0) / quizAttemptsCount)
      : null
    const quizPassRatePct = quizAttemptsCount ? round1((quizPassesCount / quizAttemptsCount) * 100) : null
    const firstAttempts = pAttempts.filter((a) => a.attempt_number === 1)
    const firstAttemptPassRatePct = firstAttempts.length
      ? round1((firstAttempts.filter((a) => a.passed).length / firstAttempts.length) * 100)
      : null

    let lastActiveAt: string | null = null
    const consider = (iso: string | null | undefined) => {
      if (iso && (!lastActiveAt || iso > lastActiveAt)) lastActiveAt = iso
    }
    for (const c of pComps) {
      consider(c.completed_at)
      consider(c.last_watched_at)
    }
    for (const a of pAttempts) consider(a.created_at)
    if (filters.courseId === 'All') {
      consider(p.last_activity_at)
      for (const s of pStudy) consider(`${s.day}T12:00:00Z`)
    }

    const idleDays = lastActiveAt ? (nowMs - new Date(lastActiveAt).getTime()) / 86400000 : Infinity
    const dueSoon = p.due_date ? (new Date(`${p.due_date}T00:00:00`).getTime() - nowMs) / 86400000 <= 14 : false

    let complianceStatus: ComplianceStatus = 'In Progress'
    if (assigned.length > 0 && completedCount >= assigned.length) {
      complianceStatus = 'Compliant'
    } else if (isPastDue) {
      complianceStatus = 'Overdue'
    } else if (completionRatePct < 60 && (dueSoon || idleDays > 7)) {
      complianceStatus = 'At Risk'
    }

    const effectivenessIndex = round1(
      completionRatePct * 0.45 +
        (avgQuizScorePct ?? completionRatePct) * 0.35 +
        (quizPassRatePct ?? completionRatePct) * 0.2,
    )

    return {
      userId: p.id,
      fullName: p.full_name,
      email: p.email ?? null,
      department: p.department,
      dueDate: p.due_date,
      assignedLessons: assigned.length,
      completedLessons: completedCount,
      inProgressLessons: inProgressCount,
      pendingLessons: pendingCount,
      overdueLessons: overdueCount,
      completionRatePct,
      learningHours,
      activeStudyDays: pStudy.length,
      quizAttemptsCount,
      quizPassesCount,
      avgQuizScorePct,
      quizPassRatePct,
      firstAttemptPassRatePct,
      complianceStatus,
      isCompliant: complianceStatus === 'Compliant',
      lastActiveAt,
      effectivenessIndex,
      rankOverall: 0,
      rankInDepartment: 0,
    }
  })

  const statusFilteredEmployees = rawEmployeeRows
    .filter((e) => filters.status === 'All' || e.complianceStatus === filters.status)
    .sort(
      (a, b) =>
        b.effectivenessIndex - a.effectivenessIndex ||
        b.completionRatePct - a.completionRatePct ||
        (b.avgQuizScorePct ?? 0) - (a.avgQuizScorePct ?? 0) ||
        b.learningHours - a.learningHours,
    )

  const deptCounters = new Map<string, number>()
  const employees = statusFilteredEmployees.map((row, idx) => {
    const deptRank = (deptCounters.get(row.department) ?? 0) + 1
    deptCounters.set(row.department, deptRank)
    return {
      ...row,
      rankOverall: idx + 1,
      rankInDepartment: deptRank,
    }
  })

  // 2. Department-wise metrics
  const byDept = new Map<string, EmployeeKpiMetric[]>()
  for (const e of employees) {
    byDept.set(e.department, [...(byDept.get(e.department) ?? []), e])
  }
  const threshold30d = new Date(nowMs - 30 * 86400000).toISOString()

  const departments: DepartmentKpiMetric[] = [...byDept.entries()]
    .map(([department, list]) => {
      const employeeCount = list.length
      const participatingEmployees = list.filter((e) => e.lastActiveAt !== null).length
      const activeLearners30d = list.filter((e) => e.lastActiveAt !== null && e.lastActiveAt >= threshold30d).length
      const avgCompletionRatePct = employeeCount
        ? round1(list.reduce((s, e) => s + e.completionRatePct, 0) / employeeCount)
        : 0
      const totalLearningHours = round2(list.reduce((s, e) => s + e.learningHours, 0))
      const avgLearningHours = employeeCount ? round2(totalLearningHours / employeeCount) : 0

      const quizAttemptsCount = list.reduce((s, e) => s + e.quizAttemptsCount, 0)
      const quizPassesCount = list.reduce((s, e) => s + e.quizPassesCount, 0)
      const scoredPeople = list.filter((e) => e.avgQuizScorePct !== null)
      const avgQuizScorePct = scoredPeople.length
        ? round1(scoredPeople.reduce((s, e) => s + (e.avgQuizScorePct ?? 0), 0) / scoredPeople.length)
        : null
      const quizPassRatePct = quizAttemptsCount ? round1((quizPassesCount / quizAttemptsCount) * 100) : null

      const compliantCount = list.filter((e) => e.complianceStatus === 'Compliant').length
      const overdueCount = list.filter((e) => e.complianceStatus === 'Overdue').length
      const pendingCount = employeeCount - compliantCount - overdueCount
      const complianceRatePct = employeeCount ? round1((compliantCount / employeeCount) * 100) : 0
      const trainingEffectivenessScore = employeeCount
        ? round1(list.reduce((s, e) => s + e.effectivenessIndex, 0) / employeeCount)
        : 0

      return {
        department,
        employeeCount,
        participatingEmployees,
        activeLearners30d,
        participationRatePct: employeeCount ? round1((participatingEmployees / employeeCount) * 100) : 0,
        avgCompletionRatePct,
        totalLearningHours,
        avgLearningHours,
        quizAttemptsCount,
        avgQuizScorePct,
        quizPassRatePct,
        compliantCount,
        pendingCount,
        overdueCount,
        complianceRatePct,
        trainingEffectivenessScore,
      }
    })
    .sort((a, b) => b.avgCompletionRatePct - a.avgCompletionRatePct || a.department.localeCompare(b.department))

  // 3. Course-wise metrics
  const activeEmpIds = new Set(employees.map((e) => e.userId))
  const courseList = selectedCourse ? [selectedCourse] : dataset.courses

  const courses: CourseKpiMetric[] = courseList
    .map((course) => {
      const targetPeople = filteredPeople.filter(
        (p) => activeEmpIds.has(p.id) && (course.category === 'General' || course.category === p.department),
      )
      const targetLearners = targetPeople.length
      const lessonIds = new Set(course.lessons.map((l) => l.id))

      let startedLearners = 0
      let completedLearners = 0
      let overdueLearners = 0
      let watchedSecTotal = 0

      for (const p of targetPeople) {
        const assignedLessons = course.lessons.filter((l) => l.department === 'General' || l.department === p.department)
        const pComps = filteredCompletions.filter((c) => c.user_id === p.id && lessonIds.has(c.module_id))
        watchedSecTotal += pComps.reduce((s, c) => s + (c.watched_seconds || 0), 0)
        const started = pComps.some((c) => c.watched_seconds > 0 || c.completed)
        const doneIds = new Set(pComps.filter((c) => c.completed).map((c) => c.module_id))
        const finished = assignedLessons.length > 0 && assignedLessons.every((l) => doneIds.has(l.id))
        if (started) startedLearners++
        if (finished) completedLearners++
        else if (p.due_date && p.due_date < today) overdueLearners++
      }

      const targetUserIds = new Set(targetPeople.map((p) => p.id))
      const cAttempts = filteredAttempts.filter((a) => targetUserIds.has(a.user_id))
      const avgQuizScorePct = cAttempts.length
        ? round1(cAttempts.reduce((s, a) => s + (a.total > 0 ? (a.score / a.total) * 100 : 0), 0) / cAttempts.length)
        : null
      const quizPassRatePct = cAttempts.length
        ? round1((cAttempts.filter((a) => a.passed).length / cAttempts.length) * 100)
        : null

      const participationRatePct = targetLearners ? round1((startedLearners / targetLearners) * 100) : 0
      const completionRatePct = targetLearners ? round1((completedLearners / targetLearners) * 100) : 0
      const dropOffRatePct = startedLearners
        ? round1(((startedLearners - completedLearners) / startedLearners) * 100)
        : 0
      const trainingEffectivenessScore = round1(
        completionRatePct * 0.45 +
          (avgQuizScorePct ?? completionRatePct) * 0.35 +
          (quizPassRatePct ?? completionRatePct) * 0.2,
      )

      return {
        courseId: course.id,
        courseTitle: course.title,
        category: course.category,
        color: course.color,
        lessonCount: course.lessons.length,
        targetLearners,
        startedLearners,
        completedLearners,
        participationRatePct,
        completionRatePct,
        learningHours: round2(watchedSecTotal / 3600),
        avgQuizScorePct,
        quizPassRatePct,
        overdueLearners,
        dropOffRatePct,
        trainingEffectivenessScore,
      }
    })
    .filter((c) => filters.department === 'All' || c.category === 'General' || c.category === filters.department)
    .sort((a, b) => b.completionRatePct - a.completionRatePct || a.courseTitle.localeCompare(b.courseTitle))

  // 4. Monthly Trends (including cumulative & monthly completion rate over the active date range)
  const monthKeys = monthKeysForFilters(filters, window, filteredCompletions, filteredAttempts, filteredStudy)
  const monthlyTrends: MonthlyTrendMetric[] = []
  const totalAssignedSlots = Math.max(
    1,
    employees.reduce((sum, e) => sum + e.assignedLessons, 0),
  )
  const cumulativeDonePairs = new Set<string>()
  const assignedPairs = new Set<string>()
  for (const e of employees) {
    for (const m of relevantModules) {
      if (m.department === 'General' || m.department === e.department) {
        assignedPairs.add(`${e.userId}:${m.id}`)
      }
    }
  }

  for (const monthKey of monthKeys) {
    const [yStr, mStr] = monthKey.split('-')
    const dt = new Date(Number(yStr), (Number(mStr) || 1) - 1, 1)
    const monthLabel = dt.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })

    const mComps = filteredCompletions.filter((c) => {
      if (!activeEmpIds.has(c.user_id)) return false
      const ts = c.completed_at ?? c.last_watched_at
      return ts ? ts.slice(0, 7) === monthKey : false
    })
    for (const c of mComps) {
      if (c.completed) {
        const pair = `${c.user_id}:${c.module_id}`
        if (assignedPairs.has(pair)) cumulativeDonePairs.add(pair)
      }
    }
    const mStudy =
      filters.courseId === 'All'
        ? filteredStudy.filter((s) => activeEmpIds.has(s.user_id) && s.day.slice(0, 7) === monthKey)
        : []
    const mAttempts = filteredAttempts.filter(
      (a) => activeEmpIds.has(a.user_id) && a.created_at.slice(0, 7) === monthKey,
    )

    const activeUserSet = new Set<string>()
    for (const c of mComps) activeUserSet.add(c.user_id)
    for (const s of mStudy) activeUserSet.add(s.user_id)
    for (const a of mAttempts) activeUserSet.add(a.user_id)

    const lessonCompletions = mComps.filter((c) => c.completed).length
    const studySec = mStudy.reduce((s, r) => s + r.seconds, 0)
    const compSec = mComps.reduce((s, r) => s + r.watched_seconds, 0)
    const avgQuizScorePct = mAttempts.length
      ? round1(mAttempts.reduce((s, a) => s + (a.total > 0 ? (a.score / a.total) * 100 : 0), 0) / mAttempts.length)
      : null
    const quizPassRatePct = mAttempts.length
      ? round1((mAttempts.filter((a) => a.passed).length / mAttempts.length) * 100)
      : null

    const monthlyRate = employees.length
      ? Math.min(100, round1((lessonCompletions / totalAssignedSlots) * 100))
      : 0
    const cumulativeRate = employees.length
      ? Math.min(100, round1((cumulativeDonePairs.size / totalAssignedSlots) * 100))
      : 0

    monthlyTrends.push({
      monthKey,
      monthLabel,
      activeUsers: activeUserSet.size,
      lessonCompletions,
      learningHours: round2(Math.max(studySec, compSec) / 3600),
      quizAttempts: mAttempts.length,
      avgQuizScorePct,
      quizPassRatePct,
      completionRatePct: monthlyRate,
      cumulativeCompletionRatePct: cumulativeRate,
    })
  }

  // 5. Company / Scope Summary
  const totalEmployees = employees.length
  const participatingEmployees = employees.filter((e) => e.lastActiveAt !== null).length
  const avgCompletionRatePct = totalEmployees
    ? round1(employees.reduce((s, e) => s + e.completionRatePct, 0) / totalEmployees)
    : 0
  const totalLearningHours = round2(employees.reduce((s, e) => s + e.learningHours, 0))

  const totalAttempts = employees.reduce((s, e) => s + e.quizAttemptsCount, 0)
  const totalPasses = employees.reduce((s, e) => s + e.quizPassesCount, 0)
  const scoredPeople = employees.filter((e) => e.avgQuizScorePct !== null)
  const avgQuizScorePct = scoredPeople.length
    ? round1(scoredPeople.reduce((s, e) => s + (e.avgQuizScorePct ?? 0), 0) / scoredPeople.length)
    : null
  const quizPassRatePct = totalAttempts ? round1((totalPasses / totalAttempts) * 100) : null

  const compliantEmployees = employees.filter((e) => e.complianceStatus === 'Compliant').length
  const overdueEmployees = employees.filter((e) => e.complianceStatus === 'Overdue').length
  const pendingEmployees = totalEmployees - compliantEmployees - overdueEmployees
  const complianceRatePct = totalEmployees ? round1((compliantEmployees / totalEmployees) * 100) : 0
  const trainingEffectivenessScore = totalEmployees
    ? round1(employees.reduce((s, e) => s + e.effectivenessIndex, 0) / totalEmployees)
    : 0

  return {
    summary: {
      totalEmployees,
      participatingEmployees,
      participationRatePct: totalEmployees ? round1((participatingEmployees / totalEmployees) * 100) : 0,
      avgCompletionRatePct,
      totalLearningHours,
      avgQuizScorePct,
      quizPassRatePct,
      compliantEmployees,
      pendingEmployees,
      overdueEmployees,
      complianceRatePct,
      trainingEffectivenessScore,
    },
    employees,
    departments,
    courses,
    monthlyTrends,
    availableDepartments,
    targets: dataset.targets,
    sqlViewsReady: dataset.sqlViewsReady,
  }
}

export async function saveKpiTargets(
  targets: KpiTargetsConfig,
  userId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('training_kpi_targets').upsert(
    {
      scope: targets.scope || 'company',
      target_completion_pct: targets.targetCompletionPct,
      target_pass_rate_pct: targets.targetPassRatePct,
      target_compliance_pct: targets.targetCompliancePct,
      target_learning_hours_monthly: targets.targetLearningHoursMonthly,
      pass_threshold_pct: targets.passThresholdPct,
      updated_by: userId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'scope' },
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
