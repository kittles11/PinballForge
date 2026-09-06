/**
 * 加倍/减半快速平衡分析（game-design《快速平衡法》）—— 找出手感变量，指导精调方向：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs tools/balance-double-halve.ts
 *
 * 方法论：对每个核心变量做 2x / 0.5x 极端调整，观察关键指标变化幅度——
 *   变化大 = 敏感变量（精调它，动一档天翻地覆）
 *   没变化 = 钝感变量（忽略它，别把调参时间浪费在这）
 *   暴露新问题 = 需要重新设计（不是调参能救的）
 *
 * 模型：期望值解析模型（非蒙特卡洛），全部输入取自真实代码常量：
 *   伤害/能量 ← OrbBalance；波次血量/移速 ← LevelManager.getWaveConfig；
 *   推进几何 ← WaveManager(SPAWN_X=320) + EnemyController(defenseLineX=-180)；
 *   漏斗倍率 ← OrbController(FUNNEL_FOCUS/REFINE)；攻城伤害 ← LevelManager.getBaseAttackDamage()（难度方案B：10 + 2.5×(章-1)）。
 * 玩家侧假设（可调，报告中标注）：平均撞钉 8 次/球、出手机隔 2.0s、
 *   漏斗分布 重炮25%/精炼50%/金币25%、雷球 3 连发副球命中 75%。
 *
 * 输出：控制台摘要 + docs/BALANCE_SENSITIVITY.md（完整表格与数据驱动判读）。
 */
import { register } from 'node:module';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

register('../ts-resolve-hook.mjs', import.meta.url);

// node 无 DOM：localStorage stub（LevelManager/OrbBalance 读档容错）
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

const { OrbBalance } = await import('../assets/scripts/Core/OrbBalance.ts');
const { LevelManager } = await import('../assets/scripts/Core/LevelManager.ts');
const {
    bossBehaviorForChapter, BOSS_BEHAVIOR_STATS,
    bulwarkIntervalForChapter, summonHpRatioForChapter,
} = await import('../assets/scripts/Core/DataModels.ts');

// ───────────────── 玩家侧假设参数（模型自由度，全部显式列出） ─────────────────
const ASSUME = {
    avgPegHits: 8,          // 单球平均撞钉次数（21 钉 × 3 次力竭的中等弧线）
    shotInterval: 2.0,      // 平均出手机隔（秒）：瞄准 0.5s + 冷却 0.25s + 节奏
    funnelMix: { heavy: 0.25, refine: 0.5, gold: 0.25 }, // 三漏斗落点分布
    lightningSubHitRatio: 0.75, // 雷球副球撞钉效率（散射偏离板心）
    marchDistance: 500,     // SPAWN_X(320) → defenseLineX(-180)
    // 攻城 DPS 不再是常量：随章节成长（难度方案B），逐锚点取 LevelManager.getBaseAttackDamage()
    avgTypeHpMult: 1.15,    // 混合池平均血量修正（Shield1.4/Speed0.7/Slime1.2 加权）
};

// ───────────────── 真实代码常量（模型输入 = 数值系统单一真源） ─────────────────
const BASE = {
    baseDamage: OrbBalance.normal.baseDamage as number,       // 40
    pegEnergyGain: OrbBalance.normal.pegEnergyGain as number, // 15
    lavaEnergyGain: OrbBalance.lava.pegEnergyGain as number,  // 60
    splitCount: OrbBalance.lightning.splitCount as number,    // 3
    heavyMult: 2,        // OrbController.FUNNEL_FOCUS_MULT
    refineMult: 1.5,     // OrbController.FUNNEL_REFINE_MULT
    goldPerFunnel: 20,   // OrbController.GOLD_REWARD_AMOUNT
    enemyHpScale: 1,     // LevelManager 血量公式整体倍率探针
    enemySpeedScale: 1,  // 移速探针
    castleHp: 100,       // CastleController 默认上限
};

type Params = typeof BASE & typeof ASSUME;

interface AnchorResult {
    name: string;
    waveHp: number;
    clearT: number;     // 全灭本波耗时
    marchT: number;     // 最快敌人撞线耗时
    margin: number;     // marchT - clearT：正=清在撞线前，负=必然漏怪攻城
    castleLeak: number; // 本波攻城损失 = 敌数 × 当前章攻城伤害(getBaseAttackDamage) × max(0, -margin)
    requiredDps: number; // 撞线前全灭所需 DPS = waveHp / marchT
}

