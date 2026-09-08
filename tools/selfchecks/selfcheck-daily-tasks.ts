/**
 * M2 运营基建自检（纯 Node，无引擎依赖）—— DailyTask 每日任务数据模型 + MetaManager.addShards：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-daily-tasks.ts
 *
 * 覆盖：① 定义表（3 条 / id 唯一 / target-reward 为正） ② 进度上报（累加 / 封顶 / 未知 id 与非法增量忽略 / 已领奖停计）
 *       ③ 领取（未完成拒绝 / 完成入账碎片 / 重复领拒绝 / hasClaimable 红点） ④ 跨日重置（进度清零、碎片保留、日期翻新）
 *       ⑤ 存档隔离（独立 key） ⑥ addShards 行为与防御
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { DailyTaskManager, DAILY_TASK_DEFS } from '../../assets/scripts/Core/DailyTaskManager.ts';
import { MetaManager } from '../../assets/scripts/Core/MetaManager.ts';

// ── node 无 DOM：装 localStorage stub（先于任何 ensureLoaded） ──
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

/** 与 DailyTaskManager 同算法的本地日期键（跨日重置校验用） */
function expectToday(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

// ── ① 定义表 ──
check('每日 3 条任务', DAILY_TASK_DEFS.length === 3);
check('id 唯一且 snake_case', new Set(DAILY_TASK_DEFS.map((t) => t.id)).size === 3
    && DAILY_TASK_DEFS.every((t) => /^[a-z][a-z0-9_]*$/.test(t.id)));
check('目标与奖励为正数', DAILY_TASK_DEFS.every((t) => t.target > 0 && t.reward > 0));

// ── ② 进度上报 ──
check('新档进度为 0 且未领取', DailyTaskManager.getTaskList().every((t) => t.progress === 0 && !t.claimed));
DailyTaskManager.reportProgress('kills', 5);
DailyTaskManager.reportProgress('kills', 3);
check('进度累加（5+3=8）', DailyTaskManager.getTaskList().find((t) => t.id === 'kills')?.progress === 8);
DailyTaskManager.reportProgress('unknown_task');
check('未知任务 id 静默忽略',
    !DailyTaskManager.getTaskList().some((t) => t.id === 'unknown_task'));
DailyTaskManager.reportProgress('kills', 0);
DailyTaskManager.reportProgress('kills', -2);
check('非法增量忽略（仍 8）', DailyTaskManager.getTaskList().find((t) => t.id === 'kills')?.progress === 8);
DailyTaskManager.reportProgress('kills', 999);
check('进度封顶到 target（20/20）',
    DailyTaskManager.getTaskList().find((t) => t.id === 'kills')?.progress === 20);

// ── ③ 领取 ──
const shardsBefore = MetaManager.getShards();
check('未完成拒绝领取（funnels 进度 0）', DailyTaskManager.claim('funnels') === 0);
DailyTaskManager.reportProgress('funnels', 15);
check('canClaim 达标为 true', DailyTaskManager.canClaim('funnels'));
check('领取入账 20 碎片', DailyTaskManager.claim('funnels') === 20 && MetaManager.getShards() === shardsBefore + 20);
check('重复领取拒绝', DailyTaskManager.claim('funnels') === 0);
DailyTaskManager.reportProgress('funnels', 5);
check('已领奖后停止计数（仍 15）',
    DailyTaskManager.getTaskList().find((t) => t.id === 'funnels')?.progress === 15);
check('hasClaimable 红点（kills 已完成未领）', DailyTaskManager.hasClaimable() === true);
check('未完成不可领（clear_waves 进度 0）', !DailyTaskManager.canClaim('clear_waves'));

// ── ④ 跨日重置（真实模拟：把存档日期改写为旧日期 + 复位读档守卫，等价次日重启 / 长会话挂后台过夜） ──
const dailyRaw = JSON.parse(store.get('pinballforge_daily')!) as { day: string; progress: Record<string, number>; claimed: Record<string, boolean> };
dailyRaw.day = '2000-01-01';
store.set('pinballforge_daily', JSON.stringify(dailyRaw));
(DailyTaskManager as any)._loaded = false; // 模拟进程重启后重新读档
const nextDayList = DailyTaskManager.getTaskList(); // ensureLoaded 读到旧日期 → 触发重置
check('跨日重置：进度与领取全清零',
    nextDayList.every((t) => t.progress === 0 && !t.claimed));
check('跨日重置：日期翻新为今天', DailyTaskManager.getDay() === expectToday());
check('跨日重置：碎片保留（Meta 存档独立）', MetaManager.getShards() === shardsBefore + 20);
check('跨日重置后可重新完成并领取（kills 20/20 → 领 20）',
    (DailyTaskManager.reportProgress('kills', 20), DailyTaskManager.claim('kills') === 20)
    && MetaManager.getShards() === shardsBefore + 40);

// ── ⑤ 存档隔离（源码级） ──
const src = strip(read('Core', 'DailyTaskManager.ts'));
check('存档 key 独立（不触碰 progress / meta / analytics）',
    /'pinballforge_daily'/.test(src)
    && !src.includes('pinballforge_progress')
    && !src.includes('pinballforge_meta')
    && !src.includes('pinballforge_analytics_buf'));
check('奖励走 MetaManager.addShards（不直改 shards）',
    /MetaManager\.addShards\(def\.reward\)/.test(src) && !/this\.shards/.test(src));

// ── ⑥ addShards 行为与防御 ──
const meta = strip(read('Core', 'MetaManager.ts'));
check('addShards 接口在位（amount: number → number）', /addShards\(amount: number\): number/.test(meta));
check('addShards 防御非法值（isFinite + max(0, floor)）',
    /Number\.isFinite\(amount\)/.test(meta) && /Math\.max\(0, Math\.floor\(amount\)\)/.test(meta));
const shardsBeforeAdd = MetaManager.getShards();
check('addShards 负数 / NaN 入账 0',
    MetaManager.addShards(-5) === 0 && MetaManager.addShards(Number.NaN) === 0
    && MetaManager.getShards() === shardsBeforeAdd);
check('addShards 正常入账（+7）',
    MetaManager.addShards(7) === 7 && MetaManager.getShards() === shardsBeforeAdd + 7);

console.log(failed === 0 ? '\n✅ 每日任务数据模型自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
