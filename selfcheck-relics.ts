/**
 * 遗物系统自检（P2-3）—— 上限规则 / 空池软锁回归锁 / 获得反馈接线：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-relics.ts
 *
 * 背景：game-design「玩家必须能从界面确认规则」。此前遗物规则（唯一持有、上限、
 * 效果全文）只存在于代码；且存在真实软锁：5 件遗物收齐后（第 3 章起第 5/10 关必然
 * 到达），传奇藏宝箱 unowned 空池 → 两张卡全隐藏 → 弹窗无可点目标 →
 * REWARD_SELECTED 永不发出、波次卡死。
 *
 * 覆盖：① 数据行为真跑（DataModels 零 cc 依赖）：表长=上限、唯一性、字段完整
 *       ② 软锁回归锁：showRewards 分流必须带 unowned>0 守卫
 *       ③ 上限唯一守卫：addRelic 满池拒绝
 *       ④ 反馈接线：RELIC_ACQUIRED 监听/注销成对、新瓷片弹入+跳字、点击复习全文、占位 x/5
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { register } from 'node:module';
register('./ts-resolve-hook.mjs', import.meta.url);
const { RELIC_DATABASE, ALL_RELIC_TYPES } = await import('./assets/scripts/Core/DataModels.ts');

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// ── ① 数据行为真跑 ──
check('遗物全表恰 5 件且 id 唯一（上限=表长的数据前提）',
    ALL_RELIC_TYPES.length === 5 && new Set(ALL_RELIC_TYPES).size === 5);
check('RELIC_DATABASE 覆盖全部类型且名称/图标/描述/价格完整',
    ALL_RELIC_TYPES.every((t: string) => {
        const d = (RELIC_DATABASE as Record<string, { name: string; icon: string; desc: string; price: number }>)[t];
        return !!d && d.name.length > 0 && d.icon.length > 0 && d.desc.length > 0 && d.price > 0;
    }));

// ── ② 软锁回归锁（本次修复的核心） ──
const reward = strip(read('UI', 'RewardDialog.ts'));
check('宝箱分流带空池守卫：unownedCount > 0 才走 showRelicChest（收齐 5 件后回退三选一）',
    /const unownedCount = ALL_RELIC_TYPES\.filter\(\(t\) => !RelicManager\.hasRelic\(t\)\)\.length;/.test(reward)
    && /&& unownedCount > 0\) \{\s*this\.showRelicChest\(\);/.test(reward));
check('回退路径可达：守卫失败落入常规三选一（_chestMode=false 分支在后续代码）',
    /this\._chestMode = false;/.test(reward));

// ── ③ 上限唯一守卫 ──
const mgr = strip(read('Core', 'RelicManager.ts'));
check('MAX_RELICS 显式定义 = ALL_RELIC_TYPES 表长',
    /export const MAX_RELICS = ALL_RELIC_TYPES\.length;/.test(mgr));
check('addRelic 满池拒绝（size >= MAX_RELICS → false，唯一守卫点）',
    /if \(RelicManager\.ownedRelics\.size >= MAX_RELICS\) \{\s*console\.warn\([\s\S]{0,120}return false;/.test(mgr));
check('addRelic 事件序：先 RELIC_ACQUIRED 后 RELIC_CHANGED（视图高亮消费依赖此时序）',
    /EventBus\.emit\(GameEvents\.RELIC_ACQUIRED, type\);\s*EventBus\.emit\(GameEvents\.RELIC_CHANGED/.test(mgr));

// ── ④ 反馈接线 ──
const bar = strip(read('UI', 'RelicBarController.ts'));
check('RELIC_ACQUIRED 监听/注销成对（onLoad on ↔ onDestroy off，无泄漏）',
    /EventBus\.on\(GameEvents\.RELIC_ACQUIRED, this\.onRelicAcquired, this\)/.test(bar)
    && /EventBus\.off\(GameEvents\.RELIC_ACQUIRED, this\.onRelicAcquired, this\)/.test(bar));
check('获得反馈：新瓷片弹入（0.2→1.25→1）+ 跳字「获得」，消费后清标记',
    /_pendingHighlight = null;[\s\S]*?setScale\(0\.2, 0\.2, 1\)[\s\S]*?Vec3\(1\.25, 1\.25, 1\)[\s\S]*?获得遗物/.test(bar));
check('rebuild 尾部消费高亮标记（时序：ACQUIRED 置位 → CHANGED 重建 → 高亮）',
    /this\.highlightNewlyAcquired\(\);\s*\}/.test(bar));
check('点击瓷片复习被动全文（TOUCH_END → showText(name：desc)，命中区显式 118×34）',
    /tile\.on\(Node\.EventType\.TOUCH_END/.test(bar)
    && /showText\(\s*`\$\{info\.name\}：\$\{info\.desc\}`/.test(bar)
    && /tf\.setContentSize\(TILE_WIDTH, TILE_HEIGHT\)/.test(bar));
check('瓷片图标走 IconLib 矢量染色（mountIcon，icon 字段为注册表名而非 emoji）',
    /mountIcon\(tile, info\.icon, 22, TILE_BORDER/.test(bar));
check('占位文案展示上限规则 0/5（数据驱动非硬编码）',
    /遗物 0\/\$\{ALL_RELIC_TYPES\.length\}/.test(bar));
check('占位态清高亮标记（防御：空池无瓷片可弹，标记不得穿透到下次重建）',
    /if \(types\.length === 0\) \{\s*this\.addPlaceholder\(\);\s*this\._pendingHighlight = null;/.test(bar));

console.log(failed === 0 ? '\n✅ 遗物系统自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
