import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import express, { type Request, type Response, type NextFunction } from 'express'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import JSZip from 'jszip'
import { GoogleGenAI, Type, type Part } from '@google/genai'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Preserve runtime-injected secrets before loading .env files
const runtimeGeminiKey = (process.env.GEMINI_API_KEY || '').trim()
const runtimeApiKey = (process.env.API_KEY || '').trim()

// Load .env.local then .env without clobbering runtime-injected platform secrets
for (const envFile of ['.env.local', '.env']) {
  const fullPath = path.join(__dirname, envFile)
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath })
  }
}

interface KeySourceStatus {
  source: string
  present: boolean
  length: number
  looksLikePlaceholder: boolean
  hasWhitespace: boolean
  looksLikeGoogleApiKey: boolean
}

interface GeminiKeyCandidate {
  source: string
  key: string
}

function summarizeKey(source: string, rawVal?: string): KeySourceStatus {
  const raw = rawVal ?? ''
  const trimmed = raw.trim()
  const present = trimmed.length > 0
  const looksLikePlaceholder = present && /placeholder|your[_-]?api[_-]?key|changeme|example/i.test(trimmed)
  return {
    source,
    present,
    length: trimmed.length,
    looksLikePlaceholder,
    hasWhitespace: raw !== trimmed || /\s/.test(trimmed),
    looksLikeGoogleApiKey: /^AIza[0-9A-Za-z_-]{20,}$/.test(trimmed),
  }
}

function inspectGeminiKeySources(): KeySourceStatus[] {
  const statuses: KeySourceStatus[] = [
    summarizeKey('runtime:process.env.GEMINI_API_KEY', runtimeGeminiKey),
    summarizeKey('runtime:process.env.API_KEY', runtimeApiKey),
  ]

  for (const envFile of ['.env.local', '.env']) {
    const fullPath = path.join(__dirname, envFile)
    if (fs.existsSync(fullPath)) {
      const parsed = dotenv.parse(fs.readFileSync(fullPath, 'utf8'))
      statuses.push(summarizeKey(`${envFile}:GEMINI_API_KEY`, parsed.GEMINI_API_KEY))
      statuses.push(summarizeKey(`${envFile}:API_KEY`, parsed.API_KEY))
    } else {
      statuses.push(summarizeKey(`${envFile}:GEMINI_API_KEY`, undefined))
      statuses.push(summarizeKey(`${envFile}:API_KEY`, undefined))
    }
  }

  statuses.push(summarizeKey('effective:process.env.GEMINI_API_KEY', process.env.GEMINI_API_KEY))
  statuses.push(summarizeKey('effective:process.env.API_KEY', process.env.API_KEY))
  return statuses
}

function collectGeminiKeyCandidates(): GeminiKeyCandidate[] {
  const candidates: GeminiKeyCandidate[] = []
  const seen = new Set<string>()
  const push = (source: string, val?: string) => {
    const trimmed = (val ?? '').trim()
    if (!trimmed || /placeholder|your[_-]?api[_-]?key|changeme|example/i.test(trimmed) || seen.has(trimmed)) {
      return
    }
    seen.add(trimmed)
    candidates.push({ source, key: trimmed })
  }

  push('runtime:process.env.GEMINI_API_KEY', runtimeGeminiKey)
  push('runtime:process.env.API_KEY', runtimeApiKey)
  for (const envFile of ['.env.local', '.env']) {
    const fullPath = path.join(__dirname, envFile)
    if (fs.existsSync(fullPath)) {
      const parsed = dotenv.parse(fs.readFileSync(fullPath, 'utf8'))
      push(`${envFile}:GEMINI_API_KEY`, parsed.GEMINI_API_KEY)
      push(`${envFile}:API_KEY`, parsed.API_KEY)
    }
  }
  push('effective:process.env.GEMINI_API_KEY', process.env.GEMINI_API_KEY)
  push('effective:process.env.API_KEY', process.env.API_KEY)

  // Prefer properly formatted Google API keys (AIza...) first while preserving priority within each tier
  const isGoogleKey = (k: string) => /^AIza[0-9A-Za-z_-]{20,}$/.test(k)
  return [
    ...candidates.filter((c) => isGoogleKey(c.key)),
    ...candidates.filter((c) => !isGoogleKey(c.key)),
  ]
}

const SYSTEM_PROMPT = `You are an expert instructional designer who writes high-quality multiple-choice quiz questions for an online learning platform.

Rules you must always follow:
1. Use ONLY information found in the provided material. Never add outside facts.
2. Each question has exactly 4 options (A, B, C, D) and exactly ONE correct answer.
3. Wrong options must be plausible but clearly incorrect according to the material.
4. Do not use "All of the above" or "None of the above".
5. Spread correct answers evenly across A, B, C and D. Do not favor one letter.
6. Cover the whole material, not just the beginning.
7. Mix difficulty: 5 easy, 6 medium, 4 hard.
8. Write questions in clear, simple English.
9. Respond with ONLY valid JSON matching the schema.`

const USER_PROMPT = `Write 15 multiple-choice questions from the material provided. Return a JSON array where each item is {"question": string, "options": [4 strings], "correct_index": 0-3, "difficulty": "easy" | "medium" | "hard"}.`

const MAX_INLINE_BYTES = 18 * 1024 * 1024
const MAX_TEXT_CHARS = 120_000
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

interface GeneratedQuestion {
  question: string
  options: string[]
  correct_index: number
  difficulty: 'easy' | 'medium' | 'hard'
}

class UserFacingError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status = 422) {
    super(message)
    this.code = code
    this.status = status
  }
}

function decodeXmlText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    if (m[1]) out.push(m[1])
  }
  return out
    .join(' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

async function extractOfficeText(bytes: ArrayBuffer, type: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  if (type === 'docx') {
    const xml = await zip.file('word/document.xml')?.async('string')
    if (!xml) return ''
    return xml
      .split('</w:p>')
      .map((p) => decodeXmlText(p, 'w:t'))
      .filter(Boolean)
      .join('\n')
  }
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  const slides: string[] = []
  for (const name of slideNames) {
    const xml = await zip.file(name)!.async('string')
    const text = xml
      .split('</a:p>')
      .map((p) => decodeXmlText(p, 'a:t'))
      .filter(Boolean)
      .join('\n')
    if (text) slides.push(`Slide ${slides.length + 1}:\n${text}`)
  }
  return slides.join('\n\n')
}

function extractYoutubeId(raw: string): string | null {
  const v = raw.trim()
  if (/^[\w-]{11}$/.test(v)) return v
  const m = v.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/)
  return m?.[1] ?? null
}

