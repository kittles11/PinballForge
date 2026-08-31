# PinballForge 项目代码地图

> 分析范围：`D:\Cocos\PinballForge\assets`、`assets/scripts`、`assets/scenes`、`assets/prefabs`、`package.json`、`tsconfig.json`、`settings`。
>
> 分析日期：2026-08-27。本文档为只读代码分析结果。本次未修改任何 `.ts`、`.scene`、`.prefab`、`.meta` 或配置文件。
>
> 证据原则：以下结论来自实际读取的源代码和 Cocos 序列化数据。无法由当前文件确认的内容明确写为“无法从当前代码确认”。

## 1. 项目基本信息

| 项目 | 结论 |
|---|---|
| 引擎 | Cocos Creator 3.8.8（`package.json`） |
| TypeScript | `tsconfig.json` 仅继承 `./temp/tsconfig.cocos.json`，项目未锁定 `typescript` 版本；无法从当前代码确认具体 TypeScript 版本 |
| 入口 Scene | `assets/scenes/MainScene.scene`；`settings/v2/packages/scene.json` 当前场景 UUID 为 `8f0f6349-6812-4743-ad71-7f2fdeee0001`，与 MainScene Meta UUID 一致 |
| 渲染/物理 | 2D UI、Graphics、Tween、Audio、Box2D 2D physics；设计分辨率 720×1280，fitHeight=true；碰撞组为 ORB/PEG/WALL/FUNNEL |
| 主要系统 | Launcher、Orb、PegBoard/Peg、Funnel/Turret、Enemy/Wave/Castle、Reward/Shop、Deck/Gold/Relic、EventBus、Audio、CameraShake |
| 完成度 | 核心可玩闭环已具备：瞄准发射、物理弹跳、钉子、漏斗开火、敌人、波次、胜负、奖励、商店、卡组和遗物。内容/数值扩展与部分奖励效果仍是占位或未接入状态。整体约为“可运行原型到早期垂直切片”，精确百分比无法从代码确认。 |

## 2. 完整目录树与文件用途

```text
PinballForge/
├─ package.json                         Cocos 项目元信息，Creator 3.8.8
├─ tsconfig.json                        继承 Cocos 临时 TS 配置，strict=false
├─ settings/
│  └─ v2/packages/
│     ├─ project.json                   720×1280、碰撞组/矩阵
│     ├─ engine.json                    引擎模块，启用 2D/Box2D/Audio/UI/Tween 等
│     ├─ scene.json                     当前场景 UUID
│     ├─ builder.json                   构建器版本元数据
│     ├─ device.json                    设备包元数据
│     ├─ program.json                   程序包元数据
│     ├─ information.json               Splash 配置状态
│     └─ cocos-service.json             Cocos 服务配置
└─ assets/
   ├─ audio/hit.wav(.meta)              音频素材；代码碰撞音实际硬编码使用 assets/ding.mp3
   ├─ ding.mp3(.meta)                   碰撞音素材（文件在 assets 根目录）
   ├─ prefabs/
   │  ├─ Orb.prefab(.meta)              默认弹珠：Sprite/RigidBody2D/CircleCollider2D/OrbController/AudioSource
   │  ├─ Enemy.prefab(.meta)            敌人：Sprite/EnemyController
   │  ├─ Peg.prefab(.meta)              钉子：Sprite/RigidBody2D/CircleCollider2D/PegComponent/AudioSource
   │  ├─ LavaOrb.prefab.prefab(.meta)   旧/专用熔岩外观 Prefab，OrbController orbType=2
   │  └─ LightningOrb.prefab.prefab(.meta) 旧/专用雷球外观 Prefab，OrbController orbType=1
   ├─ scenes/
   │  └─ MainScene.scene(.meta)         唯一实际场景，包含游戏主层级和 UI
   └─ scripts/
      ├─ Core/                           全局数据、事件、资源和状态
      ├─ Battle/                         城堡、敌人、炮塔、波次
      ├─ Game/                           输入发射器和 HUD Label
      ├─ Pinball/                        弹珠、钉子、钉板、漏斗
      └─ UI/                             奖励、商店、结算、遗物栏
```

`.meta` 文件主要提供 Cocos UUID。脚本 UUID 与场景中的自定义 `__type__` 对应；Prefab Meta UUID 与场景/脚本 Prefab 引用共同构成资源关系。目录 Meta 仅为 directory importer，没有额外运行逻辑。

## 3. Script 清单

### Core

