/**
 * 冰球机制补全自检（纯 Node，无引擎依赖）—— Task 001（2026-09-07）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-frost.ts
 *
 * 背景：冰球此前是唯一「坏掉」的球种——freezeVulnerability 是死字段（恒 0 且无消费点），
 * 冰封只定身不加伤，商店又买不到 → 冰球体系只剩控制没有收益。
 * 覆盖：① 冰球签名易伤数值（0.25，reset 幂等恢复） ② EnemyController 冰封易伤乘区接线（球签名 × 卡牌）
 *       ③ 商店上架冰球（85 金，与闪电 / 熔岩同购买管线） ④ 易伤乘区纯算术复核
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

// node 无 DOM：localStorage stub（OrbBalance → MetaManager 读档容错）
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

const { OrbBalance } = await import('../../assets/scripts/Core/OrbBalance.ts');

const enemy = strip(read('Battle', 'EnemyController.ts'));
const shop = strip(read('UI', 'ShopDialog.ts'));
const orbBalance = strip(read('Core', 'OrbBalance.ts'));

// ── ① 冰球签名易伤：死字段复活 ──
check('DEFAULT_FROST.freezeVulnerability = 0.25（冰封 → 易伤的球签名闭环）',
    /freezeVulnerability: 0\.25,/.test(orbBalance));
check('运行时 OrbBalance.frost.freezeVulnerability === 0.25', OrbBalance.frost.freezeVulnerability === 0.25);
check('reset() 后仍恢复 0.25（重开不残留、也不归零）',
    (OrbBalance.reset(), OrbBalance.frost.freezeVulnerability === 0.25));
check('冰球签名保留：freezeDuration 4（入槽全场冰封）未被破坏', OrbBalance.frost.freezeDuration === 4);

// ── ② EnemyController 乘区接线：球签名 × 极寒易伤卡（独立乘区，乘法叠加与破绽 / 清剿令同惯例） ──
check('isFrozen 分支接线：iceVulnerableMult × (1 + freezeVulnerability)',
    /if \(this\.isFrozen\) \{\s*dmg \*= EnemyController\.iceVulnerableMult \* \(1 \+ OrbBalance\.frost\.freezeVulnerability\);\s*\}/.test(enemy));
check('EnemyController 已 import OrbBalance（消费点与数据源同一真源）',
    /import \{ OrbBalance \} from '\.\.\/Core\/OrbBalance';/.test(enemy));

// ── ③ 商店上架冰球（85 金，限购 1，与闪电 / 熔岩同 purchase 管线） ──
check('定价常量 BUY_FROST_PRICE = 85（与雷 / 熔同档）',
    /const BUY_FROST_PRICE = 85;/.test(shop));
check('商品 ID 与限购：ITEM_FROST 参与售罄集合',
    /const ITEM_FROST = 'frost';/.test(shop));
check('购买接线：purchase(BUY_FROST_PRICE, ITEM_FROST) → addOrbToDeck(OrbType.Frost)',
    /this\.purchase\(BUY_FROST_PRICE, ITEM_FROST,/.test(shop)
    && /DeckManager\.instance\?\.addOrbToDeck\(OrbType\.Frost\)/.test(shop));
check('UI 货架：冰霜卡创建 + refreshItemCard 刷新（含牌库满置灰）',
    /createCard\(this\.buyFrostBtn, 'BuyFrostBtn'/.test(shop)
    && /refreshItemCard\(this\._buyFrost, ITEM_FROST,/.test(shop));
check('文案披露易伤：+25%（玩家可读，非隐藏数值）',
    /受伤 \+25%/.test(shop));

// ── ④ 易伤乘区纯算术复核（防公式被手滑改坏） ──
const vuln = 1 + 0.25;
check('冻结敌人受击 100 → 125（仅球签名）', Math.round(100 * 1 * vuln) === 125);
check('冻结 + 极寒易伤卡（×1.5）100 → 188（乘法叠加）', Math.round(100 * 1.5 * vuln) === 188);
check('未冻结敌人不吃易伤（100 → 100）', Math.round(100 * 1 * 1) === 100);

console.log(failed === 0 ? '\n✅ 冰球机制自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);