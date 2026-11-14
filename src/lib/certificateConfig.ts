import { supabase } from '@/lib/supabase'

export type CertificateTemplateId = 'classic-executive' | 'modern-emerald' | 'royal-elegance' | 'tech-midnight'

export interface PdfFieldPlacement {
  enabled: boolean
  xPct: number // 0..100 horizontal anchor %
  yPct: number // 0..100 vertical % from top edge
  fontSize: number
  color: string
  align?: 'left' | 'center' | 'right'
}

export interface CustomPdfTemplateConfig {
  enabled: boolean
  fileName: string | null
  pdfBase64: string | null
  fields: {
    recipientName: PdfFieldPlacement
    courseTitle: PdfFieldPlacement
    completedDate: PdfFieldPlacement
    certificateId: PdfFieldPlacement
    department: PdfFieldPlacement
  }
}

export interface CertificateCustomization {
  templateId: CertificateTemplateId
  organizationName: string
  certificateTitle: string
  presentationKicker: string
  completionStatement: string
  sealBadgeText: string
  sealSubtext: string
  sigLeftName: string
  sigLeftTitle: string
  sigLeftOrg: string
  sigRightName: string
  sigRightTitle: string
  sigRightOrg: string
  verificationUrl: string
  includeDepartment: boolean
  includeStats: boolean
  customPdf: CustomPdfTemplateConfig
}

export const DEFAULT_CUSTOM_PDF_CONFIG: CustomPdfTemplateConfig = {
  enabled: false,
  fileName: null,
  pdfBase64: null,
  fields: {
    recipientName: { enabled: true, xPct: 50, yPct: 47, fontSize: 28, color: '#0f172a', align: 'center' },
    courseTitle: { enabled: true, xPct: 50, yPct: 60, fontSize: 18, color: '#1e3a8a', align: 'center' },
    completedDate: { enabled: true, xPct: 24, yPct: 82, fontSize: 11, color: '#334155', align: 'center' },
    certificateId: { enabled: true, xPct: 76, yPct: 82, fontSize: 10, color: '#475569', align: 'center' },
    department: { enabled: false, xPct: 50, yPct: 53, fontSize: 11, color: '#64748b', align: 'center' },
  },
}

export const TEMPLATE_METADATA: Record<
  CertificateTemplateId,
  {
    name: string
    description: string
    primaryColor: string
    accentColor: string
    bgTint: string
    badgeIcon: string
  }
> = {
  'classic-executive': {
    name: 'Classic Executive',
    description: 'Timeless prestige in deep navy and rich gold with traditional ornate borders.',
    primaryColor: '#0f172a',
    accentColor: '#d4af37',
    bgTint: '#fdfcf8',
    badgeIcon: '🏛️',
  },
  'modern-emerald': {
    name: 'Modern Emerald',
    description: 'Crisp contemporary styling in slate and vibrant emerald with sleek geometric frames.',
    primaryColor: '#0f172a',
    accentColor: '#059669',
    bgTint: '#ffffff',
    badgeIcon: '🌿',
  },
  'royal-elegance': {
    name: 'Royal Elegance',
    description: 'Heritage distinction in imperial burgundy and warm gold with flourish corner accents.',
    primaryColor: '#581c26',
    accentColor: '#c5a059',
    bgTint: '#faf7f2',
    badgeIcon: '👑',
  },
  'tech-midnight': {
    name: 'Tech Midnight',
    description: 'Modern high-tech certification aesthetic in midnight obsidian with electric cyan accents.',
    primaryColor: '#0b0f19',
    accentColor: '#0284c7',
    bgTint: '#f8fafc',
    badgeIcon: '⚡',
  },
}

export const DEFAULT_CERTIFICATE_CONFIG: CertificateCustomization = {
  templateId: 'classic-executive',
  organizationName: 'CAPTAIN & COMPANY LEARNING & DEVELOPMENT',
  certificateTitle: 'CERTIFICATE OF COMPLETION',
  presentationKicker: 'THIS IS PROUDLY PRESENTED TO',
  completionStatement: 'has successfully completed 100% of the prescribed curriculum, lessons, and evaluations for',
  sealBadgeText: '★ 100% ★',
  sealSubtext: 'VERIFIED',
  sigLeftName: 'Sarah Jenkins, M.Ed.',
  sigLeftTitle: 'VP of People & Talent Development',
  sigLeftOrg: 'Captain & Company',
  sigRightName: 'David Vance, Ph.D.',
  sigRightTitle: 'Director of Academy & Curriculum',
  sigRightOrg: 'Captain LMS Certification Board',
  verificationUrl: 'captain-lms.internal/verify',
  includeDepartment: true,
  includeStats: true,
  customPdf: {
    ...DEFAULT_CUSTOM_PDF_CONFIG,
    fields: {
      recipientName: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.recipientName },
      courseTitle: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.courseTitle },
      completedDate: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.completedDate },
      certificateId: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.certificateId },
      department: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.department },
    },
  },
}

