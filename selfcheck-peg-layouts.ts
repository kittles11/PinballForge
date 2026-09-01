/**
 * 🎯 钉板版型（PegBoardManager）+ 顶部牌库按钮落位（DeckButtonController）— 源码级 + 纯几何自检（不依赖 cc 运行时）。
 * 运行：node --experimental-transform-types selfcheck-peg-layouts.ts
 *
 * 本自检锁定「封死直落漏斗漏洞」的版型契约与「按钮不压关卡标题」的避让契约：
 *  1) 五套版型（基础 A/B/C + Meta 钉板实验台解锁 D/E）均为 5 行 × 21 颗、最宽行恒 5、无相邻等长行；
 *  2) 版型 A / B 顶层为 5 颗全宽行（封堵两侧通道 / 封堵直落），版型 B 底层亦为 5 颗（守护漏斗入口）；
 *  3) 封通道不变量：棋盘可用宽度内任意竖直下落线，到「前两行」最近钉的水平距离 ≤ 列距一半
 *     （即不存在宽度超过半列距的整列贯通通道；旧金字塔版型顶层仅 1~3 钉时该值远超列距，正是直落漏斗漏洞）；
 *  4) BASE_PEG_LAYOUTS 恒含 A/B/C；activePegLayouts 按 boardLab 档位纳入 D(Lv1+)/E(Lv3+)；
 *  5) 🎒 按钮右上角贴顶落位契约：与顶部 HUD 行同行、高于怪物走廊，窄屏由 resolveX 钳制保证完整可见。
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
const LAYOUT_D = parseLayout('LAYOUT_D');
const LAYOUT_E = parseLayout('LAYOUT_E');
const layouts = [
    ['LAYOUT_A', LAYOUT_A], ['LAYOUT_B', LAYOUT_B], ['LAYOUT_C', LAYOUT_C],
    ['LAYOUT_D', LAYOUT_D], ['LAYOUT_E', LAYOUT_E],
] as const;

for (const [name, layout] of layouts) {
    check(`${name} 共 5 行`, layout.length === 5);
    check(`${name} 合计 21 颗`, layout.reduce((a, b) => a + b, 0) === 21);
    check(`${name} 最宽行 5 列（横向间距撑满 720 全宽）`, Math.max(...layout) === 5);
    let noAdjEqual = true;
    for (let i = 1; i < layout.length; i++) {
        if (layout[i] === layout[i - 1]) noAdjEqual = false;
    }
    check(`${name} 无相邻等长行（相邻必半距错位 → 无对齐直落通道）`, noAdjEqual);
}
check('BASE_PEG_LAYOUTS = [LAYOUT_A, LAYOUT_B, LAYOUT_C]（基础三套恒可用）',
    /const BASE_PEG_LAYOUTS\s*=\s*\[LAYOUT_A,\s*LAYOUT_B,\s*LAYOUT_C\]/.test(boardSrc));
check('activePegLayouts 按钉板实验台档位纳入 D(Lv1+)/E(Lv3+)',
    /function activePegLayouts\(\)/.test(boardSrc)
    && /getBoardLabLv\(\)/.test(boardSrc)
    && /lab >= 1[\s\S]{0,60}push\(LAYOUT_D\)/.test(boardSrc)
    && /lab >= 3[\s\S]{0,60}push\(LAYOUT_E\)/.test(boardSrc));
check('generateBoard 走 activePegLayouts 随机（不再硬编码旧 PEG_LAYOUTS）',
    /const layouts = activePegLayouts\(\);/.test(boardSrc)
    && !/PEG_LAYOUTS\[Math\.floor/.test(boardSrc));

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

// —— 4. 🎒 按钮落位：右上角贴顶契约（P0 v2 布局）——
// 36×36 徽章钉 (BTN_X, BTN_Y)=(290, 600)：与顶部 HUD 行（城堡/标题/金币 y≈590）同行贴顶、
// 横向在金币右侧与标题（x=0）错开；Y 高于怪物走廊（≈480）全程零遮挡；
// 窄屏可见性由 resolveX() 按「可视半宽 - 半径 - 8」钳制（常量 X 仅是宽屏期望位）。
const btnX = Number(btnSrc.match(/const BTN_X\s*=\s*(-?[\d.]+)/)?.[1] ?? 0);
const btnY = Number(btnSrc.match(/const BTN_Y\s*=\s*(-?[\d.]+)/)?.[1] ?? 0);
const btnSize = Number(btnSrc.match(/const BTN_SIZE\s*=\s*(\d+)/)?.[1] ?? 36);
const CANVAS_HALF_H = 640; // 720×1280 画布锚点居中
const CORRIDOR_Y = 480;    // 怪物行进走廊上沿
check(`🎒 按钮贴顶可见（顶边 ${btnY + btnSize / 2} ≤ 画布顶 ${CANVAS_HALF_H}）`,
    btnY > 0 && btnY + btnSize / 2 <= CANVAS_HALF_H);
check(`🎒 按钮高于怪物走廊（底边 ${btnY - btnSize / 2} ≥ 走廊上沿 ${CORRIDOR_Y}，行进零遮挡）`,
    btnY - btnSize / 2 >= CORRIDOR_Y);
check('🎒 按钮在金币右侧 HUD 带内（X > 金币位 210，与标题 x=0 横向错开）', btnX > 210);
check('🎒 窄屏钳制：resolveX 按可视半宽收半径与余量（20:9 下右缘 ≤ halfW - 8，徽章完整可见）',
    /Math\.min\(BTN_X,\s*halfW\s*-\s*BTN_SIZE\s*\/\s*2\s*-\s*8\)/.test(btnSrc));
check('🎒 onLoad 强制钉位（场景误摆旧位置也会被纠正）',
    /this\.node\.setPosition\(DeckButtonController\.resolveX\(\),\s*BTN_Y,\s*0\)/.test(btnSrc));

console.log(failed === 0 ? '\n✅ 钉板版型 + 按钮落位自检全部通过' : `\n❌ ${failed} 项自检失败`);
process.exitCode = failed === 0 ? 0 : 1;
