# PinballForge 运营 × 美术完善计划

> 版本：v1.0（2026-08-31）
> 视角：游戏运营 + 美术。技术架构与代码级问题见根目录 `PROJECT_ANALYSIS.md`（8/27 只读分析），本文不重复。
> 方法论：《游戏设计的100个原理》体系（核心循环 / 心流 / 80-20 / 约束三角 / 主题一致性 / 视觉引导 / Fitts / Hick / 奖惩系统 / 动态难度）。
> 维护方式：每完成一项在对应表格打勾并注明日期；里程碑验收标准不允许口头放宽。

---

## 1. 现状盘点（2026-08-31）

**一句话**：核心循环成立（瞄准→撞钉积能→漏斗开火→清波→三选一→商店→Meta 养成），是"可玩原型"；表现层与运营层均为空白。

| 维度 | 已有 | 缺口 |
|---|---|---|
| 玩法 | 4 球种、3 漏斗、4 钉种、5 敌种、16 卡（含 3 机制应答卡）、5 遗物、Boss 行为+精英词缀、50 章×10 关、Meta 解锁树（5 轨带前置）死亡补偿 | 动态难度、每日任务、长线目标 |
| 视觉 | CameraShake / FloatingText / Punch 动画 | 全部 emoji+色块占位；无特效、无场景美术 |
| 音频 | 撞钉直播池 + Web Audio 合成特效 | 音效 2 个文件；无 BGM |
| 运营 | localStorage 进度+Meta 存档 | 零埋点、无变现点位、无留存钩子 |
| 上线阻塞 | ~~音频打包路径~~ **已修复**（resources.load 优先 + 旧路径兜底 + 合成降级三层保障，`assets/resources/audio/ding.mp3` 已就位） | 平台 SDK、隐私合规 |

## 2. 产品定位（用户中心设计）

| 项 | 结论 | 依据 |
|---|---|---|
| 平台 | **微信/抖音小游戏优先，H5 兜底** | localStorage 存档、HTML5 Audio、竖屏 720×1280 fitHeight、无原生痕迹 |
| 用户 | 休闲+轻肉鸽；单局 5-10 分钟 | 3 波/关的碎片结构；对标 Peglin、弓箭传说 |
| 商业化 | **IAA（激励视频）为主 + 轻混变**，M4 前不做 IAP | 单机肉鸽无付费深度；广告位成本低、风险小 |
| 北极星 | 次留 ≥35%、7 留 ≥15%、人均广告 ≥2 次/日 | 软启动验收线（M4） |

**约束三角（快/便宜/好占俩）**：本计划选择**快+便宜**。砍掉的：IAP、体力系统、全服排行榜、外包美术。保住的：风格概念一致性、首 10 分钟体验、埋点完整性。

## 3. 运营计划

### 3.1 留存漏斗（原理：锚定效应 + 奖惩系统）

| 节点 | 现状 | 动作 | 原理 |
|---|---|---|---|
| D0 首 10 分钟 | TutorialManager 已有 | 前 3 关手工编排：1-1 纯普通怪教学、1-2 必掉雷球卡（首个爽点）、1-3 必出金币槽（经济教学） | 锚定效应：首印象锚定后续判断 |
| D1 次留 | Meta 5 条×5 级带前置解锁树（🟡起步：3 根轨 + 碎片收藏/战术洞察 2 子轨） | 继续扩至 8-10 条：新球种 / 新钉板版型 / 新流派卡跨局解锁 | 随机+固定奖励混合建立信任 |
| D3-D7 | 无 | 每日任务 3 条/天（击杀 N 只、使用 X 球、观看 1 次广告）；每日挑战关（固定 seed + 好友排行）；7 日签到 | 节奏控制：可预期固定奖励打底 |
| D30 长线 | 50 章线性公式 | 每 5 章一个视觉主题 + 1 种新机制敌人；50 章后无尽模式 | 每约 7 分钟一个新元素 |

### 3.2 变现点位（先埋 UI 点位，M4 接 SDK）

激励视频（按预期收益排序，全部玩家主动触发，不做强制插屏）：

1. **死亡复活**（城堡沦陷后看广告原地满血复活 1 次/局）
2. **结算双倍碎片**（`MetaManager.grantRunReward` 后追加）
3. **三选一免费刷新**（`drawWeightedCards` 已支持重抽）
4. 商店免费刷新 / 金币礼包

