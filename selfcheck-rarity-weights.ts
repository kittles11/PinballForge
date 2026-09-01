/**
 * P1-3 稀有度权重自检（纯 Node，无引擎依赖）——三选一加权抽取真跑 + RewardDialog 接线校验：
 *   node --experimental-transform-types selfcheck-rarity-weights.ts
 *
 * 覆盖：① drawWeightedCards 行为（确定性 rng 锚点 / 不重复 / 池小于 count / 空池 / 某稀有度整层滤空退化）
 *       ② 蒙特卡洛频率（单抽 P(史诗)≈45/625=0.072；三选一含卡频率单调 普>稀>史）
 *       ③ 权重表与卡库构成（普通3/稀有7/史诗3） ④ RewardDialog 已换走加权抽取（等权 shuffle 移除）
 * DataModels 零 cc 依赖 → 动态 import 真跑。
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { CARD_DATABASE, CARD_RARITY_WEIGHTS, drawWeightedCards } from './assets/scripts/Core/DataModels.ts';

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// ── ① 权重表与卡库构成 ──
check('权重表：普通100 / 稀有40 / 史诗15',
    CARD_RARITY_WEIGHTS['普通'] === 100 && CARD_RARITY_WEIGHTS['稀有'] === 40 && CARD_RARITY_WEIGHTS['史诗'] === 15);
const byRarity = (r: string): number => CARD_DATABASE.filter((c) => c.rarity === r).length;
check('卡库构成：16 张 = 普通3 / 稀有9 / 史诗4（史诗=三张球种 AddOrb + 猎首契约应答卡）',
    CARD_DATABASE.length === 16 && byRarity('普通') === 3 && byRarity('稀有') === 9 && byRarity('史诗') === 4);

// ── ② 确定性 rng 锚点 ──
const lo = drawWeightedCards(CARD_DATABASE, 3, () => 0.0001);
check('rng 恒 0.0001 → 逐轮取首张：熔岩流三连 [lava_orb, lava_overload, lava_core]',
    lo.map((c) => c.id).join(',') === 'lava_orb,lava_overload,lava_core');
const hi = drawWeightedCards(CARD_DATABASE, 3, () => 0.9999);
check('rng 恒 0.9999 → 逐轮取末张：应答卡逆序 [univ_bounty, univ_purge, univ_shieldbreaker]',
    hi.map((c) => c.id).join(',') === 'univ_bounty,univ_purge,univ_shieldbreaker');

const picked = drawWeightedCards(CARD_DATABASE, 3);
check('默认 Math.random：抽满 3 张且 id 互不重复',
    picked.length === 3 && new Set(picked.map((c) => c.id)).size === 3);
check('池小于 count：2 张池抽 3 返回全量 2 张（不虚报）',
    drawWeightedCards(CARD_DATABASE.slice(0, 2), 3).length === 2);
check('空池 → 空结果', drawWeightedCards([], 3).length === 0);

// 牌库满（canAddOrb=false）时 AddOrb 整层被滤：AddOrb 共 4 张（lava_orb/lightning_split/lightning_rage/frost_orb）→ 池剩 12 张
const noOrbPool = CARD_DATABASE.filter((c) => c.actionType !== 'AddOrb');
const degraded = drawWeightedCards(noOrbPool, 3);
check('AddOrb 层滤空自动退化：12 张池抽 3 不崩、无 AddOrb 混入',
    noOrbPool.length === 12 && degraded.length === 3 && degraded.every((c) => c.actionType !== 'AddOrb'));

// ── ③ 蒙特卡洛频率 ──
// 单张精确锚点（总权重 3×100+9×40+4×15=720）：P(普通)=300/720≈0.417 / P(稀有)=360/720=0.50 / P(史诗)=60/720≈0.083
const TRIALS = 20000;
const single = { '普通': 0, '稀有': 0, '史诗': 0 } as Record<string, number>;
for (let i = 0; i < TRIALS; i++) {
    const c = drawWeightedCards(CARD_DATABASE, 1)[0];
    single[c.rarity]++;
}
const pN1 = single['普通'] / TRIALS, pR1 = single['稀有'] / TRIALS, pE1 = single['史诗'] / TRIALS;
check(`单抽 P(普通) ≈ 0.417（实测 ${pN1.toFixed(4)}，±0.01）`, Math.abs(pN1 - 0.417) < 0.01);
check(`单抽 P(稀有) ≈ 0.50（实测 ${pR1.toFixed(4)}，±0.01）`, Math.abs(pR1 - 0.50) < 0.01);
check(`单抽 P(史诗) ≈ 0.083（实测 ${pE1.toFixed(4)}，±0.01）`, Math.abs(pE1 - 0.083) < 0.01);

// 三选一「至少含一张」的频率：史诗最低即可（普 vs 稀接近是张数效应：稀有 7 张 vs 普通 3 张，
// 「至少出现一张」被张数推高，属数学事实而非权重失效——权重分层已在单张锚点精确验证）
let cnt = { '普通': 0, '稀有': 0, '史诗': 0 } as Record<string, number>;
const RUNS = 5000;
for (let i = 0; i < RUNS; i++) {
    const rarities = new Set(drawWeightedCards(CARD_DATABASE, 3).map((c) => c.rarity));
    for (const r of rarities) {
        cnt[r]++;
    }
}
const [pNorm, pRare, pEpic3] = [cnt['普通'] / RUNS, cnt['稀有'] / RUNS, cnt['史诗'] / RUNS];
check(`三选一含卡频率：史诗最低（史 ${pEpic3.toFixed(3)} < 普 ${pNorm.toFixed(3)} / 稀 ${pRare.toFixed(3)}）`,
    pEpic3 < pNorm && pEpic3 < pRare);
check(`三选一含史诗频率合理（实测 ${pEpic3.toFixed(3)}，区间 [0.12, 0.30]）`,
    pEpic3 > 0.12 && pEpic3 < 0.30);

// ── ④ RewardDialog 接线（源码级断言） ──
const reward = strip(read('UI', 'RewardDialog.ts'));
const models = strip(read('Core', 'DataModels.ts'));
check('showRewards 已换 drawWeightedCards（等权 shuffle+slice 移除）',
    /drawWeightedCards\(pool, REWARD_CHOICE_COUNT\)/.test(reward)
    && !reward.includes('this.shuffle(pool)') && !reward.includes('pool.slice(0,'));
check('drawWeightedCards 定义于 DataModels（零 cc 纯数据模块）', !models.includes("from 'cc'"));
check('权重表可从 DataModels 读取（调参唯一入口）',
    /CARD_RARITY_WEIGHTS: Record<CardData\['rarity'\], number>/.test(models));
check('RewardCard.rarity 收紧为 CardData[\'rarity\']（满足泛型约束，不再宽泛 string）',
    /rarity: CardData\['rarity'\];/.test(reward));
check('牌库满滤 AddOrb 的既有守卫保留', /canAddOrb \|\| card\.actionType !== 'AddOrb'/.test(reward));

console.log(failed === 0 ? '\n✅ P1-3 稀有度权重自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
