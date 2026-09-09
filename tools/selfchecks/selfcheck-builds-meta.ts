/**
 * 流派深化（方向 1）+ 局外成长（齿轮，方向 2）自检（纯 Node，无引擎依赖）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs tools/selfchecks/selfcheck-builds-meta.ts
 *
 * 覆盖：
 *  ① OrbBalance 流派物理（行为真跑）：Lightning gravityScale=0（反向深渊零重力）/ restitution=1.25 / density=0.5；
 *     Lava gravityScale=0（反向深渊零重力）/ density=4 / restitution=0.1；reset() 幂等恢复
 *  ② GearManager 行为真跑：calcGears / wavesSurvived 公式锚点、入账累计、每 100 齿轮 → 城堡 +10、
 *     存档键 pinballforge_gears 独立落盘（stub localStorage 直接核对原始 JSON）
 *  ③ 天雷接线（源码断言）：OrbController 15% 概率 emit DAMAGE_ENEMY（主球限定）、EventBus 注册载荷、
 *     EnemyManager 消费 + 无目标判空
 *  ④ 核弹接线（源码断言）：isLavaBlast 随 FIRE_TURRET 透传、TurretController 拦截转 lavaBlast AoE
 *  ⑤ 齿轮结算接线（源码断言）：ResultDialog calcGears+addGears（读 GoldManager 余额）、
 *     CastleController maxHp += GearManager.getCastleBonus()
 * 行为断言（OrbBalance / GearManager 零 cc 依赖，直接 import 真跑）+ 源码级断言（stripComments 后检查）。
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { OrbBalance } from '../../assets/scripts/Core/OrbBalance.ts';
import {
    GearManager, calcGears, wavesSurvived,
    GEARS_SAVE_KEY, GEARS_PER_WAVE, GEARS_PER_GOLD, GEAR_HP_THRESHOLD, GEAR_HP_BONUS,
} from '../../assets/scripts/Core/GearManager.ts';

// ── node 无 DOM：装 localStorage stub（GearManager 懒读档：首次访问时才读，晚于本赋值即可） ──
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// ── ① 流派物理（行为真跑：OrbBalance 静态配置即默认值） ──
check('雷电球：gravityScale=0 / restitution=1.25 / density=0.5（反向深渊零重力 + 乱窜底座）',
    OrbBalance.lightning.gravityScale === 0
    && OrbBalance.lightning.restitution === 1.25
    && OrbBalance.lightning.density === 0.5);
check('雷电球伤害面不受影响：baseDamage=40 / pegEnergyGain=15 / splitCount=3',
    OrbBalance.lightning.baseDamage === 40 && OrbBalance.lightning.pegEnergyGain === 15
    && OrbBalance.lightning.splitCount === 3);
check('熔岩球：gravityScale=0 / density=4 / restitution=0.1（反向深渊零重力 + 重质底座）',
    OrbBalance.lava.gravityScale === 0
    && OrbBalance.lava.density === 4
    && OrbBalance.lava.restitution === 0.1);
check('熔岩球既有数值不变：scale=1.4 / splashRadius=120 / splashEnergyMultiplier=1',
    OrbBalance.lava.scale === 1.4 && OrbBalance.lava.splashRadius === 120
    && OrbBalance.lava.splashEnergyMultiplier === 1);
OrbBalance.reset();
check('reset() 后流派物理恢复默认（幂等，重开一局不漂移）',
    OrbBalance.lightning.gravityScale === 0 && OrbBalance.lightning.restitution === 1.25
    && OrbBalance.lava.gravityScale === 0 && OrbBalance.lava.density === 4
    && OrbBalance.lava.restitution === 0.1);

// ── ② 齿轮公式与 GearManager（行为真跑） ──
check('公式常量锚点：波=5 / 金=10 / 门槛=100 / 加成=10',
    GEARS_PER_WAVE === 5 && GEARS_PER_GOLD === 10
    && GEAR_HP_THRESHOLD === 100 && GEAR_HP_BONUS === 10);
check('存档键 = pinballforge_gears（独立 key，防进度 reset 误清）', GEARS_SAVE_KEY === 'pinballforge_gears');
check('wavesSurvived：1-1-1=1 / 2-1-1=31 / 3-2-2=65（(章-1)×30+(关-1)×3+波）',
    wavesSurvived(1, 1, 1) === 1 && wavesSurvived(2, 1, 1) === 31 && wavesSurvived(3, 2, 2) === 65);
check('calcGears：第 1 波死亡 = 0 波 ×5（未清波 −1 修正）', calcGears(1, 0, false) === 0);
check('calcGears：死亡但剩余 15 金 → 0×5 + 15÷10 = 1', calcGears(1, 15, false) === 1);
check('calcGears：4 波死亡（3 波有效）+ 47 金 → 15 + 4 = 19', calcGears(4, 47, false) === 19);
check('calcGears：胜利 10 波 + 99 金 → 50 + 9 = 59（胜利不修正波次）', calcGears(10, 99, true) === 59);
check('calcGears：负数 / 非法输入守卫归零', calcGears(-3, -5, true) === 0 && calcGears(1, NaN, false) === 0);
check('新档齿轮为 0（stub 无残留）', GearManager.getGears() === 0);
check('入账 95：getCastleBonus = 0（未达 100）', GearManager.addGears(95) === 95 && GearManager.getCastleBonus() === 0);
check('再入账 50（累计 145）：getCastleBonus = 10（每 100 齿轮 +10）', GearManager.addGears(50) === 145 && GearManager.getCastleBonus() === 10);
check('再入账 100（累计 245）：getCastleBonus = 20', GearManager.addGears(100) === 245 && GearManager.getCastleBonus() === 20);
check('非法入账（0/负/NaN）拒绝且不落盘', GearManager.addGears(0) === 245 && GearManager.addGears(-7) === 245 && GearManager.addGears(NaN) === 245);
check('存档已落盘：pinballforge_gears = {"gears":245}', store.get(GEARS_SAVE_KEY) === '{"gears":245}');
check('独立于 meta / 进度存档键', !store.has('pinballforge_meta') && !store.has('pinballforge_progress'));

// ── ③ 天雷（源码断言） ──
const eventBus = strip(read('Core', 'EventBus.ts'));
const orb = strip(read('Pinball', 'OrbController.ts'));
const enemyMgr = strip(read('Battle', 'EnemyManager.ts'));
check('EventBus：DAMAGE_ENEMY 事件 + 载荷 number（跨层解耦的唯一通道）',
    /DAMAGE_ENEMY = 'DAMAGE_ENEMY'/.test(eventBus) && /\[GameEvents\.DAMAGE_ENEMY\]: number;/.test(eventBus));
check('OrbController：雷球主球撞钉 15% 概率派发天雷（LIGHTNING_STRIKE_CHANCE = 0.15）',
    /const LIGHTNING_STRIKE_CHANCE = 0\.15;/.test(orb)
    && /this\.orbType === OrbType\.Lightning && !this\.isSplitChild\s*&& Math\.random\(\) < LIGHTNING_STRIKE_CHANCE/.test(orb)
    && /EventBus\.emit\(GameEvents\.DAMAGE_ENEMY, LIGHTNING_STRIKE_DAMAGE\)/.test(orb));
check('EnemyManager：监听 DAMAGE_ENEMY，随机存活敌人吃伤',
    /EventBus\.on\(GameEvents\.DAMAGE_ENEMY, this\.onDamageEnemy, this\)/.test(enemyMgr)
    && /pool\[Math\.floor\(Math\.random\(\) \* pool\.length\)\]/.test(enemyMgr));
check('EnemyManager：无存活敌人强制判空 return（.clinerules）',
    /const target = pool\.length > 0 \? pool\[Math\.floor\(Math\.random\(\) \* pool\.length\)\] : null;\s*if \(!target\) \{\s*return;/.test(enemyMgr));

// ── ④ 熔岩核弹（源码断言） ──
const turret = strip(read('Battle', 'TurretController.ts'));
check('OrbController：熔岩球入槽 FIRE_TURRET 附加 isLavaBlast 标记',
    /isLavaBlast: this\.orbType === OrbType\.Lava,/.test(orb));
check('TurretController：onFire 拦截 isLavaBlast → lavaBlast 后提前 return（不发普通子弹）',
    /if \(data\.isLavaBlast\) \{\s*this\.lavaBlast\(data\);\s*return;\s*\}/.test(turret));
check('TurretController：AoE 半径 380 + 半径外 30% 余波常量',
    /const LAVA_BLAST_RADIUS = 380;/.test(turret) && /const LAVA_BLAST_OUTER_MULT = 0\.3;/.test(turret));
check('TurretController：AoE 逐敌判空（isValid/isDead）+ takeDamage 同通道',
    /if \(!e\?\.node\?\.isValid \|\| e\.isDead\) \{\s*continue;/.test(turret)
    && /e\.takeDamage\(full \? dmg : Math\.round\(dmg \* LAVA_BLAST_OUTER_MULT\), OrbType\.Lava\)/.test(turret));
check('TurretController：核弹视听反馈复用既有管线（blast/ring/smoke/震屏/爆炸音）',
    /FxManager\.blast\(center, Theme\.orb\.lava, LAVA_BLAST_RADIUS\)/.test(turret)
    && /FxManager\.ring\(center, Theme\.orb\.lava,/.test(turret)
    && /FxManager\.smoke\(center, 150\)/.test(turret)
    && /CameraShake\.shake\(18, 0\.45\)/.test(turret)
    && /AudioManager\.playCastleExplode\(\)/.test(turret));

// ── ⑤ 齿轮结算接线（源码断言） ──
const resultDialog = strip(read('UI', 'ResultDialog.ts'));
const castle = strip(read('Battle', 'CastleController.ts'));
check('ResultDialog：结算处 calcGears（读 GoldManager 余额）+ GearManager.addGears 入账',
    /calcGears\(\s*wavesSurvived\(LevelManager\.currentChapter, LevelManager\.currentLevel, LevelManager\.currentWave\),\s*GoldManager\.instance\?\.getGold\(\) \?\? 0,\s*isWin,/.test(resultDialog)
    && /GearManager\.addGears\(this\._gainedGears\);/.test(resultDialog));
check('ResultDialog：锻造区余额行展示齿轮本局/累计',
    /齿轮 \+\$\{this\._gainedGears\}（累计 \$\{GearManager\.getGears\(\)\}）/.test(resultDialog));
check('CastleController：maxHp += GearManager.getCastleBonus()（每 100 齿轮 +10）',
    /this\.maxHp \+= GearManager\.getCastleBonus\(\);/.test(castle));
check('全链无非空断言写法（.clinerules）：instance! / enemyManager! / _gainedGears! 均不存在',
    !/instance!\./.test(resultDialog) && !/enemyManager!\./.test(turret) && !/_gainedGears!/.test(resultDialog));

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
