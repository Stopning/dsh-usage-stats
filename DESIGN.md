# dsh-usage-stats 设计文档

统计面板插件：基于 DSH 真实会话投影数据，展示 token 消耗、会话数、成本与预算，支持时间线、每会话明细、宿主进程 CPU 监测。

状态：**已实现、已安装、已在真实 Web UI 中逐页验证通过**（2026-11-03）。实现过程中的关键决定与踩坑记录见 §9。

---

## 1. 目标与范围

用户需求（m00001）：

- 展示总 token 消耗、会话数量
- 按 token 用量估算的成本与预算
- token 消耗时间线
- 各会话的 token 用量与成本
- 监测 CPU 运行和占用情况

已确认的四项决策（m00199–m00202，用户全部选推荐项）：

1. 成本口径：复用 cost-meter 价目表 + 峰/谷规则，输出人民币
2. 预算：可配置的月度上限 + 进度条 + 超额警告
3. CPU：DSH 宿主进程自身
4. UI：侧栏图标 + 独立主面板，单页仪表盘（对齐官方「会话统计」排版），带 近24小时/近7天/近14天/近30天/全部 范围切换与 人民币/美元 币种切换

不在范围：修改会话数据、写入任何存储、额外新增 Agent 工具、每会话 View 标签页。

## 2. 数据源（已实测）

### 2.1 会话数据（唯一历史来源）

`ctx.get('storageDomain').get('session_projcache').table('sessions')` —— 与 dsh-context 完全相同的官方通道。

实测：`~/.dsh/storages/session_projcache/sessions/*.json` 共 371 个文件，其中 **194 个会话有非零 token**。每条记录结构：

```
record.identity = { formatVersion, createdAt, cwd, isSeeded, inheritedEventCount }
record.rows = {
  title:      { val: string | null }
  tokenUsage: { val: { totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
                        last:   { turn, step, buckets } } }
  sessionStats: { val: { turns, steps, llmMs, toolMs, ttftMs, decodeMs, decodeTokens, lastTurn } }
  contextActivity: { val: { days: { 'YYYY-MM-DD': { tokens, requests, turns, toolCalls,
                                 cost: { provider: { model: { peak|off: { uncached, cacheRead, cacheWrite, output } } } } } } } }
  contextPressure, contextBreakdown, modelSelection, contextTimeline, ...
}
```

关键点：`contextActivity.days` 已按 **日期** 分桶，且 `cost` 已按 **provider:model:峰/谷** 四桶拆好 token 数 —— 时间线与每会话成本都不需要自己解析原始会话日志（`~/.dsh/sessions/**.jsonl.zstd`）。

实测覆盖：205 个会话有 days 行、218 条 day 条目、194 个会话有 cost 桶、**11 个不同日期**（2026-10-22 ~ 2026-11-03）。

一致性核对：`tokenUsage.totals` 求和与 `days[].tokens` 求和仅 1/194 个会话偏差 >2%（最大样本 192,987,415 vs 148,812,673，即单会话跨多日时按 createdAt 归日会失真）→ **日期归集一律以 `days` 为准，无 days 的会话才回退到 createdAt**。

### 2.2 价目表

`~/.dsh/storages/cost-meter/ledger.json` 的 `config.prices`：

```
prices.models['deepseek-v4.1-flash'] = {
  cacheHit: 0.003, cacheMiss: 0.15, output: 0.6,        // USD / 1M tokens
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  peak:    { cacheHit: 0.006, cacheMiss: 0.3,  output: 1.2 }
}
prices.default = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6, peak: {...} }
prices.providers[provider].models[model] = { input, output, cachedInput, cacheWrite?, billingMode, sourceUrl, checkedAt }
```

配套：`config.exchangeRate = 6.6743`（USD→CNY）、`config.currency='CNY'`、`config.symbol='¥'`、`config.decimals=4`、`config.peakEnabled=true`、`config.peakWindows=[{start:1,end:4},{start:6,end:10}]`（小时计）、`config.priceOverrides={}`。