interface Metrics {
    dps: number;
    dmgPerShot: number;
    goldPerLevel: number;
    pressure: number;   // 全锚点攻城损失合计 / 城堡血量（≥1 即基线牌库扛不过该章）
    anchors: AnchorResult[];
}

/** 期望值模拟：给定参数 → 关键指标 */
function simulate(p: Params): Metrics {
    // 单卡期望伤害（入槽前）：牌库 3 普通 + 1 雷 + 1 熔岩 + 1 冰
    const dmgNormal = p.baseDamage + p.avgPegHits * p.pegEnergyGain;
    const dmgLightning = p.splitCount * (p.baseDamage + p.avgPegHits * p.lightningSubHitRatio * p.pegEnergyGain);
    const dmgLava = p.baseDamage + p.avgPegHits * p.lavaEnergyGain;
    const dmgFrost = dmgNormal;
    const deckAvg = (3 * dmgNormal + dmgLightning + dmgLava + dmgFrost) / 6;
    const funnelExp = p.funnelMix.heavy * p.heavyMult + p.funnelMix.refine * p.refineMult + p.funnelMix.gold * 1;
    const dmgPerShot = deckAvg * funnelExp;
    const dps = dmgPerShot / p.shotInterval;
    const goldPerShot = p.funnelMix.gold * p.goldPerFunnel;

    const anchors: AnchorResult[] = [];
    const points: Array<[string, number, number, number]> = [
        ['1-1 第1波(教学)', 1, 1, 1],
        ['1-10 精英(第1章末)', 1, 10, 3],
        ['5-10 Boss(第5章末)', 5, 10, 3],
        ['10-10 Boss(双Boss锚)', 10, 10, 3],
        ['25-5 中盘普通', 25, 5, 2],
        ['50-10 Boss(终局)', 50, 10, 3],
    ];
    for (const [name, c, l, w] of points) {
        LevelManager.currentChapter = c;
        LevelManager.currentLevel = l;
        const def = LevelManager.getWaveConfig(w);
        const waveHp = def.count * def.hp * (def.isBoss || w === 3 ? 1 : p.avgTypeHpMult) * p.enemyHpScale;
        const clearT = waveHp / dps;
        const marchT = p.marchDistance / (def.speed * p.enemySpeedScale);
        const margin = marchT - clearT;
        const castleLeak = Math.max(0, -margin) * def.count * LevelManager.getBaseAttackDamage();
        anchors.push({ name, waveHp, clearT, marchT, margin, castleLeak, requiredDps: waveHp / marchT });
    }
    const totalLeak = anchors.reduce((s, a) => s + a.castleLeak, 0);
    // 每关金币：3 波总时长 / 出手机隔 × 每手期望金币（普通关 ≈ 教学锚 ×8 粗估）
    const levelDuration = anchors[0].clearT * 8;
    const goldPerLevel = (levelDuration / p.shotInterval) * goldPerShot;
    return { dps, dmgPerShot, goldPerLevel, pressure: totalLeak / p.castleHp, anchors };
}

// ───────────────── 加倍/减半扫描 ─────────────────
interface Probe { key: keyof Params; label: string; note: string }
const PROBES: Probe[] = [
    { key: 'baseDamage', label: '基础伤害 40', note: 'OrbBalance.baseDamage' },
    { key: 'pegEnergyGain', label: '撞钉能量 15', note: 'normal.pegEnergyGain' },
    { key: 'lavaEnergyGain', label: '熔岩能量 60', note: 'lava.pegEnergyGain' },
    { key: 'avgPegHits', label: '平均撞钉 8', note: '玩家侧假设' },
    { key: 'shotInterval', label: '出手机隔 2.0s', note: '玩家侧假设(反向)' },
    { key: 'enemyHpScale', label: '敌人血量系数', note: 'LevelManager 公式' },
    { key: 'enemySpeedScale', label: '敌人移速系数', note: 'LevelManager 公式' },
    { key: 'castleHp', label: '城堡血量 100', note: 'CastleController' },
    { key: 'goldPerFunnel', label: '金币槽 20', note: 'GOLD_REWARD_AMOUNT' },
    { key: 'heavyMult', label: '重炮倍率 2', note: 'FUNNEL_FOCUS_MULT' },
];

