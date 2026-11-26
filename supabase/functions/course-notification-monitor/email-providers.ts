export type EmailProviderType = 'resend' | 'smtp' | 'm365' | 'google_workspace'

export interface SendEmailRequest {
  to: string
  cc: string[]
  subject: string
  html: string
  text: string
  fromName: string
  fromEmail: string
}

export interface SendEmailResult {
  ok: boolean
  provider: EmailProviderType
  messageId?: string
  error?: string
}

declare const Deno: {
  env: {
    get(key: string): string | undefined
  }
}

function getEnv(key: string): string {
  return (Deno.env.get(key) ?? '').trim()
}

function formatFromHeader(name: string, email: string): string {
  const safeName = name.replace(/["<>]/g, '').trim()
  return safeName ? `${safeName} <${email}>` : email
}

/**
 * 1. Resend API (RESEND_API_KEY, optional LMS_FROM_EMAIL / DIGEST_FROM)
 */
async function sendViaResend(req: SendEmailRequest): Promise<SendEmailResult> {
  const apiKey = getEnv('RESEND_API_KEY')
  if (!apiKey) {
    return { ok: false, provider: 'resend', error: 'Server secret RESEND_API_KEY is not configured.' }
  }

  const from = getEnv('LMS_FROM_EMAIL') || getEnv('DIGEST_FROM') || formatFromHeader(req.fromName, req.fromEmail)

  const payload: Record<string, unknown> = {
    from,
    to: [req.to],
    subject: req.subject,
    html: req.html,
    text: req.text,
  }
  if (req.cc.length > 0) {
    payload.cc = req.cc
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const rawBody = await res.text()
  if (!res.ok) {
    return {
      ok: false,
      provider: 'resend',
      error: `Resend HTTP ${res.status}: ${rawBody}`,
    }
  }

  try {
    const parsed = JSON.parse(rawBody) as { id?: string }
    return { ok: true, provider: 'resend', messageId: parsed.id }
  } catch {
    return { ok: true, provider: 'resend' }
  }
}

/**
 * 2. Authorized Corporate SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE)
 * Works with corporate relays, Microsoft 365 SMTP AUTH, or Google Workspace SMTP Relay.
 */
async function sendViaSmtp(req: SendEmailRequest): Promise<SendEmailResult> {
  const host = getEnv('SMTP_HOST')
  const portRaw = getEnv('SMTP_PORT') || '587'
  const user = getEnv('SMTP_USER')
  const pass = getEnv('SMTP_PASS')
  const secure = getEnv('SMTP_SECURE').toLowerCase() === 'true' || portRaw === '465'

  if (!host || !user || !pass) {
    return {
      ok: false,
      provider: 'smtp',
      error: 'Server secrets SMTP_HOST, SMTP_USER, and SMTP_PASS are required for SMTP delivery.',
    }
  }

  const fromEmail = getEnv('LMS_FROM_EMAIL') || req.fromEmail || user
  const from = formatFromHeader(req.fromName, fromEmail)

  // Dynamic npm import supported natively by Supabase Edge Runtime (Deno)
  const nodemailerMod = (await import('npm:nodemailer@6.9.15')) as {
    default: {
      createTransport: (opts: Record<string, unknown>) => {
        sendMail: (mail: Record<string, unknown>) => Promise<{ messageId?: string }>
      }
    }
  }

  const transporter = nodemailerMod.default.createTransport({
    host,
    port: Number(portRaw),
    secure,
    auth: { user, pass },
  })

  const info = await transporter.sendMail({
    from,
    to: req.to,
    cc: req.cc.length > 0 ? req.cc.join(', ') : undefined,
    subject: req.subject,
    html: req.html,
    text: req.text,
  })

  return { ok: true, provider: 'smtp', messageId: info?.messageId }
}

/**
 * 3. Microsoft 365 via Microsoft Graph API (M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, M365_SENDER_USER)
 * Requires Mail.Send application permission on the authorized HR/LMS mailbox.
 */
async function sendViaMicrosoft365(req: SendEmailRequest): Promise<SendEmailResult> {
  const tenantId = getEnv('M365_TENANT_ID')
  const clientId = getEnv('M365_CLIENT_ID')
  const clientSecret = getEnv('M365_CLIENT_SECRET')
  const senderUser = getEnv('M365_SENDER_USER') || getEnv('LMS_FROM_EMAIL') || req.fromEmail

  if (!tenantId || !clientId || !clientSecret || !senderUser) {
    return {
      ok: false,
      provider: 'm365',
      error: 'Server secrets M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, and M365_SENDER_USER are required.',
    }
  }

  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })

  const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  })

  const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string }
  if (!tokenRes.ok || !tokenJson.access_token) {
    return {
      ok: false,
      provider: 'm365',
      error: `M365 OAuth error: ${tokenJson.error_description ?? tokenRes.status}`,
    }
  }

  const mailPayload = {
    message: {
      subject: req.subject,
      body: {
        contentType: 'HTML',
        content: req.html,
      },
      toRecipients: [{ emailAddress: { address: req.to } }],
      ccRecipients: req.cc.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: true,
  }

  const sendRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderUser)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mailPayload),
    },
  )

  if (!sendRes.ok) {
    const errText = await sendRes.text()
    return {
      ok: false,
      provider: 'm365',
      error: `Microsoft Graph sendMail HTTP ${sendRes.status}: ${errText}`,
    }
  }

  const requestId = sendRes.headers.get('request-id') ?? undefined
  return { ok: true, provider: 'm365', messageId: requestId }
}

