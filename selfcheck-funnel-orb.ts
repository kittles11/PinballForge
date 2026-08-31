/**
 * 漏斗 × 珠子解耦改造自检（纯 Node，无引擎依赖）——校验「珠子效果保持、漏斗只做数值修饰」的关键接线：
 *   node --experimental-transform-types selfcheck-funnel-orb.ts
 *
 * 背景：改版前 FIRE_TURRET 只透传漏斗类型，珠子入槽即被漏斗覆盖（雷球/冰球掉红槽全变重炮爆裂弹）。
 * 改版后（聚能/精炼/金币方案）：漏斗只乘数值倍率，炮弹外观与受击特效始终跟随珠子类型 orbType。
 * 本脚本对 6 个改动文件做源码级断言（stripComments 后检查真实代码，杜绝注释干扰）。
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

const eventBus = strip(read('Core', 'EventBus.ts'));
const orbCtrl = strip(read('Pinball', 'OrbController.ts'));
const turret = strip(read('Battle', 'TurretController.ts'));
const enemy = strip(read('Battle', 'EnemyController.ts'));
const audio = strip(read('Core', 'AudioManager.ts'));
// DataModels 需断言枚举块注释与卡牌 desc 文案 → 保留原始文本（含注释）
const models = read('Core', 'DataModels.ts');

// ── 1. 事件载荷：珠子类型透传（根因修复） ──
check('FIRE_TURRET 载荷含 orbType（珠子类型透传）',
    /\[GameEvents\.FIRE_TURRET\]:\s*\{\s*damage:\s*number;\s*orbType:\s*OrbType\s*\}/.test(eventBus));

// ── 2. OrbController：漏斗只做数值修饰，珠子类型原样广播 ──
check('广播开火载荷为 { damage, orbType }（不再传漏斗 type）',
    /EventBus\.emit\(GameEvents\.FIRE_TURRET,\s*\{\s*damage:\s*Math\.round\(damage\),\s*orbType:\s*this\.orbType\s*\}\)/.test(orbCtrl));
check('聚能倍率常量 FUNNEL_FOCUS_MULT = 2',
    /const\s+FUNNEL_FOCUS_MULT\s*=\s*2\s*;/.test(orbCtrl));
check('精炼倍率常量 FUNNEL_REFINE_MULT = 1.5',
    /const\s+FUNNEL_REFINE_MULT\s*=\s*1\.5\s*;/.test(orbCtrl));
check('红槽（HeavyCannon）乘 聚能×2 × 重炮超载卡倍率',
    /type === FunnelType\.HeavyCannon\)\s*\{\s*damage = damage \* FUNNEL_FOCUS_MULT \* EnemyController\.heavyOverloadMult;/.test(orbCtrl));
check('蓝槽（IceFreeze）乘 精炼×1.5',
    /else if \(type === FunnelType\.IceFreeze\)\s*\{\s*damage \*= FUNNEL_REFINE_MULT;/.test(orbCtrl));
check('霜冻冰球与漏斗解耦：入任意槽冰封全场（不再限定 IceFreeze 槽）',
    /if \(this\.orbType === OrbType\.Frost\)\s*\{\s*this\.freezeAllEnemies\(/.test(orbCtrl)
    && !/orbType === OrbType\.Frost && type === FunnelType\.IceFreeze/.test(orbCtrl));
check('金币槽保留：入槽即发 +20 金币',
    /type === FunnelType\.GoldCoin/.test(orbCtrl) && /GOLD_REWARD_AMOUNT/.test(orbCtrl));
check('金币槽补发专属 Ching 音效（playFire(FIRE_SFX_COIN)）',
    /AudioManager\.playFire\(FIRE_SFX_COIN\)/.test(orbCtrl));

// ── 3. 炮塔：子弹外观跟随珠子类型 ──
check('createBulletNode 按 orbType 四色分支（白/电光/火红/冰蓝）',
    /private createBulletNode\(orbType: OrbType\)/.test(turret)
    && /orbType === OrbType\.Lightning/.test(turret)
    && /orbType === OrbType\.Frost/.test(turret)
    && /orbType === OrbType\.Lava/.test(turret));
check('命中结算透传珠子类型 takeDamage(damage, orbType)',
    /target\.takeDamage\(data\.damage,\s*data\.orbType\)/.test(turret));
check('弹体生成消费珠子类型 createBulletNode(data.orbType)',
    /this\.createBulletNode\(data\.orbType\)/.test(turret) && !/createBulletNode\(data\.type\)/.test(turret));
check('炮塔不再引用漏斗类型 FunnelType',
    !/FunnelType/.test(turret));

// ── 4. 敌人：受击特效跟随珠子类型 ──
check('takeDamage 签名改为 (amount, orbType, rawFloor)',
    /public takeDamage\(amount: number,\s*orbType: OrbType,\s*rawFloor = false\)/.test(enemy));
check('受击特效 switch(orbType)：霜冻冻结/雷电光闪/熔岩红光/普通白闪',
    /switch \(orbType\)/.test(enemy)
    && /case OrbType\.Frost:\s*[\s\S]*?this\.isFrozen = true;/.test(enemy)
    && /case OrbType\.Lightning:\s*[\s\S]*?this\.flashHit\(LIGHTNING_HIT_COLOR\)/.test(enemy)
    && /case OrbType\.Lava:\s*[\s\S]*?this\.flashHit\(HEAVY_HIT_COLOR\)/.test(enemy)
    && /default:\s*[\s\S]*?this\.flashHit\(Color\.WHITE\)/.test(enemy));
check('敌方不再感知漏斗：重炮×2 分支已移除、无 FunnelType 残留',
    !/baseDmg \* 2 \* EnemyController\.heavyOverloadMult/.test(enemy) && !/FunnelType/.test(enemy));
check('极寒易伤被动保留（冰封受伤 × iceVulnerableMult）',
    /this\.isFrozen\)\s*\{\s*dmg \*= EnemyController\.iceVulnerableMult;/.test(enemy));
check('雷球连击免费攻击改走普通弹（takeFreeDamage → OrbType.Normal）',
    /public takeFreeDamage\(amount: number\): void\s*\{\s*this\.takeDamage\(amount, OrbType\.Normal, true\);/.test(enemy));

// ── 5. 音效：跟随珠子类型，金币音独立编号 ──
check('开火音效按 orbType 分支（雷/霜/熔岩/普通）',
    /type === OrbType\.Lightning/.test(audio)
    && /type === OrbType\.Frost/.test(audio)
    && /type === OrbType\.Lava/.test(audio));
check('监听端消费 d?.orbType（不再消费 d?.type）',
    /playFire\(d\?\.orbType \?\? 0\)/.test(audio) && !/d\?\.type/.test(audio));
check('FIRE_SFX_COIN = 9 独立于 OrbType 区间（0~3）',
    /export const FIRE_SFX_COIN = 9;/.test(audio));

// ── 6. 数值语义文案同步 ──
check('FunnelType 注释改为聚能/精炼（枚举成员名与数值不变，场景序列化零影响）',
    /聚能（红）：本颗珠子入槽开火伤害 ×2/.test(models)
    && /精炼（蓝）：本颗珠子入槽开火伤害 ×1\.5/.test(models)
    && /HeavyCannon = 0,/.test(models) && /IceFreeze = 1,/.test(models) && /GoldCoin = 2,/.test(models));
check('霜冻冰球卡牌文案已去掉「落入急冻槽」限定',
    !/落入急冻槽/.test(models));

console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