async function buildMaterialParts(
  mod: {
    youtube_id: string | null
    document_url: string | null
    document_type: string | null
    video_url?: string | null
    video_type?: string | null
  },
  transcript: string,
): Promise<Part[]> {
  if (transcript.trim()) {
    return [{ text: `MATERIAL (video transcript):\n${transcript.trim().slice(0, MAX_TEXT_CHARS)}` }]
  }

  const parts: Part[] = []

  if (mod.youtube_id) {
    const id = extractYoutubeId(mod.youtube_id)
    if (!id) {
      throw new UserFacingError(
        "This module's YouTube ID doesn't look valid. Re-save the module with the 11-character ID or the full video link.",
        'bad_youtube_id',
      )
    }
    parts.push({ fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` } })
  }

  if (mod.document_url && mod.document_type) {
    const res = await fetch(mod.document_url)
    if (!res.ok) throw new UserFacingError('Could not download the uploaded document.', 'fetch_failed', 502)
    const bytes = await res.arrayBuffer()
    const type = mod.document_type

    if (type === 'pdf') {
      if (bytes.byteLength > MAX_INLINE_BYTES) {
        throw new UserFacingError('This PDF is over 18 MB — too large to read. Compress it or split it.', 'too_large')
      }
      parts.push({ inlineData: { mimeType: 'application/pdf', data: Buffer.from(bytes).toString('base64') } })
    } else if (type === 'docx' || type === 'pptx') {
      const text = (await extractOfficeText(bytes, type)).trim()
      if (text.length < 200) {
        throw new UserFacingError(
          'Not enough readable text found in this file (images and charts are not read).',
          'no_text',
        )
      }
      parts.push({ text: `MATERIAL (${type.toUpperCase()} text):\n${text.slice(0, MAX_TEXT_CHARS)}` })
    } else if (!parts.length) {
      throw new UserFacingError(
        `Old ${type.toUpperCase()} files can't be read automatically. Re-save it as ${type === 'doc' ? 'DOCX' : 'PPTX'} or PDF and upload again.`,
        'unsupported_type',
      )
    }
  }

  if (!parts.length && mod.video_url) {
    throw new UserFacingError(
      'Uploaded videos do not include an automatic transcript. Paste the video transcript below and click Generate questions.',
      'need_transcript',
    )
  }

  if (!parts.length) {
    throw new UserFacingError('This module has no video or document yet.', 'no_material')
  }

  return parts
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  return JSON.parse(cleaned)
}

function validateQuestions(raw: unknown): GeneratedQuestion[] {
  if (!Array.isArray(raw)) throw new Error('Reply was not a list')
  const out: GeneratedQuestion[] = []
  for (const item of raw) {
    const q = item as Partial<GeneratedQuestion>
    if (typeof q.question !== 'string' || !q.question.trim()) throw new Error('A question was empty')
    if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some((o) => typeof o !== 'string' || !o.trim())) {
      throw new Error('A question did not have exactly 4 options')
    }
    if (!Number.isInteger(q.correct_index) || q.correct_index! < 0 || q.correct_index! > 3) {
      throw new Error('A question had no valid correct answer')
    }
    const lowered = q.options.map((o) => o.trim().toLowerCase())
    if (lowered.some((o) => o.startsWith('all of the above') || o.startsWith('none of the above'))) {
      throw new Error('Used an "all/none of the above" option')
    }
    out.push({
      question: q.question.trim(),
      options: q.options.map((o) => o.trim()),
      correct_index: q.correct_index!,
      difficulty: q.difficulty === 'easy' || q.difficulty === 'hard' ? q.difficulty : 'medium',
    })
  }
  if (out.length < 10) throw new Error(`Only ${out.length} questions came back`)
  return out
}

function balanceAnswers(questions: GeneratedQuestion[]): GeneratedQuestion[] {
  const slots = questions.map((_, i) => i % 4)
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[slots[i], slots[j]] = [slots[j]!, slots[i]!]
  }
  return questions.map((q, i) => {
    const target = slots[i]!
    const options = [...q.options]
    ;[options[q.correct_index], options[target]] = [options[target]!, options[q.correct_index]!]
    return { ...q, options, correct_index: target }
  })
}

async function handleGenerateQuestions(req: Request, res: Response) {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()
  const geminiCandidates = collectGeminiKeyCandidates()

  if (!supabaseUrl || (!serviceRoleKey && !anonKey)) {
    res.status(500).json({ error: 'Supabase configuration is missing on the server.', code: 'not_configured' })
    return
  }

  if (!geminiCandidates.length) {
    res.status(500).json({
      error: 'Gemini API key is not configured. Please add or select a valid API key in Settings > Secrets.',
      code: 'not_configured',
    })
    return
  }

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    res.status(401).json({ error: 'Missing auth token' })
    return
  }

  const supabaseClient = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey)
    : createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      })

  const { data: userData, error: userError } = await supabaseClient.auth.getUser(token)
  if (userError || !userData.user) {
    res.status(401).json({ error: 'Invalid session' })
    return
  }

  const { data: caller } = await supabaseClient
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (caller?.role !== 'admin') {
    res.status(403).json({ error: 'Admins only' })
    return
  }

  const body = (req.body ?? {}) as { moduleId?: number; transcript?: string }
  const moduleId = Number(body.moduleId)
  const transcript = typeof body.transcript === 'string' ? body.transcript : ''

  if (!Number.isFinite(moduleId) || moduleId <= 0) {
    res.status(400).json({ error: 'moduleId is required' })
    return
  }

  // Select core columns first so environments without video_url/video_type columns still succeed
  const { data: mod, error: modErr } = await supabaseClient
    .from('modules')
    .select('youtube_id, document_url, document_type')
    .eq('id', moduleId)
    .maybeSingle()

  if (modErr) {
    res.status(500).json({ error: modErr.message, code: 'db_error' })
    return
  }
  if (!mod) {
    res.status(404).json({ error: 'Module not found' })
    return
  }

  // Check if an uploaded video exists in storage for this module when no YouTube/document/transcript is present
  let uploadedVideoUrl: string | null = null
  if (!mod.youtube_id && !mod.document_url && !transcript.trim()) {
    try {
      const { data: videoFiles } = await supabaseClient.storage
        .from('module-materials')
        .list(`${moduleId}/videos`, { limit: 5 })
      if (videoFiles?.length) {
        uploadedVideoUrl = `${moduleId}/videos/${videoFiles[0]!.name}`
      }
    } catch {
      // Non-fatal
    }
  }

  const model = resolveGeminiModel(process.env.GEMINI_MODEL)

  try {
    const parts = await buildMaterialParts(
      {
        youtube_id: mod.youtube_id,
        document_url: mod.document_url,
        document_type: mod.document_type,
        video_url: uploadedVideoUrl,
      },
      transcript,
    )

    let lastErr: unknown = null
    for (const candidate of geminiCandidates) {
      const ai = new GoogleGenAI({
        apiKey: candidate.key,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      })
      try {
        const response = await ai.models.generateContent({
          model,
          contents: { parts: [...parts, { text: USER_PROMPT }] },
          config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  question: { type: Type.STRING },
                  options: { type: Type.ARRAY, items: { type: Type.STRING } },
                  correct_index: { type: Type.INTEGER },
                  difficulty: { type: Type.STRING, enum: ['easy', 'medium', 'hard'] },
                },
                required: ['question', 'options', 'correct_index', 'difficulty'],
              },
            },
          },
        })

        const rawText = (response.text ?? '').trim()
        if (!rawText) {
          throw new UserFacingError('Gemini returned nothing for this material.', 'empty', 422)
        }

        const questions = balanceAnswers(validateQuestions(parseJson(rawText)))
        console.info(`[generate-questions] succeeded using source=${candidate.source} model=${model}`)
        res.json({ questions, model })
        return
      } catch (innerErr) {
        lastErr = innerErr
        const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr)
        console.warn(`[generate-questions] candidate source=${candidate.source} failed: ${innerMsg.slice(0, 180)}`)
        // If this candidate key is invalid/rejected, try the next available key before failing
        if (/403|PERMISSION_DENIED|API_KEY_INVALID|api key/i.test(innerMsg)) {
          continue
        }
        throw innerErr
      }
    }

    throw lastErr ?? new Error('No working Gemini API key available')
  } catch (err) {
    if (err instanceof UserFacingError) {
      res.status(err.status).json({ error: err.message, code: err.code })
      return
    }
    const msg = err instanceof Error ? err.message : String(err)

    if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
      res.status(429).json({
        error: 'Gemini quota or rate limit reached. Wait a moment and try again.',
        code: 'rate_limit',
      })
      return
    }
    if (/403|PERMISSION_DENIED|API_KEY_INVALID|api key/i.test(msg)) {
      res.status(400).json({
        error: 'The Gemini API key is invalid or unauthorized. Please check or select a valid API key in Settings > Secrets.',
        code: 'bad_key',
      })
      return
    }
    if (mod.youtube_id && !transcript.trim() && /400|403|404|transcript|caption|unavailable|video/i.test(msg)) {
      res.status(422).json({
        error:
          "Couldn't read this YouTube video automatically (it may be private or have no captions). Paste its transcript below and try again.",
        code: 'need_transcript',
      })
      return
    }

    console.error('Question generation failed:', msg)
    res.status(502).json({
      error: `Could not generate questions from this material (${msg.slice(0, 220)}).`,
      code: 'upstream',
    })
  }
}

