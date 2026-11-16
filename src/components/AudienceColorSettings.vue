<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { logActivity } from '@/lib/activity'
import {
  AUDIENCE_COLOR_PRESETS,
  addDepartment,
  applyAudienceColorToExistingCourses,
  deleteDepartment,
  loadAudienceColorMap,
  loadDepartments,
  pickNextAudienceColor,
  saveAudienceColor,
} from '@/lib/departments'
import type { Department } from '@/lib/database.types'

withDefaults(
  defineProps<{
    allowManageAudiences?: boolean
    title?: string
    subtitle?: string
  }>(),
  {
    allowManageAudiences: false,
    title: 'Audience Course Colours',
    subtitle: 'Assign a default colour to each audience for Create Course. Newly created audiences are automatically assigned an unused colour.',
  },
)

const auth = useAuthStore()
const departments = ref<Department[]>([])
const colorMap = ref<Record<string, string>>({})
const loading = ref(true)
const savingName = ref<string | null>(null)
const syncingName = ref<string | null>(null)
const feedback = ref<{ ok: boolean; text: string } | null>(null)

// New audience creation (when allowManageAudiences is enabled or inline)
const newAudienceName = ref('')
const autoColorMode = ref(true)
const manualNewColor = ref('#2f5be8')
const creating = ref(false)

async function refresh() {
  loading.value = true
  const depts = await loadDepartments()
  departments.value = depts
  colorMap.value = await loadAudienceColorMap(depts)
  manualNewColor.value = pickNextAudienceColor(Object.values(colorMap.value), newAudienceName.value)
  loading.value = false
}

onMounted(refresh)

const nextAutoColor = computed(() =>
  pickNextAudienceColor(Object.values(colorMap.value), newAudienceName.value),
)

const audienceRows = computed(() => {
  const rows: { id: number | null; name: string; color: string; isBuiltIn: boolean }[] = [
    {
      id: null,
      name: 'General',
      color: colorMap.value['General'] ?? '#0f1b33',
      isBuiltIn: true,
    },
  ]
  for (const d of departments.value) {
    rows.push({
      id: d.id,
      name: d.name,
      color: colorMap.value[d.name] ?? '#2f5be8',
      isBuiltIn: false,
    })
  }
  return rows
})

function colorLabel(hex: string): string {
  const match = AUDIENCE_COLOR_PRESETS.find((p) => p.hex.toLowerCase() === hex.toLowerCase())
  return match ? `${match.label} (${hex.toUpperCase()})` : hex.toUpperCase()
}

async function assignColor(audienceName: string, hex: string) {
  const clean = hex.toLowerCase()
  colorMap.value = { ...colorMap.value, [audienceName]: clean }
  savingName.value = audienceName
  feedback.value = null
  const res = await saveAudienceColor(audienceName, clean)
  savingName.value = null
  if (res.error) {
    feedback.value = { ok: false, text: res.error }
    return
  }
  await logActivity(auth.profile?.id, `Assigned colour ${clean.toUpperCase()} to "${audienceName}" audience`)
  feedback.value = {
    ok: true,
    text: `Assigned ${colorLabel(clean)} to ${audienceName}. New courses for ${audienceName} will use this colour automatically.`,
  }
}

async function syncExistingCourses(audienceName: string, hex: string) {
  syncingName.value = audienceName
  feedback.value = null
  const res = await applyAudienceColorToExistingCourses(audienceName, hex)
  syncingName.value = null
  if (res.error) {
    feedback.value = { ok: false, text: res.error }
    return
  }
  await logActivity(auth.profile?.id, `Applied ${hex.toUpperCase()} to ${res.updated} existing "${audienceName}" course(s)`)
  feedback.value = {
    ok: true,
    text:
      res.updated > 0
        ? `Updated ${res.updated} existing course${res.updated === 1 ? '' : 's'} in ${audienceName} to ${colorLabel(hex)}.`
        : `No existing courses found under ${audienceName}. Future courses will use ${colorLabel(hex)}.`,
  }
}

async function handleCreateAudience() {
  const name = newAudienceName.value.trim()
  if (!name) return
  creating.value = true
  feedback.value = null
  const preferred = autoColorMode.value ? undefined : manualNewColor.value
  const res = await addDepartment(name, preferred)
  creating.value = false
  if (res.error) {
    feedback.value = { ok: false, text: res.error }
    return
  }
  const assigned = res.assignedColor ?? nextAutoColor.value
  await logActivity(auth.profile?.id, `Added "${name}" audience (auto-assigned colour ${assigned.toUpperCase()})`)
  newAudienceName.value = ''
  autoColorMode.value = true
  await refresh()
  feedback.value = {
    ok: true,
    text: `Added "${name}" and automatically assigned ${colorLabel(assigned)}.`,
  }
}

async function handleRemoveAudience(row: { id: number | null; name: string }) {
  if (row.id === null || row.id < 0) return
  feedback.value = null
  const res = await deleteDepartment(row.id, row.name)
  if (res.error) {
    feedback.value = { ok: false, text: res.error }
    return
  }
  await logActivity(auth.profile?.id, `Removed "${row.name}" from company audiences`)
  await refresh()
}
</script>

