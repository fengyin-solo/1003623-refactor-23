// 存量瞭望台台账迁移：把旧表（forest-fire-patrol:entries 里的 lookout 行）
// 收敛进运行状态事件台账。
//
// 兼容与正确性约束：
//   1. 旧记录缺少「故障时间」时，按原「值守日期」兜底，并在事件上打 faultTimeInferred 标记；
//   2. 迁移后同一班次（台站 + 值守日期）只落一条有效状态——重复迁移直接幂等跳过；
//   3. 按台站稳定顺序逐个提交（每台站一次 CAS），中断后从未迁移台站继续；
//   4. 并发恢复只接受先到结果：CAS 失败视为他处已写入，重读进度后跳过该台站。

import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import {
  commitEvents,
  getLedger,
  getMigrationState,
  saveMigrationState,
} from './lookout-store'
import {
  ACTION_TARGET,
  LOOKOUT_ACTIONS,
  LOOKOUT_STATUS,
  type LookoutAction,
  type LookoutEvent,
  type LookoutStatusCode,
} from './lookout-status'
import { formatDate, parseDate } from './time'

// 旧状态 -> (新状态, 对应动作)。旧表里出现的字面量都在这里归一。
const LEGACY_STATUS_MAP: Record<string, { status: LookoutStatusCode; action: LookoutAction }> = {
  [LOOKOUT_STATUS.active]: { status: LOOKOUT_STATUS.active, action: LOOKOUT_ACTIONS.recordDuty },
  [LOOKOUT_STATUS.closed]: { status: LOOKOUT_STATUS.closed, action: LOOKOUT_ACTIONS.close },
  [LOOKOUT_STATUS.fault]: { status: LOOKOUT_STATUS.fault, action: LOOKOUT_ACTIONS.reportFault },
  [LOOKOUT_STATUS.repairing]: { status: LOOKOUT_STATUS.repairing, action: LOOKOUT_ACTIONS.repair },
}

// 实在没有任何可用日期时的最后兜底（旧台账最早班次），保证时间字段始终可解析。
const FALLBACK_DATE = '2026-09-01'

export type MigratedStation = {
  lookoutId: number
  shiftDate: string
  status: LookoutStatusCode
  occurredAt: string
  faultTimeInferred: boolean
  skipped: boolean
}

/** 旧行 -> 台账事件。纯函数，方便单测与复用。 */
export function legacyRowToEvent(row: EntryRow): LookoutEvent | null {
  const lookoutId = Number(row.id)
  if (!Number.isFinite(lookoutId)) {
    return null
  }
  const mapped = LEGACY_STATUS_MAP[String(row.status)]
  if (!mapped) {
    return null
  }

  // 班次一律以原「值守日期」为准。
  const shiftDate = resolveShiftDate(row)

  // 故障时间优先取「故障时间」字段；旧记录缺失时按原值守日期兼容。
  let faultTimeInferred = false
  let occurredAt = String(row['故障时间'] ?? '').trim()
  if (!occurredAt && mapped.status === LOOKOUT_STATUS.fault) {
    occurredAt = shiftDate
    faultTimeInferred = true
  }
  if (!occurredAt) {
    occurredAt = shiftDate
  }

  return {
    lookoutId,
    shiftDate,
    status: mapped.status,
    action: mapped.action,
    occurredAt: normalizeDateTime(occurredAt),
    source: 'migrated',
    ...(faultTimeInferred ? { faultTimeInferred: true } : {}),
  }
}

function resolveShiftDate(row: EntryRow): string {
  const dutyDate = parseDate(row['值守日期'])
  if (dutyDate) {
    return formatDate(dutyDate)
  }
  // 值守日期也缺失的极旧数据，用固定兜底班次，避免迁移产出无法排班的脏时间。
  return FALLBACK_DATE
}

// 旧时间可能是 yyyy-mm-dd 或带时分秒；统一成可比较的 ISO（日期补成 00:00）。
function normalizeDateTime(value: string): string {
  const parsed = parseDate(value)
  if (!parsed) {
    return `${FALLBACK_DATE}T00:00:00.000Z`
  }
  return parsed.toISOString()
}