const base = simulate({ ...BASE, ...ASSUME } as Params);
const pct = (v0: number, v1: number): string =>
    (!isFinite(v0) || v0 === 0) ? 'n/a' : `${((v1 / v0 - 1) * 100).toFixed(0)}%`;

interface Row {
    label: string; note: string;
    dpsHalf: string; dpsDouble: string;
    pressHalf: string; pressDouble: string;
    goldHalf: string; goldDouble: string;
    swing: number; verdict: string;
}
const rows: Row[] = [];

for (const pr of PROBES) {
    const src: any = { ...(BASE as object), ...(ASSUME as object) };
    const v = src[pr.key] as number;
    const mLow = simulate({ ...src, [pr.key]: v * 0.5 } as Params);
    const mHigh = simulate({ ...src, [pr.key]: v * 2 } as Params);
    // 敏感度 = 三指标（DPS/压力/金币）2x 与 0.5x 相对变化幅度的最大值
    const swing = Math.max(
        Math.abs(mHigh.dps / mLow.dps - 1),
        Math.abs(mHigh.pressure / (mLow.pressure || 1e-9) - 1),
        Math.abs(mHigh.goldPerLevel / (mLow.goldPerLevel || 1e-9) - 1),
    );
    const verdict = swing > 0.5 ? '敏感 → 精调' : swing < 0.05 ? '钝感 → 忽略' : '中敏 → 观察';
    rows.push({
        label: pr.label, note: pr.note,
        dpsHalf: pct(base.dps, mLow.dps), dpsDouble: pct(base.dps, mHigh.dps),
        pressHalf: pct(base.pressure, mLow.pressure), pressDouble: pct(base.pressure, mHigh.pressure),
        goldHalf: pct(base.goldPerLevel, mLow.goldPerLevel), goldDouble: pct(base.goldPerLevel, mHigh.goldPerLevel),
        swing, verdict,
    });
}
rows.sort((a, b) => b.swing - a.swing);

// ───────────────── Boss 行为等效分析（P2-1，docs/BOSS_DESIGN.md 数值验证） ─────────────────
// 连续时间模型：击杀所需总伤 = HP×(1 + r·T)，r = 狂暴回复速率（每秒占最大生命比例，
// 与 EnemyController BOSS_REGEN_* 同步：5% / 6s）。解 T = HP / (DPS_eff − HP·r)，
// DPS_eff ≤ HP·r 时无解（回复超过伤害，永远杀不死——理论封底检查）。
const BOSS_REGEN_R = 0.05 / 6;

interface BossFightRow {
    chapter: number; behavior: string; hp: number; marchT: number;
    reqDps: number;          // 撞线前击杀所需 DPS（含回复与行为折算，"应对"画像）
    killTBase: number;       // 基线 DPS 击杀耗时（应对画像）
    killT3x: number;         // ×3 构筑 DPS 击杀耗时（应对画像）
    killT3xIgnore: number;   // ×3 构筑、完全无视机制
    verdict: string;
}

/** 行为 → 有效 DPS（respond=perfect 表示玩家按设计意图应对）。hp 用于诏令的固定血量抽血项 */
function behaviorAdjustedDps(behavior: string, chapter: number, hp: number, dps: number, respond: 'perfect' | 'ignore'): number {
    const S = BOSS_BEHAVIOR_STATS;
    if (behavior === 'Expose' && respond === 'perfect') {
        // 窗口覆盖率 3/10、窗口内 ×2 → 平均 ×1.3；无视 = ×1.0（零惩罚正向检查）
        return dps * (1 + (S.exposeWindow / S.exposeInterval) * (S.exposeDamageMult - 1));
    }
    if (behavior === 'Summon') {
        // 亲卫是固定血量成本：每周期 count×ratio×HP 摊到 interval 秒 → 从对 Boss 的 DPS 中线性扣除
        // （构筑越强占比折扣越小——召唤是节奏惩罚而非数值墙，符合设计意图）
        const drainPerSec = (S.summonCount * summonHpRatioForChapter(chapter) * hp) / S.summonInterval;
        return dps - drainPerSec;
    }
    if (behavior === 'Bulwark') {
        const uptime = S.bulwarkDuration / bulwarkIntervalForChapter(chapter);
        const u = respond === 'perfect' ? uptime * 0.5 : uptime; // 应对 = 剥盾提前一半
        return dps * (1 - u * (1 - S.bulwarkDamageMult));
    }
    return dps;
}