<template>
  <div class="card aud-panel">
    <div class="aud-head">
      <div>
        <h3 style="font-size: 18px">{{ title }}</h3>
        <p class="sub">{{ subtitle }}</p>
      </div>
    </div>

    <div v-if="feedback" class="fb-box" :class="feedback.ok ? 'fb-ok' : 'fb-err'">
      <span>{{ feedback.text }}</span>
      <button type="button" class="fb-close" aria-label="Dismiss" @click="feedback = null">✕</button>
    </div>

    <!-- Add Audience + Auto Colour Preview -->
    <div v-if="allowManageAudiences" class="create-box">
      <div class="create-row">
        <div class="grow">
          <label for="new-aud-name">New Audience Name</label>
          <input
            id="new-aud-name"
            v-model="newAudienceName"
            type="text"
            placeholder="e.g. Softskills, Engineering, Legal"
            @keyup.enter="handleCreateAudience"
          />
        </div>
        <div class="auto-preview">
          <label>Assigned Colour</label>
          <div class="preview-chip">
            <span
              class="swatch-dot"
              :style="{ background: autoColorMode ? nextAutoColor : manualNewColor }"
            />
            <span class="mono">
              {{ autoColorMode ? `Auto: ${colorLabel(nextAutoColor)}` : colorLabel(manualNewColor) }}
            </span>
            <input
              type="color"
              :value="autoColorMode ? nextAutoColor : manualNewColor"
              title="Pick custom colour instead of automatic assignment"
              class="color-picker-mini"
              @input="
                (e) => {
                  autoColorMode = false
                  manualNewColor = (e.target as HTMLInputElement).value
                }
              "
            />
            <button
              v-if="!autoColorMode"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="autoColorMode = true"
            >
              Auto
            </button>
          </div>
        </div>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="creating || !newAudienceName.trim()"
          @click="handleCreateAudience"
        >
          {{ creating ? 'Adding…' : '+ Add Audience' }}
        </button>
      </div>
      <p class="hint" style="margin-top: 8px">
        New audiences automatically receive a distinct unused colour (e.g. Engineering → Blue, Softskills → Yellow). You can change any audience's colour below anytime.
      </p>
    </div>

    <p v-if="loading" class="sub" style="padding: 12px 0">Loading audiences…</p>

    <div v-else class="aud-list">
      <div v-for="row in audienceRows" :key="row.name" class="aud-row">
        <div class="aud-meta">
          <span class="aud-badge" :style="{ background: row.color }" aria-hidden="true" />
          <div>
            <div class="aud-name">
              <b>{{ row.name }}</b>
              <span v-if="row.isBuiltIn" class="sub"> · Built-in (everyone)</span>
              <span v-else-if="savingName === row.name" class="sub"> · Saving…</span>
            </div>
            <div class="sub mono">{{ colorLabel(row.color) }}</div>
          </div>
        </div>

        <div class="swatch-strip" role="group" :aria-label="`Choose colour for ${row.name}`">
          <button
            v-for="preset in AUDIENCE_COLOR_PRESETS"
            :key="preset.hex"
            type="button"
            class="swatch"
            :class="{ on: row.color.toLowerCase() === preset.hex.toLowerCase() }"
            :style="{ background: preset.hex }"
            :title="`${preset.label} (${preset.hex})`"
            :aria-label="`${row.name}: ${preset.label}`"
            @click="assignColor(row.name, preset.hex)"
          />
          <label class="custom-picker" :title="`Pick custom hex colour for ${row.name}`">
            <input
              type="color"
              :value="row.color"
              @change="(e) => assignColor(row.name, (e.target as HTMLInputElement).value)"
            />
            <span>Custom</span>
          </label>
        </div>

        <div class="aud-actions">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="syncingName === row.name"
            title="Update colour of existing courses in this audience"
            @click="syncExistingCourses(row.name, row.color)"
          >
            {{ syncingName === row.name ? 'Applying…' : 'Apply to existing' }}
          </button>
          <button
            v-if="allowManageAudiences && !row.isBuiltIn && row.id !== null && row.id > 0"
            type="button"
            class="btn btn-ghost btn-sm"
            style="color: var(--danger)"
            title="Remove audience"
            @click="handleRemoveAudience(row)"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aud-panel {
  padding: 20px;
}
.aud-head {
  margin-bottom: 14px;
}
.aud-head h3 {
  margin-bottom: 2px;
}
.fb-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 14px;
  border: 1px solid var(--border);
}
.fb-ok {
  background: var(--teal-soft);
  color: var(--teal);
  border-color: var(--teal);
}
.fb-err {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: var(--danger);
}
.fb-close {
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  font-weight: 700;
}
.create-box {
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 16px;
}
.create-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}
.create-row label {
  display: block;
  font-size: 11.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-soft);
  margin-bottom: 5px;
}
.auto-preview {
  min-width: 220px;
}
.preview-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 6px 10px;
}
.swatch-dot {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  flex: none;
}
.color-picker-mini {
  width: 24px;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.aud-list {
  display: flex;
  flex-direction: column;
}
.aud-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.aud-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 190px;
}
.aud-badge {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  flex: none;
  border: 1px solid rgba(15, 26, 46, 0.14);
}
.aud-name {
  font-size: 14px;
}
.mono {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11.5px;
}
.swatch-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2.5px solid transparent;
  cursor: pointer;
  transition: transform 0.12s ease;
}
.swatch:hover {
  transform: scale(1.08);
}
.swatch.on {
  border-color: var(--ink);
  box-shadow: 0 0 0 2px var(--surface);
}
.custom-picker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink-soft);
  padding: 2px 8px 2px 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  background: var(--surface);
}
.custom-picker input[type='color'] {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.aud-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
</style>
