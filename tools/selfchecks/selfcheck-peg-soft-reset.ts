/**
 * 🔄 Boss 波钉板软复位（2026-09-06 方案乙「Boss 波红闪后钉板变空/只剩一颗」根修）— 源码级自检（不依赖 cc 运行时）。
 * 运行：node --experimental-transform-types selfcheck-peg-soft-reset.ts
 *
 * 锁定软复位接线契约：
 *  1) EventBus 新增 PEG_EXHAUSTED（void 载荷），PegComponent.exhaust() 是唯一派发点；
 *  2) PegBoardManager 监听 PEG_EXHAUSTED，按 WAVE_START 载荷 config.isBoss 武装/撤防；
 *  3) 复位判定用「当前力竭数」实时统计（刷新钉复活不虚高累计口径），阈值 14（21 颗的 2/3）；
 *  4) 复新经 scheduleOnce(0) 跑在物理 step 之外，执行前复查武装态（换波让位）；
 *  5) generateBoard 清零软复位预算（新板新鲜起算）；同帧连环力竭只排一次（pending 守卫）。
 * 说明：不 import 项目文件（cc 别名无法在 Node ESM 下解析），一律从源码正则提取真源，顺带锁定「源码形状」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Task 005: 自检已迁至 tools/selfchecks/，仓库根锚点从 here 上提两级
const REPO_ROOT = join(here, '..', '..');
const read = (...p: string[]): string => readFileSync(join(REPO_ROOT, ...p), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const busSrc = read('assets', 'scripts', 'Core', 'EventBus.ts');
const pegSrc = strip(read('assets', 'scripts', 'Pinball', 'PegComponent.ts'));
const board = strip(read('assets', 'scripts', 'Pinball', 'PegBoardManager.ts'));

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!cond) {
        failed++;
    }
}

check('EventBus 新增 PEG_EXHAUSTED 事件（void 载荷登记进 GameEventMap）',
    /PEG_EXHAUSTED\s*=\s*'PEG_EXHAUSTED'/.test(busSrc)
    && /\[GameEvents\.PEG_EXHAUSTED\]:\s*void/.test(busSrc));
check('PegComponent 引入 EventBus（emit 依赖）',
    /import \{ EventBus, GameEvents \} from '\.\.\/Core\/EventBus'/.test(pegSrc));
check('PegComponent.exhaust() 派发 PEG_EXHAUSTED（软复位唯一信源）',
    (pegSrc.match(/EventBus\.emit\(GameEvents\.PEG_EXHAUSTED\)/g) ?? []).length === 1);
check('PegBoardManager 监听 PEG_EXHAUSTED（targetOff(this) 统一注销即可覆盖）',
    /EventBus\.on\(GameEvents\.PEG_EXHAUSTED,\s*this\.onPegExhausted,\s*this\)/.test(board));
check('WAVE_START 按 config.isBoss 武装软复位（换波撤防）',
    /_bossSoftResetArmed\s*=\s*!!data\?\.config\?\.isBoss/.test(board));
check('阈值常量 = 14（21 颗的 2/3，钉板恒保有 ≥1/3 活钉）',
    /const BOSS_SOFT_RESET_EXHAUST_THRESHOLD\s*=\s*14/.test(board));
check('复位判定用当前力竭数实时统计（非累计口径，刷新钉复活不虚高）',
    /isExhausted\)\s*\{\s*exhausted\+\+/.test(board));
check('复新经 scheduleOnce(0) 跑在物理 step 之外',
    /this\.scheduleOnce\(\(\)\s*=>\s*\{[\s\S]*?PegComponent\.resetAllPegs\(\)/.test(board));
check('复新执行前复查武装态（换波 / 节点失效让位）',
    /!this\._bossSoftResetArmed \|\| !this\.node\?\.isValid/.test(board));
check('同帧连环力竭只排一次（_softResetPending 守卫）',
    /this\._softResetPending \|\| !this\.node\?\.isValid/.test(board));
check('generateBoard 清零软复位预算（新板新鲜起算）',
    /_softResetPending\s*=\s*false;\s*\n\s*this\._softResetCount\s*=\s*0;/.test(board));

// ── 方案B 收尾同步（2026-09-07）：版型轮换 + 过热掷选的源码形状锁定 ──
check('版型轮换指针 _layoutRoll 取模前移（wrap 归 0），非 roll-0 走池内索引',
    /this\._layoutRoll = \(this\._layoutRoll \+ 1\) % layouts\.length;/.test(board)
    && /const layout = this\._layoutRoll === 0/.test(board));
check('过热掷选：普通钉池 Fisher-Yates 洗牌后取前 OVERHEAT_PEG_COUNT 颗',
    /const pool = pegComponents\.filter\(\(p\) => p\.pegType === PegType\.Normal\);/.test(board)
    && /const j = Math\.floor\(Math\.random\(\) \* \(i \+ 1\)\);/.test(board)
    && /const overheated = pool\.slice\(0, OVERHEAT_PEG_COUNT\);/.test(board));
check('过热武装：armOverheat() 逐颗调用（PegComponent.onHit 受击即熄）',
    /for \(const peg of overheated\)\s*\{\s*peg\.armOverheat\(\);/.test(board));
check('方案B 决策钉日志随首次生成打出（_boardLogOnce 守卫内打完即置位）',
    /if \(!this\._boardLogOnce\)\s*\{\s*console\.log\(`\[PegBoard\] 🔥 方案B 决策钉/.test(board)
    && /this\._boardLogOnce = true;\s*\n\s*\}/.test(board));

if (failed > 0) {
    console.error(`\n❌ ${failed} 项未通过`);
    process.exit(1);
}
console.log('\n✅ Boss 波钉板软复位接线自检全部通过');
