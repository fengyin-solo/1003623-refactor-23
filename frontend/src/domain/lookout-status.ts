// 瞭望台运行状态规则：列表、详情、提醒入口共用这一份写法，不再各自判断。
//
// 设计成「事件流」：
//   - 同一班次的当前有效状态永远由该班次时间最新的一条事件派生（历史只追加、不改写，状态因此不会回退）；
//   - 每次写入带 baseVersion，落库时做 CAS 比较，并发操作只接受先到结果，后到者被拒绝重试；
//   - 迁移来的存量台账与新登记数据走完全相同的校验，迁完即合规。

export const LOOKOUT_KEY = 'lookout'

export const LOOKOUT_STATUS = {
  active: '正常值守',
  closed: '临时关闭',
  fault: '设备故障',
  repairing: '维修中',
} as const

export type LookoutStatusCode = (typeof LOOKOUT_STATUS)[keyof typeof LOOKOUT_STATUS]

export const LOOKOUT_ACTIONS = {
  recordDuty: '记录值守',
  reportFault: '登记故障',
  repair: '开工维修',
  close: '关闭瞭望台',
  resume: '恢复值守',
} as const

export type LookoutAction = (typeof LOOKOUT_ACTIONS)[keyof typeof LOOKOUT_ACTIONS]

// 动作 -> 目标状态。页面动作按钮、状态机校验都读这里，禁止再散落字面量。
export const ACTION_TARGET: Record<LookoutAction, LookoutStatusCode> = {
  [LOOKOUT_ACTIONS.recordDuty]: LOOKOUT_STATUS.active,
  [LOOKOUT_ACTIONS.reportFault]: LOOKOUT_STATUS.fault,
  [LOOKOUT_ACTIONS.repair]: LOOKOUT_STATUS.repairing,
  [LOOKOUT_ACTIONS.close]: LOOKOUT_STATUS.closed,
  [LOOKOUT_ACTIONS.resume]: LOOKOUT_STATUS.active,
}

// 允许的流转关系。未列出的跳转一律拒绝（含「历史回退」式覆盖）。
const ALLOWED_NEXT: Record<LookoutStatusCode, LookoutStatusCode[]> = {
  [LOOKOUT_STATUS.active]: [LOOKOUT_STATUS.fault, LOOKOUT_STATUS.closed],
  [LOOKOUT_STATUS.fault]: [LOOKOUT_STATUS.repairing, LOOKOUT_STATUS.closed],
  [LOOKOUT_STATUS.repairing]: [LOOKOUT_STATUS.active, LOOKOUT_STATUS.closed],
  [LOOKOUT_STATUS.closed]: [LOOKOUT_STATUS.active],
}

// 台账里没有任何事件时（台站刚迁移完还没本班记录）允许的首个动作。
const ALLOWED_FIRST: LookoutStatusCode[] = [
  LOOKOUT_STATUS.active,
  LOOKOUT_STATUS.fault,
  LOOKOUT_STATUS.closed,
]

export type EventSource = 'live' | 'migrated'

export type LookoutEvent = {
  /** 台站在旧台账里的主键，复用为台站业务标识。 */
  lookoutId: number
  /** 班次标识 yyyy-mm-dd（同班次只保留一条有效状态）。 */
  shiftDate: string
  status: LookoutStatusCode
  action: LookoutAction
  occurredAt: string
  source: EventSource
  /** 迁移兼容标记：故障时间缺失、按原值守日期兜底时置真。 */
  faultTimeInferred?: boolean
}

export type LookoutLedgerRecord = {
  version: number
  events: LookoutEvent[]
}

export type CurrentStatus = {
  lookoutId: number
  shiftDate: string
  status: LookoutStatusCode
  action: LookoutAction
  occurredAt: string
  source: EventSource
  faultTimeInferred: boolean
}

export type TransitionDecision =
  | { ok: true; target: LookoutStatusCode }
  | { ok: false; message: string }

