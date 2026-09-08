/**
 * 第 1 步（动态难度）+ 第 4 步（无尽模式）自检（纯 Node，无引擎依赖）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-dda-endless.ts
 *
 * 覆盖：① DDA 计数（失败累加 / 胜利归零 / 首败不缓冲） ② 修正系数（≥2 败生效、阶梯、封底封顶）
 *       ③ 存档持久化（重载读档恢复） ④ getWaveConfig 消费（hp / spawnInterval 同步缩放）
 *       ⑤ 无尽模式（50-10 isFinalBattle / enterEndless → 51-1、nextLevel 无钳制外推、isFinalBattle 恒 false）
 *       ⑥ 源码级接线（OpsBridge 上报挂钩、LevelManager 双系数消费、红线：无难度提示文案）
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { DynamicDifficulty } from '../../assets/scripts/Core/DynamicDifficulty.ts';
import { LevelManager } from '../../assets/scripts/Core/LevelManager.ts';
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
function approx(a: number, b: number, eps = 1e-9): boolean {
    return Math.abs(a - b) < eps;
}

// ── ① DDA 计数 ──
DynamicDifficulty.reset();
check('初始无失败缓冲（hp=1.0 / spawn=1.0）',
    approx(DynamicDifficulty.getHpMult(), 1) && approx(DynamicDifficulty.getSpawnIntervalMult(), 1));
DynamicDifficulty.reportRun(false);
check('第 1 次失败是正常学习成本，不缓冲', approx(DynamicDifficulty.getHpMult(), 1));
DynamicDifficulty.reportRun(false);
check('连续失败第 2 次起生效（hp=0.96 / spawn=1.08）',
    approx(DynamicDifficulty.getHpMult(), 0.96) && approx(DynamicDifficulty.getSpawnIntervalMult(), 1.08));
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
check('阶梯累加（6 败 → over=5 → hp=0.80→封底 0.85 / spawn=1.40→封顶 1.24）',
    approx(DynamicDifficulty.getHpMult(), 0.85) && approx(DynamicDifficulty.getSpawnIntervalMult(), 1.24));
check('dda_report 埋点已上报', Analytics.getRecent().some((e) => e.event === 'dda_report'));
DynamicDifficulty.reportRun(true);
check('任意胜利归零重计', approx(DynamicDifficulty.getHpMult(), 1)
    && DynamicDifficulty.getLoseStreak() === 0);

// ── ② 存档持久化（写档 → 复位读档守卫模拟重启） ──
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
(DynamicDifficulty as any)._loaded = false;
check('重载读档恢复失败计数（3 败 → hp=0.92）',
    approx(DynamicDifficulty.getHpMult(), 0.92) && DynamicDifficulty.getLoseStreak() === 3);
DynamicDifficulty.reset();

// ── ③ getWaveConfig 消费修正 ──
LevelManager.resetProgress();
LevelManager.currentChapter = 2;
LevelManager.currentLevel = 1;
const normalHp = LevelManager.getWaveConfig(1).hp;
const normalSpawn = LevelManager.getWaveConfig(1).spawnInterval;
const normalCount = LevelManager.getWaveConfig(1).count;
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false);
DynamicDifficulty.reportRun(false); // 6 败：hp×0.85（封底）/ spawn×1.24（封顶）
const buffedDef = LevelManager.getWaveConfig(1);
check('敌 HP 按 DDA 系数缩放（×0.85 封底）', approx(buffedDef.hp, Math.round(normalHp * 0.85)));
check('出怪间隔按 DDA 系数拉长（×1.24 封顶）', approx(buffedDef.spawnInterval, normalSpawn * 1.24));
check('波次兵力不受 DDA 影响（防线压力不放松）', buffedDef.count === normalCount);
DynamicDifficulty.reset();
LevelManager.resetProgress();

// ── ④ 无尽模式 ──
LevelManager.resetProgress();
LevelManager.currentChapter = 50;
LevelManager.currentLevel = 10;
check('50-10 为终章之战（isFinalBattle）', LevelManager.isFinalBattle());
check('常规进度文本「第 50-10 关 (1/3波)」',
    LevelManager.getProgressText() === '第 50-10 关 (1/3波)');
check('常规 nextLevel 封顶第 50 章', (LevelManager.nextLevel(), LevelManager.currentChapter === 50));
LevelManager.resetProgress();
LevelManager.currentChapter = 50;
LevelManager.currentLevel = 10;
LevelManager.enterEndless();
check('enterEndless → 51-1 且 endless=true',
    LevelManager.endless && LevelManager.currentChapter === 51 && LevelManager.currentLevel === 1);
check('无尽模式 isFinalBattle 恒 false（流程无缝续战）', !LevelManager.isFinalBattle());
check('无尽进度文本「无尽 1 层 (1/3波)」', LevelManager.getProgressText() === '无尽 1 层 (1/3波)');
LevelManager.currentChapter = 53;
LevelManager.currentLevel = 10;
LevelManager.nextLevel();
check('无尽 nextLevel 章节继续 +1（53-10 → 54-1）',
    LevelManager.currentChapter === 54 && LevelManager.currentLevel === 1);
// 51 层第 1 波血量 > 50 层第 1 波（公式外推不重置）
LevelManager.currentChapter = 51;
LevelManager.currentLevel = 1;
const endlessHp = LevelManager.getWaveConfig(1).hp;
LevelManager.currentChapter = 50;
const capHp = LevelManager.getWaveConfig(1).hp;
check('51 层血量 > 50 层血量（公式继续外推）', endlessHp > capHp);
// 存档往返：endless 落盘（nextLevel 内部 save）
LevelManager.currentChapter = 52;
LevelManager.currentLevel = 3;
LevelManager.enterEndless();
const endlessRaw = JSON.parse(store.get('pinballforge_progress')!) as { chapter: number; endless: boolean };
check('无尽进度已落盘（endless:true + 章节 ≥ 51）',
    endlessRaw.endless === true && endlessRaw.chapter >= 51);
LevelManager.resetProgress();
check('resetProgress 清除无尽标记并归 1-1',
    !LevelManager.endless && LevelManager.currentChapter === 1 && LevelManager.currentLevel === 1);

// ── ⑤ 源码级接线 ──
const ops = strip(read('Core', 'OpsBridge.ts'));
check('OpsBridge 终局上报 DynamicDifficulty.reportRun（run_fail/run_win 双路径共用）',
    ops.includes('DynamicDifficulty.reportRun(win)'));
check('OpsBridge 通关上报 DailyChallenge.onRunWin',
    ops.includes('DailyChallenge.onRunWin(LevelManager.currentChapter, LevelManager.currentLevel)'));
const level = strip(read('Core', 'LevelManager.ts'));
check('getWaveConfig 消费 DDA 双系数（hp + spawnInterval）',
    level.includes('DynamicDifficulty.getHpMult()') && level.includes('DynamicDifficulty.getSpawnIntervalMult()'));
check('红线：无「难度已降低」类提示文案', !level.includes('难度已降低') && !level.includes('难度降低'));
check('isFinalBattle 排除无尽模式', level.includes('!this.endless && this.currentChapter >= MAX_CHAPTER'));
check('DDA 存档 key 独立', strip(read('Core', 'DynamicDifficulty.ts')).includes("'pinballforge_dda'"));

console.log(failed === 0 ? '\n✅ 动态难度 + 无尽模式自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);