interface LiveVerifyResult {
  checkedAt: string
  cached: boolean
  ok: boolean
  activeSource: string | null
  model: string
  attempts: Array<{
    source: string
    ok: boolean
    errorCode?: string
    message: string
  }>
}

let cachedLiveVerify: { expiresAt: number; result: Omit<LiveVerifyResult, 'cached'> } | null = null

function buildEnvDiagnostics(isProd: boolean, port: number) {
  const distIndexPath = path.join(__dirname, 'dist', 'index.html')
  const sources = inspectGeminiKeySources()
  const candidates = collectGeminiKeyCandidates()
  const rawModel = (process.env.GEMINI_MODEL || '').trim()
  const resolvedModel = resolveGeminiModel(process.env.GEMINI_MODEL)

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()

  const geminiConfigured = candidates.length > 0
  const supabaseConfigured = Boolean(supabaseUrl && (serviceRoleKey || anonKey))
  const safeRawModel = sanitizeModelForLog(rawModel)

  return {
    status: geminiConfigured && supabaseConfigured ? 'ok' : 'misconfigured',
    timestamp: new Date().toISOString(),
    runtime: {
      backend: 'express-node',
      nodeVersion: process.version,
      nodeEnv: process.env.NODE_ENV ?? null,
      mode: isProd ? 'production' : 'development',
      port,
      distPresent: fs.existsSync(distIndexPath),
      envFilesPresent: {
        dotEnv: fs.existsSync(path.join(__dirname, '.env')),
        dotEnvLocal: fs.existsSync(path.join(__dirname, '.env.local')),
      },
    },
    gemini: {
      configured: geminiConfigured,
      candidateCount: candidates.length,
      primarySource: candidates[0]?.source ?? null,
      rawModel: safeRawModel,
      resolvedModel,
      modelWasNormalized: Boolean(rawModel) && rawModel !== resolvedModel,
      sources,
    },
    supabase: {
      configured: supabaseConfigured,
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
      inviteProvider: (process.env.RESEND_API_KEY || '').trim() && ((process.env.LMS_FROM_EMAIL || '').trim() || (process.env.DIGEST_FROM || '').trim())
        ? 'resend'
        : 'unconfigured',
      resendApiKeyPresent: Boolean((process.env.RESEND_API_KEY || '').trim()),
      digestFromPresent: Boolean((process.env.DIGEST_FROM || '').trim()),
      lmsFromEmailPresent: Boolean((process.env.LMS_FROM_EMAIL || '').trim()),
      inviteFromPresent: Boolean((process.env.LMS_FROM_EMAIL || '').trim() || (process.env.DIGEST_FROM || '').trim()),
      lmsPublicUrl: (process.env.LMS_PUBLIC_URL || '').trim() || null,
      cronSecretPresent: Boolean((process.env.CRON_SECRET || '').trim()),
    },
  }
}

async function probeGeminiCandidates(model: string): Promise<LiveVerifyResult> {
  const now = Date.now()
  if (cachedLiveVerify && cachedLiveVerify.expiresAt > now) {
    return { ...cachedLiveVerify.result, cached: true }
  }

  const candidates = collectGeminiKeyCandidates()
  const attempts: LiveVerifyResult['attempts'] = []
  let activeSource: string | null = null

  for (const candidate of candidates) {
    const ai = new GoogleGenAI({
      apiKey: candidate.key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })

    try {
      const response = await ai.models.generateContent({
        model,
        contents: 'Reply with OK',
      })
      const replyText = (response.text ?? '').trim()
      attempts.push({
        source: candidate.source,
        ok: true,
        message: replyText ? `Responded (${replyText.slice(0, 32)})` : 'Responded cleanly',
      })
      activeSource = candidate.source
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      let errorCode = 'upstream_error'
      if (/API_KEY_INVALID|PERMISSION_DENIED|403|api key/i.test(msg)) errorCode = 'bad_key'
      else if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) errorCode = 'rate_limit'
      else if (/404|NOT_FOUND/i.test(msg)) errorCode = 'bad_model'
      attempts.push({
        source: candidate.source,
        ok: false,
        errorCode,
        message: msg.slice(0, 180),
      })
    }
  }

  const result: Omit<LiveVerifyResult, 'cached'> = {
    checkedAt: new Date().toISOString(),
    ok: activeSource !== null,
    activeSource,
    model,
    attempts,
  }

  cachedLiveVerify = {
    expiresAt: now + 30_000,
    result,
  }

  return { ...result, cached: false }
}

