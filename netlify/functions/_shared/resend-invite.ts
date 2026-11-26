import type { SupabaseClient } from '@supabase/supabase-js'

export const RESEND_INTER_SEND_DELAY_MS = 550

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function resolvePublicRedirectUrl(req: Request): string | undefined {
  const configured = (process.env.LMS_PUBLIC_URL || '').trim()
  if (configured && /^https?:\/\//i.test(configured)) {
    return `${configured.replace(/\/+$/, '')}/app`
  }

  const origin = (req.headers.get('origin') || '').trim()
  if (origin && /^https?:\/\//i.test(origin)) {
    return `${origin.replace(/\/+$/, '')}/app`
  }

  const proto = (req.headers.get('x-forwarded-proto') || '').split(',')[0]?.trim() || 'https'
  const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '').split(',')[0]?.trim()
  if (host) {
    return `${proto}://${host}/app`
  }

  return undefined
}

export function getResendInviteConfig(): { apiKey: string; from: string; organizationName: string } | { error: string } {
  const apiKey = (process.env.RESEND_API_KEY || '').trim()
  const from = (process.env.LMS_FROM_EMAIL || process.env.DIGEST_FROM || '').trim()
  const organizationName = (process.env.ORGANIZATION_NAME || 'Captain LMS').trim() || 'Captain LMS'

  if (!apiKey) {
    return { error: 'Resend is not configured on the server (missing RESEND_API_KEY).' }
  }
  if (!from) {
    return { error: 'Resend sender address is not configured on the server (missing LMS_FROM_EMAIL or DIGEST_FROM).' }
  }
  return { apiKey, from, organizationName }
}