const STORAGE_KEY = 'captain_certificate_config'

export function mergeCertificateConfig(raw: Partial<CertificateCustomization> | null | undefined): CertificateCustomization {
  const src = raw ?? {}
  const srcPdf = (src.customPdf ?? {}) as Partial<CustomPdfTemplateConfig>
  const srcFields = (srcPdf.fields ?? {}) as Partial<CustomPdfTemplateConfig['fields']>

  return {
    ...DEFAULT_CERTIFICATE_CONFIG,
    ...src,
    customPdf: {
      enabled: srcPdf.enabled ?? DEFAULT_CUSTOM_PDF_CONFIG.enabled,
      fileName: srcPdf.fileName ?? null,
      pdfBase64: srcPdf.pdfBase64 ?? null,
      fields: {
        recipientName: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.recipientName, ...srcFields.recipientName },
        courseTitle: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.courseTitle, ...srcFields.courseTitle },
        completedDate: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.completedDate, ...srcFields.completedDate },
        certificateId: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.certificateId, ...srcFields.certificateId },
        department: { ...DEFAULT_CUSTOM_PDF_CONFIG.fields.department, ...srcFields.department },
      },
    },
  }
}

/**
 * Loads current certificate configuration from localStorage, falling back to default.
 */
export function getCertificateConfig(): CertificateCustomization {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CertificateCustomization>
      return mergeCertificateConfig(parsed)
    }
  } catch (e) {
    console.error('Failed to parse certificate config from storage', e)
  }
  return mergeCertificateConfig(null)
}

/**
 * Saves certificate configuration to localStorage.
 */
export function saveCertificateConfig(config: CertificateCustomization): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    window.dispatchEvent(new CustomEvent('captain-certificate-config-updated', { detail: config }))
  } catch (e) {
    console.error('Failed to save certificate config to storage', e)
  }
}

/**
 * Pulls the shared company certificate template & customization from Supabase (if migrated),
 * caches it locally, and returns the active config so all employees use the exact same template.
 */
export async function syncCertificateConfigFromServer(): Promise<CertificateCustomization> {
  try {
    const { data, error } = await supabase
      .from('certificate_settings')
      .select('config')
      .eq('id', 1)
      .maybeSingle()

    if (!error && data?.config && Object.keys(data.config).length > 0) {
      const merged = mergeCertificateConfig(data.config as Partial<CertificateCustomization>)
      saveCertificateConfig(merged)
      return merged
    }
  } catch {
    // Fall back silently to localStorage if table doesn't exist yet
  }
  return getCertificateConfig()
}

/**
 * Saves certificate configuration locally AND persists to Supabase certificate_settings so all
 * employees receive certificates using the company's single uploaded PDF template.
 */
export async function saveCertificateConfigToServer(
  config: CertificateCustomization,
  updatedBy?: string | null,
): Promise<{ ok: boolean; syncedRemote: boolean; error?: string }> {
  saveCertificateConfig(config)
  try {
    const { error } = await supabase.from('certificate_settings').upsert({
      id: 1,
      config: config as unknown as Record<string, unknown>,
      updated_by: updatedBy ?? null,
      updated_at: new Date().toISOString(),
    })

    if (error) {
      return { ok: true, syncedRemote: false, error: error.message }
    }
    return { ok: true, syncedRemote: true }
  } catch (err) {
    return { ok: true, syncedRemote: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Resets certificate configuration to defaults.
 */
export function resetCertificateConfig(): CertificateCustomization {
  try {
    localStorage.removeItem(STORAGE_KEY)
    const def = mergeCertificateConfig(null)
    window.dispatchEvent(new CustomEvent('captain-certificate-config-updated', { detail: def }))
    return def
  } catch (e) {
    console.error('Failed to reset certificate config', e)
  }
  return mergeCertificateConfig(null)
}
