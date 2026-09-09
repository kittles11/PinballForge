/**
 * 回合推进（物理肉鸽 P2）自检（纯 Node，无引擎依赖）—— 2026-09-08：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-turn-advance.ts
 *
 * 背景：敌方实时水平行军（update × moveSpeed → defenseLineX 防线 + 头槌攻城）已替换为回合制垂直下落——
 * 一次发射 = 消耗一次开火权 = 一回合：LauncherController.launchOrb 广播 TURN_ADVANCE，
 * EnemyManager 监听后驱动全体存活敌人 advanceDown 下落 TURN_STEP_Y，触达城堡线广播 ATTACK_CASTLE 后死亡。
 * 覆盖：① 事件契约（枚举 + 强类型载荷映射）② 发射端单点派发 ③ 管理器监听与生命周期
 *       ④ 回合下落几何（步长 / 城堡线 / 攻城一次性结算 / 荆棘反伤保留）⑤ 状态守卫（冰封不挡下落等语义）
 *       ⑥ 旧契约拆除断言（行军 / 防线 / 头槌残留 = 0）⑦ 步长算术复核（出生面 → 城堡线的回合数预算）
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(process.cwd());
const SCRIPTS = resolve(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(resolve(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

const eventBus = strip(read('Core', 'EventBus.ts'));
const launcher = strip(read('Game', 'LauncherController.ts'));
const manager = strip(read('Battle', 'EnemyManager.ts'));
const enemy = strip(read('Battle', 'EnemyController.ts'));

// ── ① 事件契约 ──
check('GameEvents 枚举新增 TURN_ADVANCE', /TURN_ADVANCE = 'TURN_ADVANCE'/.test(eventBus));
check('GameEventMap 强类型载荷映射：[GameEvents.TURN_ADVANCE]: void（无载荷）',
    /\[GameEvents\.TURN_ADVANCE\]: void;/.test(eventBus));

// ── ② 发射端：一次发射 = 一回合 ──
check('launchOrb 成功路径广播 TURN_ADVANCE', /EventBus\.emit\(GameEvents\.TURN_ADVANCE\);/.test(launcher));
check('单点派发：发射函数内 TURN_ADVANCE 仅出现一次（雷球散射不按子弹数重复推进回合）',
    (launcher.match(/EventBus\.emit\(GameEvents\.TURN_ADVANCE\)/g) ?? []).length === 1);
check('派发点位于成功发射之后（失败 / 弹尽路径不消耗回合）',
    /成功发射弹珠[\s\S]{0,200}EventBus\.emit\(GameEvents\.TURN_ADVANCE\);/.test(launcher));

// ── ③ 管理器监听与生命周期 ──
check('EnemyManager 监听 TURN_ADVANCE（onLoad 注册，targeter = this）',
    /EventBus\.on\(GameEvents\.TURN_ADVANCE, this\.onTurnAdvance, this\);/.test(manager));
check('onTurnAdvance：先 prune 再快照遍历（advanceDown 触底致死不污染本轮迭代）',
    /private onTurnAdvance\(\): void \{\s*this\.prune\(\);\s*const list = this\.aliveEnemies\.slice\(\);/.test(manager));
check('双重守卫：isValid / isDead 过滤后再 advanceDown（.clinerules 判空红线）',
    /if \(enemy\?\.node\?\.isValid && !enemy\.isDead\) \{\s*enemy\.advanceDown\(\);\s*\}/.test(manager));
check('onDestroy targetOff 兜底注销（监听随管理器销毁移除，防场景重载泄漏）',
    /EventBus\.targetOff\(this\);/.test(manager));

// ── ④ 回合下落几何与攻城结算 ──
check('常量定档：TURN_STEP_Y = 60 / ENEMY_FORTRESS_LINE_Y = -20（城堡线 ≈ 旧防线的等距威胁面）',
    /const TURN_STEP_Y = 60;/.test(enemy) && /const ENEMY_FORTRESS_LINE_Y = -20;/.test(enemy));
check('advanceDown：每回合垂直下落 TURN_STEP_Y（setPosition 整体写入，禁止 position.y 直改）',
    /const newY = this\.node\.position\.y - TURN_STEP_Y;/.test(enemy)
    && /this\.node\.setPosition\(this\.node\.position\.x, newY, 0\);/.test(enemy));
check('触达城堡线（Y ≤ ENEMY_FORTRESS_LINE_Y）→ 攻城结算后死亡，绝不重复扣血',
    /if \(newY <= ENEMY_FORTRESS_LINE_Y\) \{\s*this\.resolveCastleHit\(\);/.test(enemy)
    && /EventBus\.emit\(GameEvents\.ATTACK_CASTLE, \{ damage: this\.attackDamage \}\);[\s\S]{0,200}this\.die\(\);/.test(enemy));
check('荆棘城墙反伤保留：resolveCastleHit 内 THORN_REFLECT_DAMAGE 结算（军事增建零回归）',
    /RelicManager\.hasRelic\(RelicType\.ThornCastle\)[\s\S]{0,80}this\.takeDamage\(THORN_REFLECT_DAMAGE, OrbType\.Normal, true\);[\s\S]{0,40}this\.die\(\);/.test(enemy));

// ── ⑤ 状态守卫语义 ──
check('advanceDown 守卫：死亡 / 游戏结束 / 施法前摇 / 庆祝中不动（GAME_OVER 全局锁定语义保留）',
    /public advanceDown\(\): void \{\s*if \(this\._dead \|\| !this\.node\?\.isValid \|\| this\.isGameOver\s*\|\| this\._casting \|\| this\._celebrating\) \{\s*return;\s*\}/.test(enemy));
check('冰封不挡下落（冻成冰坨照常下坠：冰封只停输出节奏，不制造永久路障）',
    (() => {
        const m = enemy.match(/public advanceDown\(\): void \{[\s\S]*?\n    \}/);
        return !!m && !/isFrozen/.test(m[0]);
    })());
check('update 仅保留击退衰减消费（Kinematic 刚体每帧同步进 b2Body 的位置来源，命中判定不失效）',
    /protected update\(dt: number\): void \{\s*if \(this\._knockbackSpeed <= 0/.test(enemy)
    && /this\._knockbackSpeed \* dt/.test(enemy));

// ── ⑥ 旧契约拆除断言（残留即失败） ──
check('行军拆除：不再有 moveSpeed×dt 水平推进与 defenseLineX 防线锁定',
    !/this\.moveSpeed \* dt/.test(enemy) && !/defenseLineX/.test(enemy));
check('头槌拆除：lungeAttack / _lungeAnimating / attackTimer / attackInterval 零残留',
    !/lungeAttack|_lungeAnimating|attackTimer|attackInterval/.test(enemy));

// ── ⑦ 步长算术复核：出生面（WaveManager 高空区间真源）→ 城堡线的回合数预算 ──
const TURN_STEP_Y = 60, FORTRESS_Y = -20;
const wm = strip(read('Battle', 'WaveManager.ts'));
const spawnConst = (name: string): number =>
    Number(wm.match(new RegExp(`const ${name} = ([\\d.]+);`))?.[1] ?? 0);
const spawnXRange = spawnConst('SPAWN_X_RANGE');
const spawnYMin = spawnConst('SPAWN_Y_MIN');
const spawnYMax = spawnConst('SPAWN_Y_MAX');
const turnsFor = (startY: number): number => Math.ceil((startY - FORTRESS_Y) / TURN_STEP_Y);
check(`出生面真源同步：高空区间 Y∈[${spawnYMin}, ${spawnYMax}] / X 半径 ±${spawnXRange}（钉板内随机落怪）`,
    spawnYMin === 450 && spawnYMax === 550 && spawnXRange === 280);
check('高空随机落怪接线：spawnOne 以 setPosition 写入随机 X/Y，旧塔防固定出怪常量无残留',
    /enemy\.setPosition\(\s*Math\.random\(\) \* SPAWN_X_RANGE \* 2 - SPAWN_X_RANGE,/.test(wm)
    && !/SPAWN_Y_STEP/.test(wm) && !/const SPAWN_X = /.test(wm));
check(`步长 60px：最高出生点（Y=${spawnYMax}）需 ${turnsFor(spawnYMax)} 回合触底（节奏可反应、不拖沓）`,
    turnsFor(spawnYMax) === 10);
check(`最低出生点（Y=${spawnYMin}）需 ${turnsFor(spawnYMin)} 回合触底（与最高点差 2 回合：高度随机的天然节奏差）`,
    turnsFor(spawnYMin) === 8);

console.log(failed === 0 ? '\n✅ 回合推进（物理肉鸽 P2）自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);