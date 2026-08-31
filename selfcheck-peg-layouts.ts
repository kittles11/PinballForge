/**
 * 🎯 钉板版型（PegBoardManager）+ 顶部牌库按钮落位（DeckButtonController）— 源码级 + 纯几何自检（不依赖 cc 运行时）。
 * 运行：node --experimental-transform-types selfcheck-peg-layouts.ts
 *
 * 本自检锁定「封死直落漏斗漏洞」的版型契约与「按钮不压关卡标题」的避让契约：
 *  1) 三套版型均为 5 行 × 21 颗、最宽行恒 5（横向间距恒为 (BOARD_WIDTH - 2·EDGE_PADDING) / 4 = 172）；
 *  2) 版型 A / B 顶层为 5 颗全宽行（封堵两侧通道 / 封堵直落），版型 B 底层亦为 5 颗（守护漏斗入口）；
 *  3) 封通道不变量：棋盘可用宽度内任意竖直下落线，到「前两行」最近钉的水平距离 ≤ 列距一半
 *     （即不存在宽度超过半列距的整列贯通通道；旧金字塔版型顶层仅 1~3 钉时该值远超列距，正是直落漏斗漏洞）；
 *  4) PEG_LAYOUTS 恰由 LAYOUT_A / LAYOUT_B / LAYOUT_C 组成；
 *  5) 🎒 按钮顶边不进关卡标题带（WaveLabel y≈590±25）与遗物栏瓷片带（y∈[530,570]），右缘落在 20:9 窄屏可视半宽 284 内。
 * 说明：不 import 项目文件（cc 别名无法在 Node ESM 下解析），一律从源码正则提取真源，顺带锁定「源码形状」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]): string => readFileSync(join(here, ...p), 'utf8');
const boardSrc = read('assets', 'scripts', 'Pinball', 'PegBoardManager.ts');
const btnSrc = read('assets', 'scripts', 'UI', 'DeckButtonController.ts');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!cond) {
        failed++;
    }
}

// —— 1. 版型数据契约：5 行 × 21 颗、最宽行 5 ——
const parseLayout = (name: string): number[] => {
    const m = boardSrc.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
    return m ? m[1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
};
const LAYOUT_A = parseLayout('LAYOUT_A');
const LAYOUT_B = parseLayout('LAYOUT_B');
const LAYOUT_C = parseLayout('LAYOUT_C');
const layouts = [['LAYOUT_A', LAYOUT_A], ['LAYOUT_B', LAYOUT_B], ['LAYOUT_C', LAYOUT_C]] as const;

for (const [name, layout] of layouts) {
    check(`${name} 共 5 行`, layout.length === 5);
    check(`${name} 合计 21 颗`, layout.reduce((a, b) => a + b, 0) === 21);
    check(`${name} 最宽行 5 列（横向间距撑满 720 全宽）`, Math.max(...layout) === 5);
}
check('PEG_LAYOUTS = [LAYOUT_A, LAYOUT_B, LAYOUT_C]',
    /const PEG_LAYOUTS\s*=\s*\[LAYOUT_A,\s*LAYOUT_B,\s*LAYOUT_C\]/.test(boardSrc));

// —— 2. 顶层全宽 / 底层守护漏斗 ——
check('版型 A 顶层 5 颗全宽（封堵两侧通道）', LAYOUT_A[0] === 5);
check('版型 B 顶层 5 颗全宽（封堵直落）', LAYOUT_B[0] === 5);
check('版型 B 底层 5 颗（守护漏斗入口）', LAYOUT_B[4] === 5);

// —— 3. 封通道几何不变量：任意竖直下落线到前两行最近钉 ≤ 列距一半 ——
const boardW = Number(boardSrc.match(/const BOARD_WIDTH\s*=\s*(\d+)/)?.[1] ?? 0);
const edge = Number(boardSrc.match(/const EDGE_PADDING\s*=\s*(\d+)/)?.[1] ?? 0);
const spacingX = (boardW - edge * 2) / (5 - 1); // 最宽行恒 5 → 列距 172
const worstGap = (layout: readonly number[]): number => {
    // 前两行钉心 x 坐标（与 generateBoard 的「每行以 X=0 为中线居中」公式一致）
    const pegs: number[] = [];
    for (const rowCols of layout.slice(0, 2)) {
        for (let c = 0; c < rowCols; c++) {
            pegs.push((c - (rowCols - 1) / 2) * spacingX);
        }
    }
    // 可用宽度内逐像素扫描：取「到最近钉距离」的最大值
    const half = boardW / 2 - edge;
    let worst = 0;
    for (let x = -half; x <= half; x += 1) {
        let best = Infinity;
        for (const px of pegs) {
            best = Math.min(best, Math.abs(x - px));
        }
        worst = Math.max(worst, best);
    }
    return worst;
};
for (const [name, layout] of layouts) {
    const worst = worstGap(layout);
    check(`${name} 前两行封死宽直落通道（最大无钉距离 ${worst.toFixed(0)}px ≤ 列距一半 ${spacingX / 2}px）`,
        worst <= spacingX / 2 + 1e-9);
}

// —— 4. 🎒 按钮避让关卡标题 / 遗物栏 / 窄屏裁切 ——
const btnX = Number(btnSrc.match(/const BTN_X\s*=\s*(-?[\d.]+)/)?.[1] ?? 0);
const btnY = Number(btnSrc.match(/const BTN_Y\s*=\s*(-?[\d.]+)/)?.[1] ?? 0);
const btnW = Number(btnSrc.match(/const BTN_WIDTH\s*=\s*(\d+)/)?.[1] ?? 96);
const btnH = Number(btnSrc.match(/const BTN_HEIGHT\s*=\s*(\d+)/)?.[1] ?? 44);
check('🎒 按钮顶边 ≤ 530（同时避开标题带下缘 565 与遗物瓷片带顶 530）', btnY + btnH / 2 <= 530);
check('🎒 按钮整体仍属顶部区（未坠入钉板/漏斗区）', btnY > 0);
check('🎒 按钮右缘 ≤ 284（20:9 窄屏可视半宽 640×9/20）', btnX + btnW / 2 <= 284);

console.log(failed === 0 ? '\n✅ 钉板版型 + 按钮落位自检全部通过' : `\n❌ ${failed} 项自检失败`);
process.exitCode = failed === 0 ? 0 : 1;
