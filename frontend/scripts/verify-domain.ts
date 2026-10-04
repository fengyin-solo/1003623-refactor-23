/**
 * 瞭望台状态规则 / 台账 / 存量迁移的纯领域逻辑验证。
 * 不依赖浏览器与 localStorage：用 esbuild 把 @ 别名解析后直接在 Node 里跑。
 */
import assert from 'node:assert/strict'

import {
  LOOKOUT_RULES,
  WEATHER_RULES,
  LEGACY_SHIFT_KEY,
  currentShiftKey,
  evaluateTransition,
  allowedActions,
  shiftKeyOf,
} from '../src/domain/status-rules'
import {
  commitStatus,
  createEmptyLedger,
  importLegacyStatus,
  stationTimeline,
} from '../src/domain/lookout-ledger'
import {
  legacyShiftKeyOf,
  migrateAll,
  migrateStation,
  createMigrationState,
  uniqueStationCodes,
} from '../src/domain/lookout-migration'
import { buildLookoutReminders, buildWeatherReminders } from '../src/domain/reminders'
import type { EntryRow } from '../src/data/types'

function row(partial: Partial<EntryRow> & { id: number; status: string }): EntryRow {
  return { pending: false, abnormal: false, ...partial }
}

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

/* ------------------------------- 状态机规则 -------------------------------- */

test('关闭是终态：关闭后不允许任何动作（记录值守/登记故障都被拒）', () => {
  for (const action of ['记录值守', '登记故障', '开始维修', '关闭瞭望台']) {
    const verdict = evaluateTransition(LOOKOUT_RULES, '临时关闭', action)
    assert.equal(verdict.ok, false, `关闭后不应允许 ${action}`)
  }
  assert.deepEqual(allowedActions(LOOKOUT_RULES, '临时关闭'), [])
})

test('状态不能回退：正常值守不能直接记录值守；已审核不能被确认数据打回', () => {
  assert.equal(evaluateTransition(LOOKOUT_RULES, '正常值守', '记录值守').ok, false)
  assert.equal(evaluateTransition(LOOKOUT_RULES, '正常值守', '开始维修').ok, false)
  // 气象旧 bug：确认数据曾把已审核打回已录入，现在只允许 已审核 -> 已修正
  const verdict = evaluateTransition(WEATHER_RULES, '已审核', '确认数据')
  assert.equal(verdict.ok, true)
  if (verdict.ok) assert.equal(verdict.target, '已修正')
  assert.equal(evaluateTransition(WEATHER_RULES, '已修正', '确认数据').ok, false)
})

test('故障-维修-恢复为前向闭环', () => {
  let status = '正常值守'
  const steps: Array<[string, string]> = [
    ['登记故障', '设备故障'],
    ['开始维修', '维修中'],
    ['记录值守', '正常值守'],
  ]
  for (const [action, expected] of steps) {
    const verdict = evaluateTransition(LOOKOUT_RULES, status, action)
    assert.equal(verdict.ok, true)
    if (verdict.ok) {
      assert.equal(verdict.target, expected)
      status = verdict.target
    }
  }
})

/* ------------------------------ 台账并发/班次 ------------------------------ */

test('同一班次只能有一个有效状态：同班第二次结果记为 duplicate_shift', () => {
  let ledger = createEmptyLedger()
  const shift = '2026-10-04/白班'
  const first = commitStatus({
    ledger,
    baseVersion: ledger.version,
    stationCode: 'LOOK-1',
    shiftKey: shift,
    action: '登记故障',
    now: 1000,
  })
  assert.equal(first.ok, true)
  if (!first.ok) throw new Error('first commit failed')
  ledger = first.ledger

  // 同班次恢复后再点「开始维修」也不行：同一班次只接受先到的一个有效状态
  const duplicate = commitStatus({
    ledger,
    baseVersion: ledger.version,
    stationCode: 'LOOK-1',
    shiftKey: shift,
    action: '开始维修',
    now: 1500,
  })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.code, 'duplicate_shift')
})

test('跨班次沿用上班次状态：白班故障后，夜班可继续维修并恢复', () => {
  let ledger = createEmptyLedger()
  const fault = commitStatus({
    ledger,
    baseVersion: 0,
    stationCode: 'LOOK-7',
    shiftKey: '2026-10-04/白班',
    action: '登记故障',
    now: 1000,
  })
  assert.equal(fault.ok, true)
  if (!fault.ok) throw new Error('fault failed')
  ledger = fault.ledger

  // 新班次沿用「设备故障」，允许开始维修
  const repair = commitStatus({
    ledger,
    baseVersion: ledger.version,
    stationCode: 'LOOK-7',
    shiftKey: '2026-10-04/夜班',
    action: '开始维修',
    now: 2000,
  })
  assert.equal(repair.ok, true)
  if (!repair.ok) throw new Error(repair.message)
  ledger = repair.ledger

  // 再下一班次沿用「维修中」，记录值守恢复
  const recover = commitStatus({
    ledger,
    baseVersion: ledger.version,
    stationCode: 'LOOK-7',
    shiftKey: '2026-10-05/白班',
    action: '记录值守',
    now: 3000,
  })
  assert.equal(recover.ok, true)
})

