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

## 瞭望台运行状态台账

瞭望台的值守、故障、关闭判断不再散落在列表、详情与提醒里，统一收敛到 `frontend/src/domain/`：

- `lookout-status.ts`：运行状态机（正常值守/设备故障/维修中/临时关闭）、动作与流转目标、
  值守提醒阈值。列表、详情、提醒入口共用这一份写法。
- `lookout-store.ts`：独立事件台账（localStorage 键 `forest-fire-patrol:lookout-ledger`），
  事件只追加不改写，当前有效状态由同一班次最新事件派生，历史因此不会回退；写入带版本号
  CAS，并发恢复只接受先到结果，后到提交得到 `stale`，不覆盖先到数据。
- `lookout-migration.ts`：存量台账迁移。按台站稳定顺序逐个提交，进度落在
  `forest-fire-patrol:lookout-migration`，中断后从未迁移台站继续、重复迁移幂等；
  旧记录缺少「故障时间」时按原「值守日期」兜底，并在事件上打 `faultTimeInferred` 标记。
  迁移后同一台站同一班次只有一条有效状态。
- `reminders.ts` + `components/ReminderBanner.vue`：提醒共用写法。只有「正常值守」且超期
  的台站才产生值守提醒，临时关闭/故障/维修中一律不产生；气象页与运营概览复用同一组件。

迁移入口就在瞭望台页面顶部，可「迁移下一个台站」逐步执行，也可「一次性迁完」。
领域规则自检：`cd frontend && npm run test:domain`（纯 Node，内存版 localStorage，无需浏览器）。

