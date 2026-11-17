// Netlify Function — bulk-invites employees from the CSV import UI (src/views/admin/EmployeesView.vue).
// Runs server-side so it can use the Supabase service role key, which must never reach the browser.
//
// Requires these environment variables in the Netlify dashboard (Site settings → Environment variables):
//   SUPABASE_URL               (same value as VITE_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY  (Supabase → Settings → API → "service_role" secret key — NOT the
//                                publishable/anon key already used client-side)
//
// Auth model: the caller must be a signed-in admin. We verify the bearer token they send against
// Supabase Auth, then check their profiles.role — only then do we use the service-role client to
// invite anyone. This keeps the service-role key itself fully server-side while still gating the
// endpoint properly (no open invite-anyone-you-want endpoint).

import { createClient } from '@supabase/supabase-js'
import {
  createAndSendInviteViaResend,
  getResendInviteConfig,
  RESEND_INTER_SEND_DELAY_MS,
  resolvePublicRedirectUrl,
  sleep,
} from './_shared/resend-invite'

interface InviteRow {
  full_name?: string
  email?: string
  department?: string
  role?: string
}

const VALID_ROLES = new Set(['employee', 'hr', 'manager', 'admin'])

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: 'Server is not configured for invites yet.' }, 500)
  }

  const resendConfig = getResendInviteConfig()
  if ('error' in resendConfig) {
    return json({ error: resendConfig.error }, 500)
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Missing auth token' }, 401)

  const admin = createClient(supabaseUrl, serviceRoleKey)

  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData.user) {
    return json({ error: 'Invalid session' }, 401)
  }

  const { data: callerProfile } = await admin.from('profiles').select('role').eq('id', userData.user.id).single()
  if (callerProfile?.role !== 'admin') {
    return json({ error: 'Admins only' }, 403)
  }

  let rows: InviteRow[]
  try {
    const body = (await req.json()) as { rows?: InviteRow[] }
    rows = body.rows ?? []
  } catch {
    return json({ error: 'Invalid request body' }, 400)
  }
  if (!rows.length) return json({ error: 'No rows to invite' }, 400)
  if (rows.length > 100) return json({ error: 'Max 100 rows per import' }, 400)

  const redirectTo = resolvePublicRedirectUrl(req)
  const results: { email: string; success: boolean; provider?: string; messageId?: string; error?: string }[] = []

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx]!
    const email = (row.email ?? '').trim().toLowerCase()
    const fullName = (row.full_name ?? '').trim()
    const department = (row.department ?? '').trim() || 'General'
    const role = row.role && VALID_ROLES.has(row.role) ? row.role : 'employee'

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      results.push({ email: row.email ?? '(missing email)', success: false, error: 'Invalid email address.' })
      continue
    }
    if (!fullName) {
      results.push({ email, success: false, error: 'Full name is required.' })
      continue
    }

    const outcome = await createAndSendInviteViaResend({
      admin,
      resendConfig,
      email,
      fullName,
      department,
      role,
      redirectTo,
    })

    if (outcome.ok) {
      results.push({ email, success: true, provider: 'resend', messageId: outcome.messageId })
    } else {
      results.push({ email, success: false, provider: 'resend', error: outcome.error })
    }

    if (idx < rows.length - 1) {
      await sleep(RESEND_INTER_SEND_DELAY_MS)
    }
  }

  return json({ results, provider: 'resend' }, 200)
}