export const LOOKOUT_ALL_STATUSES: LookoutStatusCode[] = [
  LOOKOUT_STATUS.active,
  LOOKOUT_STATUS.closed,
  LOOKOUT_STATUS.fault,
  LOOKOUT_STATUS.repairing,
]

/**
 * 校验一次状态流转。
 * @param current 该班次当前有效状态；null 表示本班次还没有任何事件
 */
export function decideTransition(
  action: LookoutAction,
  current: CurrentStatus | null,
): TransitionDecision {
  const target = ACTION_TARGET[action]
  if (!target) {
    return { ok: false, message: `没有登记「${action}」这个瞭望台动作` }
  }
  if (!current) {
    return ALLOWED_FIRST.includes(target)
      ? { ok: true, target }
      : { ok: false, message: `新班次不能直接登记为「${target}」，请先记录值守` }
  }
  if (current.status === target) {
    return { ok: false, message: `当前已经是「${target}」，不用重复操作` }
  }
  const allowed = ALLOWED_NEXT[current.status] ?? []
  if (!allowed.includes(target)) {
    return { ok: false, message: `「${current.status}」不能直接流转为「${target}」` }
  }
  return { ok: true, target }
}

/** 取某班次时间最新的一条事件作为当前有效状态；同一班次只有这一个有效状态。 */
export function currentOfShift(events: LookoutEvent[], shiftDate: string): CurrentStatus | null {
  const latest = events
    .filter((event) => event.shiftDate === shiftDate)
    .sort(byOccurredDesc)[0]
  return latest ? toCurrent(latest) : null
}

/** 取台站跨班次的最新有效状态（列表/提醒按台站维度看时使用）。 */
export function currentOfLookout(
  events: LookoutEvent[],
  lookoutId: number,
): CurrentStatus | null {
  const latest = events
    .filter((event) => event.lookoutId === lookoutId)
    .sort(byOccurredDesc)[0]
  return latest ? toCurrent(latest) : null
}

function toCurrent(event: LookoutEvent): CurrentStatus {
  return {
    lookoutId: event.lookoutId,
    shiftDate: event.shiftDate,
    status: event.status,
    action: event.action,
    occurredAt: event.occurredAt,
    source: event.source,
    faultTimeInferred: event.faultTimeInferred === true,
  }
}

function byOccurredDesc(a: LookoutEvent, b: LookoutEvent): number {
  const diff = new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  // 同一时刻再按动作稳定性兜底，保证排序确定。
  return diff !== 0 ? diff : a.action.localeCompare(b.action)
}

// 值守提醒规则（共用写法）：
//   - 只有「正常值守」台站才需要值守提醒；临时关闭 / 设备故障 / 维修中都不产生，
//     修掉了「关闭后仍生成值守提醒」的问题；
//   - 超过 dutyOverdueHours 小时仍在同一值守状态，提醒该台站该班次值守超期未更新。
export const DUTY_OVERDUE_HOURS = 8

export type DutyReminder = {
  lookoutId: number
  shiftDate: string
  status: LookoutStatusCode
  occurredAt: string
  overdueHours: number
}

export function dutyReminders(
  events: LookoutEvent[],
  lookoutIds: number[],
  now: Date,
  dutyOverdueHours: number = DUTY_OVERDUE_HOURS,
): DutyReminder[] {
  const reminders: DutyReminder[] = []
  for (const lookoutId of lookoutIds) {
    const current = currentOfLookout(events, lookoutId)
    if (!current || current.status !== LOOKOUT_STATUS.active) {
      continue
    }
    const occurredAt = new Date(current.occurredAt)
    const overdueHours = Math.floor((now.getTime() - occurredAt.getTime()) / (60 * 60 * 1000))
    if (overdueHours >= dutyOverdueHours) {
      reminders.push({
        lookoutId,
        shiftDate: current.shiftDate,
        status: current.status,
        occurredAt: current.occurredAt,
        overdueHours,
      })
    }
  }
  return reminders.sort((a, b) => b.overdueHours - a.overdueHours)
}
