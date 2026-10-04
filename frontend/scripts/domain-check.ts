// 领域规则的可执行自检：不依赖浏览器，用内存版 localStorage 驱动，
// 覆盖状态机、唯一有效状态、CAS 先到先得、断点续迁、故障时间兜底、关闭台无值守提醒。
import assert from 'node:assert'

// ---- 内存 localStorage / window 桩，必须在导入数据层之前就位 ----
const memory = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
} as unknown as typeof window & Record<string, unknown>

const { SEED_ROWS } = await import('../src/data/seed.ts')
// 用示例数据初始化旧台账
memory.set('forest-fire-patrol:entries', JSON.stringify(SEED_ROWS))

const status = await import('../src/domain/lookout-status.ts')
const store = await import('../src/domain/lookout-store.ts')
const migration = await import('../src/domain/lookout-migration.ts')
const service = await import('../src/domain/lookout-service.ts')
const reminders = await import('../src/domain/reminders.ts')

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log('  ✓', name)
}

// 1. 状态机：合法/非法流转与防回退
check('状态机：正常值守可故障/关闭，不能直接维修', () => {
  const cur = status.currentOfShift([], '2026-10-04')
  assert.equal(status.decideTransition(status.LOOKOUT_ACTIONS.repair, cur).ok, false)
  assert.equal(status.decideTransition(status.LOOKOUT_ACTIONS.recordDuty, cur).ok, true)

  const active: status.CurrentStatus = {
    lookoutId: 1, shiftDate: '2026-10-04', status: status.LOOKOUT_STATUS.active,
    action: status.LOOKOUT_ACTIONS.recordDuty, occurredAt: new Date().toISOString(),
    source: 'live', faultTimeInferred: false,
  }
  assert.equal(status.decideTransition(status.LOOKOUT_ACTIONS.reportFault, active).ok, true)
  assert.equal(status.decideTransition(status.LOOKOUT_ACTIONS.close, active).ok, true)
  assert.equal(status.decideTransition(status.LOOKOUT_ACTIONS.repair, active).ok, false)
})

// 2. 同一班次只有一个有效状态（取最新事件派生）
check('同一班次多次操作，当前状态由最新事件唯一派生且不回退', () => {
  const events: status.LookoutEvent[] = [
    ev(1, '2026-10-04', status.LOOKOUT_STATUS.active, '记录值守', '2026-10-04T01:00:00Z'),
    ev(1, '2026-10-04', status.LOOKOUT_STATUS.fault, '登记故障', '2026-10-04T05:00:00Z'),
    ev(1, '2026-10-04', status.LOOKOUT_STATUS.closed, '关闭瞭望台', '2026-10-04T09:00:00Z'),
  ]
  const cur = status.currentOfShift(events, '2026-10-04')
  assert.equal(cur?.status, status.LOOKOUT_STATUS.closed)
})

// 3. 故障时间缺失按原值守日期兜底
check('迁移：故障时间缺失 -> 按原值守日期兼容并打标记', () => {
  const row3 = SEED_ROWS.lookout[2]
  assert.equal(String(row3.status), '设备故障')
  const event = migration.legacyRowToEvent(row3)!
  assert.equal(event.faultTimeInferred, true)
  assert.equal(event.shiftDate, '2026-09-03')
  assert.equal(event.occurredAt.slice(0, 10), '2026-09-03')
})

// 4. 断点续迁：逐台站提交，中断后从未迁移继续
check('迁移：逐台站提交、可断点续迁、幂等不重复', () => {
  const p1 = migration.migrateNextStation()
  assert.equal(p1.migrated, 1)
  assert.equal(p1.finished, false)
  const p2 = migration.migrateNextStation()
  assert.equal(p2.migrated, 2)
  // 再来一个即迁完 3 个
  const p3 = migration.migrateRemaining()
  assert.equal(p3.migrated, 3)
  assert.equal(p3.finished, true)

  // 唯一性
  assert.equal(migration.validateUniqueness(store.getLedger().events), true)
  // 重复调用不再写入
  const versionAfter = store.getLedger().version
  migration.migrateNextStation()
  assert.equal(store.getLedger().version, versionAfter)
})

// 5. CAS：并发只接受先到结果
check('CAS：先到结果落库，后到提交 stale 不覆盖', () => {
  const ledger = store.getLedger()
  const base = ledger.version
  const first = store.commitEvents(base, [
    ev(99, '2026-10-04', status.LOOKOUT_STATUS.active, '记录值守', '2026-10-04T00:00:00Z'),
  ])
  assert.equal(first.ok, true)
  const stale = store.commitEvents(base, [
    ev(99, '2026-10-04', status.LOOKOUT_STATUS.closed, '关闭瞭望台', '2026-10-04T01:00:00Z'),
  ])
  assert.equal(stale.ok, false)
  assert.equal((stale as { reason: string }).reason, 'stale')
})

// 6. 关闭台不产生值守提醒；正常值守超期才提醒
check('提醒：临时关闭/故障/维修台不产生值守提醒，超期值守才提醒', () => {
  const now = new Date('2026-10-04T23:00:00Z')
  // 台站1 迁移为正常值守，occurredAt 2026-09-01，远超阈值 -> 应提醒
  const r1 = reminders.buildLookoutReminders(now)
  const ids = r1.map((r) => r.key)
  assert.ok(ids.some((k) => k.startsWith('lookout-duty-1-')), '台站1 应超期提醒')
  assert.ok(!ids.some((k) => k.startsWith('lookout-duty-2-')), '关闭台2 不应有值守提醒')
  assert.ok(!ids.some((k) => k.startsWith('lookout-duty-3-')), '故障台3 不应有值守提醒')
})

// 7. service.recordAction 走状态机 + CAS，关闭后不能直接覆盖回值守
check('服务层：关闭后只允许恢复值守，禁止非法回退', () => {
  // 台站2 当前为临时关闭（迁移而来，班次 2026-09-02）。对当前班次登记故障应被拒绝。
  const reject = service.recordAction(2, status.LOOKOUT_ACTIONS.reportFault, { shiftDate: '2026-09-02' })
  assert.equal(reject.ok, false)
  // 关闭台允许恢复值守
  const allow = service.recordAction(2, status.LOOKOUT_ACTIONS.resume, {
    shiftDate: '2026-09-02', now: new Date('2026-09-02T10:00:00Z'),
  })
  assert.equal(allow.ok, true)
  assert.equal(allow.current?.status, status.LOOKOUT_STATUS.active)
})

function ev(
  lookoutId: number,
  shiftDate: string,
  s: status.LookoutStatusCode,
  action: status.LookoutAction,
  occurredAt: string,
): status.LookoutEvent {
  return { lookoutId, shiftDate, status: s, action, occurredAt, source: 'live' as const }
}

console.log(`\n全部 ${passed} 项自检通过`)
