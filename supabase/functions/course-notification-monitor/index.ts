import {
  evaluateEnrolment,
  isEnrolmentCompleted,
  resolveNotificationRecipients,
  toUtcDateString,
  type EnrolmentRecord,
  type MonitoringSettings,
} from './monitor-logic.ts'
import { renderCourseNotificationEmail } from './email-templates.ts'
import { dispatchEmail, type EmailProviderType } from './email-providers.ts'

declare const Deno: {
  env: {
    get(key: string): string | undefined
  }
  serve(handler: (req: Request) => Promise<Response> | Response): void
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface ProfileRow {
  id: string
  full_name: string
  email: string | null
  role: 'employee' | 'admin' | 'manager'
  department: string
  due_date: string | null
  is_active?: boolean
  manager_id: string | null
  manager_email: string | null
  hr_email: string | null
  last_activity_at: string | null
}

interface CourseRow {
  id: number
  title: string
  category: string
  is_published: boolean
}

interface ModuleRow {
  id: number
  course_id: number | null
  department: string
  lesson_order: number | null
  is_draft: boolean
  is_archived: boolean
}

interface SettingsRow extends MonitoringSettings {
  id: number
  sender_name: string
  sender_email: string
  email_provider: EmailProviderType
  lms_base_url: string
}

interface SupabaseQueryResult<T = unknown> {
  data: T | null
  error: { message: string; code?: string } | null
}

interface SupabaseAdminClient {
  auth: {
    getUser(jwt: string): Promise<{ data: { user: { id: string; email?: string | null } | null }; error: unknown }>
    admin: {
      getUserById(id: string): Promise<{ data: { user: { email?: string | null } | null }; error: unknown }>
    }
  }
  rpc(fn: string, params?: Record<string, unknown>): Promise<SupabaseQueryResult>
  from(table: string): {
    select(cols: string): SupabaseFilterBuilder
    insert(values: Record<string, unknown> | Record<string, unknown>[]): SupabaseFilterBuilder
    update(values: Record<string, unknown>): SupabaseFilterBuilder
  }
}

interface SupabaseFilterBuilder extends PromiseLike<SupabaseQueryResult> {
  eq(col: string, val: unknown): SupabaseFilterBuilder
  is(col: string, val: null): SupabaseFilterBuilder
  select(cols?: string): SupabaseFilterBuilder
  single<T = Record<string, unknown>>(): Promise<SupabaseQueryResult<T>>
  maybeSingle<T = Record<string, unknown>>(): Promise<SupabaseQueryResult<T>>
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

async function createAdminClient(): Promise<{ client: SupabaseAdminClient; serviceRoleKey: string } | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim()
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  if (!supabaseUrl || !serviceRoleKey) return null

  const mod = (await import('https://esm.sh/@supabase/supabase-js@2')) as {
    createClient: (
      url: string,
      key: string,
      opts?: Record<string, unknown>,
    ) => SupabaseAdminClient
  }

  const client = mod.createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return { client, serviceRoleKey }
}

async function authenticateCaller(
  req: Request,
  supabaseAdmin: SupabaseAdminClient,
  serviceRoleKey: string,
): Promise<{ authorized: boolean; isSystem: boolean; userId: string | null; role: string | null }> {
  const cronSecret = Deno.env.get('CRON_SECRET')?.trim()
  const headerCron = req.headers.get('x-cron-secret')?.trim()
  if (cronSecret && headerCron && headerCron === cronSecret) {
    return { authorized: true, isSystem: true, userId: null, role: 'system' }
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    return { authorized: false, isSystem: false, userId: null, role: null }
  }

  if (token === serviceRoleKey) {
    return { authorized: true, isSystem: true, userId: null, role: 'service_role' }
  }

  const { data: userData, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !userData.user) {
    return { authorized: false, isSystem: false, userId: null, role: null }
  }

  const { data: prof } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle<{ role: string }>()

  return {
    authorized: true,
    isSystem: false,
    userId: userData.user.id,
    role: prof?.role ?? 'employee',
  }
}

async function resolveEmployeeEmail(
  supabaseAdmin: SupabaseAdminClient,
  profile: ProfileRow,
): Promise<string | null> {
  if (profile.email && profile.email.includes('@')) return profile.email
  const { data } = await supabaseAdmin.auth.admin.getUserById(profile.id)
  return data.user?.email ?? null
}

function buildCourseUrl(baseUrl: string, modules: ModuleRow[], courseId: number, department: string): string {
  const cleanBase = (baseUrl || Deno.env.get('LMS_PUBLIC_URL') || 'https://lms.captainandcompany.com').replace(/\/+$/, '')
  const lessons = modules
    .filter((m) => m.course_id === courseId && !m.is_draft && !m.is_archived && (m.department === 'General' || m.department === department))
    .sort((a, b) => (a.lesson_order ?? 0) - (b.lesson_order ?? 0) || a.id - b.id)

  const firstLesson = lessons[0]
  return firstLesson ? `${cleanBase}/app/modules/${firstLesson.id}` : `${cleanBase}/app/catalog`
}

async function sendAndRecordNotification(params: {
  supabaseAdmin: SupabaseAdminClient
  settings: SettingsRow
  enrolment: EnrolmentRecord
  employee: ProfileRow
  employeeEmail: string | null
  cc: string[]
  course: CourseRow
  courseUrl: string
  notificationType: 'course_start' | 'inactivity_7d' | 'deadline_reminder' | 'course_overdue'
  idempotencyKey: string
  daysInactive?: number
  daysRemaining?: number
  daysOverdue?: number
}): Promise<{ outcome: 'sent' | 'failed' | 'skipped' | 'duplicate'; error?: string }> {
  const { supabaseAdmin, settings, enrolment, employee, employeeEmail, cc, course, courseUrl } = params

  if (isEnrolmentCompleted(enrolment)) {
    return { outcome: 'skipped', error: 'Course already completed; reminders stopped.' }
  }

  if (!employeeEmail) {
    return { outcome: 'skipped', error: `Missing employee email for ${employee.full_name}` }
  }

  const rendered = renderCourseNotificationEmail({
    notificationType: params.notificationType,
    employeeName: employee.full_name,
    department: employee.department,
    courseName: course.title,
    courseCategory: course.category,
    progressPct: enrolment.progress_pct,
    lastActivityIso: enrolment.last_activity_at ?? enrolment.started_at,
    deadlineDate: enrolment.deadline_date,
    courseUrl,
    organizationName: Deno.env.get('ORGANIZATION_NAME') || 'Captain LMS',
    daysInactive: params.daysInactive,
    daysRemaining: params.daysRemaining,
    daysOverdue: params.daysOverdue,
  })

  // Reserve idempotency slot before dispatching email to prevent duplicate sends across concurrent runs
  const { data: insertedLog, error: insertErr } = await supabaseAdmin
    .from('email_notification_logs')
    .insert({
      user_id: employee.id,
      course_id: course.id,
      enrolment_id: enrolment.id,
      notification_type: params.notificationType,
      idempotency_key: params.idempotencyKey,
      to_email: employeeEmail,
      cc_emails: cc,
      subject: rendered.subject,
      html_body: rendered.html,
      provider: settings.email_provider,
      status: 'pending',
      metadata: {
        progress_pct: enrolment.progress_pct,
        deadline_date: enrolment.deadline_date,
        days_inactive: params.daysInactive ?? null,
        days_remaining: params.daysRemaining ?? null,
        days_overdue: params.daysOverdue ?? null,
      },
    })
    .select('id')
    .single<{ id: number }>()

  if (insertErr) {
    if (insertErr.code === '23505' || insertErr.message.toLowerCase().includes('duplicate')) {
      return { outcome: 'duplicate' }
    }
    return { outcome: 'failed', error: insertErr.message }
  }

  const dispatchResult = await dispatchEmail(settings.email_provider, {
    to: employeeEmail,
    cc,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    fromName: settings.sender_name,
    fromEmail: settings.sender_email,
  })

  const nowIso = new Date().toISOString()

  if (dispatchResult.ok) {
    await supabaseAdmin
      .from('email_notification_logs')
      .update({
        status: 'sent',
        provider: dispatchResult.provider,
        provider_message_id: dispatchResult.messageId ?? null,
        sent_at: nowIso,
        error_message: null,
      })
      .eq('id', insertedLog?.id)

    if (params.notificationType === 'course_start') {
      await supabaseAdmin
        .from('course_enrolments')
        .update({ course_start_notified_at: nowIso, updated_at: nowIso })
        .eq('id', enrolment.id)
    } else if (params.notificationType === 'inactivity_7d') {
      await supabaseAdmin
        .from('course_enrolments')
        .update({ last_inactivity_notified_at: nowIso, updated_at: nowIso })
        .eq('id', enrolment.id)
    }

    return { outcome: 'sent' }
  }

  await supabaseAdmin
    .from('email_notification_logs')
    .update({
      status: 'failed',
      provider: dispatchResult.provider,
      error_message: dispatchResult.error ?? 'Unknown email provider error',
    })
    .eq('id', insertedLog?.id)

  return { outcome: 'failed', error: dispatchResult.error }
}

async function handleRunMonitor(
  supabaseAdmin: SupabaseAdminClient,
  payload: { department?: string; user_id?: string; origin?: string },
) {
  await supabaseAdmin.rpc('sync_course_enrolments', { p_user_id: payload.user_id ?? null })

  const [settingsRes, enrolmentsRes, profilesRes, coursesRes, modulesRes, logsRes] = await Promise.all([
    supabaseAdmin.from('notification_settings').select('*').eq('id', 1).maybeSingle<SettingsRow>(),
    supabaseAdmin.from('course_enrolments').select('*').eq('reminders_stopped', false).is('completed_at', null),
    supabaseAdmin.from('profiles').select('*'),
    supabaseAdmin.from('courses').select('id, title, category, is_published'),
    supabaseAdmin.from('modules').select('id, course_id, department, lesson_order, is_draft, is_archived'),
    supabaseAdmin.from('email_notification_logs').select('idempotency_key, status'),
  ])

  const settings: SettingsRow = settingsRes.data ?? {
    id: 1,
    enabled: true,
    inactivity_days: 7,
    reminder_days: [7, 3, 1],
    send_course_start: true,
    send_inactivity: true,
    send_deadline_reminders: true,
    send_overdue: true,
    sender_name: 'Captain LMS Notifications',
    sender_email: 'lms@captainandcompany.com',
    default_hr_email: null,
    email_provider: 'resend',
    lms_base_url: payload.origin ?? '',
  }

  const effectiveBaseUrl = settings.lms_base_url || payload.origin || ''
  const enrolments = (enrolmentsRes.data ?? []) as EnrolmentRecord[]
  const profiles = (profilesRes.data ?? []) as ProfileRow[]
  const courses = (coursesRes.data ?? []) as CourseRow[]
  const modules = (modulesRes.data ?? []) as ModuleRow[]
  const existingKeys = new Set(
    ((logsRes.data ?? []) as { idempotency_key: string; status: string }[]).map((l) => l.idempotency_key),
  )

  const profileMap = new Map(profiles.map((p) => [p.id, p]))
  const courseMap = new Map(courses.map((c) => [c.id, c]))
  const deptManagerMap = new Map<string, string>()
  for (const p of profiles) {
    if (p.role === 'manager' && p.is_active !== false && p.email && !deptManagerMap.has(p.department)) {
      deptManagerMap.set(p.department, p.email)
    }
  }

  const now = new Date()
  const todayStr = toUtcDateString(now)
  let evaluated = 0
  let sent = 0
  let failed = 0
  let skipped = 0
  const errors: string[] = []

  for (const enrolment of enrolments) {
    const employee = profileMap.get(enrolment.user_id)
    const course = courseMap.get(enrolment.course_id)
    if (!employee || !course || employee.is_active === false || !course.is_published) continue
    if (payload.department && payload.department !== 'All' && employee.department !== payload.department) continue
    if (payload.user_id && employee.id !== payload.user_id) continue

    evaluated += 1

    // Keep overdue status synced in DB
    if (!isEnrolmentCompleted(enrolment) && enrolment.deadline_date && enrolment.deadline_date < todayStr && enrolment.status !== 'overdue') {
      await supabaseAdmin
        .from('course_enrolments')
        .update({ status: 'overdue', updated_at: now.toISOString() })
        .eq('id', enrolment.id)
    }

    const actions = evaluateEnrolment(enrolment, settings, now, existingKeys)
    if (!actions.length) continue

    const empEmail = await resolveEmployeeEmail(supabaseAdmin, employee)
    const linkedMgr = employee.manager_id ? profileMap.get(employee.manager_id) : undefined
    const recipients = resolveNotificationRecipients({
      employeeEmail: empEmail,
      enrolmentHrEmail: enrolment.hr_email,
      profileHrEmail: employee.hr_email,
      defaultHrEmail: settings.default_hr_email,
      enrolmentManagerEmail: enrolment.manager_email,
      profileManagerEmail: employee.manager_email,
      linkedManagerProfileEmail: linkedMgr?.email ?? null,
      departmentManagerEmail: deptManagerMap.get(employee.department) ?? null,
    })

    const courseUrl = buildCourseUrl(effectiveBaseUrl, modules, course.id, employee.department)

    for (const action of actions) {
      const res = await sendAndRecordNotification({
        supabaseAdmin,
        settings,
        enrolment,
        employee,
        employeeEmail: recipients.to,
        cc: recipients.cc,
        course,
        courseUrl,
        notificationType: action.type,
        idempotencyKey: action.idempotencyKey,
        daysInactive: action.daysInactive,
        daysRemaining: action.daysRemaining,
        daysOverdue: action.daysOverdue,
      })

      if (res.outcome === 'sent') {
        sent += 1
        existingKeys.add(action.idempotencyKey)
      } else if (res.outcome === 'failed') {
        failed += 1
        if (res.error) errors.push(`${employee.full_name} (${action.type}): ${res.error}`)
      } else {
        skipped += 1
      }
    }
  }

  return jsonResponse({
    ok: true,
    evaluated,
    sent,
    failed,
    skipped,
    errors: errors.slice(0, 10),
  })
}

async function handleCourseStarted(
  supabaseAdmin: SupabaseAdminClient,
  payload: { user_id?: string; course_id?: number; origin?: string },
) {
  if (!payload.user_id || !payload.course_id) {
    return jsonResponse({ error: 'user_id and course_id are required.' }, 400)
  }

  const [settingsRes, enrolmentRes, employeeRes, courseRes, modulesRes, managersRes] = await Promise.all([
    supabaseAdmin.from('notification_settings').select('*').eq('id', 1).maybeSingle<SettingsRow>(),
    supabaseAdmin
      .from('course_enrolments')
      .select('*')
      .eq('user_id', payload.user_id)
      .eq('course_id', payload.course_id)
      .maybeSingle<EnrolmentRecord>(),
    supabaseAdmin.from('profiles').select('*').eq('id', payload.user_id).maybeSingle<ProfileRow>(),
    supabaseAdmin.from('courses').select('id, title, category, is_published').eq('id', payload.course_id).maybeSingle<CourseRow>(),
    supabaseAdmin.from('modules').select('id, course_id, department, lesson_order, is_draft, is_archived').eq('course_id', payload.course_id),
    supabaseAdmin.from('profiles').select('id, email, department, role, is_active').eq('role', 'manager'),
  ])

  const settings = settingsRes.data
  const enrolment = enrolmentRes.data
  const employee = employeeRes.data
  const course = courseRes.data

  if (!enrolment || !employee || !course) {
    return jsonResponse({ ok: true, skipped: true, reason: 'Enrolment or course record not found.' })
  }
  if (settings && (!settings.enabled || !settings.send_course_start)) {
    return jsonResponse({ ok: true, skipped: true, reason: 'Course start emails are disabled.' })
  }
  if (isEnrolmentCompleted(enrolment) || enrolment.course_start_notified_at) {
    return jsonResponse({ ok: true, skipped: true, reason: 'Already completed or already notified.' })
  }

  const effectiveSettings: SettingsRow = settings ?? {
    id: 1,
    enabled: true,
    inactivity_days: 7,
    reminder_days: [7, 3, 1],
    send_course_start: true,
    send_inactivity: true,
    send_deadline_reminders: true,
    send_overdue: true,
    sender_name: 'Captain LMS Notifications',
    sender_email: 'lms@captainandcompany.com',
    default_hr_email: null,
    email_provider: 'resend',
    lms_base_url: payload.origin ?? '',
  }

  let linkedManagerEmail: string | null = null
  if (employee.manager_id) {
    const { data: mgr } = await supabaseAdmin
      .from('profiles')
      .select('email')
      .eq('id', employee.manager_id)
      .maybeSingle<{ email: string | null }>()
    linkedManagerEmail = mgr?.email ?? null
  }

  const deptManager = ((managersRes.data ?? []) as ProfileRow[]).find(
    (m) => m.department === employee.department && m.is_active !== false && !!m.email,
  )

  const empEmail = await resolveEmployeeEmail(supabaseAdmin, employee)
  const recipients = resolveNotificationRecipients({
    employeeEmail: empEmail,
    enrolmentHrEmail: enrolment.hr_email,
    profileHrEmail: employee.hr_email,
    defaultHrEmail: effectiveSettings.default_hr_email,
    enrolmentManagerEmail: enrolment.manager_email,
    profileManagerEmail: employee.manager_email,
    linkedManagerProfileEmail: linkedManagerEmail,
    departmentManagerEmail: deptManager?.email ?? null,
  })

  const modules = (modulesRes.data ?? []) as ModuleRow[]
  const courseUrl = buildCourseUrl(effectiveSettings.lms_base_url || payload.origin || '', modules, course.id, employee.department)

  const res = await sendAndRecordNotification({
    supabaseAdmin,
    settings: effectiveSettings,
    enrolment,
    employee,
    employeeEmail: recipients.to,
    cc: recipients.cc,
    course,
    courseUrl,
    notificationType: 'course_start',
    idempotencyKey: `course_start:${employee.id}:${course.id}`,
  })

  return jsonResponse({ ok: res.outcome === 'sent' || res.outcome === 'duplicate', ...res })
}

async function handleRetryFailed(supabaseAdmin: SupabaseAdminClient, logId?: number) {
  if (!logId) return jsonResponse({ error: 'log_id is required.' }, 400)

  const [{ data: logRow }, { data: settings }] = await Promise.all([
    supabaseAdmin.from('email_notification_logs').select('*').eq('id', logId).maybeSingle<{
      id: number
      enrolment_id: number | null
      notification_type: string
      to_email: string
      cc_emails: string[]
      subject: string
      html_body: string | null
      status: string
    }>(),
    supabaseAdmin.from('notification_settings').select('*').eq('id', 1).maybeSingle<SettingsRow>(),
  ])

  if (!logRow) return jsonResponse({ error: 'Notification log not found.' }, 404)
  if (!settings) return jsonResponse({ error: 'Notification settings missing.' }, 400)

  const result = await dispatchEmail(settings.email_provider, {
    to: logRow.to_email,
    cc: logRow.cc_emails ?? [],
    subject: logRow.subject,
    html: logRow.html_body ?? '<p>Course notification retry</p>',
    text: logRow.subject,
    fromName: settings.sender_name,
    fromEmail: settings.sender_email,
  })

  const nowIso = new Date().toISOString()
  if (result.ok) {
    await supabaseAdmin
      .from('email_notification_logs')
      .update({
        status: 'sent',
        provider: result.provider,
        provider_message_id: result.messageId ?? null,
        sent_at: nowIso,
        error_message: null,
      })
      .eq('id', logRow.id)

    if (logRow.enrolment_id) {
      if (logRow.notification_type === 'course_start') {
        await supabaseAdmin
          .from('course_enrolments')
          .update({ course_start_notified_at: nowIso, updated_at: nowIso })
          .eq('id', logRow.enrolment_id)
      } else if (logRow.notification_type === 'inactivity_7d') {
        await supabaseAdmin
          .from('course_enrolments')
          .update({ last_inactivity_notified_at: nowIso, updated_at: nowIso })
          .eq('id', logRow.enrolment_id)
      }
    }
    return jsonResponse({ ok: true, status: 'sent', messageId: result.messageId })
  }

  await supabaseAdmin
    .from('email_notification_logs')
    .update({ status: 'failed', provider: result.provider, error_message: result.error ?? 'Retry failed' })
    .eq('id', logRow.id)

  return jsonResponse({ ok: false, error: result.error }, 502)
}

async function handleSendTest(
  supabaseAdmin: SupabaseAdminClient,
  callerUserId: string | null,
  payload: { to_email?: string; cc_emails?: string[]; origin?: string },
) {
  const toEmail = payload.to_email?.trim().toLowerCase()
  if (!toEmail || !toEmail.includes('@')) {
    return jsonResponse({ error: 'Valid to_email is required.' }, 400)
  }

  const { data: settings } = await supabaseAdmin
    .from('notification_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle<SettingsRow>()

  const effective: SettingsRow = settings ?? {
    id: 1,
    enabled: true,
    inactivity_days: 7,
    reminder_days: [7, 3, 1],
    send_course_start: true,
    send_inactivity: true,
    send_deadline_reminders: true,
    send_overdue: true,
    sender_name: 'Captain LMS Notifications',
    sender_email: 'lms@captainandcompany.com',
    default_hr_email: null,
    email_provider: 'resend',
    lms_base_url: payload.origin ?? '',
  }

  const baseUrl = (effective.lms_base_url || payload.origin || 'https://lms.captainandcompany.com').replace(/\/+$/, '')
  const cc = (payload.cc_emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@') && e !== toEmail)
  const rendered = renderCourseNotificationEmail({
    notificationType: 'manual_test',
    employeeName: 'Alex Mercer',
    department: 'Operations',
    courseName: 'Workplace Safety & Compliance',
    progressPct: 45,
    lastActivityIso: new Date().toISOString(),
    deadlineDate: toUtcDateString(new Date(Date.now() + 7 * 86_400_000)),
    courseUrl: `${baseUrl}/app/catalog`,
    organizationName: Deno.env.get('ORGANIZATION_NAME') || 'Captain LMS',
  })

  const result = await dispatchEmail(effective.email_provider, {
    to: toEmail,
    cc,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    fromName: effective.sender_name,
    fromEmail: effective.sender_email,
  })

  if (callerUserId) {
    await supabaseAdmin.from('email_notification_logs').insert({
      user_id: callerUserId,
      notification_type: 'manual_test',
      idempotency_key: `manual_test:${crypto.randomUUID()}`,
      to_email: toEmail,
      cc_emails: cc,
      subject: rendered.subject,
      html_body: rendered.html,
      provider: result.provider,
      provider_message_id: result.messageId ?? null,
      status: result.ok ? 'sent' : 'failed',
      error_message: result.ok ? null : (result.error ?? 'Unknown error'),
      sent_at: result.ok ? new Date().toISOString() : null,
    })
  }

  return jsonResponse({ ok: result.ok, provider: result.provider, messageId: result.messageId, error: result.error }, result.ok ? 200 : 502)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const adminCtx = await createAdminClient()
  if (!adminCtx) {
    return jsonResponse({ error: 'Server secrets SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are missing.' }, 500)
  }

  const { client: supabaseAdmin, serviceRoleKey } = adminCtx
  const caller = await authenticateCaller(req, supabaseAdmin, serviceRoleKey)
  if (!caller.authorized) {
    return jsonResponse({ error: 'Unauthorized request.' }, 401)
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    body = { action: 'run_monitor' }
  }

  const action = (body.action as string) || 'run_monitor'

  if (action === 'course_started') {
    const targetUserId = body.user_id as string | undefined
    const targetCourseId = Number(body.course_id)
    if (!caller.isSystem && caller.role !== 'admin' && caller.userId !== targetUserId) {
      return jsonResponse({ error: 'Forbidden: cannot trigger notification for another user.' }, 403)
    }
    return await handleCourseStarted(supabaseAdmin, {
      user_id: targetUserId,
      course_id: Number.isFinite(targetCourseId) ? targetCourseId : undefined,
      origin: typeof body.origin === 'string' ? body.origin : undefined,
    })
  }

  // All remaining actions require cron/system secret or admin role
  if (!caller.isSystem && caller.role !== 'admin') {
    return jsonResponse({ error: 'Admin or cron authorization required.' }, 403)
  }

  if (action === 'retry_failed') {
    return await handleRetryFailed(supabaseAdmin, Number(body.log_id))
  }

  if (action === 'send_test') {
    return await handleSendTest(supabaseAdmin, caller.userId, {
      to_email: typeof body.to_email === 'string' ? body.to_email : undefined,
      cc_emails: Array.isArray(body.cc_emails) ? (body.cc_emails as string[]) : undefined,
      origin: typeof body.origin === 'string' ? body.origin : undefined,
    })
  }

  return await handleRunMonitor(supabaseAdmin, {
    department: typeof body.department === 'string' ? body.department : undefined,
    user_id: typeof body.user_id === 'string' ? body.user_id : undefined,
    origin: typeof body.origin === 'string' ? body.origin : undefined,
  })
})
