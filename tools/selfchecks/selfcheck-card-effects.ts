/**
 * 卡牌效果一致性自检（P0-1 回归锁）—— 三张曾"描述与行为脱节"的卡牌全链路验证：
 *   node --experimental-transform-types selfcheck-card-effects.ts
 *
 * 背景：PROJECT_ANALYSIS 曾判定 lava_core / lightning_rage / lightning_combo 只日志占位。
 * 现已接线，但 lava_splash 与 lightning_combo 两条链此前无任何自检覆盖——本文件补齐，
 * 并把「卡牌文案 ↔ 实际数值」钉成断言，防止未来改常量不改文案（或反之）再次脱节。
 *
 * 覆盖三轨：
 *   ① 行为真跑（OrbBalance 零 cc 依赖）：升级开关默认值 / applyUpgrade / reset 幂等
 *   ② 接线断言（源码级，stripComments 后正则）：RewardDialog 分发 → OrbController 消费 → PegComponent/EnemyController 落点
 *   ③ 文案一致性：卡牌 desc 中的数字（5 连发 / 满 8 次 / 相邻溅射）与代码常量互相咬合
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { register } from 'node:module';
// 自包含解析：先注册相对路径补 .ts 的 hook（ts-resolve-hook.mjs），再动态加载 OrbBalance。
// 静态 import 会在 hook 注册前解析（ESM 静态依赖先于任何代码求值），故必须用顶层 await 动态 import。
register('../../ts-resolve-hook.mjs', import.meta.url);
const { OrbBalance } = await import('../../assets/scripts/Core/OrbBalance.ts');

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// node 无 DOM：装 localStorage stub（OrbBalance.reset → applyMetaBonus 读档容错）
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// ── ① OrbBalance 行为真跑 ──
check('默认：熔岩溅射关 / 雷球连击关 / 溅射半径 120 / 溅射能量倍率 1',
    OrbBalance.lavaAreaSplashEnabled === false
    && OrbBalance.lightningComboEnabled === false
    && OrbBalance.lava.splashRadius === 120
    && OrbBalance.lava.splashEnergyMultiplier === 1);
OrbBalance.applyUpgrade('lava_splash');
OrbBalance.applyUpgrade('lava_splash'); // 布尔置位：重复升级不叠加、不崩溃
check('applyUpgrade(lava_splash)：开关置 true 且幂等', OrbBalance.lavaAreaSplashEnabled === true);
OrbBalance.applyUpgrade('lightning_combo');
check('applyUpgrade(lightning_combo)：开关置 true', OrbBalance.lightningComboEnabled === true);
check('lightning_rage 升级路径：splitCount 3 +2 = 5（与文案「5 连发」咬合）',
    (() => { OrbBalance.applyUpgrade('lightning_projectile', 2); return OrbBalance.lightning.splitCount === 5; })());
OrbBalance.reset();
check('reset：两开关回 false、splitCount 回 3、溅射半径回 120（本局升级不跨局）',
    OrbBalance.lavaAreaSplashEnabled === false
    && OrbBalance.lightningComboEnabled === false
    && OrbBalance.lightning.splitCount === 3
    && OrbBalance.lava.splashRadius === 120);

// ── ② 接线断言：RewardDialog 分发 ──
const reward = strip(read('UI', 'RewardDialog.ts'));
check("RewardDialog：case 'LavaSplash' → applyUpgrade('lava_splash')",
    /case 'LavaSplash':\s*OrbBalance\.applyUpgrade\('lava_splash'\);/.test(reward));
check("RewardDialog：case 'LightningCombo' → applyUpgrade('lightning_combo')",
    /case 'LightningCombo':\s*OrbBalance\.applyUpgrade\('lightning_combo'\);/.test(reward));
check("RewardDialog：lightning_rage → applyUpgrade('lightning_projectile', 2)",
    /lightning_rage'\)\s*\{\s*OrbBalance\.applyUpgrade\('lightning_projectile', 2\);/.test(reward));

// ── ② 接线断言：OrbController 消费 ──
const orb = strip(read('Pinball', 'OrbController.ts'));
check('熔岩撞钉分支受开关门控：lavaAreaSplashEnabled → applyLavaSplash(peg)',
    /if \(OrbBalance\.lavaAreaSplashEnabled\)\s*\{\s*this\.applyLavaSplash\(peg\);/.test(orb));
check('applyLavaSplash：按 splashRadius 判定相邻、排除力竭钉与原点钉',
    /Vec3\.distance\(originPos, other\.node\.worldPosition\) <= OrbBalance\.lava\.splashRadius/.test(orb)
    && /other\.isExhausted \|\| hit\.has\(other\.node\.uuid\)/.test(orb)
    && /const hit = new Set<string>\(\[origin\.node\.uuid\]\)/.test(orb));
check('applyLavaSplash：溅射钉走既有 onHit(true, visited) 入口，绝不递归本球结算',
    /other\.onHit\(true, visited\)/.test(orb));
check('applyLavaSplash：溅射同步计入能量（pegEnergyGain × splashEnergyMultiplier）',
    /this\.accumulatedDamage \+= OrbBalance\.lava\.pegEnergyGain\s*\*\s*OrbBalance\.lava\.splashEnergyMultiplier;/.test(orb));
check('连击弹幕常量：阈值 8 / 追发伤害 50（与文案「满 8 次」咬合）',
    /const LIGHTNING_COMBO_THRESHOLD = 8;/.test(orb) && /const LIGHTNING_COMBO_DAMAGE = 50;/.test(orb));
check('连击门控四条件齐备：达阈值 / 非副球 / 未触发过 / 开关开启',
    /this\.hitCount >= LIGHTNING_COMBO_THRESHOLD\s*&& !this\.isSplitChild && !this\._comboBurstFired && OrbBalance\.lightningComboEnabled/.test(orb));
check('追发落点：最靠前敌人（getFrontEnemy）+ 先置守卫再延迟结算，单球至多 1 次',
    /const enemy = EnemyManager\.instance\?\.getFrontEnemy\(\);/.test(orb)
    // ★ 结算必须经 scheduleOnce 出物理锁（2026-09-05 根修：同步击杀最后一只敌人会就地触发
    //   波次结算 → 钉板在物理 step 内重建 → 「Can not active Rigidbody in contact listener」）
    && /this\._comboBurstFired = true;\s*this\.scheduleOnce\(\(\) => \{[\s\S]{0,160}?enemy\.takeFreeDamage\(LIGHTNING_COMBO_DAMAGE\);/.test(orb));

// ── ② 接线断言：下游落点真实 ──
const peg = strip(read('Pinball', 'PegComponent.ts'));
check('PegComponent.onHit 接收 visited 集合：命中去重 + 炸弹链防死循环',
    /public onHit\(skipAnim: boolean = false, visited: Set<PegComponent> \| null = null\)/.test(peg)
    && /visited\?\.has\(this\)/.test(peg) && /visited\?\.add\(this\)/.test(peg));
const enemy = strip(read('Battle', 'EnemyController.ts'));
check('takeFreeDamage 是真实伤害：直连 takeDamage（不经漏斗/炮弹管线）',
    /public takeFreeDamage\(amount: number\): void\s*\{\s*this\.takeDamage\(amount, OrbType\.Normal, true\);/.test(enemy));

// ── ③ 文案一致性：卡牌 desc ↔ 实现语义 ──
const data = strip(read('Core', 'DataModels.ts'));
check('lava_core 文案含「溅射周围相邻钉子」且 actionType=LavaSplash（与 applyLavaSplash 语义一致）',
    /id: 'lava_core'[\s\S]{0,300}desc: '[^']*溅射周围相邻钉子[^']*'[\s\S]{0,120}actionType: 'LavaSplash'/.test(data));
check('lightning_combo 文案含「连击满 8 次后免费追发 1 颗」「最靠前」且 actionType=LightningCombo',
    /id: 'lightning_combo'[\s\S]{0,300}desc: '[^']*连击满 8 次后免费追发 1 颗[^']*最靠前[^']*'[\s\S]{0,120}actionType: 'LightningCombo'/.test(data));
check('lightning_rage 文案含「5 连发」且为 AddOrb（与 splitCount 3+2=5 咬合）',
    /id: 'lightning_rage'[\s\S]{0,300}desc: '[^']*5 连发[^']*'[\s\S]{0,120}actionType: 'AddOrb'/.test(data));
check('三卡 actionType 均被 RewardDialog switch 处理（不落 default 警告）',
    /case 'LavaSplash':/.test(reward) && /case 'LightningCombo':/.test(reward) && /case 'AddOrb':/.test(reward));

// ── ④ 方案B③ 连击热流（2026-09-07）──
const orbB = strip(read('Pinball', 'OrbController.ts'));
check('连击热流常量：步进 0.1 / 封顶 ×2（乘区在入槽开火兑现，与漏斗同层）',
    /const COMBO_HEAT_STEP = 0\.1;/.test(orbB)
    && /const COMBO_HEAT_MULT_CAP = 2;/.test(orbB));
check('乘区公式：min(CAP, 1 + STEP×max(0, hitCount-1))，首撞恒 ×1',
    /Math\.min\(\s*COMBO_HEAT_MULT_CAP,\s*1 \+ COMBO_HEAT_STEP \* Math\.max\(0, this\.hitCount - 1\),\s*\)/.test(orbB));
check('能量管道语义保持：撞钉 gain/lavaGain 不乘热流（跳字与累积仍为原始每钉增量）',
    /const gain = config\.pegEnergyGain \* mult;/.test(orbB)
    && /const lavaGain = OrbBalance\.lava\.pegEnergyGain \* mult;/.test(orbB));
check('入槽开火乘区：置于漏斗分支之前（funnel-orb 锁定的 HeavyCannon 分支形状不动）',
    /let damage = base \* this\.comboHeatMult\(\);/.test(orbB)
    && /type === FunnelType\.HeavyCannon\)\s*\{\s*damage = damage \* FUNNEL_FOCUS_MULT \* EnemyController\.heavyOverloadMult;/.test(orbB));
check('雷球连击门保持源语义：hitCount（撞钉数）达 8 免费追发，与热流里程碑并存不互改',
    /this\.hitCount >= LIGHTNING_COMBO_THRESHOLD\s*&& !this\.isSplitChild && !this\._comboBurstFired && OrbBalance\.lightningComboEnabled/.test(orbB));
check('里程碑跳字：COMBO_HEAT_MILESTONES 命中弹「连击 ×N」（Theme.fx.ember，三分支共享段）',
    /COMBO_HEAT_MILESTONES\.includes\(this\.hitCount\)/.test(orbB)
    && /`连击 ×\$\{this\.hitCount\}`/.test(orbB)
    && /Theme\.fx\.ember, true,/.test(orbB));
check('热度染色：撞钉后 setHeatTint，本体色 lerp(球种拖尾色 → Theme.fx.ember, 归一化热度)',
    /_view\?\.setHeatTint\(this\._heatTint\)/.test(orbB)
    && /\(this\.comboHeatMult\(\) - 1\) \/ \(COMBO_HEAT_MULT_CAP - 1\)/.test(orbB)
    && /Theme\.fx\.ember\.r - from\.r/.test(orbB));
check('新发射/换球种热度复位：initOrbType 重置 _heatTint 后 applyTypeVisual 回球种本色',
    /this\._heatTint\.set\(orbTrailColor\(this\.orbType\)\);\s*\n\s*this\._view\?\.applyTypeVisual/.test(orbB));

console.log(failed === 0 ? '\n✅ 卡牌效果一致性自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