function legacyRows(): EntryRow[] {
  return [...listRows('lookout')].sort((a, b) => Number(a.id) - Number(b.id))
}

/** 某台站某班次是否已经迁过 —— 断点续迁与幂等的判据。 */
export function isStationMigrated(events: LookoutEvent[], lookoutId: number, shiftDate: string): boolean {
  return events.some(
    (event) => event.lookoutId === lookoutId && event.shiftDate === shiftDate,
  )
}

export type MigrationProgress = {
  migrated: number
  total: number
  finished: boolean
  last: MigratedStation | null
}

/** 迁移下一个尚未迁移的台站；全部完成返回 finished。可反复调用直到 done。 */
export function migrateNextStation(): MigrationProgress {
  const rows = legacyRows()
  const state = getMigrationState()
  state.total = rows.length

  for (const row of rows) {
    const lookoutId = Number(row.id)
    if (!Number.isFinite(lookoutId)) {
      continue
    }
    const event = legacyRowToEvent(row)
    if (!event) {
      // 无法映射的异常旧行不阻塞整体迁移：记为已跳过，进度仍可走完。
      markMigrated(state, lookoutId)
      saveMigrationState(state)
      continue
    }
    // 用台账实况判定（多标签页恢复时，对方可能已经迁过）。
    let ledger = getLedger()
    if (isStationMigrated(ledger.events, lookoutId, event.shiftDate)) {
      markMigrated(state, lookoutId)
      continue
    }

    const baseVersion = ledger.version
    const result = commitEvents(baseVersion, [event])
    if (!result.ok && result.reason === 'stale') {
      // 并发恢复：先到结果已落库，重读确认后把该台站视为已迁移，不覆盖对方数据。
      ledger = getLedger()
      if (isStationMigrated(ledger.events, lookoutId, event.shiftDate)) {
        markMigrated(state, lookoutId)
        continue
      }
      // 对方写的是别的台站，本次未完成，下一轮从本站继续。
      saveMigrationState(state)
      return snapshot(state, { ...toMigrated(event), skipped: false })
    }

    markMigrated(state, lookoutId)
    saveMigrationState(state)
    return snapshot(state, { ...toMigrated(event), skipped: false })
  }

  state.total = rows.length
  state.finishedAt = new Date().toISOString()
  saveMigrationState(state)
  return snapshot(state, null)
}

/** 一次性迁完所有剩余台站（内部循环走单台站提交，中断语义与逐步迁移一致）。 */
export function migrateRemaining(stepLimit: number = 10000): MigrationProgress {
  let progress = currentProgress()
  let guard = 0
  while (!progress.finished && guard < stepLimit) {
    progress = migrateNextStation()
    guard += 1
  }
  return progress
}

export function currentProgress(): MigrationProgress {
  const state = getMigrationState()
  return snapshot(state, null)
}

function snapshot(state: ReturnType<typeof getMigrationState>, last: MigratedStation | null): MigrationProgress {
  return {
    migrated: state.migratedIds.length,
    total: state.total,
    finished: state.finishedAt !== null || state.migratedIds.length >= state.total,
    last,
  }
}

function markMigrated(state: ReturnType<typeof getMigrationState>, lookoutId: number) {
  if (!state.migratedIds.includes(lookoutId)) {
    state.migratedIds.push(lookoutId)
  }
}

function toMigrated(event: LookoutEvent): Omit<MigratedStation, 'skipped'> {
  return {
    lookoutId: event.lookoutId,
    shiftDate: event.shiftDate,
    status: event.status,
    occurredAt: event.occurredAt,
    faultTimeInferred: event.faultTimeInferred === true,
  }
}

/** 迁移自检：是否每个台站每班只有一条有效状态（供页面与测试调用）。 */
export function validateUniqueness(events: LookoutEvent[]): boolean {
  const seen = new Set<string>()
  for (const event of events) {
    const key = `${event.lookoutId}#${event.shiftDate}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
  }
  return true
}

export { ACTION_TARGET }
