/**
 * 瞭望台运行台账的本地持久化与可续跑迁移
 *
 * localStorage 布局（与 entries 分开，避免污染旧数据层）：
 *  - forest-fire-patrol:lookout-ledger        台账 + version（乐观锁）
 *  - forest-fire-patrol:lookout-migration     迁移进度（已处理台站 / 下一台站 / 统计）
 *  - forest-fire-patrol:lookout-migration-lock 迁移锁（owner + 过期时间，中断后可接管）
 */

import { listRows, saveRows } from '@/data/local-store'
import {
  commitStatus,
  createEmptyLedger,
  describeStation,
  getStation,
  stationTimeline,
  type CommitResult,
  type LookoutLedger,
  type ShiftEvent,
  type StationLedger,
} from './lookout-ledger'
import {
  createMigrationState,
  migrateStation,
  nextStationBatch,
  stationCodeOf,
  uniqueStationCodes,
  type LookoutMigrationState,
} from './lookout-migration'
import { LOOKOUT_RULES, currentShiftKey } from './status-rules'
const LEDGER_KEY = 'forest-fire-patrol:lookout-ledger'
const MIGRATION_KEY = 'forest-fire-patrol:lookout-migration'
const LOCK_KEY = 'forest-fire-patrol:lookout-migration-lock'
const LOCK_TTL_MS = 10_000

export type {
  LookoutLedger,
  StationLedger,
  ShiftEvent,
  LookoutMigrationState,
}

/* --------------------------------- 基础读写 -------------------------------- */

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

export function readLedger(): LookoutLedger | null {
  const store = storage()
  if (!store) {
    return null
  }
  const raw = store.getItem(LEDGER_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as LookoutLedger
  } catch {
    return null
  }
}

/**
 * 整体替换台账：只接受 version 与现库一致的写入，后到结果（并发恢复）直接失败。
 * quiet=true 时只落盘不发订阅事件，由调用方在一批写入结束后统一 notify。
 */
export function replaceLedger(
  expectedVersion: number,
  ledger: LookoutLedger,
  quiet = false,
): boolean {
  const store = storage()
  if (!store) {
    return false
  }
  const current = readLedger()
  if (current && current.version !== expectedVersion) {
    return false
  }
  store.setItem(LEDGER_KEY, JSON.stringify(ledger))
  if (!quiet) {
    notify()
  }
  return true
}

export function readMigrationState(): LookoutMigrationState | null {
  const store = storage()
  if (!store) {
    return null
  }
  const raw = store.getItem(MIGRATION_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as LookoutMigrationState
  } catch {
    return null
  }
}

function writeMigrationState(state: LookoutMigrationState, quiet = false): void {
  const store = storage()
  if (store) {
    store.setItem(MIGRATION_KEY, JSON.stringify(state))
    if (!quiet) {
      notify()
    }
  }
}

/* ------------------------------- 变更订阅（UI） ------------------------------ */

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribeLookoutStore(listener: Listener): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === LEDGER_KEY ||
      event.key === MIGRATION_KEY ||
      event.key === LOCK_KEY
    ) {
      listener()
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
  }
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
    }
  }
}

function notify(): void {
  listeners.forEach((listener) => listener())
}

/* --------------------------------- 迁移锁 --------------------------------- */

export function acquireLock(owner: string, now: number = Date.now()): boolean {
  const store = storage()
  if (!store) {
    return true
  }
  const raw = store.getItem(LOCK_KEY)
  if (raw) {
    try {
      const lock = JSON.parse(raw) as { owner: string; expiresAt: number }
      // 自己已持锁（续跑）或锁已过期（上次中断）才允许进入
      if (lock.owner !== owner && lock.expiresAt > now) {
        return false
      }
    } catch {
      // 锁数据损坏视为过期锁，接管继续
    }
  }
  store.setItem(LOCK_KEY, JSON.stringify({ owner, expiresAt: now + LOCK_TTL_MS }))
  return true
}

