<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { supabaseConfigured, hasSecretKeyInClient } from '@/lib/supabase'
import { loadDepartments } from '@/lib/departments'
import ThemeToggle from '@/components/ThemeToggle.vue'
import VersionBadge from '@/components/VersionBadge.vue'
import BrandLogo from '@/components/BrandLogo.vue'

const router = useRouter()
const auth = useAuthStore()

const departments = ref<string[]>([])
const mode = ref<'signin' | 'signup'>('signin')
const email = ref('')
const password = ref('')
const fullName = ref('')
const department = ref('')
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  departments.value = (await loadDepartments()).map((d) => d.name)
  department.value = departments.value[0] ?? ''
})

async function submit() {
  error.value = ''
  busy.value = true
  try {
    if (mode.value === 'signin') {
      await auth.signIn(email.value, password.value)
      if (auth.role === 'admin') router.push('/admin')
      else if (auth.role === 'manager') router.push('/manager')
      else if (auth.role === 'hr') router.push('/hr')
      else router.push('/app')
    } else {
      const data = await auth.signUp(email.value, password.value, fullName.value, department.value)
      if (data?.session) {
        if (auth.role === 'admin') router.push('/admin')
        else if (auth.role === 'manager') router.push('/manager')
        else if (auth.role === 'hr') router.push('/hr')
        else router.push('/app')
      } else {
        error.value = 'Check your inbox to confirm your email, then sign in.'
        mode.value = 'signin'
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Something went wrong.'
    if (msg.toLowerCase().includes('forbidden use of secret') || hasSecretKeyInClient) {
      error.value = "Supabase blocked this request: VITE_SUPABASE_ANON_KEY must be the 'anon' public key (starts with eyJ... or sb_publishable_), not the secret service-role key (sb_secret_...)."
    } else if (msg.toLowerCase().includes('rate limit')) {
      error.value = "Supabase email rate limit reached (shared SMTP has an hourly limit). You can disable 'Confirm email' in Supabase Dashboard → Authentication → Providers → Email to sign up instantly without needing an email."
    } else {
      error.value = msg
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="theme-cycle-btn auth-theme-toggle">
      <ThemeToggle variant="icon" />
    </div>
    <VersionBadge />

    <div class="auth-card">
      <div class="auth-visual">
        <BrandLogo size="lg" subtitle="LMS" />
        <blockquote>
          &ldquo;Everyone used to sit through the same videos, whether it applied to them or not. Now each team
          sees their own training, and nothing else.&rdquo;
        </blockquote>
        <div class="badge-strip">
          <span class="badge-chip">🥉</span><span class="badge-chip">🥈</span><span class="badge-chip">🥇</span
          ><span class="badge-chip">💎</span><span class="badge-chip">🏆</span>
        </div>
      </div>

      <div class="auth-form">
        <h2>{{ mode === 'signin' ? 'Sign in' : 'Create account' }}</h2>
        <p class="sub">Captain LMS</p>

        <div v-if="hasSecretKeyInClient" class="banner banner-danger">
          <strong>Secret key detected in browser config:</strong> <code>VITE_SUPABASE_ANON_KEY</code> is set to a secret key (<code>sb_secret_...</code>). Supabase forbids secret keys in web browsers. Please replace it with the <strong>anon public</strong> key from Supabase Dashboard &rarr; Project Settings &rarr; API.
        </div>
        <div v-else-if="!supabaseConfigured" class="banner banner-danger">
          Supabase isn't connected yet — copy <code>.env.example</code> to <code>.env.local</code>. See README.md.
        </div>

        <form @submit.prevent="submit">
          <div v-if="mode === 'signup'" class="field">
            <label>Full name</label>
            <input v-model="fullName" type="text" required />
          </div>
          <div class="field">
            <label>Work email</label>
            <input v-model="email" type="email" required />
          </div>
          <div class="field">
            <label>Password</label>
            <input v-model="password" type="password" required minlength="6" />
          </div>
          <div v-if="mode === 'signup'" class="field">
            <label>Department</label>
            <select v-model="department">
              <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>

          <p v-if="error" class="auth-error">{{ error }}</p>

          <button class="btn btn-primary" type="submit" :disabled="busy" style="width: 100%; justify-content: center">
            {{ busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up' }}
          </button>
        </form>

        <p class="auth-switch">
          <template v-if="mode === 'signin'">
            New here? <button type="button" @click="mode = 'signup'">Create an account</button>
          </template>
          <template v-else>
            Already have an account? <button type="button" @click="mode = 'signin'">Sign in</button>
          </template>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  position: relative;
  background:
    radial-gradient(circle at 18% 18%, rgba(221, 51, 51, 0.08), transparent 48%),
    radial-gradient(circle at 82% 85%, rgba(221, 51, 51, 0.05), transparent 45%);
}
.auth-theme-toggle {
  position: fixed;
  top: 16px;
  right: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.auth-card {
  width: 100%;
  max-width: 860px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-radius: 24px;
  overflow: hidden;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
}
.auth-visual {
  background:
    radial-gradient(circle at 85% 15%, rgba(221, 51, 51, 0.52), transparent 55%),
    radial-gradient(circle at 10% 95%, rgba(217, 119, 6, 0.22), transparent 45%),
    linear-gradient(160deg, #171215, #291418 60%, #141013);
  color: #f6f2f3;
  padding: 40px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
@media (max-width: 720px) {
  .auth-card {
    grid-template-columns: 1fr;
  }
  .auth-visual {
    padding: 20px 24px;
  }
  .auth-visual .brand-logo {
    padding: 0;
  }
  .auth-visual blockquote,
  .auth-visual .badge-strip {
    display: none;
  }
  .auth-form {
    padding: 26px 24px;
  }
}
.auth-visual blockquote {
  font-family: 'Newsreader';
  font-style: italic;
  font-weight: 500;
  font-size: 19px;
  line-height: 1.45;
  color: #fff;
}
.badge-strip {
  display: flex;
  gap: 10px;
}
.badge-chip {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.25);
  display: grid;
  place-items: center;
  font-size: 16px;
}
.auth-form {
  background: var(--surface);
  padding: 36px 38px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.auth-form h2 {
  font-size: 23px;
  margin-bottom: 2px;
}
.auth-form .sub {
  color: var(--ink-soft);
  font-size: 13.5px;
  margin-bottom: 18px;
}
.banner {
  font-size: 12.5px;
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 16px;
}
.banner-danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.auth-error {
  color: var(--danger);
  font-size: 13px;
  margin-bottom: 12px;
}
.auth-switch {
  margin-top: 16px;
  font-size: 13px;
  color: var(--ink-soft);
}
.auth-switch button {
  background: none;
  border: none;
  color: var(--accent-text);
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
}
</style>
