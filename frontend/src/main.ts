import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './styles/global.css'
import { runMigrationInBackground } from './domain/lookout-store'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 瞭望台存量台账迁移：后台按台站节拍推进，可中断续跑（从未迁移台站继续）。
// 同一班次唯一有效状态、并发恢复只接受先到结果，都在领域层 + 乐观锁里保证。
if (typeof window !== 'undefined') {
  runMigrationInBackground({ intervalMs: 30 })
}