| 文件 / 类 | 职责、依赖与调用关系 | 方法 / 字段 / 事件 / 问题 |
|---|---|---|
| `Core/EventBus.ts` / `GameEventBus` | `cc.EventTarget` 的类型安全薄封装；所有主要系统依赖它 | public `on/once/off/emit/targetOff`；`GameEvents` 和 `GameEventMap` 是全局事件契约；无 TODO |
| `Core/DataModels.ts` / 数据接口、枚举、数据库 | 定义 `GamePhase`、`OrbType`、`FunnelType`、`PegType`、`RelicType`、Wave/Card/Relic 数据；提供 `CARD_DATABASE`、`RELIC_DATABASE` | 纯数据，无类方法；卡牌库 12 张，遗物库和球种定义在此；部分卡牌描述与实际动作不一致，见未完成/潜在问题 |
| `Core/AudioManager.ts` / `AudioManager` | 静态音频系统；初始化 5 个 HTML5 Audio 播放器，Web Audio 合成炮塔/攻击/爆炸音；被 Orb、Castle、Shop、事件系统使用 | public `init/unlockAudio/wire/playHitSound/playMonsterAttack/playCastleExplode/playFire`；private `playTone/vol`；监听 `ORB_HIT_PEG/FIRE_TURRET/ATTACK_CASTLE`；硬编码 `assets/ding.mp3`，打包路径风险 |
| `Core/CameraShake.ts` / `CameraShake` | 相机震屏单例；响应开火、城堡受击、GameOver，模态期间锁定 | public static `shake`；private 事件回调；监听 `FIRE_TURRET/ATTACK_CASTLE/GAME_OVER/UI_MODAL_CHANGED`；onDestroy 已注销 |
| `Core/DeckManager.ts` / `DeckManager` | 维护 0/1/2/3 类型卡组、抽牌堆、弃牌堆，初始牌组 6 颗、软上限 8 | public `addOrbToDeck/canAddOrb/getDeckSize/removeOrbFromDeck/getOrbCount/peekNextOrbType/drawNextOrbType/discardOrbType`；private `updateDeckLabel/shuffle`；Launcher 抽牌、Orb 回收、Reward/Shop 增删；`start` 才初始化，早于 start 的调用无法确认是否安全 |
| `Core/GoldManager.ts` / `GoldManager` | 单例金币余额，监听并转发 GAIN_GOLD | public `addGold/spendGold/getGold/resetGold`；private `onGainGold`；其自身广播带 total，避免二次累加；外部无 total 事件由管理器累加 |
| `Core/LevelManager.ts` / `LevelManagerClass` | 50 章×10 关×3 波、本地 localStorage 进度和波次数值生成 | `loadFromSave/getWaveConfig/nextLevel/isFinalBattle/getProgressText/resetProgress`；private `save`；WaveManager/RewardDialog/ResultDialog 使用；`nextLevel` 在最终章节封顶后仍可从终章末关进入 50-1，设计意图需确认 |
| `Core/OrbBalance.ts` / `OrbBalance` | Normal/Lightning/Lava 战斗配置和跨波运行时升级入口 | static `applyUpgrade/reset/configFor`；默认 Normal 40/15、Lightning 40/15/15°/3 发、Lava 40/60/scale1.4/gravity2/density2；`Frost` 没有专属 config |
| `Core/RelicManager.ts` / `RelicManagerClass` | 遗物集合、唯一性、被动查询和 RelicBar 自举挂载 | `addRelic/hasRelic/getRelics/resetRelics/effectiveBombRadius`；监听 director 场景启动而非 EventBus；调用 Orb/Peg/Enemy/Castle/Reward/Shop/UI；依赖固定 `Canvas/UILayer` 路径 |

### Battle

| 文件 / 类 | 职责、依赖与调用关系 | 方法 / 字段 / 事件 / 问题 |
|---|---|---|
| `Battle/CastleController.ts` / `CastleController` | 城堡 HP/护盾、受击动画、GameOver | public `onCastleAttacked/addShield/increaseMaxHp/heal`；private `onCastleDestroyed/fadeOutSprite/updateDisplay`；监听 `ATTACK_CASTLE`，触发 `GAME_OVER`；Inspector `maxHp=100`、`hpLabel` 可能为空但有 find 兜底 |
| `Battle/EnemyController.ts` / `EnemyController` | 敌人移动、到防线攻击、受击类型效果、死亡、血条 | public `takeDamage/freeze`、`isDead`；private `lungeAttack/die/createHpBar/updateHpBar/celebrate` 等；监听 `GAME_OVER`；依赖 EnemyManager、RelicManager、Castle 通过事件；Prefab 默认 HP100、速度20，Wave 会覆盖 |
| `Battle/EnemyManager.ts` / `EnemyManager` | 存活敌人注册、注销、选最靠前目标 | public `registerEnemy/unregisterEnemy/getFrontEnemy`；private `prune`；TurretController 和 EnemyController 使用；无 EventBus |
| `Battle/TurretController.ts` / `TurretController` | 监听 FIRE_TURRET，生成三色 Graphics 子弹并命中锁定目标 | private `onFire/resolveTarget/launchBullet/createBulletNode/playRecoil`；依赖 EnemyManager，Inspector 可选；监听 `FIRE_TURRET`；Fallback 路径为 `Canvas/BattleLayer/EnemyContainer/Enemy` |
| `Battle/WaveManager.ts` / `WaveManager` | 生成敌人、统计击杀、展示奖励、推进波次/关卡、终局胜利 | public `startWave`；private `spawnOne/createEnemyNode/onEnemyKilled/onRewardSelected/onGameOver`；监听 `ENEMY_KILLED/REWARD_SELECTED/GAME_OVER`；enemyPrefab 缺失时用场景模板或运行时红点怪兜底 |

### Game

