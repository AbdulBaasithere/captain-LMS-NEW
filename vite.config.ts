import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

function getEnvValue(key: string, envDirs: string[]): string {
  for (const dir of envDirs) {
    for (const filename of ['.env', '.env.local']) {
      const filepath = path.join(dir, filename)
      if (fs.existsSync(filepath)) {
        const content = fs.readFileSync(filepath, 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eqIdx = trimmed.indexOf('=')
          if (eqIdx !== -1 && trimmed.slice(0, eqIdx).trim() === key) {
            return trimmed.slice(eqIdx + 1).trim()
          }
        }
      }
    }
  }
  return ''
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const dirs = [process.cwd(), '/']
  const fileSupabaseUrl = getEnvValue('VITE_SUPABASE_URL', dirs)
  const fileSupabaseKey = getEnvValue('VITE_SUPABASE_ANON_KEY', dirs)

  const loaded = loadEnv(mode, process.cwd(), '')

  const isPlaceholderUrl = (u: string) => !u || u.includes('YOUR-PROJECT-REF') || u.includes('placeholder')
  const isPlaceholderKey = (k: string) => !k || k === 'your-anon-public-key' || k === 'placeholder-anon-key'

  const finalUrl = (!isPlaceholderUrl(fileSupabaseUrl) ? fileSupabaseUrl : '') ||
                   (!isPlaceholderUrl(loaded.VITE_SUPABASE_URL) ? loaded.VITE_SUPABASE_URL : '') ||
                   (!isPlaceholderUrl(process.env.VITE_SUPABASE_URL || '') ? process.env.VITE_SUPABASE_URL : '') ||
                   fileSupabaseUrl || loaded.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''

  const finalKey = (!isPlaceholderKey(fileSupabaseKey) ? fileSupabaseKey : '') ||
                   (!isPlaceholderKey(loaded.VITE_SUPABASE_ANON_KEY) ? loaded.VITE_SUPABASE_ANON_KEY : '') ||
                   (!isPlaceholderKey(process.env.VITE_SUPABASE_ANON_KEY || '') ? process.env.VITE_SUPABASE_ANON_KEY : '') ||
                   fileSupabaseKey || loaded.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''

  return {
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(finalUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(finalKey),
    },
    plugins: [
      vue(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    optimizeDeps: {
      include: ['pdfjs-dist', 'pdf-lib', 'jspdf'],
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
  }
})
