/**
 * M2 运营基建自检（纯 Node，无引擎依赖）—— Analytics 埋点壳行为校验：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-analytics.ts
 *
 * 覆盖：① track 入缓冲与属性保真 ② 环形缓冲 ≤BUF_MAX 且裁掉最旧 ③ localStorage 持久化与断电恢复
 *       ④ clear 清空 ⑤ 源码级：存档 key 独立、props 白名单类型、裁剪逻辑在位
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Analytics, BUF_MAX } from './assets/scripts/Core/Analytics.ts';

// ── node 无 DOM：装 localStorage stub（先于 Analytics 首次 ensureLoaded） ──
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

// ── ① track 基本行为 ──
Analytics.clear();
Analytics.track('run_start', { chapter: 1, level: 1 });
Analytics.track('card_pick', { pickedId: 'lava_orb', offers: ['lava_orb', 'univ_heal', 'frost_shield'], usedRefresh: false });
const recent = Analytics.getRecent();
check('track 入缓冲（2 条）', recent.length === 2);
check('事件名与属性保真', recent[0].event === 'run_start' && recent[0].props.chapter === 1
    && recent[1].event === 'card_pick' && (recent[1].props.offers as string[]).length === 3);
check('时间戳为 ms 量级（>1e12）', recent[0].ts > 1e12);

// ── ② 环形裁剪：多灌 50 条，最旧被挤出 ──
for (let i = 0; i < BUF_MAX + 50; i++) {
    Analytics.track('wave_start', { chapter: 1, level: 1, wave: i });
}
check(`环形裁剪：缓冲恒 ≤${BUF_MAX}`, Analytics.getRecent().length === BUF_MAX);
check('裁掉最旧：首条为第 50 次上报（wave=50）', Analytics.getRecent()[0].props.wave === 50);
const last = Analytics.getRecent();
check(`保留最新：末条 wave=${BUF_MAX + 49}`, last[last.length - 1].props.wave === BUF_MAX + 49);

// ── ③ 持久化与断电恢复 ──
check('localStorage 已写入缓冲 key', store.has('pinballforge_analytics_buf'));
(Analytics as any)._loaded = false; // 模拟进程重启：复位读档守卫
(Analytics as any)._buf = [];
Analytics.getRecent(); // 触发 ensureLoaded 重读
check('断电恢复：从存档读回满缓冲', Analytics.getRecent().length === BUF_MAX);

// ── ④ clear ──
Analytics.clear();
check('clear 清空内存与存档', Analytics.getRecent().length === 0 && !store.has('pinballforge_analytics_buf'));

// ── ⑤ 源码级断言 ──
const src = strip(read('Core', 'Analytics.ts'));
check('存档 key 独立（不触碰 progress / meta / daily）',
    /'pinballforge_analytics_buf'/.test(src)
    && !src.includes('pinballforge_progress')
    && !src.includes('pinballforge_meta')
    && !src.includes('pinballforge_daily'));
check('props 类型白名单（禁嵌套对象）', /Record<string, string \| number \| boolean \| string\[\]>/.test(src));
check('环形裁剪逻辑在位（splice 到 BUF_MAX）', /splice\(0, this\._buf\.length - BUF_MAX\)/.test(src));

console.log(failed === 0 ? '\n✅ Analytics 埋点壳自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
