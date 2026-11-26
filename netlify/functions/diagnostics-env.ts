// Netlify Function — sanitized backend environment & GEMINI_API_KEY diagnostic check.
// Logs loaded configuration status (never raw secret values) to Netlify Function logs
// and returns a JSON report. Pass ?verify=true to perform a live @google/genai check.

import { GoogleGenAI } from '@google/genai'

const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen'
const DEPRECATED_MODELS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.0-flash-thinking',
])

function resolveGeminiModel(raw: string | undefined): string {
  const candidate = (raw ?? '').trim().replace(/^models\//i, '')
  if (!candidate || /\s/.test(candidate) || !/^gemini-[a-z0-9][a-z0-9._-]*$/i.test(candidate)) {
    return DEFAULT_GEMINI_MODEL
  }
  if (DEPRECATED_MODELS.has(candidate.toLowerCase())) {
    return DEFAULT_GEMINI_MODEL
  }
  return candidate
}

function sanitizeModelForLog(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (/^(models\/)?gemini-[a-z0-9 ._-]*$/i.test(trimmed) || /^gemini\s+/i.test(trimmed)) {
    return trimmed
  }
  return `[redacted-invalid-model length=${trimmed.length}]`
}

function summarizeKey(source: string, rawVal?: string) {
  const raw = rawVal ?? ''
  const trimmed = raw.trim()
  const present = trimmed.length > 0
  return {
    source,
    present,
    length: trimmed.length,
    looksLikePlaceholder: present && /placeholder|your[_-]?api[_-]?key|changeme|example/i.test(trimmed),
    hasWhitespace: raw !== trimmed || /\s/.test(trimmed),
    looksLikeGoogleApiKey: /^AIza[0-9A-Za-z_-]{20,}$/.test(trimmed),
  }
}

export default async (req: Request) => {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    })
  }

  const url = new URL(req.url)
  const shouldVerify =
    url.searchParams.get('verify') === 'true' ||
    url.searchParams.get('verify') === '1' ||
    url.searchParams.get('probe') === 'gemini'

  const geminiKey = (process.env.GEMINI_API_KEY || '').trim()
  const fallbackApiKey = (process.env.API_KEY || '').trim()
  const activeKey = geminiKey || fallbackApiKey
  const activeSource = geminiKey ? 'process.env.GEMINI_API_KEY' : fallbackApiKey ? 'process.env.API_KEY' : null

  const rawModel = (process.env.GEMINI_MODEL || '').trim()
  const resolvedModel = resolveGeminiModel(process.env.GEMINI_MODEL)

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()

  let liveVerify:
    | {
        checkedAt: string
        ok: boolean
        activeSource: string | null
        model: string
        errorCode?: string
        message: string
      }
    | undefined

  if (shouldVerify) {
    if (!activeKey) {
      liveVerify = {
        checkedAt: new Date().toISOString(),
        ok: false,
        activeSource: null,
        model: resolvedModel,
        errorCode: 'not_configured',
        message: 'Neither GEMINI_API_KEY nor API_KEY is configured in Netlify environment variables.',
      }
    } else {
      try {
        const ai = new GoogleGenAI({
          apiKey: activeKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        })
        const response = await ai.models.generateContent({
          model: resolvedModel,
          contents: 'Reply with OK',
        })
        const replyText = (response.text ?? '').trim()
        liveVerify = {
          checkedAt: new Date().toISOString(),
          ok: true,
          activeSource,
          model: resolvedModel,
          message: replyText ? `Responded (${replyText.slice(0, 32)})` : 'Responded cleanly',
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        let errorCode = 'upstream_error'
        if (/API_KEY_INVALID|PERMISSION_DENIED|403|api key/i.test(msg)) errorCode = 'bad_key'
        else if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) errorCode = 'rate_limit'
        else if (/404|NOT_FOUND/i.test(msg)) errorCode = 'bad_model'
        liveVerify = {
          checkedAt: new Date().toISOString(),
          ok: false,
          activeSource,
          model: resolvedModel,
          errorCode,
          message: msg.slice(0, 180),
        }
      }
    }
  }

  const report = {
    status: activeKey && supabaseUrl && (serviceRoleKey || anonKey) ? 'ok' : 'misconfigured',
    timestamp: new Date().toISOString(),
    runtime: {
      backend: 'netlify-functions',
      nodeVersion: process.version,
      nodeEnv: process.env.NODE_ENV ?? null,
      context: process.env.CONTEXT ?? null,
    },
    gemini: {
      configured: Boolean(activeKey),
      primarySource: activeSource,
      rawModel: sanitizeModelForLog(rawModel),
      resolvedModel,
      modelWasNormalized: Boolean(rawModel) && rawModel !== resolvedModel,
      sources: [
        summarizeKey('process.env.GEMINI_API_KEY', process.env.GEMINI_API_KEY),
        summarizeKey('process.env.API_KEY', process.env.API_KEY),
      ],
    },
    supabase: {
      configured: Boolean(supabaseUrl && (serviceRoleKey || anonKey)),
      urlPresent: Boolean(supabaseUrl),
      urlSource: process.env.SUPABASE_URL?.trim()
        ? 'SUPABASE_URL'
        : process.env.VITE_SUPABASE_URL?.trim()
          ? 'VITE_SUPABASE_URL'
          : null,
      serviceRoleKeyPresent: Boolean(serviceRoleKey),
      anonKeyPresent: Boolean(anonKey),
      anonKeySource: process.env.SUPABASE_ANON_KEY?.trim()
        ? 'SUPABASE_ANON_KEY'
        : process.env.VITE_SUPABASE_ANON_KEY?.trim()
          ? 'VITE_SUPABASE_ANON_KEY'
          : null,
    },
    monitoringAndEmail: {
      emailProvider: (process.env.EMAIL_PROVIDER || '').trim() || null,
      resendApiKeyPresent: Boolean((process.env.RESEND_API_KEY || '').trim()),
      digestFromPresent: Boolean((process.env.DIGEST_FROM || '').trim()),
      lmsFromEmailPresent: Boolean((process.env.LMS_FROM_EMAIL || '').trim()),
      lmsPublicUrl: (process.env.LMS_PUBLIC_URL || '').trim() || null,
      cronSecretPresent: Boolean((process.env.CRON_SECRET || '').trim()),
    },
    ...(liveVerify ? { liveVerify } : {}),
  }

  console.info('[diagnostics:env]', JSON.stringify(report))

  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
