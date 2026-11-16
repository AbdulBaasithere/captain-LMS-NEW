<script setup lang="ts">
import { ref, watchEffect, onMounted, onBeforeUnmount } from 'vue'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

const props = defineProps<{
  renderChart: () => ReactNode
  height?: number
  minHeight?: number
}>()

const hostEl = ref<HTMLDivElement | null>(null)
let root: Root | null = null

onMounted(() => {
  if (!hostEl.value) return
  root = createRoot(hostEl.value)
  root.render(props.renderChart())
})

watchEffect(() => {
  const node = props.renderChart()
  if (root) {
    root.render(node)
  }
})

onBeforeUnmount(() => {
  if (root) {
    root.unmount()
    root = null
  }
})
</script>

<template>
  <div
    ref="hostEl"
    class="recharts-host"
    :style="{
      width: '100%',
      height: `${props.height ?? 280}px`,
      minHeight: `${props.minHeight ?? props.height ?? 280}px`,
    }"
  />
</template>

<style scoped>
.recharts-host :deep(.recharts-wrapper) {
  font-family: 'Plus Jakarta Sans', sans-serif;
}
.recharts-host :deep(.recharts-cartesian-axis-tick-value) {
  font-variant-numeric: tabular-nums;
}
</style>