/**
 * 4. Google Workspace via Gmail API (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)
 */
async function sendViaGoogleWorkspace(req: SendEmailRequest): Promise<SendEmailResult> {
  const clientId = getEnv('GOOGLE_CLIENT_ID')
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET')
  const refreshToken = getEnv('GOOGLE_REFRESH_TOKEN')

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      ok: false,
      provider: 'google_workspace',
      error: 'Server secrets GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN are required.',
    }
  }

  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  })

  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string }
  if (!tokenRes.ok || !tokenJson.access_token) {
    return {
      ok: false,
      provider: 'google_workspace',
      error: `Google OAuth error: ${tokenJson.error ?? tokenRes.status}`,
    }
  }

  const fromEmail = getEnv('LMS_FROM_EMAIL') || req.fromEmail
  const headers = [
    `From: ${formatFromHeader(req.fromName, fromEmail)}`,
    `To: ${req.to}`,
    ...(req.cc.length > 0 ? [`Cc: ${req.cc.join(', ')}`] : []),
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(req.subject)))}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
  ]

  const rawMime = `${headers.join('\r\n')}\r\n\r\n${req.html}`
  const encoded = btoa(unescape(encodeURIComponent(rawMime)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  })

  const sendText = await sendRes.text()
  if (!sendRes.ok) {
    return {
      ok: false,
      provider: 'google_workspace',
      error: `Gmail API HTTP ${sendRes.status}: ${sendText}`,
    }
  }

  try {
    const parsed = JSON.parse(sendText) as { id?: string }
    return { ok: true, provider: 'google_workspace', messageId: parsed.id }
  } catch {
    return { ok: true, provider: 'google_workspace' }
  }
}

export async function dispatchEmail(
  preferredProvider: EmailProviderType,
  req: SendEmailRequest,
): Promise<SendEmailResult> {
  const envOverride = getEnv('EMAIL_PROVIDER') as EmailProviderType | ''
  const provider = envOverride || preferredProvider || 'resend'

  try {
    switch (provider) {
      case 'smtp':
        return await sendViaSmtp(req)
      case 'm365':
        return await sendViaMicrosoft365(req)
      case 'google_workspace':
        return await sendViaGoogleWorkspace(req)
      case 'resend':
      default:
        return await sendViaResend(req)
    }
  } catch (err) {
    return {
      ok: false,
      provider,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
