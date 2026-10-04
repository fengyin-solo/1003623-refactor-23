# 森林防火巡护管理系统

面向森林火险监测、巡护任务调度、防火设施维护与应急响应指挥的林区防火管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 巡护任务 | `patrol` | 巡护任务 | 任务编号、巡护区域、巡护路线 |
| 火险监测 | `firewatch` | 火险监测点 | 监测点编号、监测区域、火险等级 |
| 瞭望台管理 | `lookout` | 瞭望台 | 瞭望台编号、所在山头、海拔高度 |
| 防火隔离带 | `firebreak` | 防火隔离带 | 隔离带编号、所属林区、起止坐标 |
| 扑火队伍 | `fireteam` | 扑火队伍 | 队伍编号、队伍名称、所属林场 |
| 消防装备 | `equipment` | 消防装备 | 装备编号、装备名称、装备类型 |
| 气象观测 | `weather` | 气象观测记录 | 记录编号、观测站点、观测时间 |
| 火情报告 | `firereport` | 火情报告 | 报告编号、起火地点、起火时间 |
| 无人机巡查 | `drone` | 无人机巡查任务 | 任务编号、飞行区域、飞行路线 |
| 防火宣传 | `campaign` | 防火宣传活动 | 活动编号、宣传主题、宣传方式 |
| 防火检查站 | `checkpoint` | 防火检查站 | 站点编号、站点位置、值守人员 |
| 值勤排班 | `duty` | 值勤排班表 | 排班编号、值勤日期、值勤时段 |
| 物资储备 | `supply` | 防火物资 | 物资编号、物资名称、物资类别 |
| 林区道路 | `forestroad` | 林区道路 | 道路编号、道路名称、起点位置 |
| 防火林带 | `firebelt` | 防火林带 | 林带编号、林带名称、所属林区 |
| 应急演练 | `drill` | 应急演练 | 演练编号、演练主题、参演队伍 |
| 焚烧审批 | `burnpermit` | 用火审批单 | 审批编号、申请单位、用火类型 |
| 林木生长 | `treegrowth` | 林木生长记录 | 记录编号、样地编号、林分类型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `forest-fire-patrol:entries` 这一项，或调用 `resetModule(模块)`。

## 运行状态规则与瞭望台台账迁移

值守、故障、关闭判断不再散落在列表 / 详情 / 提醒入口，统一收拢到
`frontend/src/domain/`：

| 文件 | 职责 |
| --- | --- |
| `domain/status-rules.ts` | 共用状态机：状态、动作来源白名单、终态、待处理 / 异常口径、班次键 |
| `domain/lookout-ledger.ts` | 瞭望台运行台账（纯领域）：事件只追加、同班次唯一、乐观锁并发控制 |
| `domain/lookout-migration.ts` | 存量台账迁移（纯函数）：按台站游标推进、可中断续跑、兼容旧记录 |
| `domain/lookout-store.ts` | 台账 / 迁移进度的 `localStorage` 持久化、迁移锁、后台可续跑迁移器 |
| `domain/reminders.ts` | 值守 / 故障 / 气象提醒统一来源，概览页与各业务页共用 |

关键规则：

- **状态不能回退**：瞭望台按「正常值守 → 设备故障 → 维修中 → 正常值守」前向流转，
  「临时关闭」是终态，关闭后不接受任何动作，也**不再生成值守提醒**。气象观测同样收为
  纯前向链路（修复旧写法里「确认数据」把已审核打回已录入的回退）。
- **同一班次只能有一个有效状态**：班次键为 `YYYY-MM-DD/白班|夜班`（白班 08:00-20:00）。
  台站在某班次的首个结果即该班次唯一有效状态，后来的并发恢复结果返回
  `duplicate_shift` / `stale` 直接丢弃——并发恢复只接受先到结果。台账带 `version`
  乐观锁，跨标签页写入用 compare-and-set 兜底。
- **存量迁移与兼容**：迁移在应用启动后于后台按台站节拍推进，进度记录
  `nextStationCode`，中断（含关闭页面、跨标签页抢锁，锁带 TTL）后再次进入会**从未迁移
  台站继续**，已迁移台站不重复。旧记录缺少故障时间时按原「值守日期」归班，连值守日期
  都没有的老记录进入 `0000-00-00/未登记值守日期` 兼容班次，稳定排在真实班次之前、不丢失。
- **提醒同步**：运营概览的提醒入口与瞭望台页、气象页调用同一组 `build*Reminders`，
  气象页的状态修正会同步反映到概览。

验证脚本（纯 Node，esbuild 解析别名，不依赖浏览器）：

```bash
cd frontend
npm run verify        # 领域规则 + 持久化迁移
npm run verify:domain # 仅领域规则：终态、同班次唯一、stale、兼容日期、续跑、提醒
npm run verify:store  # 仅持久化：逐台站迁移、锁 TTL 接管、幂等
```

瞭望台台账与迁移进度独立存于：

- `forest-fire-patrol:lookout-ledger`：运行台账（事件流 + version）
- `forest-fire-patrol:lookout-migration`：迁移游标与统计
- `forest-fire-patrol:lookout-migration-lock`：迁移锁（owner + TTL）
