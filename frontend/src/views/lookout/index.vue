<template>
  <section class="page" data-module="lookout">
    <header class="page-head">
      <div>
        <h2>瞭望台管理管理</h2>
        <p class="page-desc">维护瞭望台，围绕瞭望台编号、所在山头、海拔高度、视野覆盖面积做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记瞭望台</button>
        <button class="btn" type="button" @click="exportRows">导出瞭望台管理清单</button>
      </div>
    </header>

    <div v-if="migration" class="migration-banner" :class="migration.finished ? 'is-done' : 'is-running'">
      <template v-if="migration.finished">
        存量台账已迁移完成：共 {{ migration.stats.total }} 条旧记录，
        接受 {{ migration.stats.accepted }} 条有效状态，
        重复班次丢弃 {{ migration.stats.skippedDuplicate }} 条，
        不合规跳过 {{ migration.stats.skippedInvalid }} 条。
      </template>
      <template v-else>
        存量台账迁移中：已处理 {{ migration.processedStationCodes.length }} / {{ stationTotal }}
        个台站，下一个待迁移台站「{{ migration.nextStationCode ?? '—' }}」。
        中断后会从未迁移台站继续。
        <button class="btn ghost" type="button" @click="resumeMigration">立即继续</button>
      </template>
    </div>

    <ReminderPanel title="值守 / 故障提醒（关闭台站不再催值守）" :reminders="reminders" />

    <div class="stat-row">
      <article v-for="item in liveStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
          <th>当前状态</th>
          <th>可执行动作</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="['status-tag', statusClass(String(row.status))]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <template v-if="rowActions(row).length">
              <button
                v-for="action in rowActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">终态，无可用动作</span>
          </td>
          <td>
            <button class="link" type="button" @click="openDetail(row)">状态时间线</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无瞭望台管理数据，可先登记瞭望台</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条瞭望台管理记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <div>
            <strong>{{ detail.row['瞭望台编号'] }} 运行状态详情</strong>
            <p class="page-desc">所在山头：{{ detail.row['所在山头'] ?? '—' }} · 瞭望员：{{ detail.row['瞭望员'] ?? '—' }}</p>
          </div>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <p class="status-legend">
          <span class="legend-item">当前状态：{{ detailRowStatus(detail.row) }}</span>
          <span class="legend-item">当前班次：{{ currentShift }}</span>
        </p>

        <h3 class="drawer-subtitle">状态时间线（旧记录按原值守日期兼容，只追加不回退）</h3>
        <ol v-if="detail.timeline.length" class="timeline">
          <li
            v-for="(event, index) in detail.timeline"
            :key="event.shiftKey + '-' + event.at + '-' + index"
            class="timeline-item"
          >
            <span :class="['status-tag', statusClass(event.status)]">{{ event.status }}</span>
            <span class="timeline-meta">
              {{ event.shiftKey }} · {{ event.source === 'legacy' ? '存量迁移' : '动作记录' }}
              <template v-if="event.note"> · {{ event.note }}</template>
            </span>
          </li>
        </ol>
        <p v-else class="muted-text">迁移完成前暂无台账事件，动作记录后会出现在这里。</p>

        <h3 class="drawer-subtitle">可执行动作（同一班次只接受先到结果）</h3>
        <div class="row-actions">
          <template v-if="rowActions(detail.row).length">
            <button
              v-for="action in rowActions(detail.row)"
              :key="action"
              class="btn"
              type="button"
              @click="runAction(action, detail.row)"
            >
              {{ action }}
            </button>
          </template>
          <span v-else class="muted-text">已关闭终态，不再接受任何动作，也不再生成值守提醒。</span>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  LOOKOUT_RULES,
  allowedActions,
  currentShiftKey,
} from '@/domain/status-rules'
import {
  BACKGROUND_RUNNER_OWNER,
  getLookoutStation,
  getLookoutTimeline,
  migrationStep,
  readLedger,
  readMigrationState,
  subscribeLookoutStore,
  type LookoutMigrationState,
} from '@/domain/lookout-store'
import { stationCodeOf } from '@/domain/lookout-migration'
import { describeStation } from '@/domain/lookout-ledger'
import { buildLookoutReminders } from '@/domain/reminders'
import type { Reminder } from '@/domain/reminders'
import type { EntryRow } from '@/data/types'
import ReminderPanel from '@/components/ReminderPanel.vue'

const meta = moduleMeta('lookout')
const columns = meta.fields
const statuses = [...LOOKOUT_RULES.statuses]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const currentShift = currentShiftKey()
const migration = ref<LookoutMigrationState | null>(readMigrationState())

const detail = ref<{ row: EntryRow; timeline: ReturnType<typeof getLookoutTimeline> } | null>(null)

const reminders = ref<Reminder[]>([])

let unsubscribe: (() => void) | null = null

const stationTotal = computed(
  () => new Set(rows.value.map((row) => stationCodeOf(row))).size,
)

const liveStats = computed(() => [
  { label: '瞭望台总数', value: rows.value.length },
  {
    label: '正常值守数',
    value: rows.value.filter((row) => String(row.status) === '正常值守').length,
  },
  {
    label: '故障台数',
    value: rows.value.filter((row) => LOOKOUT_RULES.abnormalStatuses.includes(String(row.status))).length,
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function rowActions(row: EntryRow): string[] {
  return allowedActions(LOOKOUT_RULES, detailRowStatus(row))
}

/** 台账迁移完成后以台账有效状态为准；未迁移到的台站沿用列表里的旧状态。 */
function detailRowStatus(row: EntryRow): string {
  const station = getLookoutStation(stationCodeOf(row))
  return station ? describeStation(station, currentShift).status : String(row.status)
}

function statusClass(status: string): string {
  if (status === '临时关闭') return 'tag-terminal'
  if (status === '设备故障') return 'tag-danger'
  if (status === '维修中') return 'tag-warn'
  return 'tag-normal'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '瞭望台登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (detail.value && stationCodeOf(detail.value.row) === stationCodeOf(row)) {
    openDetail(rows.value.find((item) => Number(item.id) === Number(row.id)) ?? row)
  }
}

function openDetail(row: EntryRow) {
  detail.value = {
    row,
    timeline: getLookoutTimeline(stationCodeOf(row)),
  }
}

function closeDetail() {
  detail.value = null
}

function resumeMigration() {
  // main.ts 的后台节拍已经在跑；手动续跑与后台共用同标签页迁移身份，
  // 立刻推进一个台站。跨标签页时若另一会话持锁则本轮不改数据，
  // 等下一拍从 nextStationCode 继续。
  try {
    migrationStep(BACKGROUND_RUNNER_OWNER)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '存量台账续跑失败'
  }
  refreshExternalState()
  reload()
}

function refreshExternalState() {
  migration.value = readMigrationState()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reminders.value = buildLookoutReminders(payload.items, readLedger(), currentShift)
    migration.value = readMigrationState()
    if (detail.value) {
      detail.value = {
        ...detail.value,
        row: payload.items.find((row) => stationCodeOf(row) === stationCodeOf(detail.value!.row))
          ?? detail.value.row,
        timeline: getLookoutTimeline(stationCodeOf(detail.value.row)),
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '瞭望台管理列表读取失败'
  }
}

onMounted(() => {
  reload()
  // 迁移在 main.ts 已启动；这里订阅台账/迁移进度，完成、中断接管或跨标签页更新时自动刷新
  unsubscribe = subscribeLookoutStore(() => {
    migration.value = readMigrationState()
    reload()
  })
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>