**账本的 `days` 不可用作历史来源**：只有 2026-10-21～10-23 三天、21 个会话，且这 21 个 session id 与 projcache 的 194 个**完全不重叠**；单日 token 量级（2500 万）也与 projcache 不同源。只取 `config` 里的价目表与汇率。

### 2.3 计价公式（已用账本 ground truth 校验）

```
USD = Σ_buckets ( uncached×cacheMiss + cacheRead×cacheHit + cacheWrite×cacheMiss + output×output ) / 1e6
CNY = USD × exchangeRate
```

峰/谷：`prices.models` 的模型同时有 `peak` / `offPeak` 两套单价；`providers` 的模型是 flat 单价（无峰谷）。已用 deepseek-v4.1-flash 的 flat 单价复算账本 2026-10-21 的 0.117672 USD，误差 <0.1%。

峰谷判定沿用 dsh-context 的规则（UTC+8 工作日 9–12 / 14–18 为谷价）：

```js
function isOffPeak(ts) {
  const d = new Date(ts + 288e5)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = d.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}
```

由于 projcache 的 `cost` 已经预先分好 peak/off 桶，**不需要再做时段判定**——直接按桶取对应单价即可；峰谷单价表只在 `prices.models` 命中时生效。

### 2.4 CPU 数据

插件运行在 DSH 宿主进程内，可直接取：
- `process.cpuUsage()` — 用户态/内核态 CPU 微秒
- `process.memoryUsage()` — rss / heapUsed / heapTotal / external
- `os.loadavg()` — 系统 1/5/15 分钟负载
- `process.uptime()` — 宿主进程运行时长
- CPU 占用率 = 两次 `process.cpuUsage()` 差值 ÷ (墙钟差值 × CPU 核数)

## 3. 架构

### 3.1 包结构

```
/Users/stopning/DSH/dsh-usage-stats-plugin/
├── package.json          # name: dsh-usage-stats, dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # - insert: - id: dsh-usage-stats
├── index.js              # Host 半边：采集 + 计价 + API 路由
├── client.js             # Client 半边：侧栏入口 + 主面板
├── icon.svg              # 原创图标
├── locale/en.json        # meta.title / meta.description + 全部 UI 文案
├── locale/zh.json        # 同上（中文）
└── DESIGN.md
```

`package.json` 关键字段（对齐 dsh-context 与技能模板）：

```json
{
  "name": "dsh-usage-stats",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "icon.svg", "locale/*.json"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-sidebar-right"]
    }
  }
}
```

### 3.2 Host 半边（index.js）

```js
export const inject = ['storageDomain', 'connection']
export const name = 'dsh-usage-stats'
export const Config = Schema.object({ ... })   // budget / range / refresh
export function apply(ctx, config) { ... }
```

职责：

1. **采集**：从 `storageDomain` 读 `session_projcache` 的 `sessions` 表，逐条解析 `identity` / `rows.tokenUsage` / `rows.sessionStats` / `rows.contextActivity`。
2. **计价**：读价目表（`ledger.json` 的 `config.prices`），按 §2.3 公式算出每会话/每 provider:model 的 USD 与 CNY。
3. **聚合**：按日期、按会话、按 provider:model 三种维度汇总。
4. **路由**：通过 `ctx.connection.fetch.register` 注册三个 POST 路由，返回 `{ ok: true, value }` JSON：
   - `api/dsh-usage-stats/overview` — KPI + 按天时间线 + 预算进度 + provider:model 分布
   - `api/dsh-usage-stats/budget` — 写入预算上限（校验非负数字，落盘后立即生效）
   - `api/dsh-usage-stats/sessions` — 每会话 token 与成本列表（可带分页/排序参数）
   - `api/dsh-usage-stats/cpu` — 宿主进程 CPU/内存/负载快照 + 最近 N 次采样曲线