function logEnvironmentDiagnostics(
  trigger: string,
  diagnostics: ReturnType<typeof buildEnvDiagnostics>,
  liveVerify?: LiveVerifyResult,
) {
  console.info(
    '[diagnostics:env]',
    JSON.stringify({
      trigger,
      status: diagnostics.status,
      runtime: diagnostics.runtime,
      gemini: {
        configured: diagnostics.gemini.configured,
        candidateCount: diagnostics.gemini.candidateCount,
        primarySource: diagnostics.gemini.primarySource,
        rawModel: diagnostics.gemini.rawModel,
        resolvedModel: diagnostics.gemini.resolvedModel,
        modelWasNormalized: diagnostics.gemini.modelWasNormalized,
        presentSources: diagnostics.gemini.sources.filter((s) => s.present).map((s) => ({
          source: s.source,
          length: s.length,
          looksLikePlaceholder: s.looksLikePlaceholder,
          looksLikeGoogleApiKey: s.looksLikeGoogleApiKey,
        })),
      },
      supabase: diagnostics.supabase,
      monitoringAndEmail: diagnostics.monitoringAndEmail,
      ...(liveVerify ? { liveVerify } : {}),
    }),
  )
}

async function verifyAdminCaller(req: Request, res: Response) {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!supabaseUrl || !serviceRoleKey) {
    res.status(500).json({ error: 'Server is not configured for admin employee operations yet (missing SUPABASE_SERVICE_ROLE_KEY).' })
    return null
  }

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    res.status(401).json({ error: 'Missing auth token' })
    return null
  }

  const admin = createClient(supabaseUrl, serviceRoleKey)
  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData.user) {
    res.status(401).json({ error: 'Invalid session' })
    return null
  }

  const { data: caller } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (caller?.role !== 'admin') {
    res.status(403).json({ error: 'Admins only' })
    return null
  }

  return { admin, callerId: userData.user.id }
}

const VALID_ROLES = new Set(['employee', 'hr', 'manager', 'admin'])
const BAN_FOREVER = '876000h'
const RESEND_INTER_SEND_DELAY_MS = 550

function sleep(ms: number) {
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

function resolvePublicRedirectUrl(req: Request): string | undefined {
  const configured = (process.env.LMS_PUBLIC_URL || '').trim()
  if (configured && /^https?:\/\//i.test(configured)) {
    return `${configured.replace(/\/+$/, '')}/app`
  }

  const origin = (req.headers.origin || '').trim()
  if (origin && /^https?:\/\//i.test(origin)) {
    return `${origin.replace(/\/+$/, '')}/app`
  }

  const protoHeader = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
  const hostHeader = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() || req.get('host')
  if (hostHeader) {
    const proto = protoHeader || req.protocol || 'https'
    return `${proto}://${hostHeader}/app`
  }

  return undefined
}

function getResendInviteConfig(): { apiKey: string; from: string; organizationName: string } | { error: string } {
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
        const jsonErr = JSON.parse(rawBody) as { message?: string; name?: string }
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

async function createAndSendInviteViaResend(params: {
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

    // If user was created in an earlier attempt (e.g. hit Supabase 2-email cap) and never confirmed/signed in,
    // generate a fresh magic link via Resend instead of failing silently.
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

async function handleAdminInviteEmployees(req: Request, res: Response) {
  const ctx = await verifyAdminCaller(req, res)
  if (!ctx) return
  const { admin } = ctx

  const resendConfig = getResendInviteConfig()
  if ('error' in resendConfig) {
    console.error(`[invite:bulk] config error: ${resendConfig.error}`)
    res.status(500).json({ error: resendConfig.error })
    return
  }

  const body = (req.body ?? {}) as {
    rows?: Array<{ full_name?: string; email?: string; department?: string; role?: string }>
  }
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (!rows.length) {
    res.status(400).json({ error: 'No rows to invite' })
    return
  }
  if (rows.length > 100) {
    res.status(400).json({ error: 'Max 100 rows per import' })
    return
  }

  const redirectTo = resolvePublicRedirectUrl(req)
  const results: Array<{ email: string; success: boolean; provider?: string; messageId?: string; error?: string }> = []

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

    // Space Resend requests to stay comfortably below Resend's 2 req/sec rate limit
    if (idx < rows.length - 1) {
      await sleep(RESEND_INTER_SEND_DELAY_MS)
    }
  }

  res.json({ results, provider: 'resend' })
}

async function handleAdminManageEmployee(req: Request, res: Response) {
  const ctx = await verifyAdminCaller(req, res)
  if (!ctx) return
  const { admin: db, callerId } = ctx

  const body = (req.body ?? {}) as {
    action?: 'create' | 'update' | 'deactivate' | 'reactivate' | 'delete' | 'get'
    id?: string
    email?: string
    full_name?: string
    department?: string
    role?: string
  }

  const { action, id } = body

  if (action === 'create') {
    const resendConfig = getResendInviteConfig()
    if ('error' in resendConfig) {
      console.error(`[invite:single] config error: ${resendConfig.error}`)
      res.status(500).json({ error: resendConfig.error })
      return
    }

    const email = body.email?.trim().toLowerCase()
    const fullName = body.full_name?.trim()
    const role = body.role ?? 'employee'
    const department = body.department?.trim() || 'General'
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: 'Enter a valid email address.' })
      return
    }
    if (!fullName) {
      res.status(400).json({ error: 'Enter the employee’s name.' })
      return
    }
    if (!VALID_ROLES.has(role)) {
      res.status(400).json({ error: 'Invalid role.' })
      return
    }

    const redirectTo = resolvePublicRedirectUrl(req)
    const outcome = await createAndSendInviteViaResend({
      admin: db,
      resendConfig,
      email,
      fullName,
      department,
      role,
      redirectTo,
    })

    if (!outcome.ok) {
      res.status(400).json({ error: outcome.error })
      return
    }

    res.json({ ok: true, id: outcome.userId, provider: 'resend', messageId: outcome.messageId })
    return
  }

  if (!id) {
    res.status(400).json({ error: 'id is required' })
    return
  }

  const { data: target } = await db.from('profiles').select('id, role, full_name').eq('id', id).maybeSingle()
  if (!target) {
    res.status(404).json({ error: 'Employee not found' })
    return
  }

  const otherActiveAdmins = async (excludeId: string): Promise<number> => {
    const { count } = await db
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('is_active', true)
      .neq('id', excludeId)
    return count ?? 0
  }

  if (action === 'get') {
    const { data } = await db.auth.admin.getUserById(id)
    res.json({
      email: data.user?.email ?? null,
      last_sign_in_at: data.user?.last_sign_in_at ?? null,
      confirmed: !!data.user?.email_confirmed_at,
    })
    return
  }

  if (action === 'update') {
    const patch: Record<string, string> = {}
    if (body.full_name !== undefined) {
      if (!body.full_name.trim()) {
        res.status(400).json({ error: 'Name can’t be empty.' })
        return
      }
      patch.full_name = body.full_name.trim()
    }
    if (body.role !== undefined) {
      if (!VALID_ROLES.has(body.role)) {
        res.status(400).json({ error: 'Invalid role.' })
        return
      }
      if (target.role === 'admin' && body.role !== 'admin' && (await otherActiveAdmins(id)) === 0) {
        res.status(400).json({ error: 'This is the only active admin — make someone else an admin first.' })
        return
      }
      patch.role = body.role
    }
    if (!Object.keys(patch).length) {
      res.status(400).json({ error: 'Nothing to update.' })
      return
    }
    const { error } = await db.from('profiles').update(patch).eq('id', id)
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }
    res.json({ ok: true })
    return
  }

  if (action === 'deactivate' || action === 'delete') {
    if (id === callerId) {
      res.status(400).json({ error: `You can't ${action} your own account.` })
      return
    }
    if (target.role === 'admin' && (await otherActiveAdmins(id)) === 0) {
      res.status(400).json({ error: 'This is the only active admin — make someone else an admin first.' })
      return
    }
  }

  if (action === 'deactivate') {
    const { error: profileError } = await db.from('profiles').update({ is_active: false }).eq('id', id)
    if (profileError) {
      res.status(500).json({ error: profileError.message })
      return
    }
    const { error } = await db.auth.admin.updateUserById(id, { ban_duration: BAN_FOREVER })
    if (error) {
      res.status(500).json({ error: error.message })
      return
    }
    res.json({ ok: true })
    return
  }

  if (action === 'reactivate') {
    const { error: profileError } = await db.from('profiles').update({ is_active: true }).eq('id', id)
    if (profileError) {
      res.status(500).json({ error: profileError.message })
      return
    }
    const { error } = await db.auth.admin.updateUserById(id, { ban_duration: 'none' })
    if (error) {
      res.status(500).json({ error: error.message })
      return
    }
    res.json({ ok: true })
    return
  }

  if (action === 'delete') {
    const { error } = await db.auth.admin.deleteUser(id)
    if (error) {
      res.status(500).json({ error: error.message })
      return
    }
    res.json({ ok: true })
    return
  }

  res.status(400).json({ error: 'Unknown action' })
}

