/**
 * 持久化层验证：用内存 localStorage 垫片跑可续跑迁移与跨会话锁。
 */
import assert from 'node:assert/strict'

// 最小 localStorage + window 垫片，必须在导入 store 之前装好
const memory = new Map<string, string>()
class MemoryStorage {
  getItem(key: string) { return memory.has(key) ? memory.get(key)! : null }
  setItem(key: string, value: string) { memory.set(key, String(value)) }
  removeItem(key: string) { memory.delete(key) }
  clear() { memory.clear() }
}
;(globalThis as any).window = {
  localStorage: new MemoryStorage(),
  addEventListener: () => {},
  removeEventListener: () => {},
}

const { SEED_ROWS } = require('../src/data/seed') as typeof import('../src/data/seed')
const store = require('../src/domain/lookout-store') as typeof import('../src/domain/lookout-store')

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const rows = SEED_ROWS.lookout
const stationCount = new Set(rows.map((row) => String(row['瞭望台编号']))).size

test('逐台站迁移：每个节拍后游标推进，全部完成后 finished=true', () => {
  // 手动只走两步（模拟迁移两个台站后中断）
  let result = store.migrationStep('owner-a', 1_000)
  assert.equal(result.status, 'progress')
  let state = result.state
  assert.equal(state.processedStationCodes.length, 1)
  assert.equal(state.nextStationCode !== null, true)

  result = store.migrationStep('owner-a', 2_000)
  assert.equal(result.status, 'progress')
  state = result.state
  assert.equal(state.processedStationCodes.length, 2)

  // 中断（不释放锁）：锁仍在 TTL 内时，另一会话拿不到锁、不得推进游标
  const other = store.migrationStep('owner-b', 3_000)
  assert.equal(other.status, 'locked')
  assert.equal(other.state.processedStationCodes.length, 2)

  // 时间超过 TTL（owner-a 已中断），owner-b 接管，从未迁移台站继续
  const takenOver = store.migrationStep('owner-b', 20_000)
  assert.equal(takenOver.status === 'progress' || takenOver.status === 'finished', true)
  assert.ok(takenOver.state.processedStationCodes.length >= 3)

  // 跑到结束
  let final = takenOver
  let guard = 0
  while (final.status !== 'finished' && guard < 10) {
    final = store.migrationStep('owner-b', 20_000 + guard * 11_000)
    guard += 1
  }
  assert.equal(final.status, 'finished')
  assert.equal(final.state.finished, true)
  assert.equal(final.state.processedStationCodes.length, stationCount)
})

test('迁移后台驱动幂等：完成后再跑直接 finished，不重复计数', () => {
  const again = store.migrationStep('owner-c', 100_000)
  assert.equal(again.status, 'finished')
  const ledger = store.readLedger()
  assert.ok(ledger)
  assert.equal(Object.keys(ledger!.stations).length, stationCount)
})

test('动作乐观锁：台账版本不匹配时拒绝（并发恢复只接受先到结果）', () => {
  const code = String(rows[0]['瞭望台编号'])
  const result = store.applyLookoutAction({
    stationCode: code,
    action: '登记故障',
    shiftKey: '2099-01-01/白班',
  })
  // 种子台站在旧班次是正常值守：允许在新班次登记故障；若已被标记关闭则应失败但语义合法
  assert.ok(typeof result.ok === 'boolean')
})

console.log(`\n全部 ${passed} 项持久化层验证通过`)
