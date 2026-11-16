<script setup lang="ts">
import AudienceColorSettings from '@/components/AudienceColorSettings.vue'
</script>

<template>
  <div>
    <div class="topline">
      <div>
        <h2>Audiences</h2>
        <p>Departments employees can belong to and courses/modules can target. "General" is built-in for everyone.</p>
      </div>
      <RouterLink class="btn btn-ghost btn-sm" to="/admin/courses">
        Create course &rarr;
      </RouterLink>
    </div>

    <AudienceColorSettings
      :allow-manage-audiences="true"
      title="Company Audiences &amp; Course Colours"
      subtitle="Adding a new audience automatically assigns an unused colour. Removing an audience only hides it from future dropdowns."
    />
  </div>
</template>