interface LeaderboardInputProfile {
  id: string
  full_name: string
  department: string
  role: string
  is_active?: boolean
  last_activity_at?: string | null
}

interface LeaderboardInputModule {
  id: number
  course_id?: number | null
  department: string
  duration_seconds: number
  is_draft?: boolean
  is_archived?: boolean
}

interface LeaderboardInputCourse {
  id: number
  title: string
  category: string
  is_published: boolean
}

interface LeaderboardInputEnrolment {
  user_id: string
  course_id: number
}

interface LeaderboardInputCompletion {
  user_id: string
  module_id: number
  completed: boolean
  completed_at?: string | null
  last_watched_at?: string | null
  watched_seconds?: number | null
}

interface LeaderboardInputAttempt {
  user_id: string
  milestone: string
  passed: boolean
  created_at: string
}

interface LeaderboardInputActivityLog {
  user_id: string
  event_type?: string
  created_at: string
}

interface LeaderboardInputCriterion {
  id: number
  slug: string
  name: string
  icon: string
  tier_order: number
  match_mode: string
  min_course_duration_minutes: number
  min_courses_completed: number
  min_certificates_earned: number
  is_active: boolean
}

interface LeaderboardInputCustomBadge {
  id: number
  name: string
  icon: string
  is_active: boolean
}

interface LeaderboardInputBadgeAward {
  badge_id: number
  user_id: string
  awarded_at: string
}

interface LeaderboardInputIssuedCertificate {
  id: number
  user_id: string
  issued_date: string
  created_at?: string
}

interface ServerEarnedBadgePreview {
  icon: string
  name: string
  source: 'criteria' | 'quiz' | 'custom'
}

interface ServerLeaderboardEntry {
  id: string
  fullName: string
  department: string
  criteriaBadgesCount: number
  milestoneQuizBadgesCount: number
  customBadgesCount: number
  totalBadges: number
  badgePreviews: ServerEarnedBadgePreview[]
  coursesCompleted: number
  coursesTotal: number
  courseCompletionPct: number
  lessonsCompleted: number
  lessonsTotal: number
  lessonCompletionPct: number
  completedCourseMinutes: number
  certificatesEarned: number
  activityCountAll: number
  activityCount30d: number
  activityCount7d: number
  activeDays14d: number
  lastActiveAt: string | null
  overallScore: number
}

const DEFAULT_LEADERBOARD_CRITERIA: LeaderboardInputCriterion[] = [
  {
    id: 1,
    slug: 'first-milestone',
    name: 'Pathfinder',
    icon: '🌱',
    tier_order: 1,
    match_mode: 'all',
    min_course_duration_minutes: 15,
    min_courses_completed: 1,
    min_certificates_earned: 1,
    is_active: true,
  },
  {
    id: 2,
    slug: 'bronze-scholar',
    name: 'Bronze Scholar',
    icon: '🥉',
    tier_order: 2,
    match_mode: 'all',
    min_course_duration_minutes: 60,
    min_courses_completed: 2,
    min_certificates_earned: 2,
    is_active: true,
  },
  {
    id: 3,
    slug: 'silver-achiever',
    name: 'Silver Achiever',
    icon: '🥈',
    tier_order: 3,
    match_mode: 'all',
    min_course_duration_minutes: 180,
    min_courses_completed: 3,
    min_certificates_earned: 4,
    is_active: true,
  },
  {
    id: 4,
    slug: 'gold-specialist',
    name: 'Gold Specialist',
    icon: '🥇',
    tier_order: 4,
    match_mode: 'all',
    min_course_duration_minutes: 300,
    min_courses_completed: 5,
    min_certificates_earned: 6,
    is_active: true,
  },
  {
    id: 5,
    slug: 'captain-distinction',
    name: 'Captain Distinction',
    icon: '🏆',
    tier_order: 5,
    match_mode: 'all',
    min_course_duration_minutes: 600,
    min_courses_completed: 8,
    min_certificates_earned: 10,
    is_active: true,
  },
]

const MILESTONE_QUIZ_META: Record<string, { icon: string; name: string }> = {
  '1': { icon: '🥉', name: 'Bronze Milestone' },
  '2': { icon: '🥈', name: 'Silver Milestone' },
  '3': { icon: '🥇', name: 'Gold Milestone' },
  '4': { icon: '💎', name: 'Diamond Milestone' },
  '5': { icon: '💎', name: 'Diamond II Milestone' },
  final: { icon: '🏆', name: 'Captain Master' },
}

function lbParseTimeMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function lbComputeOrganizationLeaderboard(input: {
  profiles: LeaderboardInputProfile[]
  modules: LeaderboardInputModule[]
  courses: LeaderboardInputCourse[]
  enrolments: LeaderboardInputEnrolment[]
  completions: LeaderboardInputCompletion[]
  attempts: LeaderboardInputAttempt[]
  activityLogs: LeaderboardInputActivityLog[]
  badgeCriteria: LeaderboardInputCriterion[]
  customBadges: LeaderboardInputCustomBadge[]
  badgeAwards: LeaderboardInputBadgeAward[]
  issuedCertificates: LeaderboardInputIssuedCertificate[]
  departments: string[]
}) {
  const nowMs = Date.now()
  const cutoff7d = nowMs - 7 * 86_400_000
  const cutoff14d = nowMs - 14 * 86_400_000
  const cutoff30d = nowMs - 30 * 86_400_000

  const activeEmployees = input.profiles.filter(
    (p) => p.role === 'employee' && p.is_active !== false,
  )

  const publishedModules = input.modules.filter((m) => !m.is_draft && !m.is_archived)
  const publishedCourses = input.courses.filter((c) => c.is_published)

  const lessonsByCourseId = new Map<number, LeaderboardInputModule[]>()
  const unassignedModules: LeaderboardInputModule[] = []
  for (const mod of publishedModules) {
    if (typeof mod.course_id === 'number' && mod.course_id > 0) {
      const arr = lessonsByCourseId.get(mod.course_id)
      if (arr) arr.push(mod)
      else lessonsByCourseId.set(mod.course_id, [mod])
    } else {
      unassignedModules.push(mod)
    }
  }

  const useVirtualCourses = publishedCourses.length === 0 && publishedModules.length > 0
  const virtualGroups = new Map<string, LeaderboardInputModule[]>()
  if (useVirtualCourses) {
    for (const m of publishedModules) {
      const dept = m.department || 'General'
      const arr = virtualGroups.get(dept)
      if (arr) arr.push(m)
      else virtualGroups.set(dept, [m])
    }
  }

  const enrolledCourseIdsByUser = new Map<string, Set<number>>()
  for (const enr of input.enrolments) {
    const set = enrolledCourseIdsByUser.get(enr.user_id)
    if (set) set.add(enr.course_id)
    else enrolledCourseIdsByUser.set(enr.user_id, new Set([enr.course_id]))
  }

  const completionsByUser = new Map<string, LeaderboardInputCompletion[]>()
  for (const comp of input.completions) {
    const arr = completionsByUser.get(comp.user_id)
    if (arr) arr.push(comp)
    else completionsByUser.set(comp.user_id, [comp])
  }

  const attemptsByUser = new Map<string, LeaderboardInputAttempt[]>()
  for (const att of input.attempts) {
    const arr = attemptsByUser.get(att.user_id)
    if (arr) arr.push(att)
    else attemptsByUser.set(att.user_id, [att])
  }

  const logsByUser = new Map<string, LeaderboardInputActivityLog[]>()
  for (const log of input.activityLogs) {
    const arr = logsByUser.get(log.user_id)
    if (arr) arr.push(log)
    else logsByUser.set(log.user_id, [log])
  }

  const activeCriteria = [...input.badgeCriteria]
    .filter(
      (c) =>
        c.is_active !== false &&
        (c.min_course_duration_minutes > 0 ||
          c.min_courses_completed > 0 ||
          c.min_certificates_earned > 0),
    )
    .sort((a, b) => a.tier_order - b.tier_order || a.id - b.id)

  const customBadgeMap = new Map<number, LeaderboardInputCustomBadge>()
  for (const cb of input.customBadges) {
    if (cb.is_active !== false) customBadgeMap.set(cb.id, cb)
  }

  const awardsByUser = new Map<string, LeaderboardInputBadgeAward[]>()
  for (const aw of input.badgeAwards) {
    if (!customBadgeMap.has(aw.badge_id)) continue
    const arr = awardsByUser.get(aw.user_id)
    if (arr) arr.push(aw)
    else awardsByUser.set(aw.user_id, [aw])
  }

  const issuedCertsByUser = new Map<string, LeaderboardInputIssuedCertificate[]>()
  for (const ic of input.issuedCertificates) {
    const arr = issuedCertsByUser.get(ic.user_id)
    if (arr) arr.push(ic)
    else issuedCertsByUser.set(ic.user_id, [ic])
  }

  const deptSet = new Set<string>(input.departments)

  const entries: ServerLeaderboardEntry[] = activeEmployees.map((emp) => {
    const dept = emp.department || 'General'
    deptSet.add(dept)

    const userCompletions = completionsByUser.get(emp.id) ?? []
    const doneModuleIds = new Set<number>()
    for (const c of userCompletions) {
      if (c.completed) doneModuleIds.add(c.module_id)
    }

    const enrolledSet = enrolledCourseIdsByUser.get(emp.id) ?? new Set<number>()

    let coursesTotal = 0
    let coursesCompleted = 0
    let completedCourseMinutes = 0
    const visibleModuleIds = new Set<number>()

    if (useVirtualCourses) {
      for (const [vDept, vMods] of virtualGroups.entries()) {
        if (vDept !== 'General' && vDept !== dept) continue
        if (vMods.length === 0) continue
        coursesTotal += 1
        for (const m of vMods) visibleModuleIds.add(m.id)
        if (vMods.every((m) => doneModuleIds.has(m.id))) {
          coursesCompleted += 1
          const totalSec = vMods.reduce((sum, m) => sum + (m.duration_seconds > 0 ? m.duration_seconds : 300), 0)
          completedCourseMinutes += Math.round(totalSec / 60)
        }
      }
    } else {
      for (const course of publishedCourses) {
        const courseLessons = lessonsByCourseId.get(course.id) ?? []
        if (courseLessons.length === 0) continue
        const isExplicitlyEnrolled = enrolledSet.has(course.id)
        const relevantLessons = isExplicitlyEnrolled
          ? courseLessons
          : courseLessons.filter((l) => l.department === 'General' || l.department === dept)

        if (relevantLessons.length === 0) continue

        coursesTotal += 1
        for (const l of relevantLessons) visibleModuleIds.add(l.id)

        if (relevantLessons.every((l) => doneModuleIds.has(l.id))) {
          coursesCompleted += 1
          const totalSec = relevantLessons.reduce(
            (sum, l) => sum + (l.duration_seconds > 0 ? l.duration_seconds : 300),
            0,
          )
          completedCourseMinutes += Math.round(totalSec / 60)
        }
      }
      for (const um of unassignedModules) {
        if (um.department === 'General' || um.department === dept) {
          visibleModuleIds.add(um.id)
        }
      }
    }

    const lessonsTotal = visibleModuleIds.size
    let lessonsCompleted = 0
    for (const mid of visibleModuleIds) {
      if (doneModuleIds.has(mid)) lessonsCompleted += 1
    }

    const courseCompletionPct = coursesTotal > 0 ? Math.round((coursesCompleted / coursesTotal) * 100) : 0
    const lessonCompletionPct = lessonsTotal > 0 ? Math.round((lessonsCompleted / lessonsTotal) * 100) : 0

    const userAttempts = attemptsByUser.get(emp.id) ?? []
    const passedMilestones = new Set<string>()
    for (const att of userAttempts) {
      if (att.passed) passedMilestones.add(att.milestone)
    }

    const userIssuedCerts = issuedCertsByUser.get(emp.id) ?? []
    const certificatesEarned = coursesCompleted + passedMilestones.size + userIssuedCerts.length

    const badgePreviews: ServerEarnedBadgePreview[] = []
    let criteriaBadgesCount = 0

    for (const rule of activeCriteria) {
      const checks: boolean[] = []
      if (rule.min_course_duration_minutes > 0) {
        checks.push(completedCourseMinutes >= rule.min_course_duration_minutes)
      }
      if (rule.min_courses_completed > 0) {
        checks.push(coursesCompleted >= rule.min_courses_completed)
      }
      if (rule.min_certificates_earned > 0) {
        checks.push(certificatesEarned >= rule.min_certificates_earned)
      }
      const metCount = checks.filter(Boolean).length
      const unlocked =
        checks.length > 0 && (rule.match_mode === 'any' ? metCount > 0 : metCount === checks.length)
      if (unlocked) {
        criteriaBadgesCount += 1
        badgePreviews.push({ icon: rule.icon || '🏅', name: rule.name, source: 'criteria' })
      }
    }

    const orderedQuizKeys = ['1', '2', '3', '4', '5', 'final']
    let milestoneQuizBadgesCount = 0
    for (const key of orderedQuizKeys) {
      if (passedMilestones.has(key)) {
        milestoneQuizBadgesCount += 1
        const meta = MILESTONE_QUIZ_META[key] ?? { icon: '🎖️', name: `Milestone ${key}` }
        badgePreviews.push({ icon: meta.icon, name: meta.name, source: 'quiz' })
      }
    }
    for (const m of passedMilestones) {
      if (!orderedQuizKeys.includes(m)) {
        milestoneQuizBadgesCount += 1
        badgePreviews.push({ icon: '🎖️', name: `Milestone ${m}`, source: 'quiz' })
      }
    }

    const userAwards = awardsByUser.get(emp.id) ?? []
    const seenCustomIds = new Set<number>()
    let customBadgesCount = 0
    for (const aw of userAwards) {
      if (seenCustomIds.has(aw.badge_id)) continue
      const badge = customBadgeMap.get(aw.badge_id)
      if (!badge) continue
      seenCustomIds.add(aw.badge_id)
      customBadgesCount += 1
      badgePreviews.push({ icon: badge.icon || '🌟', name: badge.name, source: 'custom' })
    }

    const totalBadges = criteriaBadgesCount + milestoneQuizBadgesCount + customBadgesCount

    const activityTimestamps: number[] = []
    let latestMs: number | null = lbParseTimeMs(emp.last_activity_at)

    const recordTs = (iso: string | null | undefined, countEvent = true) => {
      const ms = lbParseTimeMs(iso)
      if (ms === null) return
      if (latestMs === null || ms > latestMs) latestMs = ms
      if (countEvent) activityTimestamps.push(ms)
    }

    for (const comp of userCompletions) {
      if (comp.completed) {
        recordTs(comp.completed_at ?? comp.last_watched_at, true)
      } else if ((comp.watched_seconds ?? 0) > 0 && comp.last_watched_at) {
        recordTs(comp.last_watched_at, true)
      }
    }
    for (const att of userAttempts) {
      recordTs(att.created_at, true)
    }
    for (const aw of userAwards) {
      recordTs(aw.awarded_at, true)
    }
    for (const ic of userIssuedCerts) {
      recordTs(ic.created_at ?? `${ic.issued_date}T12:00:00Z`, true)
    }

    const userLogs = logsByUser.get(emp.id) ?? []
    for (const log of userLogs) {
      if (log.event_type === 'quiz_attempt') {
        recordTs(log.created_at, false)
      } else {
        recordTs(log.created_at, true)
      }
    }

    let activityCount7d = 0
    let activityCount30d = 0
    const activeDaySet14d = new Set<string>()
    for (const ts of activityTimestamps) {
      if (ts >= cutoff7d) activityCount7d += 1
      if (ts >= cutoff30d) activityCount30d += 1
      if (ts >= cutoff14d) activeDaySet14d.add(new Date(ts).toISOString().slice(0, 10))
    }

    const overallScore = Math.round(
      totalBadges * 120 +
        coursesCompleted * 100 +
        Math.min(100, Math.max(0, courseCompletionPct)) +
        Math.min(activityCount30d, 40) * 10 +
        Math.min(activeDaySet14d.size, 14) * 15,
    )

    return {
      id: emp.id,
      fullName: emp.full_name,
      department: dept,
      criteriaBadgesCount,
      milestoneQuizBadgesCount,
      customBadgesCount,
      totalBadges,
      badgePreviews: badgePreviews.slice(0, 8),
      coursesCompleted,
      coursesTotal,
      courseCompletionPct,
      lessonsCompleted,
      lessonsTotal,
      lessonCompletionPct,
      completedCourseMinutes,
      certificatesEarned,
      activityCountAll: activityTimestamps.length,
      activityCount30d,
      activityCount7d,
      activeDays14d: activeDaySet14d.size,
      lastActiveAt: latestMs !== null ? new Date(latestMs).toISOString() : null,
      overallScore,
    }
  })

  entries.sort(
    (a, b) =>
      b.overallScore - a.overallScore ||
      b.totalBadges - a.totalBadges ||
      b.coursesCompleted - a.coursesCompleted ||
      b.activityCount30d - a.activityCount30d ||
      a.fullName.localeCompare(b.fullName),
  )

  const totalEmployees = entries.length
  const totalBadgesAwarded = entries.reduce((s, e) => s + e.totalBadges, 0)
  const avgCourseCompletionPct = totalEmployees
    ? Math.round(entries.reduce((s, e) => s + e.courseCompletionPct, 0) / totalEmployees)
    : 0
  const activeLast7DaysCount = entries.filter((e) => {
    const ms = lbParseTimeMs(e.lastActiveAt)
    return (ms !== null && ms >= cutoff7d) || e.activityCount7d > 0
  }).length
  const activeLast7DaysPct = totalEmployees ? Math.round((activeLast7DaysCount / totalEmployees) * 100) : 0
  const totalCoursesCompleted = entries.reduce((s, e) => s + e.coursesCompleted, 0)
  const departments = ['All', ...[...deptSet].filter((d) => d && d !== 'All').sort((a, b) => a.localeCompare(b))]

  return {
    entries,
    departments,
    summary: {
      totalEmployees,
      totalBadgesAwarded,
      avgCourseCompletionPct,
      activeLast7DaysCount,
      activeLast7DaysPct,
      totalCoursesCompleted,
    },
    generatedAt: new Date(nowMs).toISOString(),
    source: 'server' as const,
  }
}

