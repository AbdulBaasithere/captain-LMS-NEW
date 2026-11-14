// Netlify Function — drafts a multiple-choice question bank for a module from its uploaded material
// using Google Gemini's free tier. Runs server-side so the API key never reaches the browser.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   GEMINI_API_KEY             free key from https://aistudio.google.com/apikey
//   GEMINI_MODEL               optional, defaults to gemini-2.5-flash
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (already set for the invite function)
//
// Material handling:
//   PDF            sent to Gemini as-is (it reads text and scanned pages)
//   DOCX / PPTX    text pulled out of the file's XML here, then sent as text
//   YouTube video  sent to Gemini as a video URL; if that fails, the admin pastes a transcript instead

import { createClient } from '@supabase/supabase-js'
import JSZip from 'jszip'
import { GoogleGenAI, Type, type Part as GenAiPart } from '@google/genai'

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
9. Respond with ONLY valid JSON. No markdown, no code fences, no extra text.`

const USER_PROMPT = `Write 15 multiple-choice questions from the material provided. Return a JSON array where each item is {"question": string, "options": [4 strings], "correct_index": 0-3, "difficulty": "easy" | "medium" | "hard"}.`

const MAX_INLINE_BYTES = 18 * 1024 * 1024
const MAX_TEXT_CHARS = 120_000

interface GeneratedQuestion {
  question: string
  options: string[]
  correct_index: number
  difficulty: 'easy' | 'medium' | 'hard'
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } } | { file_data: { file_uri: string } }

class UserFacingError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status = 422) {
    super(message)
    this.code = code
    this.status = status
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function decodeXmlText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1])
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
    // Paragraph breaks keep sentences from running together.
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

async function materialParts(
  mod: { youtube_id: string | null; document_url: string | null; document_type: string | null },
  transcript: string,
): Promise<Part[]> {
  if (transcript.trim()) {
    return [{ text: `MATERIAL (video transcript):\n${transcript.trim().slice(0, MAX_TEXT_CHARS)}` }]
  }

  if (mod.youtube_id) {
    const id = extractYoutubeId(mod.youtube_id)
    if (!id) {
      throw new UserFacingError(
        "This module's YouTube ID doesn't look valid. Re-save the module with the 11-character ID or the full video link.",
        'bad_youtube_id',
      )
    }
    return [{ file_data: { file_uri: `https://www.youtube.com/watch?v=${id}` } }]
  }

  if (mod.document_url && mod.document_type) {
    const res = await fetch(mod.document_url)
    if (!res.ok) throw new UserFacingError('Could not download the uploaded file.', 'fetch_failed', 502)
    const bytes = await res.arrayBuffer()
    const type = mod.document_type

    if (type === 'pdf') {
      if (bytes.byteLength > MAX_INLINE_BYTES) {
        throw new UserFacingError('This PDF is over 18 MB — too large to read. Compress it or split it.', 'too_large')
      }
      return [{ inline_data: { mime_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } }]
    }

    if (type === 'docx' || type === 'pptx') {
      const text = (await extractOfficeText(bytes, type)).trim()
      if (text.length < 200) {
        throw new UserFacingError('Not enough readable text found in this file (images and charts are not read).', 'no_text')
      }
      return [{ text: `MATERIAL (${type.toUpperCase()} text):\n${text.slice(0, MAX_TEXT_CHARS)}` }]
    }

    throw new UserFacingError(
      `Old ${type.toUpperCase()} files can't be read automatically. Re-save it as ${type === 'doc' ? 'DOCX' : 'PPTX'} or PDF and upload again.`,
      'unsupported_type',
    )
  }

  throw new UserFacingError('This module has no video or document yet.', 'no_material')
}

function extractYoutubeId(raw: string): string | null {
  const v = raw.trim()
  if (/^[\w-]{11}$/.test(v)) return v
  const m = v.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/)
  return m ? m[1] : null
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  return JSON.parse(cleaned)
}

function validate(raw: unknown): GeneratedQuestion[] {
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

// Models drift towards putting the right answer in the same slot; assign target slots round-robin
// (shuffled) and move each correct option there so the spread across A-D is as even as possible.
function balanceAnswers(questions: GeneratedQuestion[]): GeneratedQuestion[] {
  const slots = questions.map((_, i) => i % 4)
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[slots[i], slots[j]] = [slots[j], slots[i]]
  }
  return questions.map((q, i) => {
    const target = slots[i]
    const options = [...q.options]
    ;[options[q.correct_index], options[target]] = [options[target], options[q.correct_index]]
    return { ...q, options, correct_index: target }
  })
}