function bossFightTable(dpsBase: number): BossFightRow[] {
    const rows: BossFightRow[] = [];
    for (const c of [1, 2, 3, 4, 5, 8, 12, 20, 50]) {
        LevelManager.currentChapter = c;
        LevelManager.currentLevel = 10;
        const def = LevelManager.getWaveConfig(3); // Boss 波：count=1，hp 已含 ×4.5
        const hp = def.hp * def.count;
        const marchT = ASSUME.marchDistance / def.speed;
        const b = bossBehaviorForChapter(c) as string;
        const effPerfect = behaviorAdjustedDps(b, c, hp, dpsBase, 'perfect');
        const dps3x = dpsBase * 3;
        const kill = (eff: number): number => (eff > hp * BOSS_REGEN_R ? hp / (eff - hp * BOSS_REGEN_R) : Infinity);
        const tPerfect3x = kill(behaviorAdjustedDps(b, c, hp, dps3x, 'perfect'));
        const tIgnore3x = kill(behaviorAdjustedDps(b, c, hp, dps3x, 'ignore'));
        // 撞线前击杀（应对画像）所需 DPS：DPS_req = HP/marchT + HP·r（行为反解按倍率折算近似）
        const ratio = dpsBase > 0 ? effPerfect / dpsBase : 1;
        const reqDps = (hp / marchT + hp * BOSS_REGEN_R) / Math.max(0.3, ratio);
        const tBase = kill(effPerfect);
        const verdict = !isFinite(tBase)
            ? '基线无解(回复>伤害)'
            : tBase <= marchT
                ? (tBase >= 30 && tBase <= 90 ? `✅ 时长带内(${tBase.toFixed(0)}s)` : `⏱ ${tBase.toFixed(0)}s 偏离30~90s带`)
                : `⚠️ 撞线后耗城(城堡仅扛${(BASE.castleHp / (LevelManager.getBaseAttackDamage() * 2)).toFixed(0)}s)`;
        rows.push({ chapter: c, behavior: b, hp, marchT, reqDps, killTBase: tBase, killT3x: tPerfect3x, killT3xIgnore: tIgnore3x, verdict });
    }
    return rows;
}
const bossRows = bossFightTable(base.dps);
const fmtT = (t: number): string => (isFinite(t) ? `${t.toFixed(0)}s` : '无解');

// ───────────────── 输出 ─────────────────
const anchorTable = [
    '| 锚点波次 | 波总血量 | 全灭耗时 | 撞线耗时 | 余量(+安全/−漏怪) | 攻城损失 | 撞线前全灭所需DPS | 基线DPS缺口 |',
    '|---|---|---|---|---|---|---|---|',
    ...base.anchors.map((a) => `| ${a.name} | ${Math.round(a.waveHp)} | ${a.clearT.toFixed(1)}s | ${a.marchT.toFixed(1)}s | ${a.margin >= 0 ? '+' : ''}${a.margin.toFixed(1)}s | ${Math.round(a.castleLeak)} | ${Math.round(a.requiredDps)} | ×${(a.requiredDps / base.dps).toFixed(1)} |`),
].join('\n');

const sensTable = [
    '| 变量（来源） | 0.5× DPS | 2× DPS | 0.5× 压力 | 2× 压力 | 0.5× 金币 | 2× 金币 | 摆幅 | 判读 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.label}（${r.note}） | ${r.dpsHalf} | ${r.dpsDouble} | ${r.pressHalf} | ${r.pressDouble} | ${r.goldHalf} | ${r.goldDouble} | ${(r.swing * 100).toFixed(0)}% | ${r.verdict} |`),
].join('\n');

const sensitive = rows.filter((r) => r.verdict.startsWith('敏感')).map((r) => r.label);
const dull = rows.filter((r) => r.verdict.startsWith('钝感')).map((r) => r.label);
const gapAnchors = base.anchors.filter((a) => a.margin < 0);