5. **CPU 采样**：Host 侧用 `ctx.effect` + 定时器每 2 秒采样一次，保留最近 60 个点；客户端轮询 `/cpu` 取回。

Host 半边注意事项：
- 采样定时器必须在 `ctx.effect` 里注册并返回清理函数（practices.md：插件卸载即销毁）。
- 价目表缓存 + 30 秒失效，避免每次请求都读 1MB+ 的 ledger.json。
- projcache 表条目多（371 个文件 / 17MB），读表用 `entries()` 迭代，单次请求内只解析需要的行，避免全量 JSON 解析开销；解析结果按 session id 缓存 15 秒。

### 3.3 Client 半边（client.js）

采用与 dsh-context 相同的注册方式：

```js
window.__ModuleLoader__.load({ id: 'dsh-usage-stats', factory(require) {
  const React = require('react')
  // ... 注册
}})
```

- `ctx.locale.register(ns, { en, zh })` 注册文案，`ctx.locale.bind(ns)` 取翻译函数。
- `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'dsh-usage-stats', locale }, Panel))`
- `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'dsh-usage-stats', order:25, label:()=>t('nav.title'), locale }, Icon))`
  - `order` 选 25，避开已占用的 plugins(0)/schedules(10)/skill-explorer(30)/mnemon(30)。
  - 图标用注入的 `@deepseek-ai/dsh-client-ui-sidebar-right` 组件（dsh-context 同款做法）。
- 面板结构：单页滚动仪表盘（不再分页签），顶栏为范围胶囊 + 币种胶囊 + 刷新。
- 数据获取：`fetch('api/dsh-usage-stats/overview')` 等（与 dsh-context 同款路径写法）。
- 样式：只用 `--dsw-alias-*` 主题 token；样式经 `styles.insert(css)` 注入并在卸载时清理。
- 定时刷新：`setTimeout` 链或 `ctx.timer` 驱动；Client 半边允许直接用浏览器 `setTimeout`（普通插件非动态沙箱）。
- **不 import 任何 `@deepseek-ai/dsh-client-ui-primitives`**（practices.md 明确禁止）；控件自己写。

## 4. 界面

排版逐条对齐官方宣传片（BV1i24P6rEmt，1:21–1:23）里的「会话统计」面板，单页滚动：

### 4.1 顶栏

- 左：标题「会话统计」。
- 右：范围胶囊（近 24 小时 / 近 7 天 / 近 14 天 / 近 30 天 / 全部）+ 刷新按钮。币种固定人民币，不提供切换。

### 4.2 KPI 带（4 张卡）

彩色圆角小图标 + 标签 + 大数字 + 灰色副标：

- 总 Token 消耗（副标：输入 X · 输出 Y）
- 预估成本（副标：按列表价估算）
- 会话数（副标：平均每会话 X tokens）
- 缓存命中率（副标：缓存读取 X）

### 4.3 DSH 运行状态

- 四项指标副标（2026-11-04 修正）：CPU 单核 → 「整机负载 x · n 核」；内存 → 「堆已用 x」；事件循环 p99 → 「平均 x」（取 `eventLoopMean`，原先误用整机内存总量）；运行时长 → 「PID x · Node vX」。
- `monitorEventLoopDelay` 自采样起累计，每次采样后 `reset()`，否则 p99 只涨不跌；空直方图返回 NaN，统一按 0 兜底。

- 标题右侧：绿色圆点徽章「实时 · 5 秒采样」+「N 核 · 负载 X」。
- 四项指标：CPU（单核）/ 内存（RSS）/ 事件循环 p99 / 运行时长，各带灰色副标（整机内存、堆已用、PID）。
- 下方「最近 5 分钟 CPU」柱状 sparkline + 右上「峰值 X%」。

### 4.4 每日消耗 + 模型花费（两列）

- 左：按天堆叠柱状图（输入未命中 / 缓存读取 / 缓存写入 / 输出 四色），下方四色图例。
- 右：模型花费（按模型 token 占比进度条列表，右侧成本；未命中价目表带「估算」标签）。

