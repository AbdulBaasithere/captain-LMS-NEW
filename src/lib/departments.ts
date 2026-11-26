import { supabase } from './supabase'
import type { AudienceColorRow, Department } from './database.types'

// Fallback used only if the departments table can't be reached (e.g. schema not migrated yet) —
// keeps the app usable rather than showing empty dropdowns everywhere.
const FALLBACK = ['Sales', 'Engineering', 'Finance', 'Operations', 'Marketing', 'Customer Support']
const STORAGE_KEY = 'captain_lms_audience_colors_v1'

export interface AudienceColorOption {
  label: string
  hex: string
}

export const AUDIENCE_COLOR_PRESETS: AudienceColorOption[] = [
  { label: 'Blue', hex: '#2f5be8' },
  { label: 'Yellow', hex: '#eab308' },
  { label: 'Teal', hex: '#0f7f6c' },
  { label: 'Purple', hex: '#6d3fc0' },
  { label: 'Orange', hex: '#f08a24' },
  { label: 'Rose', hex: '#a3306b' },
  { label: 'Green', hex: '#1d8348' },
  { label: 'Sky', hex: '#0284c7' },
  { label: 'Deep Blue', hex: '#1f4e8c' },
  { label: 'Navy', hex: '#0f1b33' },
]

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function normalizeHexColor(raw: string | null | undefined, fallback = '#2f5be8'): string {
  const clean = (raw ?? '').trim().toLowerCase()
  return HEX_RE.test(clean) ? clean : fallback
}

export function defaultColorForAudience(name: string): string | null {
  const n = name.trim().toLowerCase()
  if (n === 'general') return '#0f1b33'
  if (n.includes('engineer')) return '#2f5be8'
  if (n.includes('soft') || n.includes('skill')) return '#eab308'
  if (n.includes('sales')) return '#f08a24'
  if (n.includes('finance')) return '#1d8348'
  if (n.includes('market')) return '#a3306b'
  if (n.includes('operat')) return '#6d3fc0'
  if (n.includes('support')) return '#0284c7'
  return null
}

/**
 * Generates a vibrant, readable hex colour for extra audiences beyond the 10-preset palette.
 */
function generatedDistinctHex(seedIndex: number): string {
  const hue = (seedIndex * 137.508) % 360
  const s = 68
  const l = 42
  const c = ((1 - Math.abs(2 * (l / 100) - 1)) * s) / 100
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l / 100 - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g, b] = [c, x, 0]
  else if (hue < 120) [r, g, b] = [x, c, 0]
  else if (hue < 180) [r, g, b] = [0, c, x]
  else if (hue < 240) [r, g, b] = [0, x, c]
  else if (hue < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Picks an unused preset colour automatically for newly added audiences
 * (respecting recognizable domain hints like Engineering -> Blue or Softskills -> Yellow first if unused).
 */
export function pickNextAudienceColor(existingColors: Iterable<string>, newAudienceName = ''): string {
  const used = new Set(Array.from(existingColors, (c) => c.trim().toLowerCase()))
  const hinted = defaultColorForAudience(newAudienceName)
  if (hinted && !used.has(hinted.toLowerCase())) {
    return hinted
  }
  const unusedPreset = AUDIENCE_COLOR_PRESETS.find((p) => !used.has(p.hex.toLowerCase()))
  if (unusedPreset) return unusedPreset.hex
  // Beyond 10 audiences, deterministically generate a distinct colour not yet used
  for (let i = 1; i <= 32; i++) {
    const candidate = generatedDistinctHex(used.size + i)
    if (!used.has(candidate)) return candidate
  }
  return AUDIENCE_COLOR_PRESETS[used.size % AUDIENCE_COLOR_PRESETS.length]!.hex
}

function readLocalColorCache(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && HEX_RE.test(v.trim())) {
        clean[k] = v.trim().toLowerCase()
      }
    }
    return clean
  } catch {
    return {}
  }
}

function writeLocalColorCache(map: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Ignore storage quota / private mode failures
  }
}

/** Real, assignable company departments — does NOT include "General", which is a reserved
 * built-in audience for company-wide modules, not a department anyone belongs to. */
export async function loadDepartments(): Promise<Department[]> {
  const { data, error } = await supabase.from('departments').select('*').order('name')
  if (error || !data || data.length === 0) {
    return FALLBACK.map((name, i) => ({
      id: -(i + 1),
      name,
      color: defaultColorForAudience(name) ?? AUDIENCE_COLOR_PRESETS[i % AUDIENCE_COLOR_PRESETS.length]!.hex,
      created_at: '',
    }))
  }
  return data
}