export function renewLock(owner: string, now: number = Date.now()): boolean {
  const store = storage()
  if (!store) {
    return true
  }
  const raw = store.getItem(LOCK_KEY)
  if (raw) {
    try {
      const lock = JSON.parse(raw) as { owner: string; expiresAt: number }
      if (lock.owner !== owner && lock.expiresAt > now) {
        return false
      }
    } catch {
      return false
    }
  }
  store.setItem(LOCK_KEY, JSON.stringify({ owner, expiresAt: now + LOCK_TTL_MS }))
  return true
}

export function releaseLock(owner: string): void {
  const store = storage()
  if (!store) {
    return
  }
  const raw = store.getItem(LOCK_KEY)
  if (!raw) {
    return
  }
  try {
    const lock = JSON.parse(raw) as { owner: string }
    if (lock.owner === owner) {
      store.removeItem(LOCK_KEY)
      notify()
    }
  } catch {
    // 忽略损坏锁
  }
}

/* -------------------------------- 可续跑迁移 -------------------------------- */

export type StepResult =
  | { status: 'idle' }
  | { status: 'locked'; state: LookoutMigrationState }
  | { status: 'progress'; state: LookoutMigrationState }
  | { status: 'finished'; state: LookoutMigrationState }

// 本标签页内只允许一个后台迁移节拍（main.ts 与页面手动续跑共用），
// 跨标签页的互斥由 localStorage 迁移锁负责。
let activeRunnerOwner: string | null = null
/** 本标签页后台迁移的固定身份，页面“立即继续”复用它，避免互抢迁移锁。 */
export const BACKGROUND_RUNNER_OWNER = 'main-background-runner'

/**
 * 迁移一个台站并落盘。
 * 中断保护：只有一个台站整体迁移成功后才更新 nextStationCode，中途异常不会推进游标。
 */
export function migrationStep(owner: string, now: number = Date.now()): StepResult {
  if (!acquireLock(owner, now)) {
    const lockedState = readMigrationState()
    return lockedState ? { status: 'locked', state: lockedState } : { status: 'idle' }
  }
  const rows = listRows('lookout')
  const stationCodes = uniqueStationCodes(rows)
  let state = readMigrationState()
  if (!state) {
    state = createMigrationState(rows)
  }
  if (state.finished || state.nextStationCode === null) {
    releaseLock(owner)
    return { status: 'finished', state }
  }

  const batchInfo = nextStationBatch(rows, state.nextStationCode)
  if (!batchInfo) {
    releaseLock(owner)
    return { status: 'finished', state }
  }

  const ledger = readLedger() ?? createEmptyLedger()
  const result = migrateStation(ledger, state, batchInfo.stationCode, batchInfo.batch, stationCodes)
  // 乐观锁：迁移期间别的恢复会话写了台账就放弃本轮，下个节拍重试
  if (!replaceLedger(ledger.version, result.ledger, true)) {
    return { status: 'locked', state }
  }
  writeMigrationState(result.state, true)
  reconcileLegacyRows(result.ledger)
  // 台账、迁移游标、旧列表三处落盘后只发一次订阅事件，避免页面一轮多刷
  notify()

  if (result.state.finished) {
    releaseLock(owner)
    return { status: 'finished', state: result.state }
  }
  return { status: 'progress', state: result.state }
}

export function ensureMigrationStarted(): LookoutMigrationState | null {
  const rows = listRows('lookout')
  const existing = readMigrationState()
  if (existing) {
    return existing
  }
  const initial = createMigrationState(rows)
  writeMigrationState(initial)
  return initial
}

export function isMigrationFinished(): boolean {
  return readMigrationState()?.finished ?? false
}

/**
 * 后台迁移驱动：按节拍每次推进一个台站，锁过期后另一会话可接管，
 * 从迁移状态里的 nextStationCode 继续，未迁移台站不会被跳过。
 */