### 4.5 月度预算（与 4.6 并排，各占一半）

- 与「会话消耗排行」同处一行两列（`.ust-rank-budget`），左排行右预算，两卡等高。
- **竖排布局（2026-11-04 调整）**：文字在上、鲸鱼在下，整体水平居中，避免左右挤压；鲸鱼宽 `max 210px` 居中，不再并排。
- 鲸鱼水位：DeepSeek 鲸鱼 logo 剪影作为 CSS `mask` 施加在容器 `.ust-whale-shape` 上，内部两层绝对定位子元素——`.ust-whale-empty`（浅灰底，22% 次要前景色）铺满整只鲸鱼，`.ust-whale-fill`（`height = 剩余比例%`，`bottom:0`）表示**预算还剩多少**，颜色随档位变化（绿/黄/橙/红），形成「水位」效果。
  - **语义（2026-11-04 修正）**：鲸鱼是**水箱不是进度条**——水位表示**剩余**预算，不是已用。月初满水（绿），花得越多水位越低，见底时变红。旧实现用 `budget.ratio`（已用比例）填充，导致花得越多水位越高，方向反了。
  - 素材改为**矢量**：https://uxwing.com/deepseek-logo-icon/（免费商用、无需署名）的 `deepseek-logo-icon.svg`，取其鲸鱼 path（`fill-rule="nonzero"`），实测图形边界 `x 67→444, y 116→393`，故 `viewBox="67 116 377 277"`，URL-encode 后以 `url("data:image/svg+xml,…")` 内联进 `--ust-whale-mask`（约 2.9KB，无外部文件、无位图缩放模糊）。
  - 早期用 `/Applications/DeepSeek Harness.app/Contents/Resources/icon.png` 位图转遮罩（`alpha<200` 过滤 + `lum<110` 二值化 + `getbbox()` 裁剪），160px 下模糊、512px 下 base64 达 27KB，已弃用。
- 上方：大号**剩余百分比**（40px，与水位同义）+「剩余 ¥x」（14px）+「已用 ¥y」（13px）+「已用 / 上限」金额行（12px，含就地编辑铅笔）；**进度条已移除**（颜色语义已由鲸鱼承载）。
- 上限可就地编辑：平时显示数字 + 悬停出现的铅笔 ✎，点击变输入框，Enter / 保存按钮提交，Esc / 取消按钮放弃；保存后立即重算并刷新数据，刷新页面仍保留。
- 数值存插件私有文件 `~/.dsh/storages/dsh-usage-stats/budget.json`（`{amount, updatedAt}`），优先于配置项 `budgetAmount`；不动 profile 配置，改完无需重启。**注意：必须走 `POST /api/dsh-usage-stats/budget` 改，直接写文件不生效**（宿主内存里的 `settings.budgetAmount` 才是权威值）。
- 五档阈值按**剩余**比例（2026-11-04 定稿）：**≥95%（月初未动）黑** `--ust-ink`（`label-primary` 92%）→ **95–75% 绿** `#31BD9D` → **75–55% 黄** `#E0B23C` → **55–25% 橙** `#F08A24` → **<25% 红** `#E2453C`。`data-level` 依次为 `full / safe / warn / high / over`，同时作用于鲸鱼水位填充与上方大号百分比。

### 4.6 会话消耗排行（与 4.5 并排，各占一半）

- 半宽卡片：序号方块 + 标题 + 模型副标 + 右侧主副两个数字，右上三档胶囊：按 Token / 按花费 / 按耗时，取前 8。
- 显示内容随排序档位联动（2026-11-04 修正：原先只换排序、显示恒为 tokens+金额）：按 Token → 主 tokens / 副金额；按花费 → 主金额 / 副 tokens；按耗时 → 主耗时（wallMs）/ 副轮次。
- 「按耗时」用范围内每日桶的 wallMs 累加（会话页 entry 透传 `durationMs` / `turns`），不再用会话终生轮次排序。
- 时长单位用完整写法（2026-11-05 修正）：`formatMs` / `formatDuration` 一律输出 `5.9 h` / `56.3 min` / `3.1 s` / `35 min 23 s` / `37 ms`，单位文案走 locale 键 `unitDayHour` / `unitHourMin` / `unitMinSec` / `unitHour` / `unitMinute` / `unitSecond` / `unitMs`。原先裸写 `112.7m` 会被读成「112.7 百万 token」（`m` 与 `M` 同形）。

