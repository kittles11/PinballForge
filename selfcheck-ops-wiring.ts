/**
 * M2 运营接线自检（纯 Node，无引擎依赖）—— 附录 A 埋点全量挂钩 + 每日任务进度上报：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-ops-wiring.ts
 *
 * 覆盖：① meta_buy（buy 成功上报 / 失败不上报） ② daily_task_progress（进度 claimed:false / 领取 claimed:true / 已领停计）
 *       ③ OpsBridge 桥接映射（事件 → 埋点 / 任务进度的源码级存在性） ④ UI 弹窗挂钩点（card / relic / shop / 面板）
 *       ⑤ 自举链（DeckManager → OpsBridge / DailyTaskDialog；WaveManager 补 emit WAVE_START）
 * OpsBridge 的 EventBus 运行时翻译层依赖 cc 引擎（EventTarget / Component.schedule），node 无法直接跑行为，
 * 以源码级结构检查 + 纯逻辑模块（MetaManager / DailyTaskManager / Analytics）行为断言双轨覆盖。
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { MetaManager } from './assets/scripts/Core/MetaManager.ts';
import { DailyTaskManager } from './assets/scripts/Core/DailyTaskManager.ts';
import { Analytics } from './assets/scripts/Core/Analytics.ts';

// ── node 无 DOM：装 localStorage stub（先于任何 ensureLoaded；各单例懒读档，顶层 new 不触碰） ──
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰结构检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

/** 读 Analytics 环形缓冲里最后一条匹配事件（行为断言用） */
function lastEvent(event: string): { props: Record<string, unknown> } | undefined {
    const hits = Analytics.getRecent().filter((e) => e.event === event);
    return hits.length > 0 ? hits[hits.length - 1] : undefined;
}

// ── ① meta_buy：MetaManager.buy 成功分支上报（附录 A：upgradeId, toLv, price） ──
const lv0 = MetaManager.getLv('damage');
const price0 = MetaManager.getPrice('damage');
if (price0 >= 0 && MetaManager.getShards() < price0) {
    MetaManager.addShards(price0); // 兜底补碎片保证 buy 可成功
}
const shardsBeforeBuy = MetaManager.getShards();
const bought = MetaManager.buy('damage');
check('buy 成功（升级 + 扣费）', bought && MetaManager.getLv('damage') === lv0 + 1
    && MetaManager.getShards() === shardsBeforeBuy - price0);
const metaBuy = lastEvent('meta_buy');
check('meta_buy 已上报且字段齐备', !!metaBuy
    && metaBuy.props.upgradeId === 'damage' && metaBuy.props.toLv === lv0 + 1 && metaBuy.props.price === price0);
// 失败不上报：满级路径（castle 连买到满级后 getPrice 返回 -1）
while (MetaManager.getPrice('castle') >= 0) {
    MetaManager.addShards(MetaManager.getPrice('castle'));
    MetaManager.buy('castle');
}
const bufLenAfterMaxed = Analytics.getRecent().length;
check('满级后 buy 拒绝且不上报', MetaManager.buy('castle') === false && Analytics.getRecent().length === bufLenAfterMaxed);

// ── ② daily_task_progress：进度（claimed:false）与领取（claimed:true）同表漏斗 ──
Analytics.clear(); // 隔离：只看本节产生的事件
const before = DailyTaskManager.getTaskList().find((t) => t.id === 'clear_waves')!;
DailyTaskManager.reportProgress('clear_waves', 2);
const progEvt = lastEvent('daily_task_progress');
check('reportProgress 上报 daily_task_progress（claimed:false）', !!progEvt
    && progEvt.props.taskId === 'clear_waves' && progEvt.props.progress === before.progress + 2
    && progEvt.props.claimed === false);
DailyTaskManager.reportProgress('clear_waves', 99); // 封顶到 target
check('封顶后 progress 上报为 target', lastEvent('daily_task_progress')?.props.progress === before.target);
const claimGot = DailyTaskManager.claim('clear_waves');
check('claim 入账奖励并上报（claimed:true）', claimGot > 0
    && lastEvent('daily_task_progress')?.props.claimed === true
    && lastEvent('daily_task_progress')?.props.progress === before.target);
const evtCountAfterClaim = Analytics.getRecent().filter((e) => e.event === 'daily_task_progress').length;
DailyTaskManager.reportProgress('clear_waves', 1); // 已领奖：停计且不再上报
check('已领奖后 reportProgress 静默（无新事件）',
    Analytics.getRecent().filter((e) => e.event === 'daily_task_progress').length === evtCountAfterClaim
    && DailyTaskManager.getTaskList().find((t) => t.id === 'clear_waves')!.progress === before.target);