const bossTable = [
    '| 章 | 行为 | Boss 血量 | 撞线耗时 | 撞线前击杀需DPS(应对) | 基线击杀 | ×3构筑击杀(应对) | ×3构筑击杀(无视) | 判读 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...bossRows.map((r) => `| ${r.chapter} | ${r.behavior} | ${Math.round(r.hp)} | ${r.marchT.toFixed(1)}s | ${Math.round(r.reqDps)} | ${fmtT(r.killTBase)} | ${fmtT(r.killT3x)} | ${fmtT(r.killT3xIgnore)} | ${r.verdict} |`),
].join('\n');
const bandHits = bossRows.filter((r) => r.verdict.startsWith('✅'));
const bulwarkRows = bossRows.filter((r) => r.behavior === 'Bulwark');

const report = `# 数值敏感性报告（加倍/减半法）

> 生成方式：\`node --experimental-transform-types --import ./register-ts-hook.mjs tools/balance-double-halve.ts\`
> 模型：期望值解析模型（非实机数据），输入取自 OrbBalance / LevelManager / WaveManager / EnemyController / OrbController 真实常量。
> 玩家侧假设：平均撞钉 ${ASSUME.avgPegHits} 次/球、出手机隔 ${ASSUME.shotInterval}s、漏斗分布 重炮${ASSUME.funnelMix.heavy * 100}%/精炼${ASSUME.funnelMix.refine * 100}%/金币${ASSUME.funnelMix.gold * 100}%。
> **压力指标**：全锚点攻城损失合计 ÷ 城堡血量——≥1 表示零成长基线牌库在该难度段必然漏防。

## 基线状态

- 每发期望伤害（含漏斗倍率期望）：**${Math.round(base.dmgPerShot)}**
- 等效 DPS：**${Math.round(base.dps)}**
- 每关期望金币：**${Math.round(base.goldPerLevel)}**（对照：删卡 80+25 阶梯 / 买球 110 / 遗物 130~220）
- 基线压力（漏伤/城堡HP）：**${base.pressure.toFixed(1)}**
- 难度曲线（方案A/B 已接入）：敌人 HP = 线性基线 × 1.045^(章-1)；兵力 3/4/1 → 封顶 6/8/3（每 10/8/12 章 +1，Boss 波恒 1）；攻城伤害 10 + 2.5×(章-1)；移速斜率 1.8/章、封顶 150（50 章内不触顶）。

## 锚点波次（基线牌库 = 零成长）

${anchorTable}

**关键发现**：${gapAnchors.length > 0
    ? `从「${gapAnchors[0].name}」起，基线牌库 DPS 已不足以在撞线前清波（缺口 ×${(gapAnchors[0].requiredDps / base.dps).toFixed(1)} 起、随章节扩大）。` +
      `这意味着 **Roguelite 成长系统（卡牌/遗物/meta）不是锦上添花，而是数值上的承重墙**——玩家第 5 章起必须靠构筑把 DPS 抬到「所需DPS」列以上，否则必然进入拼血耗城节奏。`
    : '基线牌库可覆盖全部锚点。'}

## 加倍/减半敏感性扫描（按摆幅降序）

${sensTable}

## 判读（game-design 快速平衡法三分类）

1. **敏感变量（精调，动一档天翻地覆）**：${sensitive.join('、')}。
   伤害链路（撞钉能量/基础伤害/撞钉均值）与敌人血量是全局手感主杠杆；出手机隔本质是玩家技术代理变量，实机校准优先级最高。
2. **钝感变量（忽略，别浪费调参时间）**：${dull.length ? dull.join('、') : '（本轮无）'}。
3. **暴露的新问题（需要设计，不是调参能救的）**：
   - **成长承重墙**（见锚点表关键发现）：若希望前 4 章是「教学性安全区」，当前曲线成立；若希望零成长玩家也能苟到第 8 章，应压低血量线性项（+90/章）或抬高基线撞钉收益。
   - **金币经济错位**：基线每关 ${Math.round(base.goldPerLevel)} 金币 vs 商店定价 80~220——约 3~4 关才买得起一件遗物，商店在前期接近死系统；要么提金币槽产出，要么降前期定价。
   - **节奏线已复活（难度方案B）**：移速斜率 1.2→1.8/章、封顶 110→150（50 章内不触顶，50-10 ≈131）；后期压力由血量与节奏双线承担，攻城伤害随章成长后「余量」列负值权重显著上升。

## Boss 行为等效分析（P2-1，设计目标：Boss 战 30~90s）

> 连续时间模型：击杀总伤 = HP×(1+r·T)，r=狂暴回复 5%/6s；行为折算——破绽=窗口覆盖率×倍率(应对 ×1.3)、
> 诏令=亲卫固定血量抽血(每周期 2×12~18%HP)、坚盾=盾期覆盖率××0.5(应对提前剥半)。
> "×3 构筑"≈ 第 10 章前后玩家应有的成长档位（对照锚点表缺口列）。

${bossTable}

**判读**：
- 基线牌库（零成长）在全部 Boss 章「撞线后耗城」——与锚点表「成长承重墙」结论一致，Boss 行为没有改变这一点，只是改变**需要的构筑方向**（C 考节奏、B 考 AoE、A 考漏斗）。
- 应对 vs 无视的击杀耗时差 = 机制的真实教学强度：坚盾章 ×3 构筑下 ${bulwarkRows.length ? `${fmtT(bulwarkRows[0].killT3x)} → ${fmtT(bulwarkRows[0].killT3xIgnore)}` : '—'}（约 +${bulwarkRows.length && isFinite(bulwarkRows[0].killT3x) && isFinite(bulwarkRows[0].killT3xIgnore) ? Math.round((bulwarkRows[0].killT3xIgnore / bulwarkRows[0].killT3x - 1) * 100) : 0}%），软惩罚但不可忽略——符合"不做不可赢硬检查"红线。
- 30~90s 目标带命中 ${bandHits.length}/${bossRows.length} 章（基线口径）；偏离主因是血量复合膨胀（线性基线 × 1.045^(章-1)，难度方案A）而非行为系数——行为等效血量在 ×1.0~×1.5 区间，属可控设计余量。

## 使用建议

- 本文件是**方向性工具**，不是平衡终稿：期望值模型抹平了走位/瞄准技巧方差，实机应以 3~5 局样本复核敏感变量档位。
- 数值改动后重跑本脚本 + 全套 selfcheck；锚点表「余量」列出现「−」即该波必然漏怪攻城，「缺口」列即构筑需补齐的倍率。
`;

