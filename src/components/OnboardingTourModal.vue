<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useOnboardingTour } from '@/composables/useOnboardingTour'
import { formatTutorialDuration, sanitizeExternalUrl } from '@/lib/tutorialHelpers'

const router = useRouter()
const auth = useAuthStore()
const tour = useOnboardingTour()

const videoUrl = computed(() => sanitizeExternalUrl(tour.matchedTutorial.value?.video_url))
const thumbUrl = computed(() => sanitizeExternalUrl(tour.matchedTutorial.value?.thumbnail_url))

watch(
  () => [tour.isOpen.value, tour.currentStep.value?.route] as const,
  ([open, route]) => {
    if (open && route && router.currentRoute.value.path !== route) {
      void router.push(route)
    }
  },
)

function next() {
  if (tour.stepIndex.value < tour.steps.value.length - 1) {
    tour.goToStep(tour.stepIndex.value + 1)
  } else {
    tour.markSeenAndClose(auth.profile?.id)
  }
}

function prev() {
  if (tour.stepIndex.value > 0) {
    tour.goToStep(tour.stepIndex.value - 1)
  }
}

function skip() {
  tour.markSeenAndClose(auth.profile?.id)
}

function openFullTutorial() {
  const tut = tour.matchedTutorial.value
  tour.markSeenAndClose(auth.profile?.id)
  if (tut && tour.activeRole.value === 'employee') {
    void router.push(`/app/tutorials/${tut.id}`)
  } else {
    void router.push(tour.activeRole.value === 'admin' ? '/admin/tutorials' : '/app/tutorials')
  }
}

function onKeydown(e: KeyboardEvent) {
  if (!tour.isOpen.value) return
  if (e.key === 'Escape') skip()
  else if (e.key === 'ArrowRight') next()
  else if (e.key === 'ArrowLeft') prev()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="tour.isOpen.value" class="tour-backdrop" role="dialog" aria-modal="true" aria-label="Interactive Guided Tour">
      <div class="tour-modal">
        <header class="tour-head">
          <div class="tour-head-left">
            <span class="tour-step-badge">
              Step {{ tour.stepIndex.value + 1 }} of {{ tour.steps.value.length }}
            </span>
            <span class="tour-route-pill">{{ tour.currentStep.value.icon }} {{ tour.currentStep.value.route }}</span>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" @click="skip">Skip tour ✕</button>
        </header>

        <div class="tour-body">
          <div class="tour-media-col">
            <div class="tour-video-frame">
              <video
                v-if="videoUrl"
                :key="videoUrl"
                :src="videoUrl"
                :poster="thumbUrl || undefined"
                controls
                autoplay
                muted
                loop
                playsinline
                class="tour-video"
              />
              <div v-else class="tour-video-fallback">
                <div class="tour-fallback-icon">{{ tour.currentStep.value.icon }}</div>
                <p>Interactive preview for <b>{{ tour.currentStep.value.title }}</b></p>
                <span class="sub">You can see this live section in the background behind this guide.</span>
              </div>
            </div>
            <div v-if="tour.matchedTutorial.value" class="tour-media-meta">
              <span class="sub">
                🎬 Demo video ({{ formatTutorialDuration(tour.matchedTutorial.value.duration_seconds) }})
              </span>
              <button type="button" class="tour-link-btn" @click="openFullTutorial">
                Open in Academy →
              </button>
            </div>
          </div>

          <div class="tour-info-col">
            <h2 class="tour-title">{{ tour.currentStep.value.title }}</h2>
            <p class="tour-sub">{{ tour.currentStep.value.subtitle }}</p>

            <div class="tour-section">
              <div class="tour-section-lbl">What Each Component Does</div>
              <ul class="tour-comp-list">
                <li v-for="c in tour.currentStep.value.components" :key="c.name">
                  <b>{{ c.name }}:</b> {{ c.detail }}
                </li>
              </ul>
            </div>

            <div class="tour-section">
              <div class="tour-section-lbl">How to Use It</div>
              <ol class="tour-howto-list">
                <li v-for="item in tour.currentStep.value.howTo" :key="item">{{ item }}</li>
              </ol>
            </div>
          </div>
        </div>

        <footer class="tour-foot">
          <div class="tour-dots" role="tablist" aria-label="Tour steps">
            <button
              v-for="(s, idx) in tour.steps.value"
              :key="s.id"
              type="button"
              class="tour-dot"
              :class="{ active: idx === tour.stepIndex.value }"
              :title="s.title"
              :aria-label="`Go to step ${idx + 1}: ${s.title}`"
              @click="tour.goToStep(idx)"
            />
          </div>

          <div class="tour-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="tour.stepIndex.value === 0"
              @click="prev"
            >
              ← Back
            </button>
            <button type="button" class="btn btn-primary btn-sm" @click="next">
              {{ tour.stepIndex.value === tour.steps.value.length - 1 ? 'Finish Tour ✓' : 'Next Section →' }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tour-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.62);
  backdrop-filter: blur(4px);
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.tour-modal {
  width: min(980px, 100%);
  max-height: calc(100vh - 32px);
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tour-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.tour-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.tour-step-badge {
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 999px;
}

.tour-route-pill {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 3px 10px;
  border-radius: 999px;
}

.tour-body {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 20px;
  padding: 20px;
  overflow-y: auto;
}

.tour-media-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tour-video-frame {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: #0f172a;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tour-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #0f172a;
}

.tour-video-fallback {
  text-align: center;
  padding: 24px;
  color: #e2e8f0;
}

.tour-fallback-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.tour-media-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tour-link-btn {
  background: none;
  border: 0;
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
  padding: 0;
}

.tour-link-btn:hover {
  text-decoration: underline;
}

.tour-info-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tour-title {
  font-size: 20px;
  line-height: 1.25;
  margin: 0;
}

.tour-sub {
  font-size: 13.5px;
  color: var(--ink-2);
  margin: 0;
  line-height: 1.45;
}

.tour-section-lbl {
  font-size: 11.5px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent);
  margin-bottom: 6px;
}

.tour-comp-list,
.tour-howto-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--ink);
}

.tour-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.tour-dots {
  display: flex;
  align-items: center;
  gap: 7px;
}

.tour-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  border: 0;
  padding: 0;
  background: var(--border);
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
}

.tour-dot.active {
  width: 22px;
  background: var(--accent);
}

.tour-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 820px) {
  .tour-body {
    grid-template-columns: 1fr;
  }
}
</style>