// ── ③ OpsBridge 桥接映射（源码级：事件 → 埋点 / 任务进度） ──
const ops = strip(read('Core', 'OpsBridge.ts'));
check('session_start 冷启动一次上报', ops.includes("Analytics.track('session_start')") && ops.includes('_sessionReported'));
check('run_start 挂首个 WAVE_START（loadFromSave 后进度才准）',
    ops.includes('_runStartReported') && ops.includes("Analytics.track('run_start'"));
check('wave_start / wave_clear 全量挂钩',
    ops.includes("Analytics.track('wave_start'") && ops.includes("Analytics.track('wave_clear'")
    && ops.includes('durationSec'));
check('run_fail 带 castleHpLeft（动态难度输入）', ops.includes("Analytics.track('run_fail'") && ops.includes('castleHpLeft'));
check('run_win + run_end 上报', ops.includes("Analytics.track('run_win'") && ops.includes("Analytics.track('run_end'"));
check('run_end 延迟一帧（确保 grantRunReward 已入账）', ops.includes('scheduleOnce'));
check('shardsEarned = 结算读数 − 局初读数', ops.includes('_shardsAtRunStart') && ops.includes('shardsEarned'));
check('shop_view 挂 SHOW_SHOP（带 goldBalance）', ops.includes("Analytics.track('shop_view'") && ops.includes('goldBalance'));
check('任务进度上报：击杀 / 清波 / 入槽开火',
    ops.includes("reportProgress('kills')") && ops.includes("reportProgress('clear_waves')")
    && ops.includes("reportProgress('funnels')"));
check('击杀挂 ENEMY_KILLED、入槽开火挂 FIRE_TURRET',
    ops.includes('GameEvents.ENEMY_KILLED') && ops.includes('GameEvents.FIRE_TURRET'));

// ── ④ UI 弹窗挂钩点（源码级） ──
const reward = strip(read('UI', 'RewardDialog.ts'));
check('card_offer 上报（offers 为 id 数组 + chapter）',
    reward.includes("Analytics.track('card_offer'") && reward.includes('map((c) => c.id)'));
check('card_pick 上报（pickedId + offers + usedRefresh 占位）',
    reward.includes("Analytics.track('card_pick'") && reward.includes('pickedId') && reward.includes('usedRefresh: false'));
check('relic_offer 上报（types 数组）', reward.includes("Analytics.track('relic_offer'"));
const shop = strip(read('UI', 'ShopDialog.ts'));
check('shop_buy 上报在 purchase 成功分支（itemId + price + goldBalance）',
    shop.includes("Analytics.track('shop_buy'") && shop.includes("soldId ?? 'remove_card'")
    && shop.indexOf("Analytics.track('shop_buy'") > shop.indexOf('spendGold(price)'));
const dialog = strip(read('UI', 'DailyTaskDialog.ts'));
check('任务面板监听 SHOW_DAILY_TASKS 并调 claim', dialog.includes('GameEvents.SHOW_DAILY_TASKS')
    && dialog.includes('DailyTaskManager.claim(') && dialog.includes('canClaim('));

// ── ⑤ 自举链与契约（源码级） ──
const deck = strip(read('Core', 'DeckManager.ts'));
check('DeckManager.onLoad 自举 OpsBridge + DailyTaskDialog',
    deck.includes('OpsBridge.ensureMounted()') && deck.includes('DailyTaskDialog.ensureMounted()'));
const wave = strip(read('Battle', 'WaveManager.ts'));
check('WaveManager.startWave 补 emit WAVE_START（原只有监听无 emit 的接线缺口）',
    wave.includes('EventBus.emit(GameEvents.WAVE_START'));
const bus = strip(read('Core', 'EventBus.ts'));
check('WAVE_START 载荷为真实 WaveDef（原遗留 WaveConfig 类型）',
    bus.includes('[GameEvents.WAVE_START]: { config: WaveDef }') && !bus.includes('WaveConfig'));
check('SHOW_DAILY_TASKS 事件契约登记', bus.includes("SHOW_DAILY_TASKS = 'SHOW_DAILY_TASKS'")
    && bus.includes('[GameEvents.SHOW_DAILY_TASKS]: void'));
const meta = strip(read('Core', 'MetaManager.ts'));
check('meta_buy 挂 MetaManager.buy 成功分支', meta.indexOf("Analytics.track('meta_buy'") > meta.indexOf('this.save()'));
const daily = strip(read('Core', 'DailyTaskManager.ts'));
check('daily_task_progress 挂 reportProgress 与 claim 两处',
    (daily.match(/Analytics\.track\('daily_task_progress'/g) ?? []).length === 2);

console.log(failed === 0 ? '\n✅ 运营接线自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
