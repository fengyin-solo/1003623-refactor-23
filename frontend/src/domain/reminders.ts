// 提醒规则共用写法：瞭望台列表、详情、概览以及气象页面都从这里取提醒，
// 规则只维护一份，修掉「关闭后仍生成值守提醒」这类各处判断不一致的问题。

import { listRows } from '@/data/local-store'

import { getLedger } from './lookout-store'
import { dutyReminders, type DutyReminder } from './lookout-status'
import { hoursSince, parseDate } from './time'

export type ReminderLevel = 'info' | 'warn'

export type Reminder = {
  key: string
  module: 'lookout' | 'weather'
  level: ReminderLevel
  title: string
  detail: string
}

// 气象提醒阈值：待审核超过该小时数提醒催审；异常值记录提醒复核。
export const WEATHER_REVIEW_OVERDUE_HOURS = 24

// 值守提醒阈值，与状态规则保持一致并在此透出给页面。
export { DUTY_OVERDUE_HOURS } from './lookout-status'

export function buildLookoutReminders(now: Date = new Date()): Reminder[] {
  const ledger = getLedger()
  const rows = listRows('lookout')
  const nameOf = new Map(rows.map((row) => [Number(row.id), String(row['瞭望台编号'] ?? `#${row.id}`)]))
  const overdue: DutyReminder[] = dutyReminders(
    ledger.events,
    rows.map((row) => Number(row.id)),
    now,
  )
  return overdue.map((item) => ({
    key: `lookout-duty-${item.lookoutId}-${item.shiftDate}`,
    module: 'lookout' as const,
    level: 'warn' as const,
    title: `${nameOf.get(item.lookoutId) ?? `瞭望台${item.lookoutId}`} 值守超期`,
    detail: `${item.shiftDate} 班次自 ${item.occurredAt.slice(0, 16).replace('T', ' ')} 起已连续值守 ${item.overdueHours} 小时，请确认或轮换`,
  }))
}

export function buildWeatherReminders(now: Date = new Date()): Reminder[] {
  const reminders: Reminder[] = []
  for (const row of listRows('weather')) {
    const code = String(row['记录编号'] ?? row.id)
    const status = String(row.status)
    if (status === '异常值') {
      reminders.push({
        key: `weather-abnormal-${row.id}`,
        module: 'weather',
        level: 'warn',
        title: `${code} 气象数据异常`,
        detail: `站点 ${String(row['观测站点'] ?? '—')} 的观测记录被标记异常，请尽快复核订正`,
      })
      continue
    }
    if (status === '已录入') {
      const observedAt = parseDate(row['观测时间'])
      const ageHours = observedAt ? hoursSince(observedAt, now) : 0
      if (ageHours >= WEATHER_REVIEW_OVERDUE_HOURS) {
        reminders.push({
          key: `weather-review-${row.id}`,
          module: 'weather',
          level: 'info',
          title: `${code} 气象记录待审核`,
          detail: `站点 ${String(row['观测站点'] ?? '—')} 的观测记录已等待审核 ${ageHours} 小时`,
        })
      }
    }
  }
  return reminders
}

// 概览与全局入口取这份汇总。
export function buildAllReminders(now: Date = new Date()): Reminder[] {
  return [...buildLookoutReminders(now), ...buildWeatherReminders(now)]
}

// 给统计卡片用的分模块计数（关闭台不计入值守提醒，由底层规则保证）。
export function reminderCounts(now: Date = new Date()): Record<Reminder['module'], number> {
  const counts = { lookout: 0, weather: 0 }
  for (const reminder of buildAllReminders(now)) {
    counts[reminder.module] += 1
  }
  return counts
}
