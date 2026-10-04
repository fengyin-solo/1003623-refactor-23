<template>
  <section v-if="reminders.length" class="reminder-panel" :class="`reminder-${tone}`">
    <header class="reminder-head">
      <strong>{{ title }}</strong>
      <span class="reminder-count">{{ reminders.length }} 条</span>
    </header>
    <ul class="reminder-list">
      <li v-for="reminder in reminders" :key="reminder.key" class="reminder-item">
        <span class="reminder-badge" :class="`badge-${reminder.level}`">
          {{ reminder.level === 'warn' ? '告警' : '提示' }}
        </span>
        <span class="reminder-title">{{ reminder.title }}</span>
        <span class="reminder-detail">{{ reminder.detail }}</span>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { Reminder } from '@/domain/reminders'

defineProps<{
  reminders: Reminder[]
  title?: string
  tone?: 'all' | 'lookout' | 'weather'
}>()
</script>

<script lang="ts">
export default { name: 'ReminderBanner' }
</script>

<style scoped>
.reminder-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.reminder-panel.reminder-lookout { border-left-color: #b54708; }
.reminder-panel.reminder-weather { border-left-color: #175cd3; }
.reminder-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.reminder-count { color: var(--muted); font-size: 12px; }
.reminder-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.reminder-item { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.reminder-badge { border-radius: 999px; padding: 1px 8px; font-size: 11px; flex: none; }
.badge-warn { background: #fef3c7; color: #b54708; }
.badge-info { background: #dbeafe; color: #175cd3; }
.reminder-title { font-weight: 600; }
.reminder-detail { color: var(--muted); }
</style>
