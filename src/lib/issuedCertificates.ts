import { supabase } from '@/lib/supabase'
import type { CertificateData } from '@/lib/certificate'
import type { IssuedCertificateRow } from '@/lib/database.types'

export interface IssuedCertificate {
  id: number
  certificateCode: string
  userId: string
  title: string
  category: string
  description: string
  issuedDate: string
  totalHours: number
  totalLessons: number
  courseId: number | null
  issuedBy: string | null
  createdAt: string
}

export interface IssueCertificateInput {
  title: string
  category: string
  description: string
  issuedDate: string
  totalHours: number
  totalLessons: number
  courseId?: number | null
}

const LOCAL_CERTIFICATES_KEY = 'captain_admin_issued_certificates_v1'

function rowToModel(row: IssuedCertificateRow): IssuedCertificate {
  return {
    id: row.id,
    certificateCode: row.certificate_code,
    userId: row.user_id,
    title: row.title,
    category: row.category || 'Special Recognition',
    description: row.description ?? '',
    issuedDate: row.issued_date,
    totalHours: Number(row.total_hours ?? 0),
    totalLessons: Number(row.total_lessons ?? 0),
    courseId: row.course_id ?? null,
    issuedBy: row.issued_by ?? null,
    createdAt: row.created_at,
  }
}

function readLocalCertificates(): IssuedCertificate[] {
  try {
    const raw = localStorage.getItem(LOCAL_CERTIFICATES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as IssuedCertificate[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLocalCertificates(list: IssuedCertificate[]): void {
  try {
    localStorage.setItem(LOCAL_CERTIFICATES_KEY, JSON.stringify(list))
  } catch {
    // ignore storage errors
  }
}

function buildAdminCertCode(userId: string): string {
  const year = new Date().getFullYear()
  const userTag = userId.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'EMP'
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `CAP-${year}-${userTag}-${rand}`
}

export async function loadIssuedCertificates(options: { userId?: string } = {}): Promise<{
  certificates: IssuedCertificate[]
  tableMissing: boolean
}> {
  try {
    let query = supabase
      .from('issued_certificates')
      .select('*')
      .order('issued_date', { ascending: false })
      .order('id', { ascending: false })

    if (options.userId) {
      query = query.eq('user_id', options.userId)
    }

    const { data, error } = await query
    if (!error && data) {
      const mapped = (data as IssuedCertificateRow[]).map(rowToModel)
      if (!options.userId) {
        writeLocalCertificates(mapped)
      }
      return { certificates: mapped, tableMissing: false }
    }

    const msg = error?.message ?? ''
    const missing = /does not exist|schema cache|42P01/i.test(msg)
    const local = readLocalCertificates()
    return {
      certificates: options.userId ? local.filter((c) => c.userId === options.userId) : local,
      tableMissing: missing,
    }
  } catch {
    const local = readLocalCertificates()
    return {
      certificates: options.userId ? local.filter((c) => c.userId === options.userId) : local,
      tableMissing: true,
    }
  }
}

export async function issueCertificateToEmployees(
  input: IssueCertificateInput,
  userIds: string[],
  issuedBy?: string | null,
): Promise<{
  ok: boolean
  syncedRemote: boolean
  issued: IssuedCertificate[]
  error?: string
}> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return { ok: false, syncedRemote: false, issued: [], error: 'Select at least one employee.' }
  }

  const cleanTitle = input.title.trim()
  const cleanCategory = input.category.trim() || 'Special Recognition'
  const cleanDescription = input.description.trim()
  const issuedDate = input.issuedDate || new Date().toISOString().slice(0, 10)
  const totalHours = Math.max(0, Number(input.totalHours) || 0)
  const totalLessons = Math.max(0, Math.round(Number(input.totalLessons) || 0))
  const courseId = input.courseId ?? null

  const rows = uniqueIds.map((uid) => ({
    certificate_code: buildAdminCertCode(uid),
    user_id: uid,
    title: cleanTitle,
    category: cleanCategory,
    description: cleanDescription,
    issued_date: issuedDate,
    total_hours: totalHours,
    total_lessons: totalLessons,
    course_id: courseId,
    issued_by: issuedBy ?? null,
  }))

  try {
    const { data, error } = await supabase.from('issued_certificates').insert(rows).select('*')
    if (!error && data) {
      const issued = (data as IssuedCertificateRow[]).map(rowToModel)
      const existing = readLocalCertificates()
      writeLocalCertificates([...issued, ...existing])

      // Best-effort in-app notification for each recipient
      await supabase.from('notifications').insert(
        uniqueIds.map((uid) => ({
          user_id: uid,
          text: `You were awarded a certificate: "${cleanTitle}". View it under Badges & Certificates.`,
          action: { type: 'goto' as const, view: '/app/badges' },
        })),
      )

      return { ok: true, syncedRemote: true, issued }
    }

    const msg = error?.message ?? 'Could not issue certificate.'
    const missing = /does not exist|schema cache|42P01/i.test(msg)
    if (!missing) {
      return { ok: false, syncedRemote: false, issued: [], error: msg }
    }

    const existing = readLocalCertificates()
    let nextId = Math.max(0, ...existing.map((c) => c.id)) + 1
    const nowIso = new Date().toISOString()
    const localIssued: IssuedCertificate[] = rows.map((r) => ({
      id: nextId++,
      certificateCode: r.certificate_code,
      userId: r.user_id,
      title: r.title,
      category: r.category,
      description: r.description,
      issuedDate: r.issued_date,
      totalHours: r.total_hours,
      totalLessons: r.total_lessons,
      courseId: r.course_id,
      issuedBy: r.issued_by,
      createdAt: nowIso,
    }))
    writeLocalCertificates([...localIssued, ...existing])
    return {
      ok: true,
      syncedRemote: false,
      issued: localIssued,
      error:
        'Saved in this browser (run supabase/migrations/20261116_admin_certificates_badges_assignments.sql in Supabase to sync across devices).',
    }
  } catch (err) {
    return {
      ok: false,
      syncedRemote: false,
      issued: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function revokeIssuedCertificate(
  id: number,
): Promise<{ ok: boolean; syncedRemote: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('issued_certificates').delete().eq('id', id)
    if (!error) {
      writeLocalCertificates(readLocalCertificates().filter((c) => c.id !== id))
      return { ok: true, syncedRemote: true }
    }

    const missing = /does not exist|schema cache|42P01/i.test(error.message)
    if (!missing) {
      return { ok: false, syncedRemote: false, error: error.message }
    }

    writeLocalCertificates(readLocalCertificates().filter((c) => c.id !== id))
    return { ok: true, syncedRemote: false }
  } catch (err) {
    return {
      ok: false,
      syncedRemote: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function issuedCertToCertificateData(
  cert: IssuedCertificate,
  recipient: { full_name: string; email?: string | null; department?: string | null },
): CertificateData {
  const formattedDate = new Date(`${cert.issuedDate}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return {
    userName: recipient.full_name,
    userEmail: recipient.email ?? undefined,
    userDepartment: recipient.department ?? undefined,
    courseTitle: cert.title,
    courseCategory: cert.category || 'Official Certificate',
    completedDate: formattedDate,
    certificateId: cert.certificateCode,
    totalLessons: cert.totalLessons,
    totalMinutes: Math.round(cert.totalHours * 60),
  }
}
