import { supabase } from '@/lib/supabase'

export interface ManageResult {
  ok?: boolean
  error?: string
  provider?: string
  messageId?: string
  email?: string | null
  last_sign_in_at?: string | null
  confirmed?: boolean
}

export interface BulkInviteRowResult {
  email: string
  success: boolean
  provider?: string
  messageId?: string
  error?: string
}

export interface BulkInviteResponse {
  results?: BulkInviteRowResult[]
  provider?: string
  error?: string
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504])
const MAX_ATTEMPTS_PER_ENDPOINT = 3
const REQUEST_TIMEOUT_MS = 25_000
const BULK_BATCH_SIZE = 5

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postAdminEndpoint<T>(
  endpoints: string[],
  payload: unknown,
  fallbackNetworkError: string,
): Promise<{ status: number; body: T | null; networkError?: string }> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) {
    return { status: 401, body: null, networkError: 'Your session expired. Please sign in again.' }
  }

  let lastReason = ''

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ENDPOINT; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timer)

        const contentType = res.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
          const snippet = (await res.text().catch(() => '')).slice(0, 120).replace(/\s+/g, ' ').trim()
          lastReason = `HTTP ${res.status} (non-JSON response${snippet ? `: ${snippet}` : ''})`
          console.warn(
            `[employees-api] non-JSON response endpoint=${endpoint} attempt=${attempt}/${MAX_ATTEMPTS_PER_ENDPOINT} status=${res.status}`,
          )
          if (RETRYABLE_HTTP_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS_PER_ENDPOINT) {
            await sleep(600 * attempt)
            continue
          }
          break // Try next fallback endpoint
        }

        const body = (await res.json()) as T
        if (RETRYABLE_HTTP_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS_PER_ENDPOINT) {
          lastReason = `HTTP ${res.status}`
          console.warn(
            `[employees-api] transient HTTP ${res.status} endpoint=${endpoint} attempt=${attempt}/${MAX_ATTEMPTS_PER_ENDPOINT}; retrying…`,
          )
          await sleep(600 * Math.pow(2, attempt - 1))
          continue
        }

        return { status: res.status, body }
      } catch (err) {
        clearTimeout(timer)
        const msg = err instanceof Error ? (err.name === 'AbortError' ? 'Request timed out' : err.message) : String(err)
        lastReason = msg
        console.warn(
          `[employees-api] network failure endpoint=${endpoint} attempt=${attempt}/${MAX_ATTEMPTS_PER_ENDPOINT}: ${msg}`,
        )
        if (attempt < MAX_ATTEMPTS_PER_ENDPOINT) {
          await sleep(600 * Math.pow(2, attempt - 1))
          continue
        }
      }
    }
  }

  console.error(`[employees-api] all endpoints failed: ${endpoints.join(', ')} (${lastReason || 'unreachable'})`)
  return {
    status: 0,
    body: null,
    networkError: lastReason ? `${fallbackNetworkError} (${lastReason})` : fallbackNetworkError,
  }
}

export async function manageEmployee(body: {
  action: 'create' | 'update' | 'deactivate' | 'reactivate' | 'delete' | 'get'
  id?: string
  email?: string
  full_name?: string
  department?: string
  role?: string
}): Promise<ManageResult> {
  const { status, body: out, networkError } = await postAdminEndpoint<ManageResult>(
    ['/api/admin-manage-employee', '/.netlify/functions/admin-manage-employee'],
    body,
    'Could not reach the employee service.',
  )
  if (!out) return { error: networkError ?? 'Could not reach the employee service.' }
  if (status < 200 || status >= 300) return { error: out.error ?? `Request failed (HTTP ${status}).` }
  return out
}

export async function bulkInviteEmployees(
  rows: Array<{ full_name: string; email: string; department: string; role?: string }>,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ results: BulkInviteRowResult[]; error?: string }> {
  const allResults: BulkInviteRowResult[] = []
  let batchFatalError: string | undefined

  onProgress?.(0, rows.length)

  for (let start = 0; start < rows.length; start += BULK_BATCH_SIZE) {
    const chunk = rows.slice(start, start + BULK_BATCH_SIZE)
    const { status, body: out, networkError } = await postAdminEndpoint<BulkInviteResponse>(
      ['/api/admin-invite-employees', '/.netlify/functions/admin-invite-employees'],
      { rows: chunk },
      'Could not reach the invite service.',
    )

    if (!out) {
      const err = networkError ?? 'Could not reach the invite service.'
      batchFatalError = batchFatalError ?? err
      for (const row of chunk) {
        allResults.push({ email: row.email, success: false, error: err })
      }
    } else if (status < 200 || status >= 300) {
      const err = out.error ?? `Import failed (HTTP ${status}).`
      batchFatalError = batchFatalError ?? err
      for (const row of chunk) {
        allResults.push({ email: row.email, success: false, error: err })
      }
    } else {
      const chunkResults = out.results ?? []
      allResults.push(...chunkResults)
    }

    onProgress?.(Math.min(start + chunk.length, rows.length), rows.length)
  }

  return { results: allResults, error: batchFatalError }
}

/** Rows where is_active is missing (column not added yet) count as active. */
export function isActive(p: { is_active?: boolean }): boolean {
  return p.is_active !== false
}

/** "Talha Affan" -> "TA": first letters of the first and last words. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  const first = words[0]![0]!
  const last = words.length > 1 ? words[words.length - 1]![0]! : (words[0]![1] ?? '')
  return (first + last).toUpperCase()
}