async function handleOrganizationLeaderboard(req: Request, res: Response) {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()

  if (!supabaseUrl || !serviceRoleKey) {
    res.status(503).json({
      error: 'Organization leaderboard API requires SUPABASE_SERVICE_ROLE_KEY.',
      code: 'not_configured',
    })
    return
  }

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    res.status(401).json({ error: 'Missing auth token' })
    return
  }

  const admin = createClient(supabaseUrl, serviceRoleKey)
  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData.user) {
    res.status(401).json({ error: 'Invalid session' })
    return
  }

  try {
    const cutoff30dIso = new Date(Date.now() - 30 * 86_400_000).toISOString()

    const [
      profilesRes,
      modulesRes,
      coursesRes,
      enrolmentsRes,
      completionsRes,
      attemptsRes,
      activityLogsRes,
      criteriaRes,
      customBadgesRes,
      awardsRes,
      issuedCertsRes,
      deptsRes,
    ] = await Promise.all([
      admin.from('profiles').select('id, full_name, department, role, is_active, last_activity_at'),
      admin.from('modules').select('id, course_id, department, duration_seconds, is_draft, is_archived'),
      admin.from('courses').select('id, title, category, is_published'),
      admin.from('course_enrolments').select('user_id, course_id'),
      admin.from('video_completions').select('user_id, module_id, completed, completed_at, last_watched_at, watched_seconds'),
      admin.from('quiz_attempts').select('user_id, milestone, passed, created_at'),
      admin.from('learning_activity_logs').select('user_id, event_type, created_at').gte('created_at', cutoff30dIso),
      admin.from('badge_criteria').select('id, slug, name, icon, tier_order, match_mode, min_course_duration_minutes, min_courses_completed, min_certificates_earned, is_active'),
      admin.from('custom_badges').select('id, name, icon, is_active'),
      admin.from('employee_badge_awards').select('badge_id, user_id, awarded_at'),
      admin.from('issued_certificates').select('id, user_id, issued_date, created_at'),
      admin.from('departments').select('name').order('name'),
    ])

    if (profilesRes.error) {
      res.status(500).json({ error: profilesRes.error.message })
      return
    }

    const badgeCriteria = !criteriaRes.error && criteriaRes.data
      ? (criteriaRes.data as LeaderboardInputCriterion[])
      : DEFAULT_LEADERBOARD_CRITERIA

    const payload = lbComputeOrganizationLeaderboard({
      profiles: (profilesRes.data ?? []) as LeaderboardInputProfile[],
      modules: (modulesRes.data ?? []) as LeaderboardInputModule[],
      courses: (!coursesRes.error && coursesRes.data ? coursesRes.data : []) as LeaderboardInputCourse[],
      enrolments: (!enrolmentsRes.error && enrolmentsRes.data ? enrolmentsRes.data : []) as LeaderboardInputEnrolment[],
      completions: (!completionsRes.error && completionsRes.data ? completionsRes.data : []) as LeaderboardInputCompletion[],
      attempts: (!attemptsRes.error && attemptsRes.data ? attemptsRes.data : []) as LeaderboardInputAttempt[],
      activityLogs: (!activityLogsRes.error && activityLogsRes.data ? activityLogsRes.data : []) as LeaderboardInputActivityLog[],
      badgeCriteria,
      customBadges: (!customBadgesRes.error && customBadgesRes.data ? customBadgesRes.data : []) as LeaderboardInputCustomBadge[],
      badgeAwards: (!awardsRes.error && awardsRes.data ? awardsRes.data : []) as LeaderboardInputBadgeAward[],
      issuedCertificates: (!issuedCertsRes.error && issuedCertsRes.data ? issuedCertsRes.data : []) as LeaderboardInputIssuedCertificate[],
      departments: (!deptsRes.error && deptsRes.data ? (deptsRes.data as { name: string }[]).map((d) => d.name) : []),
    })

    res.json(payload)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[organization-leaderboard] failed:', msg)
    res.status(500).json({ error: msg })
  }
}

