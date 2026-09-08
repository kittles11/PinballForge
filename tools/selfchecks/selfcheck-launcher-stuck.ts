/**
 * 发射链路回归 & 物理防卡死 —— 源码级 + 纯逻辑自检（不依赖 cc 运行时）。
 * 运行：node --experimental-transform-types selfcheck-launcher-stuck.ts
 *
 * 背景：历史致命 bug——launchOrb() 同屏球数判断符号写反（<=），0 颗球也被拦截，
 * 控台报 `[Launcher] 同屏存活达到上限: 存活=0 最大=6 上限=4` 导致无法发射。
 * 该拦截式上限已在 P0 基线整体移除（且从未进入 git 历史）：同屏总量由卡组守恒天然封顶
 * （masterDeck ≤8 + 雷球副球凭空 ≤4 = 同屏 ≤12 颗刚体，无物理压力；12s 存活保底兜底），
 * 强行恢复只会新增「满员拦截玩家发射」的负面体验。
 * 本自检锁定：
 *  1) 旧错误日志文本不得回潮（该 bug 的观察点）；
 *  2) 雷球散射 splitCount 配置存在（LauncherController.fireLightningBurst 的数据源）；
 *  3) OrbStuckGuard 防卡死链路完整（低速顶开 → 递进力度 → 强制结算 → 12s 保底）。
 * 说明：不 import 项目文件（cc 别名无法在 Node ESM 下解析），一律从源码正则提取真值，
 * 同时顺带锁定「源码形状」本身。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Task 005: 自检已迁至 tools/selfchecks/，仓库根锚点从 here 上提两级
const REPO_ROOT = join(here, '..', '..');
const launcherSrc = readFileSync(join(REPO_ROOT, 'assets', 'scripts', 'Game', 'LauncherController.ts'), 'utf8');
// Task 006 拆分：卡球三重保底（顶开/递进/强制结算/12s 保底）已迁至 OrbStuckGuard
const guardSrc = readFileSync(join(REPO_ROOT, 'assets', 'scripts', 'Pinball', 'OrbStuckGuard.ts'), 'utf8');
const balanceSrc = readFileSync(join(REPO_ROOT, 'assets', 'scripts', 'Core', 'OrbBalance.ts'), 'utf8');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!cond) {
        failed++;
    }
}

// ── 1. 旧错误日志不得回潮（历史致命 bug 的观察点）──
check('旧错误日志「同屏存活达到上限」已从源码移除', !launcherSrc.includes('同屏存活达到上限'));

// ── 2. 雷球散射配置（LauncherController.fireLightningBurst 消费 OrbBalance.lightning.splitCount）──
// splitCount 从 OrbBalance 源码提取，保证与真实雷球分裂配置一致（过载雷球卡将其 3→5）
const splitCount = Number(balanceSrc.match(/splitCount:\s*(\d+)/)?.[1]);
check(`雷球 splitCount 已定义（实际=${splitCount}）`, Number.isInteger(splitCount) && splitCount > 0);
check('发射散射消费配置（lightningSpread(splitCount, scatterAngle)）',
    /lightningSpread\(splitCount,\s*scatterAngle\)/.test(launcherSrc));
check('STUCK_MAX_BUMPS 强制结算上限已定义', /STUCK_MAX_BUMPS\s*=\s*\d+/.test(guardSrc));
check('递进力度字段 _stuckBumps 已定义', /_stuckBumps\s*=\s*0/.test(guardSrc));
check('顶开力度随失败次数递增（IMPULSE * boost）', /STUCK_IMPULSE_[XY]\s*\*\s*boost/.test(guardSrc));
check('连顶仍卡 → 直接入槽结算腾位', /_stuckBumps >= STUCK_MAX_BUMPS[\s\S]{0,200}onSettle\?\.\(\)/.test(guardSrc));
check('恢复运动时递进力度归零', /_stuckTimer = 0;[\s\S]{0,80}_stuckBumps = 0/.test(guardSrc));
check('12s 存活保底保留且带可观测日志', /ORB_MAX_ALIVE\)[\s\S]{0,60}console\.log[\s\S]{0,200}onSettle\?\.\(\)/.test(guardSrc));

console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
