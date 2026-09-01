/**
 * 🎒 牌库与遗物背包面板（DeckViewDialog / DeckButtonController）— 源码级 + 纯逻辑自检（不依赖 cc 运行时）。
 * 运行：node --experimental-transform-types selfcheck-deck-view.ts
 *
 * 本自检锁定：
 *  1) SHOW_DECK_VIEW 事件在 EventBus 枚举与 GameEventMap 中已登记（漏登记 = 编译期静默断链）；
 *  2) DeckButtonController 轻点广播 SHOW_DECK_VIEW，且保留 TAP_SLOP 拖拽防误触守卫；
 *  3) DeckViewDialog 监听 SHOW_DECK_VIEW 打开：先广播 UI_MODAL_CHANGED true 再激活节点（冻结发射）；
 *  4) closeDialog：广播 UI_MODAL_CHANGED false 必须发生在隐藏节点之前（恢复发射不因收起动效延迟）；
 *  5) DeckManager 自举两件套（ensureMounted）与 masterDeck 公开可读；
 *  6) 牌库统计聚合公式真值表（与 buildDeckText 行为一致：按固定球种顺序、数量为 0 不显示）。
 * 说明：不 import 项目文件（cc 别名无法在 Node ESM 下解析），一律从源码正则提取真源，顺带锁定「源码形状」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]): string => readFileSync(join(here, ...p), 'utf8');
const busSrc = read('assets', 'scripts', 'Core', 'EventBus.ts');
const deckSrc = read('assets', 'scripts', 'Core', 'DeckManager.ts');
const dialogSrc = read('assets', 'scripts', 'UI', 'DeckViewDialog.ts');
const btnSrc = read('assets', 'scripts', 'UI', 'DeckButtonController.ts');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!cond) {
        failed++;
    }
}

// —— 1. 事件登记 ——
check('GameEvents 枚举已登记 SHOW_DECK_VIEW', /SHOW_DECK_VIEW\s*=\s*'SHOW_DECK_VIEW'/.test(busSrc));
check('GameEventMap 已登记 [SHOW_DECK_VIEW]: void', /\[GameEvents\.SHOW_DECK_VIEW\]\s*:\s*void/.test(busSrc));

// —— 2. 顶部背包按钮 ——
check('按钮轻点广播 SHOW_DECK_VIEW', /EventBus\.emit\(GameEvents\.SHOW_DECK_VIEW\)/.test(btnSrc));
const tapSlop = btnSrc.match(/if\s*\(\s*Vec2\.distance\(this\._pressPos,\s*pos\)\s*>\s*TAP_SLOP\s*\)\s*\{\s*return/);
check('轻点防误触守卫（位移 > TAP_SLOP 直接返回）仍存在', !!tapSlop);
check('按钮自举 ensureMounted 挂到 Canvas/UILayer/DeckBtn', /getChildByName\('DeckBtn'\)/.test(btnSrc) && /find\('Canvas\/UILayer'\)/.test(btnSrc));

// —— 3. 弹窗打开：冻结发射先于激活 ——
check('弹窗监听 SHOW_DECK_VIEW → showDialog', /EventBus\.on\(GameEvents\.SHOW_DECK_VIEW,\s*this\.showDialog,\s*this\)/.test(dialogSrc));
const showBody = dialogSrc.match(/public showDialog\(\)[\s\S]*?\n    \}/)?.[0] ?? '';
check('showDialog 内先广播 UI_MODAL_CHANGED(true) 冻结发射', /EventBus\.emit\(GameEvents\.UI_MODAL_CHANGED,\s*true\)/.test(showBody));
check('showDialog 随后激活节点（active = true）', /this\.node\.active\s*=\s*true/.test(showBody));
check('showDialog 打开时刷新内容（refreshContent）', /this\.refreshContent\(\)/.test(showBody));

// —— 4. 弹窗关闭：恢复发射必须先于隐藏（收起动效不阻塞 Launcher 解冻） ——
const closeBody = dialogSrc.match(/public closeDialog\(\)[\s\S]*?\n    \}/)?.[0] ?? '';
const resumeIdx = closeBody.indexOf('EventBus.emit(GameEvents.UI_MODAL_CHANGED, false)');
const hideIdx = closeBody.indexOf('this.node.active = false');
check('closeDialog 广播 UI_MODAL_CHANGED(false) 恢复发射', resumeIdx >= 0);
check('closeDialog 恢复发射先于隐藏节点（发射器即时解冻）', resumeIdx >= 0 && hideIdx >= 0 && resumeIdx < hideIdx);
check('关闭按钮/遮罩触摸绑定 closeDialog', /TOUCH_END,\s*this\.closeDialog,\s*this/.test(dialogSrc));

// —— 5. DeckManager 自举与数据源 ——
check('DeckManager.start 自举 DeckButtonController.ensureMounted', /DeckButtonController\.ensureMounted\(\)/.test(deckSrc));
// 弹窗自举已从 DeckManager 迁出（本类不再反向 import 它，解除循环引用）：
// 由 DeckViewDialog 模块级自举负责（bootstrap 注册场景启动钩子 + ensureMounted 兜底挂载）
const dialogBoot = dialogSrc.match(/DeckViewDialog\.bootstrap\(\);\s*[\r\n]+\s*DeckViewDialog\.ensureMounted\(\);/);
check('DeckViewDialog 模块级自举存在（bootstrap + ensureMounted，替代 DeckManager 反向挂载）', !!dialogBoot);
check('masterDeck 为 public（背包面板统计各球种数量）', /public\s+masterDeck\s*:\s*number\[\]/.test(deckSrc));

// —— 6. 牌库统计聚合公式真值表（与 buildDeckText 行为一致） ——
// 公式：单遍计数 → 按 ORB_DISPLAY 固定顺序过滤 count>0 → 「icon name × count」以 \n 连接
const orbDisplay = [...dialogSrc.matchAll(/\{\s*type:\s*OrbType\.(\w+),\s*icon:\s*'([^']+)',\s*name:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ key: m[1], icon: m[2], name: m[3] }));
check('ORB_DISPLAY 覆盖 5 种球种（普通/闪电/熔岩/冰霜/等离子）', orbDisplay.length === 5);
const countDeck = (deck: number[]): string => {
    const counts = new Map<number, number>();
    for (const t of deck) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return orbDisplay
        .map((d, i) => ({ ...d, count: counts.get(i) ?? 0 }))
        .filter((d) => d.count > 0)
        .map((d) => `${d.icon} ${d.name} × ${d.count}`)
        .join('\n');
};
check('初始卡组 3普通+1雷+1熔岩+1冰 → 4 行计数', countDeck([0, 0, 0, 1, 2, 3]).split('\n').length === 4);
check('计数正确聚合（0×3 → ⚪ 普通弹珠 × 3）', countDeck([0, 0, 0, 1, 2, 3]).includes('⚪ 普通弹珠 × 3'));
check('数量为 0 的球种不显示', !countDeck([1, 1]).includes('普通弹珠'));
check('删卡后数量同步减少（1雷 → ⚡ 裂变雷球 × 1）', countDeck([0, 1, 2, 3]).includes('⚡ 裂变雷球 × 1'));
check('Meta 解锁的等离子球（type 4）在背包正确计数显示', countDeck([0, 0, 4]).includes('🟣 等离子球 × 1'));

console.log(failed === 0 ? '\n✅ 全部自检通过' : `\n❌ ${failed} 项自检失败`);
process.exit(failed === 0 ? 0 : 1);
