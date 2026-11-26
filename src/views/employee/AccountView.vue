<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { useOnboardingTour } from '@/composables/useOnboardingTour'

const auth = useAuthStore()
const tour = useOnboardingTour()
</script>

<template>
  <div>
    <div class="topline">
      <div><h2>Account</h2></div>
    </div>
    <div class="card" style="padding: 20px; max-width: 460px; margin-bottom: 16px">
      <div class="field">
        <label>Full name</label>
        <input :value="auth.profile?.full_name" disabled />
      </div>
      <div class="field">
        <label>Department</label>
        <input :value="auth.profile?.department" disabled />
      </div>
      <div class="field">
        <label>Theme</label>
        <ThemeToggle variant="mini" surface />
      </div>
      <p class="hint">Profile editing isn't wired up yet — update the `profiles` row in Supabase directly for now.</p>
    </div>

    <div class="card" style="padding: 20px; max-width: 460px">
      <h3 style="font-size: 17px; margin-bottom: 6px">Interactive Walkthrough &amp; Demos</h3>
      <p class="sub" style="margin-bottom: 12px">
        Need a refresher on how the Dashboard, Course Catalog, Lesson Player, Badges, or Certificates work? Replay the step-by-step guided tour with video demos.
      </p>
      <button type="button" class="btn btn-primary" @click="tour.replayTour('employee')">
        🎬 Show Walkthrough &amp; Demo Again
      </button>
    </div>
  </div>
</template>
