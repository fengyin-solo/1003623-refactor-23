<template>
  <section class="page" data-module="lookout">
    <header class="page-head">
      <div>
        <h2>瞭望台管理</h2>
        <p class="page-desc">统一维护瞭望台值守、故障、关闭运行状态；台账只追加、不回退，关闭台不再产生值守提醒。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出瞭望台清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">瞭望台总数</span>
        <strong class="stat-value">{{ rows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">正常值守数</span>
        <strong class="stat-value">{{ countOf(LOOKOUT_STATUS.active) }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">故障/维修台数</span>
        <strong class="stat-value">{{ countOf(LOOKOUT_STATUS.fault) + countOf(LOOKOUT_STATUS.repairing) }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">临时关闭数</span>
        <strong class="stat-value">{{ countOf(LOOKOUT_STATUS.closed) }}</strong>
      </article>
    </div>

    <ReminderBanner :reminders="reminders" title="值守提醒" tone="lookout" />

    <MigrationPanel ref="migrationPanel" @done="reload" @refresh="reload" />

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>台账当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <button class="link" type="button" @click="openDetail(row)">
              {{ statusOf(row) }}
            </button>
            <span v-if="inferred(row)" class="infer-flag">故障时间已兜底</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无瞭望台数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 个瞭望台 · 状态规则、提醒与迁移共用一套领域写法</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <LookoutDetailDrawer
      :open="detailOpen"
      :lookout-id="detailId"
      :row="detailRow"
      :current="detailCurrent"
      :history="detailHistory"
      @close="detailOpen = false"
      @action="handleDetailAction"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import ReminderBanner from '@/components/ReminderBanner.vue'
import LookoutDetailDrawer from '@/components/LookoutDetailDrawer.vue'
import MigrationPanel from '@/components/MigrationPanel.vue'
import {
  allCurrentStatuses,
  eventsOf,
  recordAction,
  stationMap,
} from '@/domain/lookout-service'
import { buildLookoutReminders } from '@/domain/reminders'
import {
  LOOKOUT_ACTIONS,
  LOOKOUT_STATUS,
  type CurrentStatus,
  type LookoutAction,
} from '@/domain/lookout-status'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('lookout')
// 台账承接运行状态后，旧表里的「运行状态」冗余字段不再作为列表列，只保留台站资料。
const columns = ['瞭望台编号', '所在山头', '海拔高度', '视野覆盖面积', '瞭望员', '通讯方式', '设备配置', '值守日期', '故障时间']

const rows = ref<EntryRow[]>([])
const statusIndex = ref<Map<number, CurrentStatus>>(new Map())
const reminders = ref(buildLookoutReminders())
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['瞭望台编号', '所在山头', '瞭望员']

const migrationPanel = ref<InstanceType<typeof MigrationPanel> | null>(null)

// 详情抽屉状态
const detailOpen = ref(false)
const detailId = ref<number | null>(null)
const detailRow = ref<EntryRow | undefined>(undefined)
const detailCurrent = ref<CurrentStatus | null>(null)
const detailHistory = ref<ReturnType<typeof eventsOf>>([])

const filteredRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows.value
  }
  return rows.value.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
})

const statusSummary = computed(() =>
  [LOOKOUT_STATUS.active, LOOKOUT_STATUS.closed, LOOKOUT_STATUS.fault, LOOKOUT_STATUS.repairing].map(
    (status) => ({ status, count: countOf(status) }),
  ),
)

function countOf(status: string): number {
  let n = 0
  for (const row of rows.value) {
    if (statusIndex.value.get(Number(row.id))?.status === status) {
      n += 1
    }
  }
  return n
}

function statusOf(row: EntryRow): string {
  return statusIndex.value.get(Number(row.id))?.status ?? '待迁移'
}

function inferred(row: EntryRow): boolean {
  return statusIndex.value.get(Number(row.id))?.faultTimeInferred === true
}

// 列表可执行动作同样由统一状态机推导，关闭台只给「恢复值守」。
function actionsFor(row: EntryRow): LookoutAction[] {
  const status = statusIndex.value.get(Number(row.id))?.status ?? null
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
      // 尚未迁移、本班无事件：允许首次记录值守/故障/关闭
      return [LOOKOUT_ACTIONS.recordDuty, LOOKOUT_ACTIONS.reportFault, LOOKOUT_ACTIONS.close]
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openDetail(row: EntryRow) {
  const id = Number(row.id)
  detailId.value = id
  detailRow.value = stationMap().get(id)
  detailCurrent.value = statusIndex.value.get(id) ?? null
  detailHistory.value = eventsOf(id)
  detailOpen.value = true
}

function runAction(action: LookoutAction, row: EntryRow) {
  errorMessage.value = ''
  const result = recordAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (detailOpen.value && detailId.value === Number(row.id)) {
    syncDetail()
  }
}

function handleDetailAction(action: LookoutAction, lookoutId: number) {
  errorMessage.value = ''
  const result = recordAction(lookoutId, action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  syncDetail()
}

function syncDetail() {
  if (detailId.value === null) {
    return
  }
  detailCurrent.value = statusIndex.value.get(detailId.value) ?? null
  detailHistory.value = eventsOf(detailId.value)
}

function reload() {
  errorMessage.value = ''
  try {
    // 旧表仍承载台站基础资料与筛选；运行状态完全以事件台账派生的当前状态为准。
    rows.value = listEntries(meta.key, {}).items
    statusIndex.value = new Map(
      allCurrentStatuses()
        .filter((item) => item.current !== null)
        .map((item) => [item.lookoutId, item.current as CurrentStatus]),
    )
    reminders.value = buildLookoutReminders()
    migrationPanel.value?.reload()
    syncDetail()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '瞭望台台账读取失败'
  }
}

onMounted(reload)
</script>