| 文件 / 类 | 职责、依赖与调用关系 | 方法 / 字段 / 事件 / 问题 |
|---|---|---|
| `Game/LauncherController.ts` / `LauncherController` | 触摸拖拽瞄准、方向限制、轨迹线、卡组抽球、雷球分裂、发射冷却和同屏上限 | public 生命周期；private `checkConfig/registerInput/unregisterInput/updateAim/.../fireLightningBurst/fireOrb/countAliveOrbs`；监听 `UI_MODAL_CHANGED/GAME_OVER/GAME_VICTORY`；Inspector `orbPrefab/launcherNode/trajectoryGraphics` 是核心潜在 null 点 |
| `Game/EnergyLabelController.ts` / `EnergyLabelController` | UPDATE_ENERGY 刷新能量 HUD | private `onUpdateEnergy`；监听 `UPDATE_ENERGY`，固定路径找 `EnergyLabel`，注销完整 |
| `Game/GoldLabelController.ts` / `GoldLabelController` | GAIN_GOLD 刷新金币 HUD和 Punch | private `onGainGold`；监听 `GAIN_GOLD`；固定位置 x=210,y=590 |

### Pinball

| 文件 / 类 | 职责、依赖与调用关系 | 方法 / 字段 / 事件 / 问题 |
|---|---|---|
| `Pinball/OrbController.ts` / `OrbController` | 物理弹珠生命周期、球种初始化、撞钉加能量、磁力、入槽、回收和安全清场 | public `initOrbType/triggerFunnelAndDestroy/recycleAllOrbs`；private 接触、类型检测、冻结全敌人、反馈、保底结算；触发 `UPDATE_ENERGY/FIRE_TURRET/GAIN_GOLD`；空实现 `applyAreaDamage/applyBurn`；Frost 类型文档/逻辑存在但基础 Prefab/OrbBalance 不完整 |
| `Pinball/FunnelSlot.ts` / `FunnelSlot` | Collider BEGIN_CONTACT 识别 Orb 并委托入槽，播放吞球反馈 | private `onBeginContact/processOrb/playSwallowFeedback/themeColor`；Orb 触发 FIRE_TURRET/金币并销毁；Inspector `funnelType` |
| `Pinball/PegComponent.ts` / `PegComponent` | 钉子受击计数、力竭、爆炸、刷新、重置和升级乘倍钉 | public `onHit/resetPeg/setPegType/upgradeToMultiplier`，static `resetAllPegs/upgradeRandomNormalPegs`；依赖 CameraShake/RelicManager；不直接触发 EventBus；默认每轮 3 次、Bomb 半径下限120 |
| `Pinball/PegBoardManager.ts` / `PegBoardManager` | 3 种 21 钉版型随机生成，每波奖励后重排 | public `generateBoard`；private `onRewardSelected`；监听 `REWARD_SELECTED`；Inspector `pegPrefab` 是核心引用；bomb=1、refresh=1、multiplier=1~3 |

### UI

| 文件 / 类 | 职责、依赖与调用关系 | 方法 / 字段 / 事件 / 问题 |
|---|---|---|
| `UI/RewardDialog.ts` / `RewardDialog` | 常规卡牌三选一、5/10 关遗物二选一、应用奖励并推进 | public `showRewards`；private `showRelicChest/bindCard/setCardLabel/selectReward/applyReward/advanceToNextLevel` 等；监听 `SHOW_REWARDS`，发 `UI_MODAL_CHANGED/REWARD_SELECTED`；部分卡牌只日志占位 |
| `UI/ShopDialog.ts` / `ShopDialog` | 纯代码构建战后商店：买球、删普通球、修城堡、买遗物、Tab、继续 | private `ensureReady/buildUI/openShop/refreshUi/onBuy.../onContinue` 等；监听 `SHOW_SHOP`，发 `UI_MODAL_CHANGED/REWARD_SELECTED`；按钮主要 Inspector 可选，缺失时动态构建 |
| `UI/ResultDialog.ts` / `ResultDialog` | GAME_OVER/GAME_VICTORY 结算弹窗，重置静态状态并重载当前场景 | public `showResult`；private `onGameOver/onGameVictory/onRestartClick/playPopAnimation`；监听两个终局事件；Inspector `titleLabel/descLabel/restartBtn` 有空防护 |
| `UI/RelicBarController.ts` / `RelicBarController` | 动态绘制已拥有遗物横栏，无遗物时显示占位 | private `onRelicChanged/rebuild/addPlaceholder/createTile/makeLabel`；监听 `RELIC_CHANGED`；由 RelicManager 动态创建，最大数量注释为5但数据侧遗物数量上限无法确认 |

## 4. 游戏核心架构（代码确认的调用关系）