test('关闭后的后续班次也不能恢复（终态跨班次持续）', () => {
  let ledger = createEmptyLedger()
  const close = commitStatus({
    ledger,
    baseVersion: 0,
    stationCode: 'LOOK-8',
    shiftKey: '2026-10-04/白班',
    action: '关闭瞭望台',
    now: 1000,
  })
  assert.equal(close.ok, true)
  if (!close.ok) throw new Error('close failed')
  ledger = close.ledger

  const next = commitStatus({
    ledger,
    baseVersion: ledger.version,
    stationCode: 'LOOK-8',
    shiftKey: '2026-10-05/白班',
    action: '记录值守',
    now: 2000,
  })
  assert.equal(next.ok, false)
})

test('并发恢复只接受先到结果：过期版本号写入一律 stale', () => {
  let ledger = createEmptyLedger()
  const shift = '2026-10-04/白班'
  const first = commitStatus({
    ledger,
    baseVersion: 0,
    stationCode: 'LOOK-1',
    shiftKey: shift,
    action: '登记故障',
    now: 1000,
  })
  assert.equal(first.ok, true)
  if (!first.ok) throw new Error('first commit failed')
  ledger = first.ledger

  // 另一个恢复会话拿着旧的 version=0 提交结果
  const stale = commitStatus({
    ledger,
    baseVersion: 0,
    stationCode: 'LOOK-1',
    shiftKey: '2026-10-04/夜班',
    action: '关闭瞭望台',
    now: 2000,
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.code, 'stale')
})

test('事件只追加：时间线保留全部历史，最新事件决定当前状态，历史不会回退', () => {
  let ledger = createEmptyLedger()
  const ops: Array<[string, string, number, string]> = [
    ['2026-10-04/白班', '登记故障', 1000, '设备故障'],
    ['2026-10-04/夜班', '开始维修', 2000, '维修中'],
    ['2026-10-05/白班', '记录值守', 3000, '正常值守'],
    ['2026-10-05/夜班', '关闭瞭望台', 4000, '临时关闭'],
  ]
  for (const [shift, action, now, expected] of ops) {
    const result = commitStatus({
      ledger,
      baseVersion: ledger.version,
      stationCode: 'LOOK-9',
      shiftKey: shift,
      action,
      now,
    })
    assert.equal(result.ok, true, `${action} 应成功`)
    if (!result.ok) throw new Error(result.message)
    assert.equal(result.event.status, expected)
    ledger = result.ledger
  }
  const timeline = stationTimeline(ledger.stations['LOOK-9'])
  assert.equal(timeline.length, 4)
  assert.equal(timeline[timeline.length - 1].status, '临时关闭')
})

test('importLegacyStatus 同班次先到唯一，后来者 accepted=false 但不报错', () => {
  let ledger = createEmptyLedger()
  const first = importLegacyStatus({
    ledger,
    stationCode: 'S1',
    shiftKey: '2026-09-01/白班',
    status: '正常值守',
    at: 1,
  })
  assert.equal(first.ok, true)
  if (first.ok) {
    assert.equal(first.accepted, true)
    ledger = first.ledger
  }
  const second = importLegacyStatus({
    ledger,
    stationCode: 'S1',
    shiftKey: '2026-09-01/白班',
    status: '设备故障',
    at: 2,
  })
  assert.equal(second.ok, true)
  if (second.ok) {
    assert.equal(second.accepted, false)
    assert.equal(second.ledger.version, ledger.version)
  }
})

/* -------------------------------- 存量迁移 -------------------------------- */

test('旧记录缺故障时间时按原值守日期兼容；日期也没有时落 LEGACY_SHIFT_KEY', () => {
  const withDutyDate = row({
    id: 1,
    status: '设备故障',
    '瞭望台编号': 'L1',
    '值守日期': '2026-09-03',
  })
  assert.equal(legacyShiftKeyOf(withDutyDate), '2026-09-03/白班')

  const withDateTime = row({
    id: 2,
    status: '设备故障',
    '瞭望台编号': 'L1',
    '值守日期': '2026-09-03 14:30',
  })
  assert.equal(legacyShiftKeyOf(withDateTime), '2026-09-03/白班')

  const nothing = row({ id: 3, status: '正常值守', '瞭望台编号': 'L2' })
  assert.equal(legacyShiftKeyOf(nothing), LEGACY_SHIFT_KEY)
})

test('整批迁移：同台站同班次只保留先到有效状态，重复计入 skippedDuplicate', () => {
  const rows: EntryRow[] = [
    row({ id: 1, status: '正常值守', '瞭望台编号': 'L1', '值守日期': '2026-09-01' }),
    // 同台站、同日期班次的后到记录（并发恢复旧台账里的重复行）
    row({ id: 2, status: '设备故障', '瞭望台编号': 'L1', '值守日期': '2026-09-01' }),
    row({ id: 3, status: '临时关闭', '瞭望台编号': 'L2', '值守日期': '2026-09-02' }),
    row({ id: 4, status: '不存在的旧状态', '瞭望台编号': 'L3' }),
  ]
  const { ledger, state } = migrateAll(rows)
  assert.equal(state.stats.total, 4)
  assert.equal(state.stats.accepted, 2)
  assert.equal(state.stats.skippedDuplicate, 1)
  assert.equal(state.stats.skippedInvalid, 1)
  assert.equal(state.finished, true)
  // 同班次先到结果（正常值守）保留，后到故障被丢弃
  const l1 = ledger.stations['L1']
  assert.equal(l1.events.length, 1)
  assert.equal(l1.events[0].status, '正常值守')
  assert.equal(l1.events[0].source, 'legacy')
  assert.equal(ledger.stations['L2'].events[0].status, '临时关闭')
})

test('迁移可中断续跑：按台站推进游标，中断后从未迁移台站继续', () => {
  const rows: EntryRow[] = [
    row({ id: 1, status: '正常值守', '瞭望台编号': 'A', '值守日期': '2026-09-01' }),
    row({ id: 2, status: '设备故障', '瞭望台编号': 'B', '值守日期': '2026-09-02' }),
    row({ id: 3, status: '维修中', '瞭望台编号': 'C', '值守日期': '2026-09-03' }),
  ]
  const codes = uniqueStationCodes(rows)
  assert.deepEqual(codes, ['A', 'B', 'C'])

  // 只迁第一个台站（模拟中断）
  let ledger = createEmptyLedger()
  let state = createMigrationState(rows)
  const first = migrateStation(
    ledger,
    state,
    'A',
    rows.filter((item) => item['瞭望台编号'] === 'A'),
    codes,
  )
  ledger = first.ledger
  state = first.state
  assert.deepEqual(state.processedStationCodes, ['A'])
  assert.equal(state.nextStationCode, 'B')
  assert.equal(state.finished, false)
  assert.equal(ledger.stations['B'], undefined)

  // 恢复：从 B 继续，再到 C
  for (const code of ['B', 'C']) {
    const result = migrateStation(
      ledger,
      state,
      code,
      rows.filter((item) => item['瞭望台编号'] === code),
      codes,
    )
    ledger = result.ledger
    state = result.state
  }
  assert.equal(state.finished, true)
  assert.equal(state.nextStationCode, null)
  assert.deepEqual(Object.keys(ledger.stations).sort(), ['A', 'B', 'C'])
  assert.equal(state.stats.accepted, 3)
})

/* --------------------------------- 提醒 ---------------------------------- */

test('关闭台站不生成值守提醒（修复关闭后仍催值守）', () => {
  const ledger = createEmptyLedger()
  const closed = importLegacyStatus({
    ledger,
    stationCode: 'L2',
    shiftKey: LEGACY_SHIFT_KEY,
    status: '临时关闭',
    at: 0,
  })
  assert.equal(closed.ok, true)
  const rows: EntryRow[] = [
    row({ id: 1, status: '正常值守', '瞭望台编号': 'L1' }),
    row({ id: 2, status: '临时关闭', '瞭望台编号': 'L2' }),
    row({ id: 3, status: '设备故障', '瞭望台编号': 'L3', '值守日期': '2026-09-03' }),
  ]
  const finalLedger = closed.ok && closed.accepted ? closed.ledger : ledger
  const reminders = buildLookoutReminders(rows, finalLedger, shiftKeyOf(new Date()))
  const titles = reminders.map((item) => item.title)
  assert.ok(!titles.some((title) => title.includes('L2')), '关闭台站 L2 不应出现提醒')
  assert.ok(titles.some((title) => title.includes('L3') && title.includes('故障')))
  // 故障提醒带出原值守日期兼容文案
  const fault = reminders.find((item) => item.title.includes('L3'))
  assert.ok(fault?.detail.includes('2026-09-03'))
})

test('气象提醒：异常值 danger、未审核 warn，已修正/已审核不催', () => {
  const rows: EntryRow[] = [
    row({ id: 1, status: '异常值', '记录编号': 'W1', '观测站点': '站1' }),
    row({ id: 2, status: '已录入', '记录编号': 'W2', '观测站点': '站2' }),
    row({ id: 3, status: '已修正', '记录编号': 'W3' }),
  ]
  const reminders = buildWeatherReminders(rows)
  assert.equal(reminders.length, 2)
  assert.equal(reminders.find((item) => item.title.includes('W1'))?.level, 'danger')
  assert.equal(reminders.find((item) => item.title.includes('W2'))?.level, 'warn')
})

/* --------------------------------- 收尾 ---------------------------------- */

test('currentShiftKey 形如 日期/班次', () => {
  assert.match(currentShiftKey(() => new Date('2026-10-04T10:00:00')), /^\d{4}-\d{2}-\d{2}\/白班$/)
  assert.match(currentShiftKey(() => new Date('2026-10-04T22:00:00')), /^\d{4}-\d{2}-\d{2}\/夜班$/)
})

console.log(`\n全部 ${passed} 项领域逻辑验证通过`)
