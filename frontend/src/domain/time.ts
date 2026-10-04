// 统一的时间工具：规则计算与迁移都只认这一层，方便测试时注入固定时钟。

export const DAY_MS = 24 * 60 * 60 * 1000

export type Clock = () => Date

export const defaultClock: Clock = () => new Date()

/** 把任意值解析成 Date；无法解析时返回 null（不做任何猜测性兜底）。 */
export function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

/** 格式化成 yyyy-mm-dd，台账落库与展示统一用这个形态。 */
export function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 距今的整小时数（负数表示时间点在未来）。 */
export function hoursSince(date: Date, now: Date = defaultClock()): number {
  return Math.floor((now.getTime() - date.getTime()) / (60 * 60 * 1000))
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS)
}
