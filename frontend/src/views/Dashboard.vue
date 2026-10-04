<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常；值守与气象提醒与各业务页同一来源。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>

    <ReminderPanel title="值守 / 故障 / 气象提醒（关闭台站不催值守，气象页改动在此同步）" :reminders="reminders" />

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import { listEntries, loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'
import ReminderPanel from '@/components/ReminderPanel.vue'
import { buildLookoutReminders, buildWeatherReminders, type Reminder } from '@/domain/reminders'
import { readLedger, subscribeLookoutStore } from '@/domain/lookout-store'
import { currentShiftKey } from '@/domain/status-rules'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const reminders = ref<Reminder[]>([])
let unsubscribe: (() => void) | null = null

function collectReminders(): Reminder[] {
  const lookoutRows = listEntries('lookout').items
  const weatherRows = listEntries('weather').items
  // 瞭望台提醒按运行台账判断（关闭后不再催值守），气象提醒与气象页面共用同一函数
  return [
    ...buildLookoutReminders(lookoutRows, readLedger(), currentShiftKey()),
    ...buildWeatherReminders(weatherRows),
  ].sort((a, b) => {
    const weight = { danger: 0, warn: 1, info: 2 }
    return weight[a.level] - weight[b.level]
  })
}

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  reminders.value = collectReminders()
}

onMounted(() => {
  refresh()
  // 台账迁移或动作写入后，提醒入口即时同步（含跨标签页 storage 事件）
  unsubscribe = subscribeLookoutStore(refresh)
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>