### 4.7 Token 构成 + 对话性能（两列，置于最底）

- 左：环形图，中心显示总量 + cost，右侧列表四项数值与百分比。
- 右：对话性能（平均每轮耗时 / 平均首字延迟 / 输出速度 / 工具错误率，各带副标 + 脚注）。

### 4.8 配色

官方取样值：主色青绿 `#31BD9D`；输入（未命中）`#3B82F6`；缓存读取 `#49B9A0`；缓存写入 `#F3A139`；输出 `#855DEA`。
主题变量 `--dsw-alias-brand-primary` 在浅色皮肤下解析为近黑 `#0f1115`，因此进度条/柱状图改用面板内自定义变量 `--ust-brand: #31BD9D`，其余颜色仍走 `--dsw-alias-*` token。

### 4.9 滚动

- 外层槽位容器（`.PIRFFq_centerCol`）高度固定且 `overflow: hidden`，面板必须自己滚动：`.ust-root` 加 `flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden`。

## 5. 配置（Config）

```js
defineConfig({                       // 自带 standard-schema，零外部依赖（见 §9.1）
  budgetAmount:      { type:'number', min:0,    default:100 },   // 月度预算上限（元）
  budgetPeriod:      { enum:['month'],           default:'month' },
  defaultRange:      { enum:['7d','30d','all'], default:'30d' },
  refreshIntervalMs: { type:'number', min:1000, default:5000 },
  topSessions:       { type:'number', min:1, max:1000, default:200 },
  currency:          { enum:['CNY','USD'],       default:'CNY' },
})
```

用户可在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里为 `dsh-usage-stats` 行加 `config:` 覆盖。

## 6. 安装与验证

安装：`plugin_manager action=install_bundle target=/Users/stopning/DSH/dsh-usage-stats-plugin`

验证：
1. `node --check` 语法检查 index.js / client.js
2. 安装后用 `cordis_inspect_query` 确认：
   - 插件行存在（`Config.listConfigs` 查 schema）
   - Client `Slots.listSubTree` 里 `sidebar.panellist` 与 `main` 出现 `dsh-usage-stats`
3. 直接用 `curl -X POST http://127.0.0.1:52022/api/dsh-usage-stats/overview` 验证路由返回真实数据（需带 §9.7 的 cookie）
4. 渲染验证：已用无头 Chromium 打开 Web GUI，确认四个 KPI、运行状态四项、对话性能四项、8 条排行、5 行模型花费均渲染，五档范围与币种切换数值正确。

## 7. 风险与边界

| 风险 | 处理 |
|---|---|
| 无浏览器控制，无法截图验证渲染 | 只做语法/清单/槽位/路由验证，如实说明 |
| projcache 中 `days` 覆盖不全（194/371 会话有 token，11 天） | 无 days 的会话回退到 identity.createdAt 归日，并单独计入「未按日分摊」桶 |
| 单会话跨多日导致 createdAt 归日失真 | 以 `days` 为准，createdAt 仅作回退 |
| 价目表不含某些模型（如 `minimax:MiniMax-M3.1-Flash`） | 用 `prices.providers` 中同系列模型（minimax-m3）或 `prices.default` 兜底，并在 UI 标注「估算」 |
| cost-meter 账本 days 已过期 | 只用其 config 价目表，不读其历史 |
| 峰谷与 cost-meter 的 peakWindows 不同 | 以 projcache 已分好的 peak/off 桶 + prices.models 的 peak/offPeak 单价为准 |

