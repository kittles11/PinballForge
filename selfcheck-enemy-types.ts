/**
 * 四大特色敌人 & 波次混合出怪 —— 纯逻辑自检（不依赖 cc 运行时，仅校验 DataModels 纯数据层）。
 * 运行：node --experimental-transform-types selfcheck-enemy-types.ts
 */
import {
    EnemyType,
    ENEMY_TYPE_STATS,
    ENEMY_UNLOCK_CHAPTER,
    WAVE_TYPE_POOLS,
    rollEnemyType,
} from './assets/scripts/Core/DataModels.ts';

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!cond) {
        failed++;
    }
}

// ── 1. 类型数值表与需求对齐 ──
check('铁甲怪自带 2 层护盾', ENEMY_TYPE_STATS[EnemyType.Shield].shieldLayers === 2);
check('突袭怪移速覆盖 85 px/s', ENEMY_TYPE_STATS[EnemyType.Speed].speedOverride === 85);
check('史莱姆死亡分裂 2 只', ENEMY_TYPE_STATS[EnemyType.Slime].splitCount === 2);
check('Boss 体型 2.2 倍', ENEMY_TYPE_STATS[EnemyType.Boss].scale === 2.2);
check('普通怪均衡（无护盾/不分裂/1 倍体型）',
    ENEMY_TYPE_STATS[EnemyType.Normal].shieldLayers === 0
    && ENEMY_TYPE_STATS[EnemyType.Normal].splitCount === 0
    && ENEMY_TYPE_STATS[EnemyType.Normal].scale === 1);
check('小怪标志独立于类型表（分裂层数只配在 Slime 上）',
    ENEMY_TYPE_STATS[EnemyType.Normal].shieldLayers === 0
    && ENEMY_TYPE_STATS[EnemyType.Speed].shieldLayers === 0
    && ENEMY_TYPE_STATS[EnemyType.Boss].shieldLayers === 0);

// ── 2. 新手引导：第 1 章第 1 波固定普通怪 ──
check('第 1 章第 1 波 500 次抽样全为普通怪',
    Array.from({ length: 500 }, () => rollEnemyType(1, 1)).every((t) => t === EnemyType.Normal));

// ── 3. 章节解锁：第 1 章不出现 Slime（第 2 章解锁）──
check('第 1 章第 3 波 800 次抽样不出现史莱姆',
    Array.from({ length: 800 }, () => rollEnemyType(3, 1)).every((t) => t !== EnemyType.Slime));

// ── 4. 第 2 章起 Slime 解锁，且只出池内类型 ──
const ch2w3 = Array.from({ length: 2000 }, () => rollEnemyType(3, 2));
check('第 2 章第 3 波可出现史莱姆', ch2w3.includes(EnemyType.Slime));
check('第 2 章第 3 波仅出池内类型（Normal/Shield/Slime）',
    ch2w3.every((t) => t === EnemyType.Normal || t === EnemyType.Shield || t === EnemyType.Slime));

// ── 5. 随机源边界：0 取池首，≈1 取池尾 ──
check('rnd=0 时取池内首个类型（第 2 波 → Normal）', rollEnemyType(2, 5, () => 0) === EnemyType.Normal);
check('rnd≈1 时取池内末个类型（第 2 波 → Speed）', rollEnemyType(2, 5, () => 0.9999999) === EnemyType.Speed);
check('waveIndex 越界回退池 1（rnd=0 → Normal）', rollEnemyType(99, 5, () => 0) === EnemyType.Normal);

// ── 6. 权重分布：第 2 章第 2 波 ≈ Normal 40% / Shield 30% / Speed 30%（±5% 容差）──
const N = 9000;
const counts: Record<string, number> = { Normal: 0, Shield: 0, Speed: 0, Slime: 0, Boss: 0 };
for (let i = 0; i < N; i++) {
    counts[rollEnemyType(2, 2)]++;
}
const ratio = (t: string): number => counts[t] / N;
check(`第 2 章第 2 波权重接近 40/30/30（实际 Normal=${(ratio('Normal') * 100).toFixed(1)}% Shield=${(ratio('Shield') * 100).toFixed(1)}% Speed=${(ratio('Speed') * 100).toFixed(1)}%）`,
    Math.abs(ratio('Normal') - 0.4) < 0.05
    && Math.abs(ratio('Shield') - 0.3) < 0.05
    && Math.abs(ratio('Speed') - 0.3) < 0.05);
check('第 2 章第 2 波绝不出未入池的 Slime/Boss', ratio('Slime') === 0 && ratio('Boss') === 0);

// ── 7. 未解锁权重归一化：第 1 章第 3 波池 {Normal 25, Shield 35}（Slime 40 剔除）→ 25/60≈41.7% ──
const ch1w3 = Array.from({ length: 9000 }, () => rollEnemyType(3, 1));
const nRate = ch1w3.filter((t) => t === EnemyType.Normal).length / ch1w3.length;
check(`第 1 章第 3 波 Slime 权重折算后 Normal ≈ 41.7%（实际 ${(nRate * 100).toFixed(1)}%）`, Math.abs(nRate - 25 / 60) < 0.05);

// ── 8. Boss 不参与混合池 ──
const poolTypes = new Set(Object.values(WAVE_TYPE_POOLS).flat().map(([t]) => t));
check('混合池不含 Boss（Boss 波由 isBoss 单独指定）', !poolTypes.has(EnemyType.Boss));
check('Boss 解锁章节为哨兵值 99（永不入池）', ENEMY_UNLOCK_CHAPTER[EnemyType.Boss] === 99);

console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
