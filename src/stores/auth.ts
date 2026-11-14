import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/database.types'

export const useAuthStore = defineStore('auth', () => {
  const profile = ref<Profile | null>(null)
  const loading = ref(true)

  const isLoggedIn = computed(() => !!profile.value)
  const role = computed(() => profile.value?.role ?? null)

  let inflightProfileFetch: Promise<void> | null = null

  async function fetchProfile() {
    if (inflightProfileFetch) return inflightProfileFetch
    inflightProfileFetch = (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession()
        const userId = sessionData.session?.user.id
        if (!userId) {
          profile.value = null
          loading.value = false
          return
        }
        const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single()
        if (error) {
          console.error('Failed to load profile', error)
          profile.value = null
        } else if (data.is_active === false) {
          // Deactivated while still holding a valid session — end it.
          await supabase.auth.signOut()
          profile.value = null
        } else {
          profile.value = data
        }
        loading.value = false
      } finally {
        inflightProfileFetch = null
      }
    })()
    return inflightProfileFetch
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    await fetchProfile()
  }

  async function signUp(email: string, password: string, fullName: string, department: string) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, department, role: 'employee' } },
    })
    if (error) throw error
    if (data?.session) {
      await fetchProfile()
    }
    return data
  }

  async function signOut() {
    await supabase.auth.signOut()
    profile.value = null
  }

  supabase.auth.onAuthStateChange(() => {
    fetchProfile()
  })

  return { profile, loading, isLoggedIn, role, fetchProfile, signIn, signUp, signOut }
})
