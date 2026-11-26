<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import ThemeToggle from '@/components/ThemeToggle.vue'
import VersionTag from '@/components/VersionTag.vue'
import BrandLogo from '@/components/BrandLogo.vue'
import { onMounted, watch } from 'vue'
import { useWidgetsStore } from '@/stores/widgets'
import { initialsOf } from '@/lib/employees'
import OnboardingTourModal from '@/components/OnboardingTourModal.vue'
import { useOnboardingTour } from '@/composables/useOnboardingTour'

const auth = useAuthStore()
const widgets = useWidgetsStore()
const tour = useOnboardingTour()
onMounted(() => {
  void widgets.load()
  if (auth.profile?.id) tour.maybeStartFirstLoginTour('admin', auth.profile.id)
})
watch(
  () => auth.profile?.id,
  (id) => {
    if (id) tour.maybeStartFirstLoginTour('admin', id)
  },
)
const router = useRouter()

async function logout() {
  await auth.signOut()
  router.push('/login')
}

const links = [
  { to: '/admin/overview', label: 'Analytics', short: 'Analytics', icon: '▦' },
  { to: '/admin/monitoring', label: 'Monitoring & Alerts', short: 'Alerts', icon: '🔔' },
  { to: '/admin/employees', label: 'Employees', short: 'People', icon: '👥' },
  { to: '/admin/courses', label: 'Courses', short: 'Courses', icon: '🎓' },
  { to: '/admin/tutorials', label: 'Academy Tutorials', short: 'Academy', icon: '🎬' },
  { to: '/admin/modules', label: 'Modules (lessons)', short: 'Lessons', icon: '▤' },
  { to: '/admin/audiences', label: 'Audiences', short: 'Audiences', icon: '🏷️' },
  { to: '/admin/certificates', label: 'Certificates', short: 'Certs', icon: '📜' },
  { to: '/admin/badges', label: 'Badges & Milestones', short: 'Badges', icon: '🎖️' },
  { to: '/admin/dashboard-settings', label: 'Dashboard Settings', short: 'Settings', icon: '⚙' },
  { to: '/admin/release-notes', label: 'Release Notes', short: 'Notes', icon: '📝' },
]
</script>

<template>
  <div class="shell active">
    <aside class="rail">
      <BrandLogo size="md" subtitle="LMS · Admin" />
      <RouterLink v-for="l in links" :key="l.to" :to="l.to" class="navlink"
        ><span>{{ l.icon }}</span> {{ l.label }}</RouterLink
      >
      <div class="rail-foot">
        <ThemeToggle variant="mini" />
        <div class="who">
          <div class="avatar">{{ initialsOf(auth.profile?.full_name) }}</div>
          <div>
            <div class="nm">{{ auth.profile?.full_name }}</div>
            <div class="rl">ADMIN</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
          <button class="signout" style="width: auto" @click="logout">Sign out</button>
          <VersionTag />
        </div>
      </div>
    </aside>

    <div class="main">
      <div class="mobile-topbar">
        <BrandLogo size="sm" subtitle="LMS · Admin" />
        <div style="display: flex; align-items: center; gap: 4px">
          <ThemeToggle variant="icon" />
          <button class="theme-cycle-btn" style="color: #fca5a5" title="Sign out" @click="logout">⏻</button>
          <VersionTag />
        </div>
      </div>

      <RouterView />

      <nav class="mobile-tabbar">
        <RouterLink v-for="l in links" :key="l.to" :to="l.to" class="navlink"
          ><span>{{ l.icon }}</span> {{ l.short }}</RouterLink
        >
      </nav>
    </div>
    <OnboardingTourModal />
  </div>
</template>