## 8. 交付清单

- [x] index.js（Host：采集/计价/聚合/路由/CPU 采样）
- [x] client.js（Client：侧栏 + 单页仪表盘）
- [x] locale/en.json、locale/zh.json（含 meta.title / meta.description；UI 文案内联在 client.js 字典）
- [x] icon.svg（原创，三柱柱状图，#4F7DF3）
- [x] cordis.patch.yml、package.json
- [x] node --check 通过
- [x] install_bundle 成功（`{"stage":"enable","application":"applied","changed":true,"warnings":[]}`）
- [x] cordis_inspect_query 验证槽位（main + sidebar.panellist 均 active）与路由真实数据
- [x] 渲染验证：已用无头 Chromium 确认单页仪表盘全部区块 + 五档范围 + 币种切换

## 9. 实现决定与踩坑记录

### 9.1 零外部依赖 + 自带 standard-schema

首次 install_bundle 失败：`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`。
根因：pnpm 以**符号链接**把 bundle 挂进 profile（`node_modules/dsh-usage-stats -> ../../../../DSH/dsh-usage-stats-plugin`），Node 从工作区真实路径解析依赖，而工作区没有 node_modules。

结论：cordis 的 `resolveConfig` 只要求 `runtime.Config["~standard"].validate(config)`（cordis lib/index.js:957-963），**不限定 schemastery**。因此 index.js 自写 `defineConfig(spec)`，返回
`{ '~standard': { version:1, vendor:'dsh-usage-stats', validate(value){...} } }`（支持 number 的 min/max、enum、default；非法项返回 `{issues:[{message,path}]}`），
package.json 删除整个 dependencies 块 → 插件**零外部依赖**。
副作用：config 目录里该插件 status 显示 `unsupported`（vendor 非 schemastery），不影响激活。

### 9.2 价格四级回退

`resolvePrice` 不能只做模型名精确匹配（大小写、连字符差异会全部落到 default 兜底）。最终顺序：

1. `prices.models` 表（命中 → `priceSource:'model'`）
2. 本渠道 `prices.providers[provider].models`（`'provider'` / `'provider-peak'`）
3. 跨渠道同名模型 proxied 匹配（`'proxied'`，取 checkedAt 最新）
4. `prices.default` 兜底（`'default'`，UI 标注「估算」）

匹配用 `normalizeModelId()`（去所有非字母数字字符），并同时比较完整归一化名与 `vendor/model` 的 tail。
修复后 30 天内只剩 `qodercn:qmodel_38max` 仍为估算（价目表完全没有该渠道）。

### 9.3 成本换算只做一次

客户端原先用 `m.costUsd * data.exchangeRate`，currency='USD' 时会二次换算。
改为 Host 端直接下发 `costDisplay`（index.js:532 `.map((m) => ({ ...m, costDisplay: toDisplay(m.costUsd) }))`），客户端只用 `costDisplay`。
同时 `range` 字段从写死的 `settings.defaultRange` 改为返回实际请求的 range（另加 `requestedRange`）。

### 9.4 API 路径必须带前缀

`new URL(relative, document.baseURI).pathname` 在 base 为 `/` 时会把 `api/dsh-usage-stats/overview` 解析成 `/overview` → 405。
正确写法：`const relative = \`${API}/${path}\`.replace(/^\/+/, '')` 再 `new URL(\`/${relative}\`, document.baseURI).pathname`。

### 9.5 locale 注册必须幂等

`ctx.locale.register(ns, {zh, en})` 在同命名空间同语言已注册时**抛错** `locale namespace "dsh-usage-stats" already has locale "zh"`。
页面 reload / bundle 刷新会重复 apply → 异常中断 apply → **侧栏与主面板槽位都注册不上**（整个面板消失）。
修复：包 try/catch，重复注册时忽略。
同源的坑：占位符必须用**单花括号** `{n}` —— locale 服务的替换正则是 `/\{(\w+)\}/g`，写 `{{n}}` 不会替换。

