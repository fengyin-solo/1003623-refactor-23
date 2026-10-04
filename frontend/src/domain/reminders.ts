/**
 * 值守 / 故障 / 气象提醒（共用写法）
 *
 * 列表、详情、提醒入口（运营概览）都调用同一份判断：
 *  - 已关闭（终态）的瞭望台永远不再生成值守提醒——修复「关闭后仍催值守」；
 *  - 故障 / 维修中台站催故障处置，且会带出原值守日期（旧记录没有故障时间时兼容）；
 *  - 气象异常值与待审核提醒在这里统一产出，气象页面与概览页天然同步。
 */

import type { EntryRow } from '@/data/types'

import { STATUS_RULES_BY_MODULE, currentShiftKey, isSettled } from './status-rules'
import { getStation, stationCurrentStatus, type LookoutLedger } from './lookout-ledger'

export type ReminderLevel = 'info' | 'warn' | 'danger'

export type Reminder = {
  key: string
  module: string
  level: ReminderLevel
  title: string
  detail: string
  refId?: number
}

/* -------------------------------- 瞭望台 ---------------------------------- */

function stationDateText(row: EntryRow): string {
  const raw = String(row['值守日期'] ?? row['故障时间'] ?? '').trim()
  if (!raw) {
    return '原值守日期未登记'
  }
  return raw.slice(0, 10)
}

export function buildLookoutReminders(
  rows: EntryRow[],
  ledger: LookoutLedger | null,
  shiftKey: string = currentShiftKey(),
): Reminder[] {
  const reminders: Reminder[] = []
  for (const row of rows) {
    const stationCode = String(row['瞭望台编号'] ?? row.id)
    const station = ledger ? getStation(ledger, stationCode) : undefined
    const effectiveStatus = station
      ? stationCurrentStatus(station, shiftKey).status
      : String(row.status ?? '')
    const base = {
      key: `lookout:${row.id}`,
      module: 'lookout',
      refId: Number(row.id),
    }

    if (effectiveStatus === '临时关闭') {
      // 终态：关闭后不再生成任何值守提醒
      continue
    }
    if (effectiveStatus === '设备故障') {
      reminders.push({
        ...base,
        level: 'danger',
        title: `瞭望台 ${stationCode} 设备故障待维修`,
        detail: `原值守日期 ${stationDateText(row)}（旧记录无故障时间时按值守日期兼容），请尽快安排维修`,
      })
      continue
    }
    if (effectiveStatus === '维修中') {
      reminders.push({
        ...base,
        level: 'warn',
        title: `瞭望台 ${stationCode} 维修中待恢复`,
        detail: `原值守日期 ${stationDateText(row)}，维修完成后请记录值守恢复`,
      })
      continue
    }
    if (effectiveStatus === '正常值守') {
      // 正常态：当前班次没有新的值守事件时提醒一次（旧台账迁在历史班次，不等于本班已值守）
      const hasCurrentShift = station?.events.some(
        (event) => event.shiftKey === shiftKey && event.status === '正常值守',
      )
      if (!hasCurrentShift) {
        reminders.push({
          ...base,
          level: 'info',
          title: `瞭望台 ${stationCode} 待记录本班次值守`,
          detail: `当前班次 ${shiftKey} 尚未收到值守记录`,
        })
      }
    }
  }
  return reminders
}

/* --------------------------------- 气象 ---------------------------------- */

export function buildWeatherReminders(rows: EntryRow[]): Reminder[] {
  const rules = STATUS_RULES_BY_MODULE.weather
  const reminders: Reminder[] = []
  for (const row of rows) {
    const status = String(row.status ?? '')
    const recordCode = String(row['记录编号'] ?? row.id)
    const base = {
      key: `weather:${row.id}`,
      module: 'weather',
      refId: Number(row.id),
    }
    if (status === '异常值') {
      reminders.push({
        ...base,
        level: 'danger',
        title: `气象记录 ${recordCode} 标记为异常值`,
        detail: `观测站点 ${String(row['观测站点'] ?? '—')}，请尽快修正数据`,
      })
    } else if (!isSettled(rules, status)) {
      reminders.push({
        ...base,
        level: 'warn',
        title: `气象记录 ${recordCode} 待审核`,
        detail: `观测时间 ${String(row['观测时间'] ?? '—')}，当前状态「${status}」`,
      })
    }
  }
  return reminders
}

/* ----------------------------- 通用（其他模块） ----------------------------- */

/**
 * 其余页面的气象/业务提醒统一走这里：有共用规则集的模块按规则判断
 * 待处理（未 settled）与异常（abnormalStatuses）；没有规则集的模块保持
 * 原来的 pending/abnormal 标记口径，不改行为。
 */
export function buildGenericReminders(module: string, rows: EntryRow[]): Reminder[] {
  const rules = STATUS_RULES_BY_MODULE[module]
  if (!rules) {
    return rows
      .filter((row) => row.abnormal)
      .map((row) => ({
        key: `${module}:${row.id}`,
        module,
        level: 'danger' as const,
        refId: Number(row.id),
        title: `记录 ${row.id} 被标记为异常`,
        detail: `当前状态「${String(row.status ?? '')}」，请关注`,
      }))
  }
  const reminders: Reminder[] = []
  for (const row of rows) {
    const status = String(row.status ?? '')
    if (rules.abnormalStatuses.includes(status)) {
      reminders.push({
        key: `${module}:${row.id}`,
        module,
        level: 'danger',
        refId: Number(row.id),
        title: `记录 ${row.id} 状态异常`,
        detail: `当前状态「${status}」，请尽快处置`,
      })
    } else if (!isSettled(rules, status)) {
      reminders.push({
        key: `${module}:${row.id}`,
        module,
        level: 'info',
        refId: Number(row.id),
        title: `记录 ${row.id} 待处理`,
        detail: `当前状态「${status}」，等待下一环节`,
      })
    }
  }
  return reminders
}

export function reminderLevelLabel(level: ReminderLevel): string {
  return level === 'danger' ? '紧急' : level === 'warn' ? '提醒' : '知会'
}
