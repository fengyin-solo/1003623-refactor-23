import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import {
  commitEvents,
  getLedger,
  type CommitResult,
} from './lookout-store'
import {
  ACTION_TARGET,
  currentOfLookout,
  decideTransition,
  LOOKOUT_ACTIONS,
  LOOKOUT_STATUS,
  type CurrentStatus,
  type LookoutAction,
  type LookoutEvent,
  type LookoutStatusCode,
} from './lookout-status'
import { formatDate } from './time'

export type ActionOutcome = {
  ok: boolean
  message: string
  current?: CurrentStatus
}

// 台账需要先迁移才能登记实时事件；页面据此引导先跑迁移。
export function ledgerReady(): boolean {
  return getLedger().events.length > 0
}

export function stationIds(): number[] {
  return listRows('lookout').map((row) => Number(row.id))
}

export function stationMap(): Map<number, EntryRow> {
  return new Map(listRows('lookout').map((row) => [Number(row.id), row]))
}

export function allEvents(): LookoutEvent[] {
  return getLedger().events
}

export function currentFor(lookoutId: number): CurrentStatus | null {
  return currentOfLookout(getLedger().events, lookoutId)
}

export type StationStatus = {
  lookoutId: number
  current: CurrentStatus | null
}

export function allCurrentStatuses(): StationStatus[] {
  const events = getLedger().events
  return stationIds().map((lookoutId) => ({ lookoutId, current: currentOfLookout(events, lookoutId) }))
}

/**
 * 记录一次实时运行动作。
 * 走统一状态机校验；落库用 CAS，并发时只接受先到结果，后到者重读后报冲突，不覆盖。
 */
export function recordAction(
  lookoutId: number,
  action: LookoutAction,
  options: { shiftDate?: string; now?: Date } = {},
): ActionOutcome {
  const now = options.now ?? new Date()
  const shiftDate = options.shiftDate ?? formatDate(now)
  const target = ACTION_TARGET[action]
  if (!target) {
    return { ok: false, message: `没有登记「${action}」这个瞭望台动作` }
  }

  // CAS 只读一次库：基于读取时刻的版本做比较，先到者成功，后到者 stale。
  const ledger = getLedger()
  const shiftEvents = ledger.events.filter(
    (event) => event.lookoutId === lookoutId && event.shiftDate === shiftDate,
  )
  const current = currentOfLookout(shiftEvents, lookoutId)
  const decision = decideTransition(action, current)
  if (!decision.ok) {
    return { ok: false, message: decision.message }
  }

  const event: LookoutEvent = {
    lookoutId,
    shiftDate,
    status: decision.target,
    action,
    occurredAt: now.toISOString(),
    source: 'live',
  }
  const result = commitEvents(ledger.version, [event])
  if (result.ok) {
    return { ok: true, message: `已${action}，当前状态「${decision.target}」`, current: currentFor(lookoutId) ?? undefined }
  }
  return handleConflict(result, lookoutId, action)
}

function handleConflict(result: Extract<CommitResult, { ok: false }>, lookoutId: number, action: LookoutAction): ActionOutcome {
  if (result.reason === 'stale') {
    const winner = currentFor(lookoutId)
    const who = winner ? `「${winner.status}」` : '更新的状态'
    return {
      ok: false,
      message: `状态已被其他操作先更新为${who}，「${action}」未生效，请刷新后重试`,
      current: winner ?? undefined,
    }
  }
  return { ok: false, message: `「${action}」未产生任何变更` }
}

export function eventsOf(lookoutId: number): LookoutEvent[] {
  return getLedger()
    .events.filter((event) => event.lookoutId === lookoutId)
    .sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt))
}

export const LOOKOUT_STATUS_LABELS = LOOKOUT_STATUS
export { LOOKOUT_ACTIONS, LOOKOUT_STATUS }
export type { LookoutStatusCode }