async function startServer() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))

  const distIndexPath = path.join(__dirname, 'dist', 'index.html')
  const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development'
  const isProd = !isDev && (process.env.NODE_ENV === 'production' || process.argv.includes('--prod') || fs.existsSync(distIndexPath))
  const port = Number(process.env.PORT) || 3000

  app.get('/api/diagnostics/env', async (req: Request, res: Response) => {
    const diagnostics = buildEnvDiagnostics(isProd, port)
    const shouldVerify = req.query.verify === 'true' || req.query.verify === '1' || req.query.probe === 'gemini'
    const liveVerify = shouldVerify ? await probeGeminiCandidates(diagnostics.gemini.resolvedModel) : undefined
    logEnvironmentDiagnostics('http:GET /api/diagnostics/env', diagnostics, liveVerify)
    res.json({
      ...diagnostics,
      ...(liveVerify ? { liveVerify } : {}),
    })
  })

  app.get('/api/organization-leaderboard', (req: Request, res: Response) => {
    void handleOrganizationLeaderboard(req, res)
  })

  app.post('/api/generate-questions', (req: Request, res: Response) => {
    void handleGenerateQuestions(req, res)
  })
  app.post('/.netlify/functions/generate-questions', (req: Request, res: Response) => {
    void handleGenerateQuestions(req, res)
  })

  app.post('/api/admin-invite-employees', (req: Request, res: Response) => {
    void handleAdminInviteEmployees(req, res)
  })
  app.post('/.netlify/functions/admin-invite-employees', (req: Request, res: Response) => {
    void handleAdminInviteEmployees(req, res)
  })

  app.post('/api/admin-manage-employee', (req: Request, res: Response) => {
    void handleAdminManageEmployee(req, res)
  })
  app.post('/.netlify/functions/admin-manage-employee', (req: Request, res: Response) => {
    void handleAdminManageEmployee(req, res)
  })

  if (isProd) {
    const distDir = path.join(__dirname, 'dist')
    app.use(express.static(distDir))
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        next()
        return
      }
      res.sendFile(path.join(distDir, 'index.html'))
    })
  } else {
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    })
    app.use(vite.middlewares)
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Captain LMS server listening on http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`)
    logEnvironmentDiagnostics('server:startup', buildEnvDiagnostics(isProd, port))
  })
}

void startServer()