export function runMigrationInBackground(options?: {
  intervalMs?: number
  owner?: string
  onTick?: (state: LookoutMigrationState) => void
}): { stop: () => void; promise: Promise<LookoutMigrationState> } {
  const intervalMs = options?.intervalMs ?? 40
  // 同标签页已有迁移器时复用其 owner，避免两个节拍互抢锁
  const owner = options?.owner ?? activeRunnerOwner ?? BACKGROUND_RUNNER_OWNER
  activeRunnerOwner = owner
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const promise = new Promise<LookoutMigrationState>((resolve) => {
    const tick = () => {
      if (stopped) {
        return
      }
      try {
        // migrationStep 内部负责抢锁：拿不到锁说明另一会话在迁，
        // 等一拍后再尝试（其锁 TTL 过期即可从中断处接管）
        const result = migrationStep(owner)
        if (result.status === 'finished' || result.status === 'progress') {
          options?.onTick?.(result.state)
        }
        if (result.status === 'finished') {
          activeRunnerOwner = null
          resolve(result.state)
          return
        }
      } catch {
        // 单拍失败不致命，下一拍从 nextStationCode 继续
      }
      timer = setTimeout(tick, intervalMs)
    }
    ensureMigrationStarted()
    timer = setTimeout(tick, 0)
  })

  return {
    promise,
    stop: () => {
      stopped = true
      if (timer) {
        clearTimeout(timer)
      }
      releaseLock(owner)
    },
  }
}

/* ------------------------------ 台账动作（页面） ----------------------------- */

/**
 * 瞭望台动作统一入口：乐观锁 + 同班次唯一。
 * 并发恢复只接受先到结果：stale / duplicate_shift 都原样返回，不覆盖。
 */
export function applyLookoutAction(input: {
  stationCode: string
  action: string
  shiftKey?: string
  note?: string
}): CommitResult {
  const ledger = readLedger() ?? createEmptyLedger()
  const result = commitStatus({
    ledger,
    baseVersion: ledger.version,
    stationCode: input.stationCode,
    shiftKey: input.shiftKey ?? currentShiftKey(),
    action: input.action,
    now: Date.now(),
    note: input.note,
  })
  if (!result.ok) {
    return result
  }
  if (!replaceLedger(ledger.version, result.ledger)) {
    return {
      ok: false,
      code: 'stale',
      message: '台账刚被其他会话更新，只接受先到结果，请刷新后重试',
    }
  }
  syncLegacyRow(input.stationCode, result.event.status)
  return result
}

/** 动作生效后同步旧列表里该台站的展示状态，保持导出/概览口径一致。 */
function syncLegacyRow(stationCode: string, status: string): void {
  const rows = listRows('lookout')
  let changed = false
  const next = rows.map((row) => {
    if (stationCodeOf(row) !== stationCode) {
      return row
    }
    changed = true
    return {
      ...row,
      status,
      pending: !LOOKOUT_RULES.settledStatuses.includes(status),
      abnormal: LOOKOUT_RULES.abnormalStatuses.includes(status),
    }
  })
  if (changed) {
    saveRows('lookout', next)
  }
}

/** 迁移一个台站后，把该台站全部旧记录的展示状态对齐到台账有效状态。 */
function reconcileLegacyRows(ledger: LookoutLedger): void {
  const rows = listRows('lookout')
  const next = rows.map((row) => {
    const stationCode = stationCodeOf(row)
    const station = getStation(ledger, stationCode)
    if (!station) {
      return row
    }
    const state = describeStation(station, currentShiftKey())
    if (state.status === String(row.status)) {
      return row
    }
    return {
      ...row,
      status: state.status,
      pending: !state.settled,
      abnormal: state.abnormal,
    }
  })
  saveRows('lookout', next)
}

export function getLookoutStation(stationCode: string): StationLedger | undefined {
  const ledger = readLedger()
  return ledger ? getStation(ledger, stationCode) : undefined
}

export function getLookoutTimeline(stationCode: string): ShiftEvent[] {
  return stationTimeline(getLookoutStation(stationCode))
}

/** 重置瞭望台数据（页面“回到示例数据”场景）：台账与迁移进度一并清空。 */
export function resetLookoutStore(): void {
  const store = storage()
  if (store) {
    store.removeItem(LEDGER_KEY)
    store.removeItem(MIGRATION_KEY)
    store.removeItem(LOCK_KEY)
    notify()
  }
}
