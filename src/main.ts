import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

// Guard against iframe sandbox restrictions on modal dialogs
if (typeof window !== 'undefined') {
  const origAlert = window.alert?.bind(window)
  window.alert = (message?: unknown) => {
    try {
      origAlert?.(message)
    } catch {
      console.warn('[Blocked alert]', message)
    }
  }
  const origConfirm = window.confirm?.bind(window)
  window.confirm = (message?: string) => {
    try {
      return origConfirm ? origConfirm(message) : true
    } catch {
      console.warn('[Blocked confirm - defaulting to true]', message)
      return true
    }
  }
}

import App from './App.vue'
import router from './router'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')
