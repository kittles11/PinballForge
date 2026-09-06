/**
 * 物理警告 × 灰钉穿透 × 奖励死锁 × 渲染互斥 四联修复自检（纯 Node，无引擎依赖）——
 *   node --experimental-transform-types selfcheck-contact-fix.ts
 *
 * 背景（2026-09-04）：
 *   ① 「Can not active Rigidbody in contact listener」：exhaust / resetPeg / triggerFunnelAndDestroy
 *      在 onBeginContact 同步链（物理锁定栈）内改碰撞体状态触发引擎警告；
 *   ② 第二波「只剩一颗钉子」：力竭钉禁用碰撞体后弹珠穿透灰钉，钉板功能性消失；
 *   ③ 第 3 波后永久卡死：selectReward 裸调 applyReward，单卡抛错 → 弹窗滞留 → 看门狗被
 *      anyModalOpen() 挡死 → 波次推进链永久中断。
 * 背景（2026-09-05 追加）：
 *   ④ 「Can't add renderable component」：MotionStreak 直接 addComponent 到已挂 Sprite 的弹珠
 *      根节点（renderable 同节点互斥）——每次发射刷一条，且拖尾注册被拒后从未渲染；
 *   ⑤ 「[RuntimeTex] builtin-sprite effect 未就绪」：effectName 'builtin-sprite' 按注册键查表
 *      恒查不到 → passes 恒空 → 逐次重试逐次警告刷屏，加法混合从未生效；
 *   ⑥ 雷球连击在物理锁内同步击杀最后一只敌人 → 波次结算 → 钉板在物理 step 内重建
 *      （21 次 RigidBody2D 激活）→ ⑤①类警告成串刷屏；
 *   ⑦ Peg/Orb 预制体 spriteFrame 指向已删除贴图（uuid 悬空，仅 library 缓存苟活），
 *      重建资源库/出包后钉体球体渲染消失。
 * 背景（2026-09-05 第二轮追加）：
 *   ⑧ 引擎 Node.destroy() 内部第一步就是 this.active=false（同步失活！仅内存销毁延迟到帧末）——
 *      弹珠在漏斗 onBeginContact 物理锁内销毁自己 → RigidBody2D.onDisable → b2 setActive(false)
 *      → 「Can not active RigidBody in contract listener」每次入槽刷一条（此前误判 destroy 帧末生效）；
 *   ⑨ 自建加法混合材质的 blendState 覆盖会整体替换 BlendTarget → 辉光渲染成不透明方块
 *      （「弹珠变方块」回归根因）——删除自建材质，改走 Sprite.srcBlendFactor/dstBlendFactor
 *      引擎原生路径；
 *   ⑩ ResultDialog 场景节点失活时 GAME_OVER 监听注册不上 → 城堡毁灭后无结算弹窗、无法重开
 *      （CastleController 增加 emit 后兜底开门）。
 * 本脚本对修复文件做源码级断言（stripComments 后检查真实代码，杜绝注释干扰）。
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const SCRIPTS = resolve(process.cwd(), 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

const peg = strip(read('Pinball', 'PegComponent.ts'));
const orb = strip(read('Pinball', 'OrbController.ts'));
const reward = strip(read('UI', 'RewardDialog.ts'));

// ── 1. PegComponent：物理行为与计能解耦（警告源 ①② + 灰钉穿透一起根治）──
check('exhaust/resetPeg 全文件不再触碰 collider.enabled（力竭钉保留碰撞体，弹珠仍被弹开）',
    !/\.enabled\s*=\s*(true|false)/.test(peg));
check('Collider2D 依赖已整体移除（import / getComponent 缓存均无）',
    !/Collider2D/.test(peg));
check('isExhausted 守卫保留（力竭钉只停计能，不重置不穿透）',
    /_isExhausted\s*=\s*true/.test(peg) && /_isExhausted\s*=\s*false/.test(peg));

// ── 2. OrbController：入槽结算重复守卫 + 物理栈内零碰撞体操作（警告源 ③）──
check('triggerFunnelAndDestroy 入口三重守卫：_funnelEntered / _destroying / node 有效性（destroy 帧末生效前的重复 contact 回调空跑）',
    /public triggerFunnelAndDestroy\(funnel: FunnelSlotLike \| null\): void \{\s*if \(this\._funnelEntered \|\| this\._destroying \|\| !this\.node\?\.isValid\) \{\s*return;\s*\}\s*this\._funnelEntered = true;\s*this\._destroying = true;/.test(orb));
check('入槽结算尾部改为 scheduleOnce 延迟销毁（Node.destroy 内部即 this.active=false 同步失活，物理锁内销毁必刷 RigidBody 警告）',
    /this\.scheduleOnce\(\(\) => \{\s*if \(this\.node\?\.isValid\) \{\s*this\.node\.destroy\(\);\s*\}\s*\}, 0\);\s*\}/.test(orb)
    && (orb.match(/\.enabled\s*=\s*(true|false)/g) ?? []).length === 1);
check('唯一的 enabled 赋值在 recycleAllOrbs（物理栈外调用：WaveManager/RewardDialog 的 try 块内），防帧尾残球撞钉',
    /orb\._collider\.enabled = false;/.test(orb));
check('recycleAllOrbs 全部调用点均有 try/catch 异常隔离（不阻断结算/展示链）',
    /try\s*\{\s*OrbController\.recycleAllOrbs\(\);/.test(strip(read('Battle', 'WaveManager.ts')))
    && /try\s*\{\s*OrbController\.recycleAllOrbs\(\);/.test(reward));

// ── 3. RewardDialog：奖励流程异常免疫（死锁根治）──
check('selectReward 内 applyReward 被 try/catch 包裹（单卡抛错只跳过该奖励，流程照常推进）',
    /try\s*\{\s*this\.applyReward\(reward\);\s*\}\s*catch/.test(reward));
check('三个选卡分支（降级 / 常规 / 传奇藏宝箱）的 playHideAnimation 全部位于 finally 块内（弹窗必关，看门狗不被 anyModalOpen 挡死）',
    (reward.match(/finally\s*\{\s*this\.playHideAnimation\(index\)/g) ?? []).length === 3);
check('_selecting = true 后必有 finally 收尾路径（降级/常规/藏宝箱三处，异常时也不永久锁死选卡）',
    (reward.match(/this\._selecting = true;/g) ?? []).length === 3
    && /_selecting = false/.test(reward));

// ── 4. 弹窗自举（2026-09-04 第三轮回归根因）：场景节点 active + start 防自吞 + WaveManager 兜底开门 ──
// 根因：RewardDialog / ShopDialog / ResultDialog 在场景中被摆成 _active=false，组件 onLoad 永不执行
// （Cocos 仅在节点首次激活时调用），SHOW_REWARDS / SHOW_SHOP 监听注册不上，emit 永远空转 → 永久死锁。
const shop = strip(read('UI', 'ShopDialog.ts'));
const result = strip(read('UI', 'ResultDialog.ts'));
const wave = strip(read('Battle', 'WaveManager.ts'));
const sceneRaw = read('..', 'scenes', 'MainScene.scene');

for (const name of ['RewardDialog', 'ShopDialog', 'ResultDialog']) {
    const block = sceneRaw.match(new RegExp(`"_name": "${name}"[\\s\\S]{0,600}?"_active": (true|false)`));
    check(`场景 ${name} 节点 _active=true（false 时 onLoad 永不执行、SHOW_* 监听注册不上）`,
        !!block && block[1] === 'true');
}
check('三个弹窗的 start() 均带 _showing 防自吞守卫（closeAllModals 启动期失活会推迟 start 到首次激活执行）',
    /if \(!this\._showing\) \{\s*this\.node\.active = false;/.test(reward)
    && /if \(!this\._showing\) \{\s*this\.node\.active = false;/.test(shop)
    && /if \(!this\._showing\) \{\s*this\.node\.active = false;/.test(result));
check('showRewards / openShop / showResult 入口均先置位 _showing（先置位再激活）',
    /this\._showing = true/.test(reward)
    && /this\._showing = true/.test(shop)
    && /this\._showing = true/.test(result));
check('WaveManager 兜底开门：emit 后无弹窗激活时直接调用 RewardDialog.showRewards（组件方法不依赖节点激活态）',
    /private openRewardDialogFallback\(\): void/.test(wave)
    && (wave.match(/this\.openRewardDialogFallback\(\)/g) ?? []).length >= 2
    && /dialog\.showRewards\(\)/.test(wave));

// ── 5. 「钉板只剩一颗钉子」复发回归钉（2026-09-04）：@property 的 prefab 序列化旧值会覆盖代码新默认值 ──
// maxHitsPerRound / disabledColor 只改代码不改 Peg.prefab 等于没改（序列化 3 / #999999 继续生效，
// 波内全场力竭 + 灰钉不可见 → 玩家看到「钉板功能性消失」）。钉死 prefab 序列化值，回归即报。
const prefabRaw = read('..', 'prefabs', 'Peg.prefab');
const prefabNum = (key: string): number | null => {
    const m = prefabRaw.match(new RegExp(`"${key}":\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
};
const prefabColor = (key: string): string => {
    const m = prefabRaw.match(new RegExp(`"${key}":\\s*\\{[\\s\\S]{0,80}?"r":\\s*(\\d+),\\s*"g":\\s*(\\d+),\\s*"b":\\s*(\\d+)`));
    return m ? `${m[1]},${m[2]},${m[3]}` : '';
};
check('Peg.prefab maxHitsPerRound=6（序列化旧值 3 会覆盖代码默认值 → 波内全场力竭灰化）',
    prefabNum('maxHitsPerRound') === 6);
check('Peg.prefab disabledColor=184,194,214（0xB8C2D6；旧 #999999 深灰在深蓝底上几乎不可见）',
    prefabColor('disabledColor') === '184,194,214');
check('Peg.prefab hitColor=144,238,144（受击高亮浅绿可见）',
    prefabColor('hitColor') === '144,238,144');
check('PegComponent 代码默认 maxHitsPerRound=6（与 prefab 序列化值一致，防漂移）',
    /maxHitsPerRound\s*=\s*6;/.test(peg));
check('Theme.peg.exhaust=0xB8C2D6（力竭钉必须肉眼可见，不许改回深灰）',
    /exhaust:\s*hex\(0xB8C2D6\)/.test(strip(read('Core', 'ArtTheme.ts'))));

// ── 6. 2026-09-05 根修回归钉：renderable 互斥 / 物理栈内销毁与重建钉板 / 贴图悬空 / 加法混合 ──
const pegboard = strip(read('Pinball', 'PegBoardManager.ts'));
const rtex = strip(read('Core', 'RuntimeTex.ts'));
const turret = strip(read('Battle', 'TurretController.ts'));
const fx = strip(read('Core', 'FxManager.ts'));
const castle = strip(read('Battle', 'CastleController.ts'));

check('MotionStreak 挂 OrbTrail 子节点（与 Sprite 同节点互斥；曾直接挂弹珠根节点，每次发射刷 renderable 警告且拖尾不渲染）',
    /getChildByName\('OrbTrail'\)/.test(orb) && !/this\.addComponent\(MotionStreak\)/.test(orb));
check('雷球连击伤害 scheduleOnce 延迟出物理锁（同步击杀曾就地触发波次结算 → 钉板在物理 step 内重建）',
    /_comboBurstFired = true;\s*this\.scheduleOnce\(\(\) => \{\s*if \(enemy\.node\?\.isValid && !this\._destroying\) \{\s*enemy\.takeFreeDamage\(LIGHTNING_COMBO_DAMAGE\);/.test(orb));
check('PegBoardManager.onRewardSelected 延迟一帧 generateBoard（钉板重建含 21 次 RigidBody2D 激活，禁止在物理栈内执行）',
    /onRewardSelected\(\): void \{\s*this\.scheduleOnce\(\(\) => this\.generateBoard\(\), 0\);/.test(pegboard));
check('自建加法混合材质已删除（blendState 覆盖会整体替换 BlendTarget → 辉光渲染成不透明方块，「弹珠变方块」回归根因）',
    !/additiveMaterial/.test(rtex) && !/additiveMaterial/.test(orb)
    && !/additiveMaterial/.test(turret) && !/additiveMaterial/.test(fx));
check('三处辉光 Sprite 改用引擎原生混合因子（srcBlendFactor/dstBlendFactor，_updateBlendFunc 在材质实例上正确叠加）',
    (orb.match(/srcBlendFactor = gfx\.BlendFactor\.SRC_ALPHA/g) ?? []).length === 2
    && /srcBlendFactor = gfx\.BlendFactor\.SRC_ALPHA/.test(turret)
    && /srcBlendFactor = gfx\.BlendFactor\.SRC_ALPHA/.test(fx));
// ★ 2026-09-05 选项B根修（⑦ 的终局方案）：隐形钉不能再靠「运行时补贴图」自愈——该方案受
//   useGraphicsFallback 全局连坐 + _discSF 进程级缓存 + 把 null 原样赋回 spriteFrame 三重缺陷，
//   修了几轮仍复发。终局是让钉子/球体的可见性彻底不依赖任何 Sprite / 贴图 / 运行时纹理上传。
check('钉子本体由 Graphics 实心圆盘无条件绘制（可见性不再依赖 Sprite/贴图）',
    /g\.fillColor = this\._tint;\s*g\.circle\(0, 0, Math\.max\(1, r - 1\)\);\s*g\.fill\(\);/.test(peg));
check('PegComponent 彻底切断 Sprite / RuntimeTex 依赖（防自愈方案回潮）',
    !/getComponent\(Sprite\)/.test(peg) && !/RuntimeTex/.test(peg));
check('球体本体由 OrbBody 子节点 Graphics 实心圆盘绘制（同构根修；子节点规避 renderable 互斥）',
    /getChildByName\('OrbBody'\)/.test(orb) && /g\.fillColor = this\._tint;\s*g\.circle\(0, 0, r\);/.test(orb));
check('OrbController 不再自愈主节点 spriteFrame（disc 方案废弃，受击闪色迁至 _tint → redrawBody）',
    !/RuntimeTex\.disc/.test(orb) && !/bodySp/.test(orb)
    && /this\._tint\.set\(Theme\.orb\.lightningFlash\);\s*this\.redrawBody\(\);/.test(orb));
check('RuntimeTex.disc 已移除（连带 buildDiscData：无人调用的脆弱路径不留存）',
    !/static disc\(/.test(rtex) && !/buildDiscData/.test(rtex));
check('Peg/Orb prefab 不再引用任何贴图 uuid（悬空引用 f12a23c4… 随 Sprite 组件一并移除）',
    !/f12a23c4/.test(prefabRaw) && !/f12a23c4/.test(read('..', 'prefabs', 'Orb.prefab')));
check('PegBoardManager 把可渲染性纳入成功判据（旧「实生成 21」掩盖隐形钉，是问题修不掉的直接原因）',
    /peg\.isRenderable\(\)/.test(pegboard) && /可渲染 \$\{visible\}/.test(pegboard));
check('CastleController.onCastleDestroyed emit 后兜底开门（ResultDialog 场景节点失活时 GAME_OVER 监听缺失 → 城堡毁灭后无结算弹窗、无法重开）',
    /EventBus\.emit\(GameEvents\.GAME_OVER\);\s*const resultNode = find\('Canvas\/UILayer\/ResultDialog'\);/.test(castle)
    && /getComponent\('ResultDialog'\) as ResultDialogLike/.test(castle)
    && /dialog\.showResult\(false\);/.test(castle));

console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