### 3.3 动态难度（Buster 原则：暗中调整，玩家不可感知）

- 监控：连续失败次数、单波耗时、放弃率
- 触发：连续 3-5 次失败 → 敌 HP -5~10% / 出怪间隔 +10%
- 反向：连续 3 次零压力通过 → 回调
- 落点：`LevelManager.getWaveConfig()` 是唯一数值出口，在此加一个存档内的隐藏修正系数即可
- **红线**：不显示"难度已降低"字样；保留通关成就感

### 3.4 版本节奏（项目规划）

软启动（1000 人灰度）→ 数据迭代 → 全量。内容管线：**50 章算法生成保留骨架，前 10 章手工调优保体验**，后续章节只做新元素注入（新敌人/新钉板/新卡），不做关卡重做。

## 4. 美术计划

### 4.1 风格方向（主题一致性——锁定后才允许开工任何资产）

**方向：蒸汽朋克锻造工坊**。理由：游戏名 PinballForge 与核心机制（精铸碎片⚒、弹珠打磨、锻造 Meta）都是"锻造"，机制×题材×视觉三方协同。

- **关键词**：铜与铁的暖金属、炉火光、铆钉、齿轮、坩埚弹珠
- **色板基线**（待概念图定稿）：
  - 环境/底色：锻铁深灰 `#2B2D31` + 铜棕 `#B87333`
  - 火系：熔岩橙 `#FF6B35`；电系：电光青 `#00E5FF`；冰系：冰晶蓝 `#7FD8FF`；中立：金币 `#FFD700`
  - **颜色语义铁律**：火=橙、电=青、冰=蓝白、中立=金，必须贯穿卡牌边框、球体、开火特效、漏斗槽四层，玩家不读文字即可构建策略（原理：主题协同 1+1>2）
- **概念图**（人工产出，1 张即可）：主场景全景含城堡+钉板+漏斗+敌人，作为所有后续资产的比对基准
- 待选参考：SteamWorld Dig 的工坊质感、Peglin 的"桌面玩具感"

### 4.2 占位替换 P0 清单（M1 执行，完整规格见附录 B）

| 现状 | 替换物 | 数量 |
|---|---|---|
| emoji 敌人 🔴🛡️⚡🦠👹 | 敌人立绘（含受击闪白 tint，无需单独帧） | 5 |
| emoji 遗物 ⛏️💥🛡️🌊👑 | 遗物图标，统一描边风格 | 5 |
| 卡牌纯文字 | 卡面模板（普通/稀有/史诗 3 套边框）+ 12 卡图。**史诗边框必须做出"贵"**（锚定效应拉高抽卡感知价值） | 模板 3 + 卡图 12 |
| Graphics 色块场景 | 主场景背景 720×1280 ×1 + 钉板框 + 城堡 + 3 漏斗槽 | 6 |

低成本路线：Kenney.nl / itch.io CC0 改造 + AI 立绘统一色板，先不外包。

### 4.3 Juice 与视觉引导（M1-P1）

- **可供性**：漏斗槽改"凹陷+光晕"暗示可入槽；全按钮统一凸起+阴影（原理：视觉引导/可供性）
- **注意力捕获优先级**：Boss 出场（运动+意外）> 漏斗命中（运动）> 金币飘字（吸引力）。当前所有反馈同权重，玩家不知道看哪——用强度分层解决
- **黄金比例**：HUD 按 φ 分割（状态区:战斗区 ≈ 1:1.618，720×1280 下状态区约 310px 高）

### 4.4 UI/UX（Fitts / Hick）

- 三选一保持 3 张（Hick 最优 3-6 ✅）；卡牌热区加大，放屏幕下部 40% 拇指区（Fitts）
- 弹窗统一 1 主按钮 + 1 次按钮
- 现有 DeckButtonController 的轻点/拖拽区分保留

### 4.5 音频（M1-P1）

- 音效包 9 个 + BGM 2 首（战斗/结算各一），优先免费库起步（规格见附录 B）
- 现有 Web Audio 合成音保留为**降级兜底**，不做删除

## 5. 里程碑（运营 × 美术交叉排期）

