/**
 * 程序化音乐系统自检（纯 Node，无引擎依赖）—— MusicManager 接线完整性 + 音序数据一致性：
 *   node --experimental-transform-types selfcheck-music.ts
 *
 * 背景：game-audio 原则「静音的游戏丢掉一半灵魂」——项目此前完全无 BGM。
 * MusicManager 依赖 EventBus（cc.EventTarget），node 无法直接跑行为，
 * 按 ops-wiring 同款双轨：源码级结构断言 + 可静态提取的音序数据断言。
 *
 * 覆盖：① 零 cc 依赖 / 共享 ctx（不自建 AudioContext）
 *       ② DeckManager 自举链 + 事件接线（波次强度 / 终局 stinger / 模态 ducking）
 *       ③ 调度器范式（前瞻排程 + 未解锁不推进 + 终局标记守卫）
 *       ④ 音序数据：4 和弦循环 / 32 格旋律 / stinger 上行与下行方向
 *       ⑤ Safari 兼容红线：exponentialRamp 目标值不得为 0
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

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

const music = strip(read('Core', 'MusicManager.ts'));

// ── ① 依赖与共享上下文 ──
check('MusicManager 零 cc 运行时依赖（纯 Web Audio，只 import AudioManager/EventBus）',
    !/from 'cc'/.test(music)
    && /import \{ AudioManager \} from '\.\/AudioManager';/.test(music)
    && /import \{ EventBus, GameEvents \} from '\.\/EventBus';/.test(music));
check('不自建 AudioContext：全部发声经 AudioManager.context 共享单例 ctx',
    !/new AudioContext|webkitAudioContext/.test(music)
    && /AudioManager\.context/.test(music));
check('AudioManager 暴露 context getter（共享出口存在）',
    /public static get context\(\): AudioContext \| null\s*\{\s*return AudioManager\.ctx;/.test(strip(read('Core', 'AudioManager.ts'))));

// ── ② 自举与事件接线 ──
check('DeckManager.onLoad 自举 MusicManager.ensureStarted()（与 Tutorial/OpsBridge 同款时机）',
    /MusicManager\.ensureStarted\(\);/.test(strip(read('Core', 'DeckManager.ts'))));
check('四事件全接线：WAVE_START / GAME_OVER / GAME_VICTORY / UI_MODAL_CHANGED',
    /EventBus\.on\(GameEvents\.WAVE_START/.test(music)
    && /EventBus\.on\(GameEvents\.GAME_OVER/.test(music)
    && /EventBus\.on\(GameEvents\.GAME_VICTORY/.test(music)
    && /EventBus\.on\(GameEvents\.UI_MODAL_CHANGED/.test(music));
check('wire() 幂等守卫（_wired 防重复注册）',
    /if \(MusicManager\._wired\) \{\s*return;/.test(music));

// ── ③ 调度器范式 ──
check('前瞻调度：setInterval 轮询 + while (nextTime < currentTime + LOOKAHEAD) 排程',
    /setInterval\(\(\) => MusicManager\._tick\(\), TICK_MS\)/.test(music)
    && /while \(MusicManager\._nextTime < ctx\.currentTime \+ LOOKAHEAD\)/.test(music));
check('未解锁不推进：ctx 非 running 时 _nextTime 归零（恢复后重新对齐，杜绝爆发补排）',
    /ctx\.state !== 'running'[\s\S]{0,120}MusicManager\._nextTime = 0/.test(music));
check('终局守卫：GAME_OVER/VICTORY 置 _ended 并停播；ensureStarted 清标记重播',
    /MusicManager\._ended = true;\s*MusicManager\._stop\(\)/.test(music)
    && /_start\(\)[\s\S]{0,80}if \(MusicManager\._running \|\| MusicManager\._ended\)/.test(music)
    && /ensureStarted[\s\S]{0,120}MusicManager\._ended = false/.test(music));
check('Boss 层由 WAVE_START 载荷驱动：_bossMode = config.isBoss',
    /_bossMode = !!d\?\.config\?\.isBoss/.test(music));
check('模态 ducking：UI_MODAL_CHANGED → BGM 总线 setTargetAtTime 0.25/1 平滑切换',
    /_bus\.gain\.setTargetAtTime\(open \? 0\.25 : 1, ctx\.currentTime, 0\.05\)/.test(music));
check('stinger 独立总线（终局反馈不受 duck 压制）',
    /_stingerBus[\s\S]{0,400}connect\(ctx\.destination\)/.test(music)
    && /_toneBus\(.*MusicManager\._stingerBus\)/.test(music));

// ── ④ 音序数据一致性（从源码静态提取） ──
const chordBass = [...music.matchAll(/\{ bass: (\d+), arp: \[([0-9, ]+)\] \}/g)];
check('和弦表恰 4 小节循环（Am-F-C-G）', chordBass.length === 4);
check('每和弦琶音 4 音', chordBass.every(([, , arp]) => arp.split(',').length === 4));
const melodyRow = music.match(/const MELODY: readonly number\[\] = \[([\s\S]*?)\];/);
// 数组字面量内的行尾注释（// Am 小节…）不参与解析：先剥掉再取数字格
const melody = melodyRow
    ? melodyRow[1].replace(/\/\/[^\n]*/g, '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
    : [];
check('B 乐句旋律 32 格（4 小节 × 8 八分）', melody.length === 32);
check('旋律格非休止即落在可闻音区（MIDI 40~90，休止=0）',
    melody.every((n) => n === 0 || (n >= 40 && n <= 90)));
const winRow = music.match(/const STINGER_WIN: readonly number\[\] = \[([\d, ]+)\];/);
const loseRow = music.match(/const STINGER_LOSE: readonly number\[\] = \[([\d, ]+)\];/);
const win = winRow ? winRow[1].split(',').map((s) => +s.trim()) : [];
const lose = loseRow ? loseRow[1].split(',').map((s) => +s.trim()) : [];
check('胜利 stinger 上行琶音（音高单调递增）', win.length === 4 && win.every((v, i) => i === 0 || v > win[i - 1]));
check('失败 stinger 下行音阶（音高单调递减）', lose.length === 4 && lose.every((v, i) => i === 0 || v < lose[i - 1]));
check('循环 64 步 = 8 小节 × 8 八分（A/B 双乐句结构成立）',
    /const LOOP_STEPS = 64;/.test(music) && /const BAR_STEPS = 8;/.test(music));

// ── ⑤ 兼容红线 ──
check('Safari 红线：无 exponentialRampToValueAtTime(0, ...) 零值目标',
    !/exponentialRampToValueAtTime\(0[,)]/.test(music));
check('音量入 ramp 前钳制（Math.max(0.0002, gain)）',
    /Math\.max\(0\.0002, gain\)/.test(music));

console.log(failed === 0 ? '\n✅ 程序化音乐系统自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
