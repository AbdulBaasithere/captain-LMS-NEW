import { supabase } from '@/lib/supabase'
import { loadCourses, type CourseVM } from '@/lib/courses'
import type { CourseEnrolment, Module, Profile } from '@/lib/database.types'

export interface AssignCourseParams {
  courseId: number
  courseTitle: string
  userIds: string[]
  deadlineDate?: string | null
  assignedBy?: string | null
  profilesById: Map<string, Profile>
}

export async function assignCourseToEmployees(params: AssignCourseParams): Promise<{
  ok: boolean
  assignedCount: number
  error?: string
}> {
  const uniqueIds = [...new Set(params.userIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return { ok: false, assignedCount: 0, error: 'Select at least one employee.' }
  }

  const deadline = params.deadlineDate?.trim() ? params.deadlineDate.trim() : null
  const nowIso = new Date().toISOString()
  const todayStr = nowIso.slice(0, 10)

  const { data: existingRows, error: fetchErr } = await supabase
    .from('course_enrolments')
    .select('*')
    .eq('course_id', params.courseId)
    .in('user_id', uniqueIds)

  if (fetchErr) {
    return { ok: false, assignedCount: 0, error: fetchErr.message }
  }

  const existingByUser = new Map<string, CourseEnrolment>()
  for (const row of (existingRows ?? []) as CourseEnrolment[]) {
    existingByUser.set(row.user_id, row)
  }

  const payload = uniqueIds.map((uid) => {
    const existing = existingByUser.get(uid)
    const profile = params.profilesById.get(uid)
    const effectiveDeadline = deadline ?? existing?.deadline_date ?? profile?.due_date ?? null

    let status = existing?.status ?? 'not_started'
    if (existing?.completed_at || status === 'completed') {
      status = 'completed'
    } else if (effectiveDeadline && effectiveDeadline < todayStr) {
      status = 'overdue'
    } else if (existing?.started_at || (existing?.progress_pct ?? 0) > 0) {
      status = 'in_progress'
    } else {
      status = 'not_started'
    }

    return {
      user_id: uid,
      course_id: params.courseId,
      assigned_by: params.assignedBy ?? existing?.assigned_by ?? null,
      hr_email: existing?.hr_email ?? profile?.hr_email ?? null,
      manager_email: existing?.manager_email ?? profile?.manager_email ?? null,
      deadline_date: effectiveDeadline,
      status,
      progress_pct: existing?.progress_pct ?? 0,
      enrolled_at: existing?.enrolled_at ?? nowIso,
      updated_at: nowIso,
    }
  })

  const { error: upsertErr } = await supabase
    .from('course_enrolments')
    .upsert(payload, { onConflict: 'user_id,course_id' })

  if (upsertErr) {
    return { ok: false, assignedCount: 0, error: upsertErr.message }
  }

  // Send in-app notifications to newly assigned employees (or where assigned_by wasn't set before)
  const notifyIds = uniqueIds.filter((uid) => {
    const existing = existingByUser.get(uid)
    return !existing || !existing.assigned_by
  })

  if (notifyIds.length > 0) {
    const dueMsg = deadline ? ` (due ${deadline})` : ''
    await supabase.from('notifications').insert(
      notifyIds.map((uid) => ({
        user_id: uid,
        text: `You have been assigned to the course "${params.courseTitle}"${dueMsg}.`,
        action: { type: 'goto' as const, view: '/app/catalog' },
      })),
    )
  }

  return { ok: true, assignedCount: uniqueIds.length }
}

export async function updateCourseAssignmentDeadline(params: {
  enrolmentId: number
  deadlineDate: string | null
  isCompleted: boolean
  hasStarted: boolean
}): Promise<{ ok: boolean; error?: string }> {
  const cleanDeadline = params.deadlineDate?.trim() ? params.deadlineDate.trim() : null
  const todayStr = new Date().toISOString().slice(0, 10)
  const nextStatus = params.isCompleted
    ? 'completed'
    : cleanDeadline && cleanDeadline < todayStr
      ? 'overdue'
      : params.hasStarted
        ? 'in_progress'
        : 'not_started'

  const { error } = await supabase
    .from('course_enrolments')
    .update({
      deadline_date: cleanDeadline,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.enrolmentId)

  return error ? { ok: false, error: error.message } : { ok: true }
}

export async function unassignCourseFromEmployee(enrolmentId: number): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('course_enrolments').delete().eq('id', enrolmentId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

/**
 * Loads all published modules & courses available to an employee, including both
 * General/department courses AND any courses explicitly assigned via course_enrolments
 * (even if the course belongs to another department).
 */
export async function loadEmployeeCoursesAndEnrolments(userId: string, department: string): Promise<{
  modules: Module[]
  courses: CourseVM[]
  enrolments: CourseEnrolment[]
  enrolmentByCourseId: Map<number, CourseEnrolment>
}> {
  const { data: enrolData } = await supabase
    .from('course_enrolments')
    .select('*')
    .eq('user_id', userId)

  const enrolments = (enrolData ?? []) as CourseEnrolment[]
  const enrolmentByCourseId = new Map<number, CourseEnrolment>()
  const assignedCourseIds: number[] = []

  for (const e of enrolments) {
    enrolmentByCourseId.set(e.course_id, e)
    assignedCourseIds.push(e.course_id)
  }

  const orParts = [`department.eq.General`, `department.eq.${department}`]
  if (assignedCourseIds.length > 0) {
    orParts.push(`course_id.in.(${assignedCourseIds.join(',')})`)
  }

  const { data: modData } = await supabase
    .from('modules')
    .select('*')
    .or(orParts.join(','))
    .eq('is_draft', false)
    .eq('is_archived', false)
    .order('id')

  const modules = (modData ?? []) as Module[]
  const allLoaded = await loadCourses(modules)

  // Keep courses that either belong to General/employee's department OR are explicitly assigned
  const courses = allLoaded.filter((c) => {
    if (c.lessons.length === 0) return false
    if (c.dbId && enrolmentByCourseId.has(c.dbId)) return true
    return c.category === 'General' || c.category === department || c.lessons.some((l) => l.department === 'General' || l.department === department)
  })

  return {
    modules,
    courses,
    enrolments,
    enrolmentByCourseId,
  }
}
