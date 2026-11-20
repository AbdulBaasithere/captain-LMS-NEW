<script setup lang="ts">
withDefaults(
  defineProps<{
    subtitle?: string
    size?: 'sm' | 'md' | 'lg'
    plain?: boolean
  }>(),
  {
    subtitle: '',
    size: 'md',
    plain: false,
  },
)
</script>

<template>
  <div class="brand-logo" :class="[`sz-${size}`, { plain }]">
    <div class="brand-plaque">
      <img
        src="/assets/aistudio/captain-logo_d6af1701.png"
        alt="Captain — We create bonds"
        class="brand-img"
      />
    </div>
    <span v-if="subtitle" class="brand-sub">{{ subtitle }}</span>
  </div>
</template>

<style scoped>
.brand-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.brand-logo.sz-md {
  padding: 0 4px 16px;
}

.brand-logo.sz-sm {
  gap: 8px;
}

.brand-logo.sz-lg {
  gap: 12px;
}

.brand-plaque {
  background: #ffffff;
  border-radius: 9px;
  padding: 5px 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.24);
  border: 1px solid rgba(255, 255, 255, 0.16);
}

.brand-logo.plain .brand-plaque {
  background: transparent;
  padding: 0;
  border: none;
  box-shadow: none;
}

.brand-logo.sz-sm .brand-plaque {
  padding: 3px 7px;
  border-radius: 7px;
}

.brand-logo.sz-lg .brand-plaque {
  padding: 7px 12px;
  border-radius: 11px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
}

.brand-img {
  display: block;
  width: auto;
  object-fit: contain;
}

.brand-logo.sz-sm .brand-img {
  height: 24px;
}

.brand-logo.sz-md .brand-img {
  height: 30px;
}

.brand-logo.sz-lg .brand-img {
  height: 40px;
}

.brand-sub {
  font: 700 13px 'Plus Jakarta Sans', sans-serif;
  color: #f6f2f3;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.brand-logo.sz-sm .brand-sub {
  font-size: 12.5px;
}

.brand-logo.sz-lg .brand-sub {
  font-size: 16px;
  font-weight: 800;
  color: #ffffff;
}

.brand-logo.plain .brand-sub {
  color: var(--ink);
}
</style>
