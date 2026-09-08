/**
 * 多分辨率适配自检（纯 Node，无引擎依赖）—— Task 010（2026-09-07）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs tools/selfchecks/selfcheck-resolution.ts
 *
 * 背景：弹窗均为「Dialog 节点 + Graphics 手绘」纯代码 UI，无 Widget/拉伸容器——多分辨率
 * 适配依赖两条约定，本自检将其锁死（防回归）：
 *   ① 遮罩铺满：全部弹窗 OVERLAY_WH ≥ 1811（=1280×√2，fitHeight 视高恒 1280，任意纵横比/旋转屏覆盖）；
 *   ② 面板收敛：PANEL_WIDTH ≤ 基线可视宽 720；商店加高 1040 仍在可视高 1280 内；
 *   ③ 窄屏缩放：ShopDialog.openShop 先 applyScale(可视宽)（20:9 可视宽 576 < 内容需求 660 → 等比缩小），
 *      弹性入场动效终点 = _uiScale（防 tween 固定 1 覆盖缩放）；
 *   ④ 稀有位布局：两稀有卡中心距 ≥ 卡宽（互不重叠）、最远边 ≤ 面板半宽（不越界）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(process.cwd());
const SCRIPTS = resolve(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(resolve(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行首注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// ── ① 设计分辨率真解析（settings JSON，不靠正则猜） ──
const proj = JSON.parse(readFileSync(resolve(ROOT, 'settings', 'v2', 'packages', 'project.json'), 'utf8'));
const dr = proj.general?.designResolution ?? {};
check('designResolution 720×1280 + fitHeight（视高恒 1280，遮罩/审计按此锁定）',
    dr.width === 720 && dr.height === 1280 && dr.fitHeight === true);

// fitHeight 几何：可视设计宽 = (屏宽/屏高) × 1280（纯算术）
const visW = (w: number, h: number): number => (w / h) * 1280;
check('16:9 竖屏可视宽 = 720（设计基线，零缩放）', Math.abs(visW(9, 16) - 720) < 0.01);
check('20:9 竖屏可视宽 = 576（市售窄屏下限档）', Math.abs(visW(9, 20) - 576) < 0.01);

// ── ② 遮罩铺满：OVERLAY_WH ≥ 1280×√2 ≈ 1811（对角线覆盖任意纵横比/旋转屏） ──
const dialogFiles = ['ShopDialog', 'SettingsDialog', 'DailyTaskDialog', 'DeckViewDialog', 'SignInDialog'];
for (const f of dialogFiles) {
    const m = strip(read('UI', `${f}.ts`)).match(/const OVERLAY_WH = (\d+);/);
    const wh = m ? Number(m[1]) : 0;
    check(`遮罩铺满：${f} OVERLAY_WH=${wh} ≥ 1811（1280×√2）`, wh >= 1811);
}

// ── ③ 面板收敛：宽 ≤ 720（基线可视宽），商店高 1040 ≤ 1280（可视高） ──
for (const f of dialogFiles) {
    const m = strip(read('UI', `${f}.ts`)).match(/const PANEL_WIDTH = (\d+);/);
    const w = m ? Number(m[1]) : 9999;
    check(`面板收敛：${f} PANEL_WIDTH=${w} ≤ 720`, w <= 720);
}
check('商店加高面板仍在竖屏可视高内：PANEL_HEIGHT=1040 ≤ 1280',
    /const PANEL_HEIGHT = 1040;/.test(strip(read('UI', 'ShopDialog.ts'))) && 1040 <= 1280);

// ── ④ 窄屏缩放护栏（ShopDialog：内容最宽 660、唯一带整体缩放的弹窗） ──
const shop = strip(read('UI', 'ShopDialog.ts'));
check('openShop 先 applyScale(view.getVisibleSize().width) 再掷稀有位（缩放先于布局/掷定）',
    /this\.applyScale\(view\.getVisibleSize\(\)\.width\);[\s\S]{0,80}this\.rollRareOffers\(\);/.test(shop));
check('内容需求宽 = max(面板620, 稀有卡跨度540) + 40 呼吸 = 660（16:9 免缩放 / 20:9 需缩放的临界）',
    /const need = Math\.max\(PANEL_WIDTH, 2 \* \(Math\.abs\(RARE_X\[1\]\) \+ BTN_WIDTH \/ 2\)\) \+ 40;/.test(shop)
    && Math.max(620, 2 * (140 + 130)) + 40 === 660);
check('缩放钳制 ≤1：_uiScale = Math.min(1, visW/need)（基线绝不放大；20:9 → 0.873 且缩放后 660×0.873 ≤ 576）',
    /this\._uiScale = Math\.min\(1, visW \/ need\);/.test(shop)
    && Math.abs(Math.min(1, visW(9, 20) / 660) - 0.873) < 0.001
    && Math.min(1, visW(9, 20) / 660) * 660 <= visW(9, 20) + 0.001);
check('入场动效终点 = _uiScale（防 tween 固定 1 覆盖窄屏缩放）',
    /\.to\(0\.06, \{ scale: new Vec3\(this\._uiScale, this\._uiScale, 1\) \}\)/.test(shop));

// ── ⑤ 稀有位布局回归锁：两卡不重叠、不越界、刷新卡补位第三行右空位 ──
check('RARE_X = [-140, 140]（与首二行 2 列同轨）', /const RARE_X = \[-140, 140\];/.test(shop));
const rareX = [-140, 140];
const cardW = 260;
check('两稀有卡中心距 280 ≥ 卡宽 260（互不重叠；修复前 ±140/0 三卡两两重叠 120px）',
    Math.abs(rareX[1] - rareX[0]) >= cardW);
check('稀有卡最远边 270 ≤ 面板半宽 310（不越界出面板）',
    Math.max(...rareX.map(Math.abs)) + cardW / 2 <= 620 / 2);
check('「刷新货架」落第三行右留白位 (140,-250)：与维修卡(-140,-250)同行不重叠',
    /140, -250, '刷新货架'/.test(shop) && Math.abs(140 - (-140)) >= cardW);

console.log(failed === 0 ? '\n✅ 多分辨率适配自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