async function sendInviteEmailViaResend(params: {
  apiKey: string
  from: string
  organizationName: string
  to: string
  fullName: string
  department: string
  role: string
  actionLink: string
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  const firstName = params.fullName.split(/\s+/)[0] || params.fullName
  const safeOrg = escapeHtml(params.organizationName)
  const safeName = escapeHtml(firstName)
  const safeDept = escapeHtml(params.department)
  const safeRole = escapeHtml(params.role.toUpperCase())
  const safeLink = escapeHtml(params.actionLink)

  const subject = `You're invited to ${params.organizationName}`
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #172033; line-height: 1.55;">
      <div style="background: #0f1b33; color: #ffffff; padding: 18px 22px; border-radius: 12px 12px 0 0;">
        <strong style="font-size: 16px; letter-spacing: 0.2px;">${safeOrg}</strong>
      </div>
      <div style="border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px; padding: 24px; background: #ffffff;">
        <h2 style="margin: 0 0 12px; font-size: 20px; color: #0f1b33;">Welcome, ${safeName}</h2>
        <p style="margin: 0 0 14px;">You have been invited to join <strong>${safeOrg}</strong>.</p>
        <p style="margin: 0 0 18px; font-size: 14px; color: #475569;">
          <strong>Department:</strong> ${safeDept}<br />
          <strong>Role:</strong> ${safeRole}
        </p>
        <p style="margin: 0 0 22px;">
          <a href="${safeLink}" style="display: inline-block; background: #2f5be8; color: #ffffff; text-decoration: none; font-weight: 600; padding: 12px 20px; border-radius: 8px;">
            Accept Invitation &amp; Open ${safeOrg}
          </a>
        </p>
        <p style="margin: 0 0 8px; font-size: 12.5px; color: #64748b;">
          If the button doesn't work, copy and paste this link into your browser:
        </p>
        <p style="margin: 0; font-size: 12px; word-break: break-all; color: #334155;">${safeLink}</p>
      </div>
    </div>
  `.trim()

  const text = [
    `Welcome to ${params.organizationName}, ${firstName}!`,
    '',
    `Department: ${params.department}`,
    `Role: ${params.role}`,
    '',
    `Accept your invitation and access the LMS here:`,
    params.actionLink,
  ].join('\n')

  const maxAttempts = 3
  let lastError = 'Resend request failed.'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: params.from,
          to: [params.to],
          subject,
          html,
          text,
        }),
      })

      const rawBody = await res.text()
      if (res.ok) {
        let messageId: string | undefined
        try {
          messageId = (JSON.parse(rawBody) as { id?: string }).id
        } catch {
          // Ignore non-JSON body on 2xx
        }
        console.info(`[invite:resend] delivered to=${params.to} attempt=${attempt} messageId=${messageId ?? 'n/a'}`)
        return { ok: true, messageId }
      }

      let parsedMessage = rawBody
      try {
        const jsonErr = JSON.parse(rawBody) as { message?: string }
        if (jsonErr.message) parsedMessage = jsonErr.message
      } catch {
        // Use raw text
      }

      lastError = `Resend HTTP ${res.status}: ${parsedMessage.slice(0, 220)}`
      const retryable = res.status === 429 || res.status >= 500
      console.warn(`[invite:resend] attempt=${attempt}/${maxAttempts} failed to=${params.to} status=${res.status}: ${parsedMessage.slice(0, 180)}`)

      if (retryable && attempt < maxAttempts) {
        const retryAfterSec = Number(res.headers.get('retry-after') || '0')
        const backoffMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 1000 * attempt
        await sleep(backoffMs)
        continue
      }

      return { ok: false, error: lastError }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = `Resend network error: ${msg}`
      console.warn(`[invite:resend] network error attempt=${attempt}/${maxAttempts} to=${params.to}: ${msg}`)
      if (attempt < maxAttempts) {
        await sleep(800 * attempt)
        continue
      }
      return { ok: false, error: lastError }
    }
  }

  return { ok: false, error: lastError }
}

export async function createAndSendInviteViaResend(params: {
  admin: SupabaseClient
  resendConfig: { apiKey: string; from: string; organizationName: string }
  email: string
  fullName: string
  department: string
  role: string
  redirectTo?: string
}): Promise<{ ok: true; userId: string; messageId?: string } | { ok: false; error: string }> {
  const { admin, resendConfig, email, fullName, department, role, redirectTo } = params

  let userId: string | null = null
  let actionLink: string | null = null
  let createdNewUser = false

  const linkOptions = {
    data: { full_name: fullName, department, role: 'employee' },
    ...(redirectTo ? { redirectTo } : {}),
  }

  const inviteLinkRes = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: linkOptions,
  })

  if (!inviteLinkRes.error && inviteLinkRes.data?.user && inviteLinkRes.data?.properties?.action_link) {
    userId = inviteLinkRes.data.user.id
    actionLink = inviteLinkRes.data.properties.action_link
    createdNewUser = true
  } else {
    const inviteErrMsg = inviteLinkRes.error?.message || 'Could not generate invite link.'
    const alreadyRegistered = /already.*registered|already exists|duplicate|email_exists/i.test(inviteErrMsg)

    if (!alreadyRegistered) {
      console.warn(`[invite:supabase] generateLink(invite) failed email=${email}: ${inviteErrMsg}`)
      return { ok: false, error: inviteErrMsg }
    }

    const magicLinkRes = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: redirectTo ? { redirectTo } : undefined,
    })

    if (magicLinkRes.error || !magicLinkRes.data?.user || !magicLinkRes.data?.properties?.action_link) {
      console.warn(`[invite:supabase] magiclink fallback failed email=${email}: ${magicLinkRes.error?.message ?? inviteErrMsg}`)
      return { ok: false, error: inviteErrMsg }
    }

    const existingUser = magicLinkRes.data.user
    if (existingUser.email_confirmed_at || existingUser.last_sign_in_at) {
      return { ok: false, error: 'A user with this email address is already registered and active.' }
    }

    userId = existingUser.id
    actionLink = magicLinkRes.data.properties.action_link
  }

  const sendResult = await sendInviteEmailViaResend({
    apiKey: resendConfig.apiKey,
    from: resendConfig.from,
    organizationName: resendConfig.organizationName,
    to: email,
    fullName,
    department,
    role,
    actionLink,
  })

  if (!sendResult.ok) {
    if (createdNewUser && userId) {
      try {
        await admin.auth.admin.deleteUser(userId)
      } catch (cleanupErr) {
        console.warn(`[invite:cleanup] failed to roll back uninvited user=${userId}:`, cleanupErr)
      }
    }
    return { ok: false, error: sendResult.error }
  }

  const { error: profileErr } = await admin
    .from('profiles')
    .update({ role, full_name: fullName, department })
    .eq('id', userId)

  if (profileErr) {
    console.warn(`[invite:profile] profile update failed user=${userId}: ${profileErr.message}`)
  }

  return { ok: true, userId, messageId: sendResult.messageId }
}
