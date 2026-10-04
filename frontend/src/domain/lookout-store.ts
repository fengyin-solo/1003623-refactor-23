import type { LookoutLedgerRecord, LookoutEvent } from './lookout-status'

// 运行状态台账独立存放，不和旧的通用台账（forest-fire-patrol:entries）互相覆盖。
const LEDGER_STORAGE_KEY = 'forest-fire-patrol:lookout-ledger'
const MIGRATION_STORAGE_KEY = 'forest-fire-patrol:lookout-migration'

const EMPTY_LEDGER: LookoutLedgerRecord = { version: 0, events: [] }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readLedger(): LookoutLedgerRecord {
  if (!hasStorage()) {
    return clone(EMPTY_LEDGER)
  }
  const raw = window.localStorage.getItem(LEDGER_STORAGE_KEY)
  if (!raw) {
    return clone(EMPTY_LEDGER)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LookoutLedgerRecord>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 0,
      events: Array.isArray(parsed.events) ? (parsed.events as LookoutEvent[]) : [],
    }
  } catch {
    return clone(EMPTY_LEDGER)
  }
}

let cache: LookoutLedgerRecord | null = null

export function getLedger(): LookoutLedgerRecord {
  if (cache === null) {
    cache = readLedger()
  }
  // 永远返回副本，调用方在副本上组织新事件，最后统一 commit，避免旁路改写。
  return clone(cache)
}

export type CommitResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'stale' | 'empty' }

/**
 * 以 CAS 方式提交事件。
 * 并发恢复/多个标签页同时操作时，只有 baseVersion 与库内一致的先到结果被接受，
 * 其余提交拿到 stale，需要重新读取后重试或放弃。
 */
export function commitEvents(
  baseVersion: number,
  newEvents: LookoutEvent[],
): CommitResult {
  if (newEvents.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  const current = readLedger()
  if (current.version !== baseVersion) {
    cache = current
    return { ok: false, reason: 'stale' }
  }
  const next: LookoutLedgerRecord = {
    version: current.version + 1,
    events: [...current.events, ...newEvents],
  }
  persist(next)
  return { ok: true, version: next.version }
}

/** 仅迁移/重置场景使用：直接覆盖整份台账（仍推进版本号，让旧 CAS 全部失效）。 */
export function replaceLedger(ledger: LookoutLedgerRecord): number {
  const next: LookoutLedgerRecord = {
    version: readLedger().version + 1,
    events: clone(ledger.events),
  }
  persist(next)
  return next.version
}

function persist(ledger: LookoutLedgerRecord) {
  cache = clone(ledger)
  if (hasStorage()) {
    window.localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger))
  }
}

// ---- 迁移进度（断点续迁靠它） ----

export type MigrationState = {
  /** 已迁移完成的台站 id（按稳定顺序逐个提交，已完成的重启后直接跳过）。 */
  migratedIds: number[]
  /** 本次/上次迁移扫到的总台站数，用于展示进度。 */
  total: number
  finishedAt: string | null
}

const EMPTY_MIGRATION: MigrationState = { migratedIds: [], total: 0, finishedAt: null }

export function getMigrationState(): MigrationState {
  if (!hasStorage()) {
    return clone(EMPTY_MIGRATION)
  }
  const raw = window.localStorage.getItem(MIGRATION_STORAGE_KEY)
  if (!raw) {
    return clone(EMPTY_MIGRATION)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MigrationState>
    return {
      migratedIds: Array.isArray(parsed.migratedIds) ? parsed.migratedIds.map(Number) : [],
      total: typeof parsed.total === 'number' ? parsed.total : 0,
      finishedAt: parsed.finishedAt ?? null,
    }
  } catch {
    return clone(EMPTY_MIGRATION)
  }
}

export function saveMigrationState(state: MigrationState): void {
  if (hasStorage()) {
    window.localStorage.setItem(MIGRATION_STORAGE_KEY, JSON.stringify(state))
  }
}

export function ledgerStorageKey(): string {
  return LEDGER_STORAGE_KEY
}