```text
MainScene
├─ LauncherController
│  ├─ DeckManager.drawNextOrbType()
│  └─ instantiate Orb.prefab → OrbController.initOrbType()
│       ├─ OrbController.onBeginContact → PegComponent.onHit()
│       │    ├─ UPDATE_ENERGY → EnergyLabelController
│       │    └─ ORB_HIT_PEG → AudioManager
│       └─ FunnelSlot.onBeginContact
│            └─ OrbController.triggerFunnelAndDestroy()
│                 └─ FIRE_TURRET → TurretController
│                      └─ EnemyManager.getFrontEnemy()
│                           └─ EnemyController.takeDamage()
│                                └─ ENEMY_KILLED → WaveManager
├─ PegBoardManager → Peg.prefab → PegComponent
├─ WaveManager
│  ├─ LevelManager.getWaveConfig()
│  ├─ Enemy.prefab / 场景模板 / 运行时兜底敌人
│  └─ ENEMY_KILLED 全灭 → SHOW_REWARDS 或 GAME_VICTORY
├─ CastleController
│  └─ ATTACK_CASTLE ← EnemyController.lungeAttack()
│       └─ GAME_OVER → ResultDialog / Launcher / Enemy / CameraShake
├─ RewardDialog → applyReward() → Deck/Castle/Enemy/Peg/Gold/Relic
│  └─ 关闭后 REWARD_SELECTED → WaveManager.startWave()
└─ ShopDialog → GoldManager/DeckManager/Castle/RelicManager
   └─ 继续后 REWARD_SELECTED
```

## 5. EventBus 事件

| 事件 | 触发者 | 监听者 | 时机 / 参数 |
|---|---|---|---|
| `ORB_HIT_PEG` | 当前无业务监听；OrbController | 无 | 撞钉，`{pegId,orbId,points,hitCount}`；声音走独立 wire |
| `ORB_ENTER_FUNNEL` | EventMap 已定义，但当前代码未发现实际 emit | 无 | `{orbId,funnelId}`；未接入 |
| `UPDATE_ENERGY` | OrbController | EnergyLabelController | 每次有效撞钉，number 为累计伤害/能量 |
| `FIRE_TURRET` | OrbController | TurretController、AudioManager、CameraShake | 入槽，`{damage,type}` |
| `ATTACK_CASTLE` | EnemyController | CastleController、AudioManager、CameraShake | 到防线攻击，`{damage}` |
| `GAIN_GOLD` | OrbController、RewardDialog、WaveManager、GoldManager.add/spend | GoldManager、GoldLabelController、AudioManager（wire） | `amount`，可含 `total`；金币槽+20、黄金遗物每球命中钉+1 |
| `WAVE_START` | 当前未发现 emit | 当前未发现监听 | EventMap 定义 `{config}`，但实际波次通过直接调用 `startWave` |
| `ENEMY_KILLED` | EnemyController.die | WaveManager | 死亡时携带 EnemyController 实例 |
| `GAME_OVER` | CastleController | ResultDialog、LauncherController、EnemyController、WaveManager、CameraShake | HP归零；无参数 |
| `GAME_VICTORY` | WaveManager | ResultDialog、LauncherController | 50-10 第3波全灭；无参数 |
| `SHOW_REWARDS` | WaveManager | RewardDialog | 波次全灭且非终局；无参数 |
| `SHOW_SHOP` | RewardDialog/Shop 流程中应触发，但 RewardDialog 当前代码主要直接推进；实际触发链需结合 ShopDialog 完整下半段运行确认 | ShopDialog | 无参数；是否每次奖励后必达需重点验证 |
| `REWARD_SELECTED` | RewardDialog、ShopDialog | WaveManager、PegBoardManager | 选择奖励/商店继续；无参数 |
| `UI_MODAL_CHANGED` | RewardDialog、ResultDialog、ShopDialog | LauncherController、CameraShake | boolean；打开冻结发射、免震屏 |
| `RELIC_CHANGED` | RelicManager | RelicBarController | 当前遗物数组 |
| `RELIC_ACQUIRED` | RelicManager | 当前未发现监听 | 新遗物类型 |

生命周期检查：大多数 Component 在 `onDestroy` 用 `off` 或 `targetOff`。已确认的异常风险是 `RelicManager` 在模块构造时直接 `director.on`，没有显式全局注销；它是常驻模块，场景重载期间可能重复/长期持有回调。RewardDialog/ShopDialog 使用 `onEnable` 幂等标志，逻辑上避免重复监听。GameOver/Victory 后，Launcher、WaveManager、Enemy 均有锁，但 `ORB_HIT_PEG` 等异步/帧尾回调是否完全阻断只能在运行时确认。

## 6. MainScene.scene 分析

### 层级

```text
MainScene
├─ Canvas
│  ├─ Camera (CameraShake、Camera 等)
│  ├─ Background
│  ├─ WallLayer
│  │  ├─ LeftWall
│  │  ├─ RightWall
│  │  └─ TopWall
│  ├─ BattleLayer
│  │  ├─ Turret (TurretController)
│  │  └─ EnemyContainer (EnemyManager、WaveManager、可作为 Enemy 模板)
│  ├─ UILayer
│  │  ├─ CastleHpLabel
│  │  ├─ EnergyLabel
│  │  ├─ WaveLabel
│  │  ├─ GoldLabel
│  │  ├─ DeckLabel
│  │  ├─ RewardDialog/CardA/CardB/CardC
│  │  ├─ ShopDialog
│  │  └─ ResultDialog/TitleLabel/DescLabel/RestartButton
│  ├─ PegboardLayer/PegContainer
│  ├─ FunnelLayer/Funnel_A/Funnel_B/Funnel_C/Divider_Left/Divider_Right
│  └─ LauncherNode/TrajectoryGraphics
```

