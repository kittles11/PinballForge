/**
 * 发射上限判断 & 物理防卡死 —— 源码级 + 纯逻辑自检（不依赖 cc 运行时）。
 * 运行：node --experimental-transform-types selfcheck-launcher-stuck.ts
 *
 * 背景：历史致命 bug——launchOrb() 同屏球数判断符号写反（<=），0 颗球也被拦截，
 * 控台报 `[Launcher] 同屏存活达到上限: 存活=0 最大=6 上限=4` 导致无法发射。
 * 本自检锁定：
 *  1) LauncherController 上限判断必须是「超过才拦截」（>），存活=0 必可发射；
 *  2) 旧错误日志文本不得回潮；
 *  3) OrbController 防卡死链路完整（低速顶开 → 递进力度 → 强制结算 → 12s 保底）。
 * 说明：不 import 项目文件（OrbBalance 内部使用无扩展名 import，Node ESM 无法解析），
 * 一律从源码正则提取真值，同时顺带锁定「源码形状」本身，符号再写反必挂。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const launcherSrc = readFileSync(join(here, 'assets', 'scripts', 'Game', 'LauncherController.ts'), 'utf8');
const orbSrc = readFileSync(join(here, 'assets', 'scripts', 'Pinball', 'OrbController.ts'), 'utf8');
const balanceSrc = readFileSync(join(here, 'assets', 'scripts', 'Core', 'OrbBalance.ts'), 'utf8');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!cond) {
        failed++;
    }
}

// ── 1. 上限常量与比较符号（核心回归锁：符号写反必挂）──
const maxAlive = Number(launcherSrc.match(/MAX_ALIVE_ORBS\s*=\s*(\d+)/)?.[1]);
check(`MAX_ALIVE_ORBS 已定义且为正整数（实际=${maxAlive}）`, Number.isInteger(maxAlive) && maxAlive > 0);

// 判断必须是 aliveCount + toAdd > MAX_ALIVE_ORBS；任何 < / <= / >= 形态都视为符号写反
const judge = launcherSrc.match(/if\s*\(\s*aliveCount\s*\+\s*toAdd\s*(>=|<=|>|<)\s*MAX_ALIVE_ORBS\s*\)/);
check(`同屏上限判断使用 >（超过才拦截；实际符号='${judge?.[1] ?? '未找到'}'）`, judge?.[1] === '>');

// ── 2. 旧错误日志不得回潮 ──
check('旧错误日志「同屏存活达到上限」已从源码移除', !launcherSrc.includes('同屏存活达到上限'));

// ── 3. 拦截场景真值表（公式与源码判断一致：拦截 ⇔ alive + toAdd > max）──
// splitCount 从 OrbBalance 源码提取，保证与真实雷球分裂配置一致
const splitCount = Number(balanceSrc.match(/splitCount:\s*(\d+)/)?.[1]);
check(`雷球 splitCount 已定义（实际=${splitCount}）`, Number.isInteger(splitCount) && splitCount > 0);
const blocked = (alive: number, toAdd: number): boolean => alive + toAdd > maxAlive;

check('存活=0 单发 → 允许发射（本次致命 bug 场景）', !blocked(0, 1));
check(`存活=0 雷球分裂 ${splitCount} 颗 → 允许发射`, !blocked(0, splitCount));
check(`存活=${maxAlive}（满员）单发 → 拦截`, blocked(maxAlive, 1));
check(`存活=${maxAlive - 1} 雷球分裂 ${splitCount} 颗 → 拦截（预留槽位防超限）`, blocked(maxAlive - 1, splitCount));
check(`存活=${maxAlive - 1} 单发 → 允许发射`, !blocked(maxAlive - 1, 1));

// ── 4. OrbController 物理防卡死链路完整 ──
check('STUCK_MAX_BUMPS 强制结算上限已定义', /STUCK_MAX_BUMPS\s*=\s*\d+/.test(orbSrc));
check('递进力度字段 _stuckBumps 已定义', /_stuckBumps\s*=\s*0/.test(orbSrc));
check('顶开力度随失败次数递增（IMPULSE * boost）', /STUCK_IMPULSE_[XY]\s*\*\s*boost/.test(orbSrc));
check('连顶仍卡 → 直接入槽结算腾位', /_stuckBumps >= STUCK_MAX_BUMPS[\s\S]{0,200}triggerFunnelAndDestroy\(null\)/.test(orbSrc));
check('恢复运动时递进力度归零', /_stuckTimer = 0;[\s\S]{0,80}_stuckBumps = 0/.test(orbSrc));
check('12s 存活保底保留且带可观测日志', /ORB_MAX_ALIVE\)[\s\S]{0,60}console\.log[\s\S]{0,200}triggerFunnelAndDestroy\(null\)/.test(orbSrc));

console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