mkdirSync(resolve('docs'), { recursive: true });
writeFileSync(resolve('docs', 'BALANCE_SENSITIVITY.md'), report, 'utf8');

console.log('=== 基线 ===');
console.log(`每发伤害 ${Math.round(base.dmgPerShot)} | DPS ${Math.round(base.dps)} | 每关金币 ${Math.round(base.goldPerLevel)} | 压力 ${base.pressure.toFixed(1)}`);
console.log('\n=== 锚点 ===');
for (const a of base.anchors) {
    console.log(`${a.name}: HP ${Math.round(a.waveHp)} 全灭 ${a.clearT.toFixed(1)}s 撞线 ${a.marchT.toFixed(1)}s 余量 ${a.margin.toFixed(1)}s 漏伤 ${Math.round(a.castleLeak)} 需DPS ${Math.round(a.requiredDps)}`);
}
console.log('\n=== 敏感性（按摆幅降序）===');
for (const r of rows) {
    console.log(`${r.label}: 摆幅 ${(r.swing * 100).toFixed(0)}% | DPS 0.5x=${r.dpsHalf} 2x=${r.dpsDouble} | ${r.verdict}`);
}
console.log('\n=== Boss 行为等效（基线/×3构筑）===');
for (const r of bossRows) {
    console.log(`第${r.chapter}章 ${r.behavior}: HP ${Math.round(r.hp)} 撞线 ${r.marchT.toFixed(1)}s | 基线 ${fmtT(r.killTBase)} | ×3应对 ${fmtT(r.killT3x)} | ×3无视 ${fmtT(r.killT3xIgnore)} | ${r.verdict}`);
}
console.log('\n报告已写入 docs/BALANCE_SENSITIVITY.md');