场景中还存在按 UUID 挂载的脚本组件：`CastleController`、`EnemyManager`、`TurretController`、`WaveManager`、`CameraShake`、`DeckManager`、`GoldManager`、`PegBoardManager`、`FunnelSlot`、`OrbController`/`PegComponent` 相关 Prefab 组件、`LauncherController`、Energy/Gold Label、Reward/Shop/Result UI。场景序列化中的具体自定义类型通过对应 `.ts.meta` UUID 交叉确认。

### Inspector 与潜在 null

- `TurretController.enemyManager` 可空，代码会从父节点子孙搜索。
- `WaveManager.enemyPrefab` 可空，有模板和运行时红点兜底；但兜底节点只添加 `EnemyController`，缺 Sprite 时功能仍可运行。
- `PegBoardManager.pegPrefab` 无有效 Prefab 时 `generateBoard()` 直接返回，可能没有钉板。
- `LauncherController.orbPrefab`、`trajectoryGraphics` 是发射和瞄准核心；代码对缺失 Prefab 有警告，但无法发射。
- `CastleController.hpLabel`、Energy/Gold Label、RewardDialog 三张卡、ResultDialog 三个引用都有不同程度的 find/空防护；Reward/Shop 的动态 UI 可以补充部分引用。
- Funnel 节点必须具有 `Collider2D`，否则 `FunnelSlot.start` 不会注册碰撞。
- 场景墙体采用组 8，设置中的碰撞矩阵声明 WALL 为 index 3（位掩码应为 8），与场景数据一致；Orb/PEG/FUNNEL 组也需依赖矩阵实际运行验证。

## 7. Prefab 分析

| Prefab | Component → Script | Inspector/资源关系 |
|---|---|---|
| `Orb.prefab` | UITransform 24×24、Sprite（蓝色 SpriteFrame）、RigidBody2D dynamic/bullet/gravity1/group2、CircleCollider2D r12/group1、OrbController orbType0、AudioSource | LauncherController 的 `orbPrefab` 应引用它；OrbController 动态变成雷/熔岩/冰球；Prefab 内 hitClip=null，碰撞声实际由 AudioManager HTML5 播放 |
| `Enemy.prefab` | UITransform 48×48、红 Sprite、EnemyController | 默认 maxHp100、moveSpeed20、defenseLineX=-200；WaveManager 优先 instantiate；EnemyController 动态生成血条 |
| `Peg.prefab` | UITransform32×32、Sprite、RigidBody2D static/group4、CircleCollider2D r16/group4、PegComponent pegType0/maxHits3、AudioSource | PegBoardManager 每波 instantiate 后调用 `setPegType`；需保证场景/设置中的 PEG 碰撞位正确 |
| `LavaOrb.prefab.prefab` | 与 Orb 类似，OrbController orbType2；Sprite 橙红；gravityScale1.8 | 当前 Launcher 使用单一 `orbPrefab` 动态赋型，代码未发现直接引用此专用 Prefab |
| `LightningOrb.prefab.prefab` | 与 Orb 类似，OrbController orbType1；Sprite 青色 | 当前 Launcher 使用单一 `orbPrefab` 动态赋型，代码未发现直接引用此专用 Prefab |
| Funnel/Turret/UI/Boss/Projectile | 未发现独立对应 Prefab 文件；Funnel、Turret、UI、Projectile 多由 MainScene 或运行时 Node/Graphics 构成；Boss 由 EnemyPrefab/模板 + WaveDef scale=2.2 动态生成 | 用户要求的 Boss/Projectile Prefab：无法从当前代码确认存在独立资源 |

## 8. 当前完整游戏流程

1. MainScene 加载，单例/组件建立；`DeckManager.start` 初始化 3 普通+雷+熔岩+冰的 6 球牌库，`PegBoardManager` 生成 21 颗钉子，`WaveManager` 开始第1波。
2. `LauncherController` 接收触摸，限制向下角度 -165°~-15°，绘制虚线；松手后检查弹珠数量≤4、冷却0.2s、模态/终局锁，再抽取球型。
3. 生成 Orb Prefab，入树前 `initOrbType`；普通/熔岩单发，雷球默认对称3连发，中间为主球，副球不回收牌库。
4. 弹珠在 Box2D 中与墙/钉子碰撞；撞钉后 PegComponent 计数、动画/类型效果，Orb 增加伤害/能量并广播 HUD，黄金矿工遗物可每钉+1且单球上限8。
5. 弹珠经 FunnelSlot 物理接触或 y<-380 保底入槽；按槽位重炮/急冻/金币计算，发 `FIRE_TURRET`，金币槽立即+20，回收主球类型并销毁。
6. Turret 监听开火，创建红/蓝/金 Graphics Projectile，0.12s 飞向开火时锁定的最前敌人；EnemyController 按槽位结算重炮×2、急冻3s、金币白闪。
7. Enemy 向左移动到防线，之后每1秒头槌广播 ATTACK_CASTLE；Castle 先扣护盾再扣HP，HP≤0 播放爆炸并 `GAME_OVER`。
8. Enemy 死亡广播 `ENEMY_KILLED`；WaveManager 全灭后回收残余弹珠，通常打开奖励；第50章第10关第3波全灭直接 `GAME_VICTORY`。
9. RewardDialog 常规展示3张卡；第5/10关最后波展示未拥有遗物二选一。应用卡牌后重置钉子、发 `REWARD_SELECTED`。
10. ShopDialog 负责买球、删球、修城堡、买遗物；继续时关闭模态并发 `REWARD_SELECTED`。WaveManager 进入下一波或 `LevelManager.nextLevel()` 后下一关第1波。
11. 结算 ResultDialog 在 GameOver/Victory 显示；再来一局重置 Enemy/OrbBalance/Gold/Relic/Level/Shop 静态状态并 reload 当前场景。

