/**
 * 第 2 步（七日签到 + 每日挑战）+ 第 3 步（激励视频点位）自检（纯 Node，无引擎依赖）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-retention-ads.ts
 *
 * 覆盖：① 签到（奖励表递增 / 每日一次 / 循环制断签不清零 / 碎片入账 / 重载持久化）
 *       ② 每日挑战（同日确定性目标关 / 首胜入账 / 重复领与非目标关拒绝 / 跨日重置）
 *       ③ AdService（mock 发奖回调 / ad_show→ad_complete 埋点漏斗）
 *       ④ 源码级接线（EventBus 新事件、货币走 MetaManager、存档 key 独立）
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { SignInManager, SIGNIN_REWARDS } from '../../assets/scripts/Core/SignInManager.ts';
import { DailyChallenge, DAILY_CHALLENGE_REWARD } from '../../assets/scripts/Core/DailyChallenge.ts';
import { AdService } from '../../assets/scripts/Core/AdService.ts';
import { MetaManager } from '../../assets/scripts/Core/MetaManager.ts';
import { Analytics } from '../../assets/scripts/Core/Analytics.ts';

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
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// ── ① 七日签到 ──
SignInManager.reset();
check('奖励表 7 日递增（20/30/40/50/60/80/120）',
    SIGNIN_REWARDS.length === 7
    && SIGNIN_REWARDS.every((v, i) => i === 0 || v > SIGNIN_REWARDS[i - 1])
    && SIGNIN_REWARDS[0] === 20 && SIGNIN_REWARDS[6] === 120);
check('新档可签且第 1 天奖 ⚒20', SignInManager.canSign() && SignInManager.getNextReward() === 20);
const shards0 = MetaManager.getShards();
check('签到入账 ⚒20', SignInManager.sign() === 20 && MetaManager.getShards() === shards0 + 20);
check('当日重复签到拒绝（返回 0）', SignInManager.sign() === 0 && !SignInManager.canSign());
check('碎片只入账一次', MetaManager.getShards() === shards0 + 20);
// 断签不清零：跨日后第 2 格照常 ⚒30（模拟次日：改写 lastSignDay + 复位读档守卫）
const raw = JSON.parse(store.get('pinballforge_signin')!) as { lastSignDay: string };
raw.lastSignDay = '2000-01-01';
store.set('pinballforge_signin', JSON.stringify(raw));
(SignInManager as any)._loaded = false;
check('跨日后恢复可签（断签不清零，第 2 天 ⚒30）',
    SignInManager.canSign() && SignInManager.getCycleDay() === 2 && SignInManager.getNextReward() === 30);
SignInManager.sign();
// 循环制：连续模拟 6 个"次日"签到，累计 7 次后奖励回到第 1 格（⚒20）
let lastReward = 0;
for (let i = 0; i < 6; i++) {
    const r = JSON.parse(store.get('pinballforge_signin')!) as { lastSignDay: string };
    r.lastSignDay = '2000-01-01';
    store.set('pinballforge_signin', JSON.stringify(r));
    (SignInManager as any)._loaded = false;
    lastReward = SignInManager.sign();
}
check('第 8 次签到奖励循环回第 1 格（⚒20）', lastReward === 20 && SignInManager.getTotalSigns() === 8);
check('循环指针指向第 2 格（下一签 ⚒30）',
    SignInManager.getCycleDay() === 2 && SignInManager.getNextReward() === 30);
check('signin 埋点已上报（daily_task_progress 表）', Analytics.getRecent().some((e) =>
    e.event === 'daily_task_progress' && e.props.taskId === 'signin'));

// ── ② 每日挑战 ──
store.delete('pinballforge_challenge');
(DailyChallenge as any)._loaded = false;
const ch = DailyChallenge.getTodayChapter();
const lv = DailyChallenge.getTodayLevel();
check(`目标关在合法范围（第 ${ch}-${lv} 关 ∈ 1-1~50-10）`,
    ch >= 1 && ch <= 50 && lv >= 1 && lv <= 10);
check('同日目标关确定性（重复读取一致）',
    DailyChallenge.getTodayChapter() === ch && DailyChallenge.getTodayLevel() === lv);
check('isFeatured 自洽（对目标关 true / 对其它关 false）',
    DailyChallenge.isFeatured(ch, lv) && !DailyChallenge.isFeatured(ch === 50 ? 1 : ch + 1, lv));
const shards1 = MetaManager.getShards();
check('非目标关通关不发奖', DailyChallenge.onRunWin(ch === 50 ? 1 : ch + 1, lv) === 0
    && MetaManager.getShards() === shards1);
check('目标关首胜入账 ⚒60', DailyChallenge.onRunWin(ch, lv) === DAILY_CHALLENGE_REWARD
    && MetaManager.getShards() === shards1 + DAILY_CHALLENGE_REWARD);
check('重复领奖拒绝', DailyChallenge.onRunWin(ch, lv) === 0
    && MetaManager.getShards() === shards1 + DAILY_CHALLENGE_REWARD);
// 跨日重置
const cRaw = JSON.parse(store.get('pinballforge_challenge')!) as { day: string };
cRaw.day = '2000-01-01';
store.set('pinballforge_challenge', JSON.stringify(cRaw));
(DailyChallenge as any)._loaded = false;
check('跨日重置：未领奖状态恢复（可再战）', !DailyChallenge.hasClaimed());

// ── ③ AdService（mock） ──
Analytics.clear();
let rewarded = 0;
let skipped = 0;
AdService.showRewarded('revive', () => { rewarded += 1; }, () => { skipped += 1; });
check('mock 激励视频播完发奖（onReward 恰好 1 次）', rewarded === 1 && skipped === 0);
check('ad_show → ad_complete 埋点漏斗齐备',
    Analytics.getRecent().some((e) => e.event === 'ad_show' && e.props.placement === 'revive')
    && Analytics.getRecent().some((e) => e.event === 'ad_complete' && e.props.placement === 'revive'));

// ── ④ 源码级接线 ──
const bus = strip(read('Core', 'EventBus.ts'));
check('EventBus 登记 RUN_REVIVED / RUN_CONTINUED（枚举 + 载荷映射）',
    bus.includes("RUN_REVIVED = 'RUN_REVIVED'") && bus.includes("RUN_CONTINUED = 'RUN_CONTINUED'")
    && bus.includes('[GameEvents.RUN_REVIVED]: void') && bus.includes('[GameEvents.RUN_CONTINUED]: void'));
const signSrc = strip(read('Core', 'SignInManager.ts'));
const chSrc = strip(read('Core', 'DailyChallenge.ts'));
check('签到 / 挑战奖励走 MetaManager.addShards（与死亡补偿同货币）',
    signSrc.includes('MetaManager.addShards(got)')
    && chSrc.includes('MetaManager.addShards(DAILY_CHALLENGE_REWARD)'));
check('签到 / 挑战存档 key 独立（不触碰 progress / meta / daily / dda）',
    signSrc.includes("'pinballforge_signin'") && chSrc.includes("'pinballforge_challenge'")
    && !signSrc.includes('pinballforge_progress') && !chSrc.includes('pinballforge_progress'));
const adSrc = strip(read('Core', 'AdService.ts'));
check('AdService 三点位 id 定义（revive / shards_double / card_refresh）',
    adSrc.includes("'revive'") && adSrc.includes("'shards_double'") && adSrc.includes("'card_refresh'"));
check('AdService 上报 ad_show（附录 A placement 字段）', adSrc.includes("Analytics.track('ad_show'"));

console.log(failed === 0 ? '\n✅ 留存钩子 + 广告服务自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);