function toGenAiParts(parts: Part[]): GenAiPart[] {
  return parts.map((p) => {
    if ('text' in p) return { text: p.text }
    if ('inline_data' in p) return { inlineData: { mimeType: p.inline_data.mime_type, data: p.inline_data.data } }
    return { fileData: { fileUri: p.file_data.file_uri } }
  })
}

async function callGemini(parts: Part[], apiKey: string, model: string): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  })

  try {
    const response = await ai.models.generateContent({
      model,
      contents: { parts: [...toGenAiParts(parts), { text: USER_PROMPT }] },
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
    const text = (response.text ?? '').trim()
    if (!text) throw new UserFacingError('Gemini returned nothing for this material.', 'empty', 422)
    return text
  } catch (err) {
    if (err instanceof UserFacingError) throw err
    const message = err instanceof Error ? err.message : String(err)
    console.error('Gemini error:', message)
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) {
      throw new UserFacingError(
        'Gemini quota or rate limit reached. Nothing was lost — wait about a minute and try again.',
        'rate_limit',
        429,
      )
    }
    if (/403|PERMISSION_DENIED|API_KEY_INVALID|api key/i.test(message)) {
      throw new UserFacingError('The Gemini API key is invalid or missing.', 'bad_key', 500)
    }
    if (/404|NOT_FOUND/i.test(message)) {
      throw new UserFacingError(
        `Gemini model "${model}" isn't available for this key. Set GEMINI_MODEL to gemini-4-hydrogen.`,
        'bad_model',
        500,
      )
    }
    if (/400|transcript|caption|unavailable/i.test(message)) {
      throw new UserFacingError(`Gemini could not read this material: ${message}`, 'unreadable', 422)
    }
    throw new UserFacingError(`Gemini error: ${message.slice(0, 240)}`, 'upstream', 502)
  }
}

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
    return 'gemini-4-hydrogen'
  }
  if (DEPRECATED_MODELS.has(candidate.toLowerCase())) {
    return 'gemini-4-hydrogen'
  }
  return candidate
}

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()
  const geminiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim()
  if (!supabaseUrl || (!serviceRoleKey && !anonKey)) return json({ error: 'Server is not configured yet.', code: 'not_configured' }, 500)
  if (!geminiKey) {
    return json({ error: "Question generation isn't set up yet — add GEMINI_API_KEY.", code: 'not_configured' }, 500)
  }

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Missing auth token' }, 401)

  const admin = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey)
    : createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } })
  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData.user) return json({ error: 'Invalid session' }, 401)
  const { data: caller } = await admin.from('profiles').select('role').eq('id', userData.user.id).single()
  if (caller?.role !== 'admin') return json({ error: 'Admins only' }, 403)

  let moduleId: number
  let transcript = ''
  try {
    const body = (await req.json()) as { moduleId?: number; transcript?: string }
    moduleId = Number(body.moduleId)
    transcript = body.transcript ?? ''
  } catch {
    return json({ error: 'Invalid request body' }, 400)
  }
  if (!moduleId) return json({ error: 'moduleId is required' }, 400)

  const { data: mod } = await admin
    .from('modules')
    .select('youtube_id, document_url, document_type')
    .eq('id', moduleId)
    .single()
  if (!mod) return json({ error: 'Module not found' }, 404)

  const model = resolveGeminiModel(process.env.GEMINI_MODEL)

  try {
    const parts = await materialParts(mod, transcript)
    const reply = await callGemini(parts, geminiKey, model)
    const questions = balanceAnswers(validate(parseJson(reply)))
    return json({ questions, model })
  } catch (e) {
    if (e instanceof UserFacingError) {
      if (e.code === 'unreadable' && mod.youtube_id && !transcript.trim()) {
        return json(
          {
            error:
              "Couldn't read this video automatically (it may be private or have no captions). Paste its transcript below and try again.",
            code: 'need_transcript',
          },
          422,
        )
      }
      return json({ error: e.message, code: e.code }, e.status)
    }
    return json({ error: 'Something went wrong while generating questions.', code: 'unknown' }, 500)
  }
}