## 9. 已实现功能分级

- **P0 核心玩法**：触摸瞄准发射；Box2D 弹跳；21 钉随机版型；钉子受击/力竭；三类漏斗；炮塔命中敌人；敌人推进和攻击城堡；GameOver/Victory。
- **P1 战斗**：三槽伤害差异；重炮双伤害；急冻定身；敌人 HP 条；Boss 波次数值和缩放；城堡护盾；荆棘反伤；震屏与攻击/爆炸反馈。
- **P2 Roguelite**：6 球初始牌库、抽弃循环、8 球上限；三选一卡牌；5/10 关遗物宝箱；遗物唯一持有；商店买球/删球/买遗物；章节进度 localStorage。
- **P3 UI**：城堡/能量/金币/波次/牌库 HUD；奖励弹窗；动态商店与 Tab；结算弹窗；遗物栏；按钮/遮罩/弹性动画。
- **P4 Audio**：撞钉 5 声道 HTML5 pool；Web Audio 炮塔三类、怪物攻击、城堡爆炸；浏览器手势解锁。
- **P5 Polish**：弹珠卡死检测/12秒超时；副球减负；目标锁定避免隔空打怪；血条；颜色反馈；GameOver 后冻结；残球安全回收。

## 10. 未完成/占位系统

- `OrbController.applyAreaDamage`、`applyBurn` 是空实现，明确标注为未来范围伤害/灼烧入口。
- `DataModels` 的 `lava_core` 描述范围溅射，但 RewardDialog 对其只执行 `AddOrb`，没有真正范围伤害。
- `lightning_rage` 描述升级为5连发，但 RewardDialog 只输出日志，实际仍为 `OrbBalance.lightning.splitCount=3`。
- `lightning_combo` 描述8连击免费追发，但当前代码未发现完整免费追发实现；`OrbController` 只有 `_comboBurstFired` 字段，实际行为需进一步核实，倾向未完成。
- `OrbBalance` 声明多个 `OrbUpgradeId`，但当前奖励未统一通过 `applyUpgrade` 接入。
- `WAVE_START`、`ORB_ENTER_FUNNEL`、`RELIC_ACQUIRED` 已定义事件契约，但当前未发现完整触发/监听链。
- 专用 Lava/Lightning Prefab 存在，但主发射器采用单一 Orb Prefab 动态赋型；专用资源是否保留为未来内容无法确认。
- 独立 Funnel、Turret、Projectile、Boss Prefab 不存在；大多是场景节点或运行时 Graphics/动态 Enemy。
- `hit.wav`、Prefab 内 AudioSource 的 `hitClip=null` 与 AudioManager 的 `ding.mp3` 方案并存，资源体系未统一。

## 11. 潜在 Bug

### P0：可能导致核心功能无法运行

1. **钉板为空**：`assets/scripts/Pinball/PegBoardManager.ts` 的 `generateBoard()` 在 `pegPrefab` 无效时直接返回。现象是开局没有钉子、Orb 只下落。建议确认 MainScene 的 PegBoardManager.pegPrefab 是否绑定 `Peg.prefab`。
2. **弹珠无法发射**：`assets/scripts/Game/LauncherController.ts` 的 `fireOrb()` 依赖 `orbPrefab` 和其中的 `RigidBody2D`。缺任一引用会只警告不发射。建议在 Inspector/启动校验中确认 `Orb.prefab` 引用。
3. **漏斗不结算**：`assets/scripts/Pinball/FunnelSlot.ts` 只有在 `Collider2D` 存在时才注册 BEGIN_CONTACT。建议确认三个 Funnel 节点均有正确 Collider、sensor 和 FUNNEL 碰撞组。

### P1：严重逻辑风险

1. **金币事件自循环设计复杂**：`GoldManager.addGold()` 发 `GAIN_GOLD`，自身监听同事件并依赖 `total` 字段避免二次累加；任何带错误 total 的外部事件可能导致余额与 UI 不一致。建议将“命令”和“通知”分离，或统一只由 GoldManager 写余额。
2. **Reward→Shop 转场不透明**：`WaveManager` 发 `SHOW_REWARDS`，RewardDialog 选择后直接 `REWARD_SELECTED`；用户需求描述的奖励后自动商店与 EventBus 中 `SHOW_SHOP` 存在，但当前已读流程中触发链不完全清晰。建议运行时逐波验证是否每次奖励后都打开 Shop，不能仅凭事件名假设。
3. **数据描述与实际效果不一致**：`DataModels.ts` 的 `lightning_rage/lava_core/lightning_combo` 和 RewardDialog 实现不一致，玩家会看到未兑现的卡牌描述。建议要么接入升级，要么修改数据描述（本次未修改）。
4. **终章进度边界**：`LevelManager.nextLevel()` 在 50-10 后不会再走 Victory 的正常路径以外推进，但 `isFinalBattle()` 只判断当前是否处于终章末关；建议测试终章奖励、胜利与重开边界。

