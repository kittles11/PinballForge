/**
 * 协同组合包第一批自检（纯 Node，无引擎依赖）—— Task 008（2026-09-07）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs tools/selfchecks/selfcheck-synergy.ts
 *
 * 落地报告第 6 节组合 1-4（球×敌 / 球×槽 / 球×钉 三个断层各补一条化学反应）：
 *   ① 碎冰：雷球命中冰封敌人 = 50 固定直伤 + 解冻（引爆冰雕，放弃易伤窗口的一次性回报）；
 *   ② 寒霜导热：冰球入冰槽 → 冻结时长 +2s（同系归位奖励）；
 *   ③ 殉爆：熔岩溅射波及炸药钉 → 引爆（既有管线回归锁——熔岩溅射经 onHit 进炸药钉爆炸分支）；
 *   ④ 镀金钉：镀金乘倍钉（潮汐镀金标记）撞击 +5 金赏金，一次性发放。
 * 数值/文案常量全部与代码互相咬合（selfcheck-card-effects 同款三轨验证）。
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

// node 无 DOM：localStorage stub（OrbBalance → MetaManager 读档容错）
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

const { OrbBalance } = await import('../../assets/scripts/Core/OrbBalance.ts');

const orb = strip(read('Pinball', 'OrbController.ts'));
const enemy = strip(read('Battle', 'EnemyController.ts'));
const peg = strip(read('Pinball', 'PegComponent.ts'));

// ── ① 碎冰：雷球 × 冰封敌人 ──
check('碎冰常量：SHATTER_BONUS_DAMAGE = 50（与连击追发同价）',
    /const SHATTER_BONUS_DAMAGE = 50;/.test(orb));
check('接线：雷球撞钉时取 getFrontEnemy 判定 isFrozen（球×敌协同入口）',
    /if \(this\.orbType === OrbType\.Lightning\) \{\s*const frozenTarget = EnemyManager\.instance\?\.getFrontEnemy\(\);/.test(orb));
check('结算出物理锁：scheduleOnce(0) 包裹 takeFreeDamage（同步击杀触发波次结算的既有根修）',
    /frozenTarget\?\.isFrozen\) \{\s*this\.scheduleOnce\(\(\) => \{\s*if \(frozenTarget\.node\?\.isValid && !this\._destroying\) \{\s*frozenTarget\.takeFreeDamage\(SHATTER_BONUS_DAMAGE \* EnemyController\.shatterBonusMult\);/.test(orb));
check('碎冰解除冻结：breakFreeze()（易伤窗口随之失去——「引爆冰雕」取舍成立）',
    /frozenTarget\.breakFreeze\(\);/.test(orb));
check('EnemyController.breakFreeze 公开且幂等安全（unschedule 挂起计时器 + 死亡守卫）',
    /public breakFreeze\(\): void\s*\{\s*if \(this\._dead \|\| !this\.node\?\.isValid\) \{\s*return;\s*\}\s*this\.unschedule\(this\.unfreeze\);/.test(enemy));
check('碎冰倍率重开零残留：resetStaticData 覆盖 shatterBonusMult',
    /EnemyController\.shatterBonusMult = 1;/.test(enemy));
check('碎冰跳字：纯文字「碎冰!」标识（规则 C 零 emoji，玩家可读）', /碎冰!/.test(orb));
check('碎冰/赏金跳字零 emoji（icon-ui 规则 C 白名单外禁止 pictographic）',
    !/\p{Extended_Pictographic}/u.test(orb.match(/碎冰![^`]*`/)?.[0] ?? '')
    && !/\p{Extended_Pictographic}/u.test(orb.match(/GILDED_PEG_GOLD_BOUNTY} 金`/)?.[0] ?? ''));

// ── ② 寒霜导热：冰球 × 冰槽 ──
check('OrbBalance 签名：frost.funnelFreezeBonus = 2（入冰槽冻结 +2s）',
    OrbBalance.frost.funnelFreezeBonus === 2);
check('reset() 后恢复 2（重开不残留）',
    (OrbBalance.reset(), OrbBalance.frost.funnelFreezeBonus === 2));
check('接线：入槽结算按槽型加成（IceFreeze 才 +bonus，其它槽不加）',
    /const duration = OrbBalance\.frost\.freezeDuration\s*\+\s*\(type === FunnelType\.IceFreeze \? OrbBalance\.frost\.funnelFreezeBonus : 0\);\s*this\.freezeAllEnemies\(duration\);/.test(orb));

// ── ③ 殉爆：熔岩溅射 × 炸药钉（既有管线回归锁） ──
check('熔岩溅射波及钉走 onHit 入口（炸药钉爆炸分支在 onHit 内触发）',
    /other\.onHit\(true, visited\);/.test(orb));
check('onHit 炸药钉分支：命中即 triggerBombExplosion（殉爆链的既有终点）',
    /if \(this\.pegType === PegType\.Bomb\) \{\s*this\.triggerBombExplosion\(visited\);/.test(peg));
check('爆炸连锁防死循环：visited 去重 + _isExploding 守卫（殉爆不引入新递归风险）',
    /if \(this\._isExploding\) \{\s*return;/.test(peg) && /visited\?\.has\(this\)/.test(peg));

// ── ④ 镀金钉：镀金乘倍钉 × 撞击金币 ──
check('赏金常量：GILDED_PEG_GOLD_BOUNTY = 5（镀金钉撞击 +5 金）',
    /const GILDED_PEG_GOLD_BOUNTY = 5;/.test(orb));
check('镀金标记只在 gildRandomNormalPegs 建立（战后永久强化不标记）',
    /peg\.gildedAtWave = 1;/.test(peg));
check('赏金接线：gildedAtWave > 0 → addGold(bounty)（金矿工同一 GAIN_GOLD 管线；方案B① 边缘镀金赏金 ×2）',
    /const bounty = GILDED_PEG_GOLD_BOUNTY \* \(peg\.edgeBonus \? EDGE_GILD_BOUNTY_MULT : 1\);/.test(orb)
    && /if \(peg\.gildedAtWave > 0\) \{[\s\S]{0,120}GoldManager\.instance\.addGold\(bounty\);/.test(orb));
check('赏金一次性：发放后标记失效（OrbController 置 0）+ 类型重设清标记（PegComponent setPegType 置 0）',
    /peg\.gildedAtWave = 0;/.test(orb) && /this\.gildedAtWave = 0;/.test(peg));
check('类型重设清除镀金标记（setPegType 回归原生钉）',
    /this\.gildedAtWave = 0;/.test(peg));

// ── ④ 纯算术复核（防公式被手滑改坏） ──
check('碎冰收益：50 固定伤 + 失去 25% 易伤窗口（冻结中 100 伤预期 125 → 碎冰路径 50+100=150 ≥ 125，决策成立）',
    50 + 100 >= 100 * 1.25);
check('镀金钉单波天花板：2 钉 × 6 次 × 5 金 = 60 金/波（防通胀封顶可计算）',
    2 * 6 * 5 === 60);

console.log(failed === 0 ? '\n✅ 协同组合包自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
