import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import express, { type Request, type Response, type NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import JSZip from 'jszip'
import { GoogleGenAI, Type, type Part } from '@google/genai'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Preserve runtime-injected secrets before loading .env files
const runtimeGeminiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim()

// Load .env.local then .env without clobbering runtime-injected platform secrets
for (const envFile of ['.env.local', '.env']) {
  const fullPath = path.join(__dirname, envFile)
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath })
  }
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
  const candidate = (raw ?? '').trim()
  if (!candidate || /\s/.test(candidate) || !/^[a-z0-9][a-z0-9._-]*$/i.test(candidate)) {
    return DEFAULT_GEMINI_MODEL
  }
  if (DEPRECATED_MODELS.has(candidate.toLowerCase())) {
    return DEFAULT_GEMINI_MODEL
  }
  return candidate
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
  const geminiKey = runtimeGeminiKey || (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim()

  if (!supabaseUrl || (!serviceRoleKey && !anonKey)) {
    res.status(500).json({ error: 'Supabase configuration is missing on the server.', code: 'not_configured' })
    return
  }

  if (!geminiKey) {
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

  const ai = new GoogleGenAI({
    apiKey: geminiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  })

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
    res.json({ questions, model })
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

async function startServer() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))

  app.post('/api/generate-questions', (req: Request, res: Response) => {
    void handleGenerateQuestions(req, res)
  })

  const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod')

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

  const port = Number(process.env.PORT) || 3000
  app.listen(port, '0.0.0.0', () => {
    console.log(`Captain LMS server listening on http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`)
  })
}

void startServer()