### P2：潜在问题

1. **音频 Web 构建路径**：`Core/AudioManager.ts:init` 硬编码 `new Audio('assets/ding.mp3')`；注释已承认打包后可能 404。建议改为 Cocos resources/AudioSource 资源管线。
2. **全局 director 监听未注销**：`Core/RelicManager.ts` 构造函数注册 `Director.EVENT_AFTER_SCENE_LAUNCH`，模块没有销毁路径。场景反复重载时可能保留全局引用/回调。建议确认 director API 的全局监听语义并提供一次性/可注销管理。
3. **物理组需实际运行验证**：设置矩阵和 Prefab/Scene 的 `_group` 使用位掩码，Orb/PEG/WALL/FUNNEL 的碰撞关系若有一个位不一致会表现为穿透或无碰撞。建议使用 Cocos Physics Debug 检查。
4. **固定路径脆弱**：`EnemyController`、`TurretController`、`OrbController`、HUD 和 `RelicManager` 多处依赖 `Canvas/...`。改名或换场景会导致静默失效。建议后续统一 Inspector 引用或集中路径常量。
5. **动态 UI 尺寸/设计分辨率不一致风险**：Shop 使用 960×640 遮罩与 620×780 面板，而项目 designResolution 为720×1280；是否适配所有设备无法从静态文件确认。

### P3：代码质量问题

1. `CastleController.onCastleAttacked(data: any)` 放弃了 EventBus 的类型安全，应使用事件映射类型。
2. 多处存在硬编码路径、颜色、坐标和价格；虽然当前原型便于调参，但长期维护成本高。
3. `DataModels`、`OrbController`、`LauncherController` 对球型编号存在重复导出/兼容常量，增加漂移风险。
4. 未发现测试文件、测试脚本或自动化运行校验；行为只能依靠编辑器/运行时验证。

## 12. 数值系统

| 系统 | 当前数值 | 定义位置 |
|---|---|---|
| Orb | Normal damage40/energy15；Lightning damage40/energy15/scatter15°/3；Lava damage40/energy60/scale1.4/gravity2/density2；Frost 入急冻槽全敌4s；最大存活12s、卡球1.8s、速度阈值15、保底 y=-380 | `Core/OrbBalance.ts`、`Pinball/OrbController.ts` |
| Peg | 3次受击力竭；Multiplier×2；Bomb半径下限120；板宽720、高560、边距16；每板21颗 | `Pinball/PegComponent.ts`、`PegBoardManager.ts` |
| Funnel | x<-80重炮，x>80金币，中间急冻；金币+20 | `OrbController.ts`、`DataModels.ts` |
| Turret/Projectile | 飞行0.12s；后坐力20；无目标终点x=360；重炮半径16，冰/金币半径12 | `Battle/TurretController.ts` |
| Enemy | 默认HP100/速度30/防线-180/攻击间隔1s/伤害10；Prefab默认速度20、防线-200；急冻3s；血条46×8 | `EnemyController.ts`、`Enemy.prefab` |
| Boss | 基础HP140×章节1.15指数×关卡1+8%×4.5；体型2.2；终章每章第10关第3波 | `Core/LevelManager.ts` |
| Castle | maxHp/currentHp默认100；护盾先吸收，无上限；王者之冕开局+15护盾、关卡结算+30金币 | `CastleController.ts`、`RelicManager.ts` |
| Wave | 每关3波；数量3/4/1；间隔0.8/0.6/0；精英HP×2.5；50章×10关 | `LevelManager.ts`、`WaveManager.ts` |
| Reward | 三选一；5/10关遗物二选一；卡牌 Heal35/MaxHP25/Gold60/IceShield30/Heavy或Ice+50% 等 | `DataModels.ts`、`RewardDialog.ts` |
| Gold | 初始0；金币槽+20；黄金矿工每钉+1、单球上限8；商店闪电/熔岩110、删卡80+25阶梯、维修50、遗物220 | `GoldManager.ts`、`OrbController.ts`、`ShopDialog.ts` |

## 13. 游戏设计分析

- **核心玩法**：玩家通过角度控制发射弹珠，让弹珠在钉板上产生尽可能多的撞击/能量，最后选择漏斗，把本轮能量转成不同类型的炮塔攻击。
- **玩家循环**：瞄准 → 发射 → 撞钉积累 → 选漏斗 → 炮塔打怪/金币 → 敌人推进 → 清波 → 选奖励/逛商店 → 新钉板/下一波。
- **Build 系统**：已有三种弹珠类型、三种漏斗、特殊钉子、卡牌和遗物。卡组已经是可循环的类型池，但真实升级仍有部分未接入。
- **Roguelite**：有单局遗物、战后随机卡、商店消费、章节进度存档和重开重置；尚未看到随机地图、事件、路线、永久解锁或跨局 meta progression。
- **成长系统**：当前主要是单局卡组增球、重炮倍率、护盾、HP、钉子升级、遗物；敌人数值按章节/关卡公式增长。长期养成和内容解锁无法从当前代码确认。
- **内容量**：1 个 MainScene、5 个 Prefab、12 张卡牌、遗物数据库、3 种钉板版型、3 波/关、50×10 算法生成关卡；视觉内容主要复用少量 Sprite 和运行时 Graphics。
- **最大短板**：设计数据已经超前于实际行为，多个卡牌/升级只展示或日志未生效；资源、场景绑定和固定路径也使运行可靠性依赖 Inspector 配置。