| 里程碑 | 时长 | 内容 | 验收标准（不允许口头放宽） |
|---|---|---|---|
| **M1 表现力切片** | 2 周 | 4.1 概念图定稿 → 附录 B P0 资产全量替换 → 4.3 Juice 特效 → 音效包接入 | 录屏给 3 个未接触过的人看，"想玩"≥2 人；任意截图看不出是色块原型 |
| **M2 运营基建** | 2 周 | 附录 A 埋点全量 + 4 个广告点位 UI（空接）+ 每日任务系统 + Meta 扩至 8 条 | 测试包内可见完整漏斗数据上报；D1 钩子上线 |
| **M3 调优** | 2 周 | 前 10 章手工难度曲线 + 动态难度逻辑（3.3）+ 全卡池加倍/减半平衡轮 | 首日通过率曲线无悬崖；无弃选率 >80% 的卡 |
| **M4 软启动** | 2 周+ | 1000 人灰度 → 按数据迭代留存与广告位 → 接入正式 SDK | 次留≥35%，人均广告≥2 次/日，崩溃率 <1% |

依赖关系：M1 概念图是全美术资产的前置，**先锁风格再开工**；M2 埋点字段设计已在附录 A 定稿，可与 M1 并行开发。

## 6. 下一步执行顺序（Act 落地清单）

1. ✅ 本计划文档落地（本文档）
2. ✅ P0 音频打包路径修复——**核实已于此前迭代完成**（AudioManager.init 走 `resources.load('audio/ding')`，`assets/resources/audio/ding.mp3` 就位，含兜底与合成降级）
3. ⬜ 附录 B 规格表交美术/AI 产线开工 P0 资产（敌人 5 + 遗物 5 + 卡牌模板 3 + 场景件 6）
4. ✅ 附录 A 埋点接口壳——已落地 `Core/Analytics.ts`（track = console 输出 + localStorage 环形缓冲 ≤200 条，M4 换 SDK 只改 track 内部；自检 `selfcheck-analytics.ts` 全过）
5. ✅ M2 每日任务数据模型——已落地 `Core/DailyTaskManager.ts`（3 条/天、跨日重置覆盖长会话挂后台过夜场景、奖励经 `MetaManager.addShards` 入账碎片；自检 `selfcheck-daily-tasks.ts` 全过；UI 面板与上报挂钩点留 M2 接线）

---

## 附录 A：埋点事件表（挂钩点已映射到现有代码）

抽象层：`Analytics.track(event: string, props?: object)`，先 console 输出 + localStorage 环形缓冲（≤200 条，调试用），M4 换微信/抖音 SDK 同签名替换。**（已落地：`Core/Analytics.ts`，2026-08-31）**

| 事件名 | 字段 | 挂钩点（现有代码位置） | 用途 |
|---|---|---|---|
| `session_start` | ts | MainScene 首个 onLoad | 会话数/DAU |
| `run_start` | chapter, level | ResultDialog 重开入口 / 首局 | 单局漏斗分子 |
| `wave_start` | chapter, level, wave | WaveManager 波次开始 | 进度深度 |
| `wave_clear` | chapter, level, wave, durationSec | WaveManager 波末 | 波难度校准 |
| `run_fail` | chapter, level, wave, castleHpLeft, runDurationSec | ResultDialog GameOver 分支 | **卡点定位 → 动态难度输入** |
| `run_win` | chapter, level, runDurationSec | ResultDialog Victory 分支 | 通过率 |
| `card_offer` | offers: string[3], chapter | RewardDialog 弹出时 | 卡牌曝光 |
| `card_pick` | pickedId, offers, usedRefresh | RewardDialog 选择回调 | 弃选率 → 冷门卡重做 |
| `relic_offer` | types: string[2] | RewardDialog 5/10 关二选一 | 遗物曝光 |
| `shop_view` / `shop_buy` | itemId, price, goldBalance | ShopDialog 打开 / 购买成功回调 | 商店转化与定价 |
| `meta_buy` | upgradeId, toLv, price | MetaManager.buy() 成功分支 | meta 消耗节奏 |
| `run_end` | result, shardsEarned, runDurationSec | MetaManager.grantRunReward() 后 | 单局时长分布（目标 5-10 分钟） |
| `ad_show` / `ad_complete` | placement | M4 广告 SDK 接入后 | 变现漏斗 |
| `daily_task_progress` | taskId, progress, claimed | M2 新增系统 | 任务完成率 |

埋点红线：只带数值与 id，**不采集任何个人身份信息**；事件名与字段名一旦上线不改名（只增不改）。

## 附录 B：美术资产规格表（P0/P1 全量）

