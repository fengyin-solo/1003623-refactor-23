/**
 * 运行状态规则（共用写法）
 *
 * 列表页、详情抽屉、提醒入口、存量台账迁移、动作写入都只认这里的规则，
 * 任何页面都不再自己判断「这个状态能不能做那个动作」。
 *
 * - 规则按「动作 + 允许的来源状态」描述，杜绝历史状态回退（例如关闭后还能记成值守）。
 * - 终态（terminalStatuses）一旦进入就不再接受任何动作，例如瞭望台临时关闭。
 * - settledStatuses / abnormalStatuses 给看板统计与提醒共用，pending 不再靠状态顺序猜。
 */

export type TransitionRule = {
  /** 触发动作，与 modules.ts 里登记的动作同名 */
  action: string
  /** 只有这些来源状态允许执行该动作；空数组表示任何状态都不允许 */
  from: string[]
  /** 动作生效后的目标状态 */
  to: string
}

export type StatusRuleSet = {
  module: string
  statuses: string[]
  transitions: TransitionRule[]
  /** 已落停、无需再催办的状态（其余状态计入待处理） */
  settledStatuses: string[]
  /** 异常状态（计入异常量、提醒升级） */
  abnormalStatuses: string[]
  /** 终态：进入后拒绝一切后续动作 */
  terminalStatuses?: string[]
}

export type TransitionVerdict =
  | { ok: true; target: string }
  | { ok: false; message: string }

export function targetOf(rules: StatusRuleSet, action: string): string | undefined {
  return rules.transitions.find((item) => item.action === action)?.to
}

/** 动作→目标状态映射，供模块元数据复用，避免另写一份 actionTargets。 */
export function actionTargetsOf(rules: StatusRuleSet): Record<string, string> {
  return Object.fromEntries(rules.transitions.map((item) => [item.action, item.to]))
}

export function evaluateTransition(
  rules: StatusRuleSet,
  currentStatus: string,
  action: string,
): TransitionVerdict {
  if (rules.terminalStatuses?.includes(currentStatus)) {
    return {
      ok: false,
      message: `当前已是「${currentStatus}」终态，不能再执行「${action}」`,
    }
  }
  const rule = rules.transitions.find((item) => item.action === action)
  if (!rule) {
    return { ok: false, message: `没有登记「${action}」这个动作` }
  }
  if (!rule.from.includes(currentStatus)) {
    return {
      ok: false,
      message: `「${currentStatus}」状态下不能执行「${action}」，状态不能回退或越级`,
    }
  }
  return { ok: true, target: rule.to }
}

/** 当前状态下页面上应该出现的动作（列表、详情抽屉共用）。 */
export function allowedActions(rules: StatusRuleSet, currentStatus: string): string[] {
  if (rules.terminalStatuses?.includes(currentStatus)) {
    return []
  }
  return rules.transitions.filter((item) => item.from.includes(currentStatus)).map((item) => item.action)
}

export function isSettled(rules: StatusRuleSet, status: string): boolean {
  return rules.settledStatuses.includes(status)
}

export function isAbnormal(rules: StatusRuleSet, status: string): boolean {
  return rules.abnormalStatuses.includes(status)
}

export function isTerminal(rules: StatusRuleSet, status: string): boolean {
  return rules.terminalStatuses?.includes(status) ?? false
}

/* ---------------------------------- 班次 ---------------------------------- */

export type ShiftKind = '白班' | '夜班'

/** 白班 08:00-20:00，与会话里的值守班次口径一致；其余时间为夜班。 */
export function shiftKindOf(date: Date): ShiftKind {
  return date.getHours() >= 8 && date.getHours() < 20 ? '白班' : '夜班'
}

export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 班次键：YYYY-MM-DD/白班|夜班。同一班次的唯一性按这个键判断。 */
export function shiftKeyOf(date: Date): string {
  return `${formatDate(date)}/${shiftKindOf(date)}`
}

export function currentShiftKey(now: () => Date = () => new Date()): string {
  return shiftKeyOf(now())
}

/** 旧台账里既没有故障时间、也没有值守日期时使用的兼容班次键，排序在所有真实班次之前。 */
export const LEGACY_SHIFT_KEY = '0000-00-00/未登记值守日期'

/* -------------------------------- 瞭望台规则 -------------------------------- */

/**
 * 正常值守 ──登记故障──▶ 设备故障 ──开始维修──▶ 维修中 ──记录值守──▶ 正常值守
 *     │                     │                     │
 *     └────────── 关闭瞭望台（任意非终态）──────────┘
 *                           ▼
 *                       临时关闭（终态，不再生成任何值守提醒，也不接受后续动作）
 */
export const LOOKOUT_RULES: StatusRuleSet = {
  module: 'lookout',
  statuses: ['正常值守', '设备故障', '维修中', '临时关闭'],
  transitions: [
    // 只有从故障/维修中恢复时才需要重新记录值守，正常态重复记值守会被拒绝
    { action: '记录值守', from: ['设备故障', '维修中'], to: '正常值守' },
    { action: '登记故障', from: ['正常值守', '维修中'], to: '设备故障' },
    { action: '开始维修', from: ['设备故障'], to: '维修中' },
    { action: '关闭瞭望台', from: ['正常值守', '设备故障', '维修中'], to: '临时关闭' },
  ],
  settledStatuses: ['正常值守', '临时关闭'],
  abnormalStatuses: ['设备故障'],
  terminalStatuses: ['临时关闭'],
}

/* -------------------------------- 气象规则 --------------------------------- */

/**
 * 已录入 ──提交审核──▶ 已审核 ──确认数据──▶ 已修正 ──提交审核──▶ 已审核
 *    │                   ▲                                      │
 *    └──标记异常──▶ 异常值 ──修正数据──▶ 已修正 ──────────────────┘
 *
 * 全部为前向流转：旧写法里「确认数据」会把已审核打回已录入，这里一并收住。
 */
export const WEATHER_RULES: StatusRuleSet = {
  module: 'weather',
  statuses: ['已录入', '已审核', '已修正', '异常值'],
  transitions: [
    { action: '提交审核', from: ['已录入', '已修正'], to: '已审核' },
    { action: '确认数据', from: ['已审核'], to: '已修正' },
    { action: '标记异常', from: ['已录入'], to: '异常值' },
    { action: '修正数据', from: ['异常值'], to: '已修正' },
  ],
  settledStatuses: ['已审核', '已修正'],
  abnormalStatuses: ['异常值'],
}

/** 需要走共用状态机的模块登记表，页面/服务只认规则，不再各自散写判断。 */
export const STATUS_RULES_BY_MODULE: Record<string, StatusRuleSet> = {
  lookout: LOOKOUT_RULES,
  weather: WEATHER_RULES,
}
