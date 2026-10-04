/**
 * 瞭望台运行台账（纯领域模型，不碰 localStorage，迁移/服务/页面共用）
 *
 * 台账按「台站 → 班次 → 事件」组织：
 *  - 事件只能追加，不能改、不能删，历史状态因此不会回退；
 *  - 同一台站同一班次以先到事件为有效状态，后来的并发恢复结果一律冲突丢弃；
 *  - 台站当前状态取最新班次的有效状态，关闭台站的最新班次为「临时关闭」。
 */

import {
  LEGACY_SHIFT_KEY,
  LOOKOUT_RULES,
  allowedActions,
  evaluateTransition,
  isAbnormal,
  isSettled,
  isTerminal,
} from './status-rules'

export type EventSource = 'legacy' | 'action'

export type ShiftEvent = {
  /** 班次键 YYYY-MM-DD/白班|夜班；旧记录缺时间时为 LEGACY_SHIFT_KEY */
  shiftKey: string
  status: string
  /** 班次内时间戳，越大越新；旧台账按原值守日期兼容，无具体时刻时为 0 */
  at: number
  source: EventSource
  note?: string
}

export type StationLedger = {
  /** 台站业务编号（瞭望台编号），迁移后同一编号只有一条台账 */
  stationCode: string
  events: ShiftEvent[]
}

export type LookoutLedger = {
  version: number
  stations: Record<string, StationLedger>
}

export function createEmptyLedger(): LookoutLedger {
  return { version: 0, stations: {} }
}

function stationKey(stationCode: string): string {
  return stationCode
}

function sortEvents(events: ShiftEvent[]): ShiftEvent[] {
  return [...events].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    return a.shiftKey.localeCompare(b.shiftKey)
  })
}

/**
 * 提交一次状态结果（并发恢复只接受先到结果）。
 * 同一台站同一班次已有事件（即已有有效状态）时返回冲突，绝不覆盖。
 * baseVersion 与台账当前 version 不一致也返回冲突（跨标签页/并发恢复的乐观锁）。
 */
export type CommitResult =
  | { ok: true; ledger: LookoutLedger; event: ShiftEvent }
  | { ok: false; code: 'stale' | 'duplicate_shift' | 'invalid'; message: string }

export function commitStatus(params: {
  ledger: LookoutLedger
  baseVersion: number
  stationCode: string
  shiftKey: string
  action: string
  now: number
  note?: string
}): CommitResult {
  const { ledger, baseVersion, stationCode, shiftKey, action, now, note } = params
  if (baseVersion !== ledger.version) {
    return {
      ok: false,
      code: 'stale',
      message: '台账已被其他操作更新，本次结果已被先到结果覆盖，请刷新后重试',
    }
  }

  const station = ledger.stations[stationKey(stationCode)]
  const current = statusForShift(station, shiftKey)
  const verdict = evaluateTransition(LOOKOUT_RULES, current.status, action)
  if (!verdict.ok) {
    return { ok: false, code: 'invalid', message: verdict.message }
  }

  // 同一班次只能有一个有效状态：该班次已收到任何结果，后来的并发恢复结果一律丢弃
  if (station && station.events.some((event) => event.shiftKey === shiftKey)) {
    return {
      ok: false,
      code: 'duplicate_shift',
      message: '该班次已有先到的有效状态，同一班次只能记录一次结果',
    }
  }

  const event: ShiftEvent = { shiftKey, status: verdict.target, at: now, source: 'action', note }
  const nextStations = { ...ledger.stations }
  const existing = nextStations[stationKey(stationCode)]
  nextStations[stationKey(stationCode)] = existing
    ? { ...existing, events: [...existing.events, event] }
    : { stationCode, events: [event] }

  return {
    ok: true,
    ledger: { version: ledger.version + 1, stations: nextStations },
    event,
  }
}

/**
 * 迁移专用：把旧台账折算成一个有效事件写入。
 * 与动作提交一样遵循「同班次唯一」，重复（同班次再来一条）按先到结果丢弃，由迁移器计数。
 */
export type ImportResult =
  | { ok: true; ledger: LookoutLedger; accepted: boolean }
  | { ok: false; message: string }

export function importLegacyStatus(params: {
  ledger: LookoutLedger
  stationCode: string
  shiftKey: string
  status: string
  at: number
  note?: string
}): ImportResult {
  const { ledger, stationCode, shiftKey, status, at, note } = params
  if (!LOOKOUT_RULES.statuses.includes(status)) {
    return { ok: false, message: `旧状态「${status}」不在运行状态规则内` }
  }
  const existing = ledger.stations[stationKey(stationCode)]
  if (existing && existing.events.some((event) => event.shiftKey === shiftKey)) {
    // 同一班次已有先到结果：后来的并发恢复结果直接丢弃，保持唯一有效状态
    return { ok: true, ledger, accepted: false }
  }
  const event: ShiftEvent = { shiftKey, status, at, source: 'legacy', note }
  const nextStations = { ...ledger.stations }
  nextStations[stationKey(stationCode)] = existing
    ? { ...existing, events: [...existing.events, event] }
    : { stationCode, events: [event] }
  return {
    ok: true,
    ledger: { version: ledger.version + 1, stations: nextStations },
    accepted: true,
  }
}

export type StationCurrentState = {
  status: string
  shiftKey: string
  terminal: boolean
  settled: boolean
  abnormal: boolean
  allowedActions: string[]
}

/**
 * 某个班次上的起点状态：该班次已有事件就用它（唯一有效状态）；
 * 该班次还没事件（开新班次）时沿用上一班次的有效状态；
 * 完全没有台账的台站按正常值守起步。
 */
export function statusForShift(
  station: StationLedger | undefined,
  shift: string,
): { status: string; shiftKey: string } {
  if (!station || station.events.length === 0) {
    return { status: '正常值守', shiftKey: LEGACY_SHIFT_KEY }
  }
  const sorted = sortEvents(station.events)
  const inShift = sorted.filter((event) => event.shiftKey === shift)
  if (inShift.length > 0) {
    // 同班次先到结果即唯一有效状态（写入层也保证不会有第二条）
    return { status: inShift[0].status, shiftKey: inShift[0].shiftKey }
  }
  const latest = sorted[sorted.length - 1]
  return { status: latest.status, shiftKey: latest.shiftKey }
}

/** 台站当前状态：取最新班次先到事件的有效状态；没有台账时按正常值守起步。 */
export function stationCurrentStatus(
  station: StationLedger | undefined,
  currentShift?: string,
): { status: string; shiftKey: string } {
  return statusForShift(station, currentShift ?? '')
}

export function describeStation(
  station: StationLedger | undefined,
  currentShift: string,
): StationCurrentState {
  const { status, shiftKey } = stationCurrentStatus(station, currentShift)
  return {
    status,
    shiftKey,
    terminal: isTerminal(LOOKOUT_RULES, status),
    settled: isSettled(LOOKOUT_RULES, status),
    abnormal: isAbnormal(LOOKOUT_RULES, status),
    allowedActions: allowedActions(LOOKOUT_RULES, status),
  }
}

/** 台站历史时间线（详情抽屉用）：旧记录按原值守日期排在前，新动作按时间追加在后。 */
export function stationTimeline(station: StationLedger | undefined): ShiftEvent[] {
  return station ? sortEvents(station.events) : []
}

export function getStation(ledger: LookoutLedger, stationCode: string): StationLedger | undefined {
  return ledger.stations[stationKey(stationCode)]
}
