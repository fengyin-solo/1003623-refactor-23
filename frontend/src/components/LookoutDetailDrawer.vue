<template>
  <div v-if="open" class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <header class="drawer-head">
        <div>
          <h3>{{ code }} 运行台账</h3>
          <p class="drawer-sub">{{ row?.['所在山头'] ?? '—' }} · 瞭望员 {{ row?.['瞭望员'] ?? '—' }}</p>
        </div>
        <button class="btn ghost" type="button" @click="emit('close')">关闭</button>
      </header>

      <div class="drawer-current">
        <span class="drawer-label">当前有效状态</span>
        <strong :class="['status-pill', 'pill-' + statusKey(current?.status)]">
          {{ current?.status ?? '暂无本班记录' }}
        </strong>
        <span class="drawer-meta">班次 {{ current?.shiftDate ?? '—' }}</span>
        <span class="drawer-meta">{{ current?.source === 'migrated' ? '迁移自存量台账' : '实时登记' }}</span>
        <span v-if="current?.faultTimeInferred" class="drawer-flag">故障时间缺失，已按原值守日期兼容</span>
      </div>

      <div class="drawer-actions">
        <button
          v-for="action in availableActions"
          :key="action"
          class="btn"
          type="button"
          @click="trigger(action)"
        >
          {{ action }}
        </button>
      </div>

      <h4 class="drawer-title">状态历史（只追加，不回退）</h4>
      <table class="data-table history-table">
        <thead>
          <tr><th>班次</th><th>状态</th><th>动作</th><th>发生时间</th><th>来源</th></tr>
        </thead>
        <tbody>
          <tr v-for="(event, index) in history" :key="event.occurredAt + '-' + index">
            <td>{{ event.shiftDate }}</td>
            <td :class="'cell-' + statusKey(event.status)">{{ event.status }}</td>
            <td>{{ event.action }}</td>
            <td>{{ formatOccurred(event.occurredAt) }}</td>
            <td>
              {{ event.source === 'migrated' ? '迁移' : '实时' }}
              <span v-if="event.faultTimeInferred" class="drawer-flag">时间兜底</span>
            </td>
          </tr>
          <tr v-if="!history.length">
            <td colspan="5" class="empty-state">暂无状态记录</td>
          </tr>
        </tbody>
      </table>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import {
  LOOKOUT_ACTIONS,
  LOOKOUT_STATUS,
  type CurrentStatus,
  type LookoutAction,
  type LookoutEvent,
  type LookoutStatusCode,
} from '@/domain/lookout-status'
import type { EntryRow } from '@/data/types'

const props = defineProps<{
  open: boolean
  lookoutId: number | null
  row: EntryRow | undefined
  current: CurrentStatus | null
  history: LookoutEvent[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'action', action: LookoutAction, lookoutId: number): void
}>()

const code = computed(() => String(props.row?.['瞭望台编号'] ?? `瞭望台${props.lookoutId ?? ''}`))

// 详情里能执行的动作与列表是同一份状态机推导，这里按当前状态做可见性收敛：
// 未在状态机允许集合里的动作直接不展示，杜绝「关闭后又登记值守」式回退入口。
const availableActions = computed<LookoutAction[]>(() => {
  const status = props.current?.status ?? null
  switch (status) {
    case LOOKOUT_STATUS.active:
      return [LOOKOUT_ACTIONS.reportFault, LOOKOUT_ACTIONS.close]
    case LOOKOUT_STATUS.fault:
      return [LOOKOUT_ACTIONS.repair, LOOKOUT_ACTIONS.close]
    case LOOKOUT_STATUS.repairing:
      return [LOOKOUT_ACTIONS.resume, LOOKOUT_ACTIONS.close]
    case LOOKOUT_STATUS.closed:
      return [LOOKOUT_ACTIONS.resume]
    default:
      return [LOOKOUT_ACTIONS.recordDuty, LOOKOUT_ACTIONS.reportFault, LOOKOUT_ACTIONS.close]
  }
})

function statusKey(status: LookoutStatusCode | undefined): string {
  const map: Record<string, string> = {
    [LOOKOUT_STATUS.active]: 'active',
    [LOOKOUT_STATUS.closed]: 'closed',
    [LOOKOUT_STATUS.fault]: 'fault',
    [LOOKOUT_STATUS.repairing]: 'repairing',
  }
  return map[String(status)] ?? 'unknown'
}

function formatOccurred(value: string): string {
  return value.slice(0, 16).replace('T', ' ')
}

function trigger(action: LookoutAction) {
  if (props.lookoutId !== null) {
    emit('action', action, props.lookoutId)
  }
}
</script>

<script lang="ts">
export default { name: 'LookoutDetailDrawer' }
</script>

<style scoped>
.drawer-mask {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
  display: flex; justify-content: flex-end; z-index: 50;
}
.drawer {
  width: 640px; max-width: 92vw; background: #fff; height: 100%;
  padding: 18px 20px; overflow: auto; box-shadow: -8px 0 24px rgba(15, 23, 42, 0.18);
}
.drawer-head { display: flex; justify-content: space-between; align-items: flex-start; }
.drawer-sub { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
.drawer-current { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
.drawer-label { color: var(--muted); font-size: 12px; }
.drawer-meta { color: var(--muted); font-size: 12px; }
.drawer-flag { background: #fef3c7; color: #b54708; border-radius: 999px; padding: 1px 8px; font-size: 11px; }
.status-pill { border-radius: 999px; padding: 3px 12px; font-size: 13px; }
.pill-active { background: #dcfce7; color: #166534; }
.pill-closed { background: #f1f5f9; color: #475569; }
.pill-fault { background: #fee2e2; color: #b42318; }
.pill-repairing { background: #fef3c7; color: #b54708; }
.drawer-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.drawer-title { margin: 8px 0; font-size: 14px; }
.history-table { font-size: 12px; }
.cell-active { color: #166534; }
.cell-closed { color: #475569; }
.cell-fault { color: #b42318; }
.cell-repairing { color: #b54708; }
</style>