/**
 * Loads the resolved colour for every audience ('General' + all departments), combining
 * DB columns (`departments.color`, `audience_colors`), local cache, and smart defaults.
 */
export async function loadAudienceColorMap(preloadedDepts?: Department[]): Promise<Record<string, string>> {
  const depts = preloadedDepts ?? (await loadDepartments())
  const cache = readLocalColorCache()
  const dbMap: Record<string, string> = {}

  try {
    const { data, error } = await supabase.from('audience_colors').select('*')
    if (!error && data) {
      for (const row of data as AudienceColorRow[]) {
        if (HEX_RE.test(row.color)) {
          dbMap[row.audience_name] = row.color.toLowerCase()
        }
      }
    }
  } catch {
    // Table may not exist before migration; fall back smoothly
  }

  for (const d of depts) {
    if (d.color && HEX_RE.test(d.color) && !dbMap[d.name]) {
      dbMap[d.name] = d.color.toLowerCase()
    }
  }

  const resolved: Record<string, string> = {}
  const assignedSoFar: string[] = []

  const allNames = ['General', ...depts.map((d) => d.name)]
  for (const name of allNames) {
    const chosen =
      dbMap[name] ??
      cache[name] ??
      defaultColorForAudience(name) ??
      pickNextAudienceColor(assignedSoFar, name)
    resolved[name] = chosen
    assignedSoFar.push(chosen)
  }

  writeLocalColorCache({ ...cache, ...resolved })
  return resolved
}

export async function addDepartment(
  name: string,
  chosenColor?: string,
): Promise<{ error: string | null; assignedColor?: string }> {
  const trimmed = name.trim()
  if (!trimmed) return { error: 'Name is required.' }
  if (trimmed.toLowerCase() === 'general') {
    return { error: '"General" is a built-in company-wide audience.' }
  }

  const currentMap = await loadAudienceColorMap()
  const assignedColor =
    chosenColor && HEX_RE.test(chosenColor.trim())
      ? chosenColor.trim().toLowerCase()
      : pickNextAudienceColor(Object.values(currentMap), trimmed)

  let { error } = await supabase.from('departments').insert({ name: trimmed, color: assignedColor })

  // Graceful fallback if the SQL migration adding departments.color hasn't been executed yet
  if (error && error.message.toLowerCase().includes('color')) {
    const retry = await supabase.from('departments').insert({ name: trimmed })
    error = retry.error
  }

  if (error) {
    return { error: error.message.includes('duplicate') ? 'That audience already exists.' : error.message }
  }

  const cache = readLocalColorCache()
  writeLocalColorCache({ ...cache, [trimmed]: assignedColor })

  try {
    await supabase.from('audience_colors').upsert(
      { audience_name: trimmed, color: assignedColor, updated_at: new Date().toISOString() },
      { onConflict: 'audience_name' },
    )
  } catch {
    // Non-fatal before SQL migration
  }

  return { error: null, assignedColor }
}

export async function saveAudienceColor(
  audienceName: string,
  color: string,
): Promise<{ error: string | null; persistedToDb: boolean }> {
  const clean = normalizeHexColor(color)
  const cache = readLocalColorCache()
  writeLocalColorCache({ ...cache, [audienceName]: clean })

  let persistedToDb = false

  try {
    const { error: acErr } = await supabase.from('audience_colors').upsert(
      { audience_name: audienceName, color: clean, updated_at: new Date().toISOString() },
      { onConflict: 'audience_name' },
    )
    if (!acErr) persistedToDb = true
  } catch {
    // Table might not exist yet
  }

  if (audienceName !== 'General') {
    try {
      const { error: deptErr } = await supabase
        .from('departments')
        .update({ color: clean })
        .eq('name', audienceName)
      if (!deptErr) persistedToDb = true
    } catch {
      // Column might not exist yet
    }
  }

  return { error: null, persistedToDb }
}

export async function applyAudienceColorToExistingCourses(
  audienceName: string,
  color: string,
): Promise<{ updated: number; error: string | null }> {
  const clean = normalizeHexColor(color)
  const { data, error } = await supabase
    .from('courses')
    .update({ color: clean })
    .eq('category', audienceName)
    .select('id')
  if (error) return { updated: 0, error: error.message }
  return { updated: data?.length ?? 0, error: null }
}

export async function deleteDepartment(id: number, name?: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('departments').delete().eq('id', id)
  if (error) return { error: error.message }

  if (name) {
    const cache = readLocalColorCache()
    delete cache[name]
    writeLocalColorCache(cache)
    try {
      await supabase.from('audience_colors').delete().eq('audience_name', name)
    } catch {
      // Non-fatal
    }
  }

  return { error: null }
}
