/**
 * 过载雷球（lightning_rage）修复自检——雷球散射数量消费链路 + AddOrb 重复加卡回归：
 *   node --experimental-transform-types selfcheck-lightning-rage.ts
 *
 * 修复前：① fireLightningBurst 硬编码 3 颗，applyUpgrade('lightning_projectile', 2) 无人消费（5 连发失效）
 *        ② RewardDialog AddOrb 分支 addOrbToDeck 调用两次（选一张球卡加 2 颗）
 * 覆盖：① OrbBalance 行为真跑（splitCount 默认/升级/reset、lightningSpread 几何锚点）
 *       ② LauncherController 接线（散射消费 splitCount、中心主球判定、瞄准钳制常量保留）
 *       ③ RewardDialog 加卡唯一性
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { register } from 'node:module';
// 自包含解析：先注册相对路径补 .ts 的 hook（ts-resolve-hook.mjs），再动态加载 OrbBalance。
// 静态 import 会在 hook 注册前解析（ESM 静态依赖先于任何代码求值），故必须用顶层 await 动态 import。
register('./ts-resolve-hook.mjs', import.meta.url);
const { OrbBalance } = await import('./assets/scripts/Core/OrbBalance.ts');

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// node 无 DOM：装 localStorage stub（避免 OrbBalance.reset → applyMetaBonus 读档时的容错警告噪音）
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

const DEG = Math.PI / 180;
const anglesEq = (a: number[], b: number[]): boolean =>
    a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

// ── ① OrbBalance 行为真跑 ──
check('雷球默认：splitCount=3 / scatterAngle=15°',
    OrbBalance.lightning.splitCount === 3 && Math.abs(OrbBalance.lightning.scatterAngle - 15 * DEG) < 1e-9);
check('spread 锚点 n=3：[-15°, 0, +15°]（与旧版 left/dir/right 三连发等价）',
    anglesEq(OrbBalance.lightningSpread(3, 15 * DEG), [-15 * DEG, 0, 15 * DEG]));
check('spread 锚点 n=5：±30° 五连发（过载雷球）',
    anglesEq(OrbBalance.lightningSpread(5, 15 * DEG),
        [-30 * DEG, -15 * DEG, 0, 15 * DEG, 30 * DEG]));
check('spread 偶数兜底 n=4：中心偏半档 [-22.5°, -7.5°, +7.5°, +22.5°]',
    anglesEq(OrbBalance.lightningSpread(4, 15 * DEG),
        [-22.5 * DEG, -7.5 * DEG, 7.5 * DEG, 22.5 * DEG]));
check('spread 防御：0/负数钳为 1 颗 [0]',
    anglesEq(OrbBalance.lightningSpread(0, 15 * DEG), [0]) && anglesEq(OrbBalance.lightningSpread(-3, 15 * DEG), [0]));

OrbBalance.applyUpgrade('lightning_projectile', 2);
check('过载雷球升级：splitCount 3 → 5（applyUpgrade lightning_projectile +2）',
    OrbBalance.lightning.splitCount === 5);
OrbBalance.reset();
check('reset 清回默认 3（本局升级不跨局）', OrbBalance.lightning.splitCount === 3);

// ── ② LauncherController 接线（源码级断言） ──
const launcher = strip(read('Game', 'LauncherController.ts'));
check('fireLightningBurst 消费 OrbBalance.lightning（splitCount/scatterAngle）',
    /const \{ splitCount, scatterAngle \} = OrbBalance\.lightning;/.test(launcher)
    && /OrbBalance\.lightningSpread\(splitCount, scatterAngle\)/.test(launcher));
check('硬编码 SCATTER 常量已移除（数量改由数据驱动）', !launcher.includes('SCATTER_'));
check('中心球为主球（入槽回收），其余副球（i !== centerIdx）',
    /const centerIdx = \(offsets\.length - 1\) \/ 2;/.test(launcher) && /i !== centerIdx/.test(launcher));
check('瞄准角度钳制常量保留（MIN/MAX_LAUNCH_ANGLE 未被误删）',
    launcher.includes('MIN_LAUNCH_ANGLE') && launcher.includes('MAX_LAUNCH_ANGLE'));
check('每颗弹旋转方向公式（dir 旋转 offset 角）',
    /dir\.x \* cos - dir\.y \* sin,/.test(launcher) && /dir\.x \* sin \+ dir\.y \* cos,/.test(launcher));

// ── ③ RewardDialog 加卡唯一性 ──
const reward = strip(read('UI', 'RewardDialog.ts'));
check('AddOrb 分支 addOrbToDeck 只调用一次（重复加卡 bug 已修）',
    (reward.match(/addOrbToDeck\(/g) || []).length === 1);
check('lightning_rage 仍触发雷球散射升级（lightning_projectile +2）',
    /lightning_rage'\)\s*\{\s*OrbBalance\.applyUpgrade\('lightning_projectile', 2\);/.test(reward));
check('「暂不启用 5 连发」的过期注释已移除', !reward.includes('暂不启用'));

console.log(failed === 0 ? '\n✅ 过载雷球修复自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
