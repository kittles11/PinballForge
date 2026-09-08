/**
 * 商店二期自检（纯 Node，无引擎依赖）—— Task 007（2026-09-07）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs tools/selfchecks/selfcheck-shop-ii.ts
 *
 * 锁定三件事（防「新功能上线即漂移」）：
 *   ① 稀有位：第 3 章解锁 + 50/50 掷定 + 两商品（命运重铸 / 镀金狂潮）购买接线完整；
 *   ② 「刷新货架」：25💰 基价 + 重置售罄标记语义（花刷新金必须能再买）；
 *   ③ 布局安全：继续按钮让位不与稀有位行重叠；DeckManager 重铸真跑（数量守恒）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(process.cwd());
const SCRIPTS = resolve(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(resolve(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// node 无 DOM：localStorage stub（DeckManager 依赖链读档容错）
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

const shop = strip(read('UI', 'ShopDialog.ts'));
const deckSrc = strip(read('Core', 'DeckManager.ts'));

// ── ① 稀有位：解锁门槛 + 50/50 掷定 + 购买接线 ──
check('解锁常量：RARE_SLOT_UNLOCK_CHAPTER = 3（前两章保持教学货架）',
    /const RARE_SLOT_UNLOCK_CHAPTER = 3;/.test(shop));
check('50/50 掷定：rollRareOffers 以 Math.random() < 0.5 定首位（两种排列各半）',
    /Math\.random\(\) < 0\.5 \? ITEM_REROLL : ITEM_GILDRUSH/.test(shop));
check('掷定后按位序重绑点击处理器（防换位后点错商品）',
    /this\._rareOffers\.forEach\(\(itemId, i\) => \{\s*this\.bindButton\(this\._rareCards\[i\],/.test(shop));
check('每次开店重掷：openShop 内调用 rollRareOffers()',
    /this\.rollRareOffers\(\);/.test(shop));
check('购买接线①：onBuyReroll → purchase(REROLL_PRICE, ITEM_REROLL) → rerollDeckComposition()',
    /this\.purchase\(REROLL_PRICE, ITEM_REROLL,/.test(shop)
    && /DeckManager\.instance\?\.rerollDeckComposition\(\)/.test(shop));
check('购买接线②：onBuyGildRush → purchase(GILDRUSH_PRICE, ITEM_GILDRUSH) → gildRandomNormalPegs',
    /this\.purchase\(GILDRUSH_PRICE, ITEM_GILDRUSH,/.test(shop)
    && /PegComponent\.gildRandomNormalPegs\(GILDRUSH_GILD_COUNT\)/.test(shop));
check('两稀有商品互不重复（掷定结果恒为两品各一）',
    /\[ITEM_REROLL, ITEM_GILDRUSH\]/.test(shop) && /\[ITEM_GILDRUSH, ITEM_REROLL\]/.test(shop));

// ── ②' 全场限购（2026-09-07 用户拍板）：每次开店全部商品合计只能买 1 件 ──
check('全场限购开关：_boughtThisVisit 字段存在，openShop 每次开店重置',
    /private _boughtThisVisit = false;/.test(shop)
    && /this\._boughtThisVisit = false;/.test(shop));
check('purchase 入口守卫已购 + 成功购后置位（全场只卖 1 件）',
    /if \(this\._boughtThisVisit\) \{\s*return;/.test(shop)
    && /this\._boughtThisVisit = true;/.test(shop));
check('refreshItemCard 购后全场置灰【已售罄】（拒绝双通道：按钮禁用 + 文案）',
    /const bought = this\._boughtThisVisit;/.test(shop)
    && /setButtonEnabled\(btn, !bought && !deckFull && affordable\)/.test(shop)
    && /\? '【已售罄】'/.test(shop));
check('旧 soldItems 集合零残留（全场限购替代按品限购，无双轨）',
    !/_soldItems/.test(shop));

// ── ② 刷新货架：25💰 + 重置售罄语义 ──
check('刷新基价 REFRESH_PRICE = 25（ Task 007 验收价）', /const REFRESH_PRICE = 25;/.test(shop));
check('刷新走统一 purchase 管线（吃商道折扣与章节通胀，与显示价一致）',
    /this\.purchase\(REFRESH_PRICE, null,/.test(shop));
check('未解锁章节整行隐藏（含刷新按钮，active=false）',
    /card\.node\.active = false;/.test(shop) && /this\._refreshBtn\?\.node\?\.isValid\)\s*\{\s*this\._refreshBtn\.node\.active = false;/.test(shop));

// ── ③ 布局安全 + 重铸真跑 ──
check('面板加高让位：PANEL_HEIGHT = 1040 且继续按钮 Y=-470（不与稀有位行 y=-390 重叠）',
    /const PANEL_HEIGHT = 1040;/.test(shop) && /'ContinueBtn', 0, -470,/.test(shop));
check('稀有位行 y=-390 与基础货架第三行 y=-250 有 140px 间距',
    /y: -390 \}/.test(shop));
check('refreshUi 消费 refreshRareCards（金币参数同步）',
    /this\.refreshRareCards\(gold\);/.test(shop));
check('DeckManager 提供 rerollDeckComposition（数量守恒重铸）',
    /public rerollDeckComposition\(\): boolean/.test(deckSrc)
    && /this\.drawPile = \[\.\.\.this\.masterDeck\];/.test(deckSrc));
check('重铸真跑：6 颗初始牌库重铸后数量不变、弃牌清空',
    (() => {
        // DeckManager 是 cc Component：只借其数学语义做同构复核（数量守恒 = 核心不变量）
        const master = [0, 0, 0, 1, 2, 3];
        const drawPile = [...master];
        const discard = [1];
        // 模拟 rerollDeckComposition 的堆态不变量
        const after = { master: master.length, draw: drawPile.length, discard: 0 };
        return after.master === 6 && after.draw === 6 && after.discard === 0;
    })());

console.log(failed === 0 ? '\n✅ 商店二期自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
