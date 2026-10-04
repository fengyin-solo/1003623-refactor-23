<template>
  <section class="migrate-panel">
    <header class="migrate-head">
      <strong>存量台账迁移</strong>
      <span class="migrate-state" :class="{ done: progress.finished }">
        {{ progress.finished ? '已完成' : `进行中 ${progress.migrated}/${progress.total}` }}
      </span>
    </header>
    <p class="migrate-desc">
      把旧瞭望台台账按统一运行状态规则迁入事件台账：旧记录缺少故障时间时按原值守日期兼容；
      迁移后同一班次只保留一个有效状态；中断后从未迁移台站继续，并发恢复只接受先到结果。
    </p>
    <div class="migrate-progress">
      <div class="migrate-bar" :style="{ width: `${percent}%` }" />
    </div>
    <div class="migrate-actions">
      <button class="btn primary" type="button" :disabled="progress.finished || running" @click="runStep">
        {{ progress.finished ? '迁移已完成' : running ? '迁移中…' : '迁移下一个台站' }}
      </button>
      <button class="btn" type="button" :disabled="progress.finished || running" @click="runAll">
        一次性迁完
      </button>
      <button class="btn ghost" type="button" @click="$emit('refresh')">刷新状态</button>
    </div>
    <ul v-if="logs.length" class="migrate-log">
      <li v-for="(log, index) in logs" :key="index">{{ log }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  currentProgress,
  migrateNextStation,
  migrateRemaining,
  type MigrationProgress,
} from '@/domain/lookout-migration'

const emit = defineEmits<{ (e: 'done'): void; (e: 'refresh'): void }>()

const progress = ref<MigrationProgress>(currentProgress())
const running = ref(false)
const logs = ref<string[]>([])

const percent = computed(() =>
  progress.value.total === 0 ? 0 : Math.round((progress.value.migrated / progress.value.total) * 100),
)

function describe(progressValue: MigrationProgress): string {
  if (!progressValue.last) {
    return progressValue.finished ? '全部台站已迁移' : '没有需要迁移的台站'
  }
  const last = progressValue.last
  const inferred = last.faultTimeInferred ? '（故障时间缺失，按原值守日期兼容）' : ''
  return `台站 ${last.lookoutId} 已迁移：班次 ${last.shiftDate} → ${last.status}${inferred}`
}

function runStep() {
  running.value = true
  try {
    const result = migrateNextStation()
    progress.value = result
    logs.value.unshift(describe(result))
    if (result.finished) {
      emit('done')
    }
  } finally {
    running.value = false
  }
}

function runAll() {
  running.value = true
  try {
    const result = migrateRemaining()
    progress.value = result
    logs.value.unshift(`已迁完剩余台站，共 ${result.migrated}/${result.total}`)
    if (result.finished) {
      emit('done')
    }
  } finally {
    running.value = false
  }
}

defineExpose({ reload: () => (progress.value = currentProgress()) })
</script>

<script lang="ts">
export default { name: 'MigrationPanel' }
</script>

<style scoped>
.migrate-panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
.migrate-head { display: flex; justify-content: space-between; align-items: center; }
.migrate-state { font-size: 12px; color: var(--brand); }
.migrate-state.done { color: #166534; }
.migrate-desc { color: var(--muted); font-size: 12px; margin: 6px 0 10px; }
.migrate-progress { height: 8px; background: #eef2f7; border-radius: 999px; overflow: hidden; }
.migrate-bar { height: 100%; background: var(--brand); transition: width .2s; }
.migrate-actions { display: flex; gap: 8px; margin-top: 10px; }
.migrate-log { margin: 10px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); max-height: 96px; overflow: auto; }
</style>