## 14. 下一阶段开发建议

### P0

1. **验证并固化 MainScene 所有核心引用和碰撞矩阵**。原因：没有 Peg/Orb/Funnel 绑定就无法玩；涉及 MainScene、`PegBoardManager`、`LauncherController`、`FunnelSlot`、settings project/engine。新增 Inspector 校验或运行时诊断；会影响启动顺序和物理；难度中；直接提升可运行率。
2. **补一条最小可重复运行验收清单/自检**。原因：当前无测试；覆盖发射→入槽→开火→击杀→奖励→下一波→GameOver。涉及全部核心脚本但不必立即重构；难度中；能阻止后续功能回归。
3. **修复音频资源打包路径**。原因：当前代码注释明确指出 Web 构建可能 404；涉及 `AudioManager.ts`、`ding.mp3`、音频资源配置；可能替换播放适配器；难度中；保证核心反馈在正式构建可用。

### P1

1. **兑现或下线三类未实现卡牌效果**。原因：玩家 Build 选择必须真实改变策略；涉及 `DataModels.ts`、`RewardDialog.ts`、`OrbBalance.ts`、`OrbController.ts`、`EnemyController.ts`；新增连锁/范围/追发状态；会影响伤害、金币和波次平衡；难度中高；提升 Build 可信度。
2. **把 GoldManager 的写入与通知分开**。原因：当前同事件自监听易产生重复/顺序 bug；涉及 `GoldManager.ts`、Orb/Reward/Shop/UI；新增单一写入口或专用余额变更事件；会影响所有金币来源；难度中；提升经济系统稳定性。
3. **验证 Reward→Shop→下一波实际事件时序**。原因：事件契约存在但链路不够直观；涉及 `RewardDialog.ts`、`ShopDialog.ts`、`WaveManager.ts`、`UI_MODAL_CHANGED`；可能新增明确 SHOW_SHOP 状态；影响输入冻结和波次推进；难度中；避免奖励/商店卡死。
4. **统一 Inspector 引用与固定路径兜底策略**。原因：改名即静默失效；涉及 MainScene、Launcher/Turret/Relic/HUD；新增集中引用或场景上下文；影响场景装配；难度中；提升维护和扩展能力。

### P2

1. **扩展内容数据而非继续硬编码关卡公式**。原因：当前50×10只是公式，实际敌人种类和场景变化少；涉及 DataModels、LevelManager、EnemyController、WaveManager；新增敌人类型、Boss 行为、关卡配置；影响存档兼容和平衡；难度高；提升重复游玩。
2. **补足遗物交互反馈和上限规则**。原因：已有 RelicBar 和被动查询，但玩家无法从代码确认数量/叠加规则；涉及 RelicManager、RelicBar、Shop/Reward；新增说明、上限和状态反馈；影响 UI 布局；难度中；提升策略可读性。
3. **统一专用 Orb Prefab 与动态 Orb 架构**。原因：Lava/Lightning 专用 Prefab 当前似乎未被主流程使用；涉及三个 Prefab、Launcher、OrbController、Meta 引用；选择一种资源策略并清理冗余；影响美术和 Inspector；难度中；减少资产歧义。

### P3

1. **增加正式测试、调试面板和物理可视化开关**。原因：当前完全依赖手工运行；涉及 package/scripts 或 Cocos 调试配置；不能安装第三方库；难度中；提升开发效率。
2. **补充 UI/音频/受击表现和真实 Boss/Projectile 资源**。原因：当前大量运行时 Graphics/占位路径；涉及 MainScene、UI、Prefab、Audio；影响渲染层和资源导入；难度中高；提升完成度和产品化观感。

## 15. 禁止事项与最终一致性检查

- 本次没有修改任何游戏 `.ts`、`.scene`、`.prefab`、`.meta`、`package.json`、`tsconfig.json` 或 `settings` 文件。
- 未安装第三方库，未进行重构，未调整游戏数值。
- 已读取并核对：24 个 TypeScript、1 个 MainScene、5 个 Prefab、对应 Meta、`package.json`、`tsconfig.json`、settings v2 包配置。
- `settings/` 顶层没有直接的 `editor.json/packages.json` 等文件，实际配置位于 `settings/v2/packages/`，本文档按实际目录记录。
- TypeScript 具体版本、实际运行帧序/平台表现、Inspector 中某些引用在运行时是否有效：无法从当前代码确认。
- 本文档自身路径：`D:\Cocos\PinballForge\PROJECT_ANALYSIS.md`。