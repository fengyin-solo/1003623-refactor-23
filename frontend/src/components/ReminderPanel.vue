<template>
  <section v-if="reminders.length" class="reminder-panel" :class="`reminder-${tight ? 'tight' : 'full'}`">
    <header class="reminder-head">
      <strong>{{ title }}</strong>
      <span class="reminder-count">{{ reminders.length }} 条</span>
    </header>
    <ul class="reminder-list">
      <li
        v-for="item in reminders"
        :key="item.key"
        class="reminder-item"
        :class="`level-${item.level}`"
      >
        <span class="reminder-level">{{ levelText(item.level) }}</span>
        <div class="reminder-body">
          <p class="reminder-title">{{ item.title }}</p>
          <p v-if="item.detail" class="reminder-detail">{{ item.detail }}</p>
        </div>
      </li>
    </ul>
  </section>
  <p v-else-if="showEmpty" class="reminder-empty">{{ emptyText }}</p>
</template>

<script setup lang="ts">
import type { Reminder, ReminderLevel } from '@/domain/reminders'
import { reminderLevelLabel } from '@/domain/reminders'

defineProps<{
  title?: string
  reminders: Reminder[]
  showEmpty?: boolean
  emptyText?: string
  tight?: boolean
}>()

function levelText(level: ReminderLevel): string {
  return reminderLevelLabel(level)
}
</script>

<style scoped>
.reminder-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.reminder-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
}
.reminder-count {
  color: var(--muted);
  font-size: 12px;
}
.reminder-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.reminder-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  border-left: 3px solid var(--border);
  padding: 4px 8px;
  background: #f8fafc;
  border-radius: 4px;
}
.reminder-item.level-danger { border-left-color: #d92d20; }
.reminder-item.level-warn { border-left-color: #f79009; }
.reminder-item.level-info { border-left-color: #1f6feb; }
.reminder-level {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.reminder-title { margin: 0; font-size: 13px; }
.reminder-detail { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.reminder-empty { font-size: 12px; color: var(--muted); }
</style>
