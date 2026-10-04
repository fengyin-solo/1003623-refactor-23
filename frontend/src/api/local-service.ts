import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  STATUS_RULES_BY_MODULE,
  currentShiftKey,
  evaluateTransition,
  isAbnormal as ruleIsAbnormal,
  isSettled as ruleIsSettled,
} from '@/domain/status-rules'
import {
  applyLookoutAction,
  getLookoutStation,
} from '@/domain/lookout-store'
import { describeStation } from '@/domain/lookout-ledger'
import { stationCodeOf as legacyStationCodeOf } from '@/domain/lookout-migration'

// 会写进数据的「往回走」动作：没有共用规则的模块命中时标成异常态（沿用旧口径兜底）。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(decorateRows(key, listRows(key)), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 读侧统一套用共用状态规则：
 *  - 瞭望台的当前状态以运行台账为准（列表、详情、提醒同一口径）；
 *  - 走共用状态机的模块，pending/abnormal 按规则集的 settled/abnormal 计算。
 */
function decorateRows(key: string, rows: EntryRow[]): EntryRow[] {
  const rules = STATUS_RULES_BY_MODULE[key]
  if (key === 'lookout') {
    const shift = currentShiftKey()
    return rows.map((row) => {
      const stationCode = legacyStationCodeOf(row)
      const station = getLookoutStation(stationCode)
      if (!station) {
        return row
      }
      const state = describeStation(station, shift)
      return {
        ...row,
        status: state.status,
        pending: !state.settled,
        abnormal: state.abnormal,
      }
    })
  }
  if (!rules) {
    return rows
  }
  return rows.map((row) => ({
    ...row,
    pending: !ruleIsSettled(rules, String(row.status)),
    abnormal: ruleIsAbnormal(rules, String(row.status)),
  }))
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const rules = STATUS_RULES_BY_MODULE[key]

  if (key === 'lookout') {
    const rows = listRows(key)
    const row = rows.find((item) => Number(item.id) === id)
    if (!row) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const stationCode = legacyStationCodeOf(row)
    // 规则合法性（含终态拒绝、不可回退）全部交给台账写入时的共用规则机判断
    const result = applyLookoutAction({ stationCode, action })
    if (!result.ok) {
      return { ok: false, message: result.message }
    }
    return {
      ok: true,
      message: `${meta.entity}已${action}，当前班次状态「${result.event.status}」`,
    }
  }

  if (rules) {
    return runRuleAction(meta, key, id, action)
  }
  return runLegacyAction(meta, key, id, action)
}

/** 走共用状态机的模块（如气象）：只允许规则内的前向流转，状态不能回退。 */
function runRuleAction(
  meta: ModuleMeta,
  key: string,
  id: number,
  action: string,
): ActionResult {
  const rules = STATUS_RULES_BY_MODULE[key]
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const verdict = evaluateTransition(rules, current, action)
  if (!verdict.ok) {
    return { ok: false, message: `${meta.entity}${verdict.message}` }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: verdict.target,
    pending: !ruleIsSettled(rules, verdict.target),
    abnormal: ruleIsAbnormal(rules, verdict.target),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${verdict.target}」` }
}

/** 未接入共用状态机的模块：保持原有通用流转写法（含终态提示的最小收口）。 */
function runLegacyAction(
  meta: ModuleMeta,
  key: string,
  id: number,
  action: string,
): ActionResult {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of decorateRows(key, listRows(key))) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = decorateRows(meta.key, rows[meta.key] ?? [])
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