**通用规范**
- 格式 PNG-32（透明底）；单图 ≤256KB；源文件存 `assets/art/source/`（不入构建）
- 命名：snake_case，前缀按类别（enemy_/relic_/card_/orb_/fx_/sfx_/bgm_）
- 交付目录：`assets/art/sprites/{enemies,relics,cards,scene,orbs}`；音频 `assets/audio/{sfx,bgm}`
- 图集：Cocos 自动图集按 UI 界面分组（battle / dialog / reward 三组），碎图禁入构建

| 资产 | 文件名 | 尺寸(px) | 数量 | 级别 | 备注 |
|---|---|---|---|---|---|
| 敌人立绘 | enemy_normal / _shield / _speed / _slime / _boss | 128×128 | 5 | P0 | 受击闪白用 tint 不需单独帧；Boss 另需出场待机 2 帧 |
| 遗物图标 | relic_gold_miner / _high_explosive / _thorn / _tidal / _crown | 96×96 | 5 | P0 | 统一金属描边 |
| 卡牌边框 | card_frame_common / _rare / _epic | 240×336 | 3 | P0 | 史诗边框做出"贵"（烫金+光效），锚定感知价值 |
| 卡面图标 | card_icon_<12 张卡 id> | 96×96 | 12 | P0 | 按色板四色语义 |
| 场景背景 | bg_main | 720×1280 | 1 | P0 | 预留顶部 310px 状态区（φ 分割） |
| 钉板框 | pegboard_frame | 720×560 | 1 | P0 | 木钉/乘倍/炸药/刷新钉孔位四态贴图另计 4×32 |
| 城堡 | castle | 128×160 | 1 | P0 | 需血条底座；受击抖动已有 CameraShake |
| 漏斗槽 | funnel_heavy / _ice / _gold | 96×96 | 3 | P0 | 凹陷+光晕可供性设计 |
| 弹珠 | orb_normal / _lightning / _lava / _frost | 64×64 | 4 | P1 | 附带拖尾贴图 1（32×32 渐隐条） |
| 粒子贴图 | fx_dot / fx_spark | 32×32 | 2 | P1 | Cocos 2D 粒子复用，不进图集 |
| 音效 | sfx_peg_hit / _funnel / _fire_normal / _fire_lightning / _fire_lava / _fire_frost / _buy / _win / _lose | mp3/ogg ≤100KB/个 | 9 | P1 | 保留 Web Audio 合成作降级 |
| BGM | bgm_battle / bgm_result | ogg 30-60s 循环 | 2 | P1 | 战斗 1 首、结算 1 首 |

**P0 合计 35 张图**，AI 辅助产线日产能约 8-10 张，M1 两周内含返工可完成。

## 附录 C：历史决策记录

| 日期 | 项 | 结论 |
|---|---|---|
| 2026-08-27 | PROJECT_ANALYSIS.md 标记 P0 音频路径风险 | **已于后续迭代修复**：AudioManager.init() 三层保障（resources.load → 旧路径兜底 → Web Audio 合成降级），该 P0 关闭 |
| 2026-08-31 | 商业化模式 | IAA 为主，IAP 推迟至软启动数据之后 |
| 2026-08-31 | 美术方向 | 蒸汽朋克锻造工坊（主题一致性），奇幻/赛博备选否决 |
| 2026-08-31 | M2 运营基建数据层 | `Core/Analytics.ts`（埋点壳）+ `Core/DailyTaskManager.ts`（每日任务模型）落地，各带纯 Node 自检（selfcheck-analytics / selfcheck-daily-tasks，hook 运行）；每日任务奖励经 `MetaManager.addShards` 入账碎片；任务面板 UI 与进度上报挂钩点留 M2 接线 |
| 2026-09-02 | 构筑闭环 + Meta 树（方向 2/3） | **应答卡**：破盾者/清剿令/猎首契约 3 张，各克制一类新机制（盾/召唤/精英），经 `EnemyController` 静态倍率挂 `takeDamage`，把"敌人侧机制"连回"构筑侧选择"。**Meta 解锁树**：`META_PREREQS` 前置门控，新增子轨 碎片收藏（需开局资金 Lv3，结算碎片 +15%/级）与 战术洞察（需弹珠打磨 Lv3，经 `enforceRarityFloor` 纯函数对三选一施加稀有度地板 Lv1 稀有/Lv3 史诗）；锻造区压缩 6 行、未解锁行显示 🔒 前置。自检 `selfcheck-meta-cards.ts`（24 项），全套 23/23 绿 |

