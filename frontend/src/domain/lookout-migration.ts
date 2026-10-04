/**
 * 瞭望台存量台账迁移（纯函数：不读写 localStorage，runner 负责落盘与续跑）
 *
 * 迁移规则：
 *  - 旧记录缺少「故障时间」时，按原值守日期（值守日期字段）兼容；连日期都没有的
 *    老记录进入 LEGACY_SHIFT_KEY，保证不丢、且稳定排在所有真实班次之前。
 *  - 同一台站同一班次只保留先到的一条有效状态（按旧记录 id 升序），重复记为 skipped。
 *  - 迁移按台站逐项推进，nextStationCode 之后的台站一律未处理；中断后从这里继续，
 *    已迁移台站不会重复导入（importLegacyStatus 本身也按班次去重，双保险）。
 */

import type { EntryRow } from '@/data/types'

import { LEGACY_SHIFT_KEY, LOOKOUT_RULES } from './status-rules'
import {
  createEmptyLedger,
  importLegacyStatus,
  type LookoutLedger,
} from './lookout-ledger'

export type MigrationItemResult = {
  stationCode: string
  id: number
  shiftKey: string
  status: string
  accepted: boolean
  reason?: string
}

export type LookoutMigrationState = {
  /** 每个台站是否处理过（按台站编号，逐条台站推进） */
  processedStationCodes: string[]
  /** 下一个待处理的台站编号；为空表示已全部处理完 */
  nextStationCode: string | null
  finished: boolean
  items: MigrationItemResult[]
  stats: {
    total: number
    accepted: number
    skippedDuplicate: number
    skippedInvalid: number
  }
}

/** 旧记录故障时间缺失时取原值守日期；都没有则落到未登记兼容班次。 */
export function legacyShiftKeyOf(row: EntryRow): string {
  const candidates = ['故障时间', '值守日期', '最近值守日期']
  for (const field of candidates) {
    const value = String(row[field] ?? '').trim()
    if (value) {
      // 兼容 "YYYY-MM-DD HH:mm" 或纯日期两种写法，只取日期段
      const datePart = value.slice(0, 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        return `${datePart}/白班`
      }
      return LEGACY_SHIFT_KEY
    }
  }
  return LEGACY_SHIFT_KEY
}

function legacyAtOf(row: EntryRow, shiftKey: string): number {
  if (shiftKey === LEGACY_SHIFT_KEY) {
    return 0
  }
  const parsed = Date.parse(`${shiftKey.slice(0, 10)}T00:00:00`)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function createMigrationState(rows: EntryRow[]): LookoutMigrationState {
  return {
    processedStationCodes: [],
    nextStationCode: rows.length > 0 ? stationCodeOf(rows[0]) : null,
    finished: rows.length === 0,
    items: [],
    stats: { total: rows.length, accepted: 0, skippedDuplicate: 0, skippedInvalid: 0 },
  }
}

export function stationCodeOf(row: EntryRow): string {
  return String(row['瞭望台编号'] ?? row.id)
}

/** 取出一个待迁移台站的全部旧记录（按 id 升序，确保先到结果稳定）。 */
export function nextStationBatch(
  rows: EntryRow[],
  nextStationCode: string | null,
): { stationCode: string; batch: EntryRow[] } | null {
  if (nextStationCode === null) {
    return null
  }
  const batch = rows
    .filter((row) => stationCodeOf(row) === nextStationCode)
    .sort((a, b) => Number(a.id) - Number(b.id))
  if (batch.length === 0) {
    return null
  }
  return { stationCode: nextStationCode, batch }
}

/**
 * 迁移一个台站：返回新台账与迁移状态。纯函数，runner 拿到结果整体落盘，
 * 中途任何一条记录都不单独写库——失败就整个台站保持未迁移，下次重试。
 * allStationCodes 为全部台站编号（按首次出现顺序），用于把游标推进到下一个台站。
 */
export function migrateStation(
  ledger: LookoutLedger,
  state: LookoutMigrationState,
  stationCode: string,
  batch: EntryRow[],
  allStationCodes: string[],
): { ledger: LookoutLedger; state: LookoutMigrationState } {
  let working = ledger
  const items: MigrationItemResult[] = []
  let accepted = 0
  let skippedDuplicate = 0
  let skippedInvalid = 0

  for (const row of batch) {
    const status = String(row.status ?? '')
    const shiftKey = legacyShiftKeyOf(row)
    if (!LOOKOUT_RULES.statuses.includes(status)) {
      skippedInvalid += 1
      items.push({
        stationCode,
        id: Number(row.id),
        shiftKey,
        status,
        accepted: false,
        reason: `旧状态「${status}」不在规则内，已跳过`,
      })
      continue
    }
    const result = importLegacyStatus({
      ledger: working,
      stationCode,
      shiftKey,
      status,
      at: legacyAtOf(row, shiftKey),
      note: '存量台账迁移',
    })
    if (!result.ok) {
      skippedInvalid += 1
      items.push({
        stationCode,
        id: Number(row.id),
        shiftKey,
        status,
        accepted: false,
        reason: result.message,
      })
      continue
    }
    working = result.ledger
    if (result.accepted) {
      accepted += 1
      items.push({ stationCode, id: Number(row.id), shiftKey, status, accepted: true })
    } else {
      skippedDuplicate += 1
      // 两种情况都计入重复：同批次旧记录撞班次，或该班次已被真实动作先到占用
      items.push({
        stationCode,
        id: Number(row.id),
        shiftKey,
        status,
        accepted: false,
        reason: '同一班次已有先到有效状态（存量重复或已被动作占用），并发恢复结果丢弃',
      })
    }
  }

  const processed = [...state.processedStationCodes, stationCode]
  const currentIndex = allStationCodes.indexOf(stationCode)
  const nextCode =
    currentIndex >= 0 && currentIndex + 1 < allStationCodes.length
      ? allStationCodes[currentIndex + 1]
      : null

  return {
    ledger: working,
    state: {
      processedStationCodes: processed,
      nextStationCode: nextCode,
      finished: nextCode === null,
      items: [...state.items, ...items],
      stats: {
        total: state.stats.total,
        accepted: state.stats.accepted + accepted,
        skippedDuplicate: state.stats.skippedDuplicate + skippedDuplicate,
        skippedInvalid: state.stats.skippedInvalid + skippedInvalid,
      },
    },
  }
}

/** 一次性跑完整批迁移（测试与 reset 场景用）。 */
export function migrateAll(rows: EntryRow[]): {
  ledger: LookoutLedger
  state: LookoutMigrationState
} {
  const stationCodes = uniqueStationCodes(rows)
  let ledger = createEmptyLedger()
  let state = createMigrationState(rows)
  for (const stationCode of stationCodes) {
    const batch = rows
      .filter((row) => stationCodeOf(row) === stationCode)
      .sort((a, b) => Number(a.id) - Number(b.id))
    const result = migrateStation(ledger, state, stationCode, batch, stationCodes)
    ledger = result.ledger
    state = result.state
  }
  return { ledger, state }
}

export function uniqueStationCodes(rows: EntryRow[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const row of [...rows].sort((a, b) => Number(a.id) - Number(b.id))) {
    const code = stationCodeOf(row)
    if (!seen.has(code)) {
      seen.add(code)
      ordered.push(code)
    }
  }
  return ordered
}
