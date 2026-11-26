import { supabase } from '@/lib/supabase'

export type DifficultyMode = 'mixed' | 'easy' | 'medium' | 'hard'

export interface QuizGenerationOptions {
  questionCount?: number
  difficultyMode?: DifficultyMode
  customInstructions?: string
}

export interface GeneratedQuestion {
  question: string
  options: string[]
  correct_index: number
  difficulty: 'easy' | 'medium' | 'hard'
}

export interface GenerateResult {
  questions?: GeneratedQuestion[]
  error?: string
  code?: string
}

async function postGenerateEndpoint(
  url: string,
  token: string,
  payload: { moduleId: number; transcript: string; options?: QuizGenerationOptions },
): Promise<{ status: number; body: GenerateResult | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  })

  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    return { status: res.status, body: null }
  }

  try {
    const body = (await res.json()) as GenerateResult
    return { status: res.status, body }
  } catch {
    return { status: res.status, body: null }
  }
}

export async function generateQuestions(
  moduleId: number,
  transcript = '',
  options: QuizGenerationOptions = {},
): Promise<GenerateResult> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) {
    return { error: 'Your session expired. Please sign in again and retry.', code: 'unauthenticated' }
  }

  const endpoints = ['/api/generate-questions', '/.netlify/functions/generate-questions']

  for (const endpoint of endpoints) {
    try {
      const { status, body } = await postGenerateEndpoint(endpoint, token, { moduleId, transcript, options })
      if (!body) {
        // 404 / HTML fallback means this deployment doesn't host this endpoint; try next fallback
        continue
      }
      if (status < 200 || status >= 300) {
        return {
          error: body.error ?? `Question generator returned HTTP ${status}.`,
          code: body.code,
        }
      }
      return { questions: body.questions }
    } catch {
      // Network error on this endpoint; try fallback
    }
  }

  return {
    error:
      'Could not reach any question generator backend (/api/generate-questions or /.netlify/functions/generate-questions). Verify your server or Netlify Functions deployment.',
    code: 'network',
  }
}