### 9.6 生效方式

- **客户端半边（client.js）改动**：只需刷新页面。客户端 bundle 的 `rev` 由文件 mtime/ctime/size 的 sha1 算出（dsh-client-modules `artifactRevision`），文件一变 rev 就变，浏览器重新拉取。
- **Host 半边（index.js）改动**：需重启宿主进程（~/.dsh/bin/dsh-restart 或 dsh-restart-idle）。
- 官方热更新通道是 `@deepseek-ai/dsh-client-hmr`（轮询 bundle 文件元数据 → `clientModules.rebuilt(id)` → SSE `/plugins/events` → 浏览器重载），但本 profile 未启用该插件。

### 9.7 Web GUI 认证取 cookie 的办法

DSH Web GUI 用 `?token=<launchToken>` 换 cookie（dsh-client-connection 的 `processLaunchToken` / `authorizeIndex`，签发 HttpOnly `dsh-auth-<sha256(authority)>`）。
launch token 只在宿主内存，但桌面 App 的 Chromium cookie 库里已有有效 cookie，可直接取用：

```bash
sqlite3 "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies" \
  "select name||'='||value from cookies where name like 'dsh-auth-%' order by creation_utc desc limit 1;"
# 然后 curl -X POST http://127.0.0.1:52022/api/dsh-usage-stats/overview \
#   -H 'content-type: application/json' -H "Cookie: $COOKIE" -d '{"range":"30d"}'
```
必须按 creation_utc 取最新一条，旧 cookie 会 401。

### 9.8 与 cost-meter 账本的口径差异

账本 `ledger.json` 的 days 只覆盖 2026-10-21~10-23 共 21 个会话，与 projcache 的 194 个会话**完全不重叠**（overlap=0），量级也不同 → 两者不同源。
本插件**只用账本的 `config.prices` 当价目表**，历史与成本一律以 projcache 为准自行估算。
另外账本认为 `minimax:MiniMax-M3.1-Flash` 与 `qodercn:qfmodel` 成本为 0（无按量计费渠道），本插件按公开价目表估算 → 口径本就不同，UI 已标注「部分模型未命中价目表，已按默认价估算」。

### 9.9 官方排版复刻的验证链路（2026-11-04）

- 官方界面取证：B 站 BV1i24P6rEmt 1:21–1:23，用 `yt-dlp` 拉 1080P + `imageio-ffmpeg` 抽帧，逐帧确认区块顺序、文案与配色。
- 客户端可刷新不用重启：`@deepseek-ai/dsh-client-modules` 的 `artifactRevision` 取文件 `mtimeMs/ctimeMs/size` 做哈希，文件一变 `rev` 就变，刷新页面即拉新 `client.js`；只有改 Host 半边 `index.js` 才需要重启宿主。
- 无头验证工具链：runtime python 的 `playwright` 因 `greenlet` 扩展 Team ID 与进程不符无法导入（`codesign` 去签/自签均无效），改用系统 python3.9 venv 装 `playwright==1.60.0`（1.64 无 cp39 wheel），并显式传 `executable_path` 指向已下载的 `chromium_headless_shell-1248`。
- 截图要点：面板高于视口时元素截图会截断空白，验证时把视口高度拉到 1800。
- 探测脚本 `verify.ui.py`：注入桌面端 `dsh-auth-*` cookie 后打开 `http://127.0.0.1:<port>/`，点侧栏「会话统计」，再读 `.ust-kpi-value` / `.ust-metric-value` / `.ust-perf-value` / `.ust-donut-total` 并整面板截图。
- 已确认的实测值（近 7 天）：总 Token 288M、成本 ¥60、会话 174、缓存命中率 94.2%；近 24 小时 228M / ¥38.85 / 35 会话；切 USD 后 $11.51。近 30 天与「全部」相同，因为真实数据最早只到 10-22。
