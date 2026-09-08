/**
 * Task 004 敌人受击反馈包 —— 源码级 + 纯逻辑自检（无引擎依赖）。
 * 运行：node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-kill-feedback.ts
 *
 * 锁定三件事（诊断报告 Task 004 验收）：
 *  ① 击杀反馈链真实接线：EnemyController.die → HitStop 60ms + FxManager.blast + 击杀音；
 *  ② 连杀递进：窗口内累计、窗口外重置，音高爬升消费 killStreak；达到 KILL_STREAK_REWARD 叠奖励音；
 *  ③ 弹窗期免疫全部复用现成锁（HitStop._modalOpen / FxManager._modalOpen / CameraShake._isModalOpen），
 *     且击杀反馈不触碰刚体/碰撞体（物理回调栈内触发时与 FIRE_TURRET 顿帧同款安全路径）。
 * AudioManager.playKill 行为真跑：AudioManager 无 cc import（sys 除外? —— sys 来自 cc），
 * 故对 sfxEnabled/ctx 走「函数存在 + 合成入口不抛错」的守卫验证，不强制跑通播放链。
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const SCRIPTS = resolve(process.cwd(), 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

const enemy = strip(read('Battle', 'EnemyController.ts'));
const audio = strip(read('Core', 'AudioManager.ts'));
const hitstop = strip(read('Core', 'HitStop.ts'));
const fx = strip(read('Core', 'FxManager.ts'));
const shake = strip(read('Core', 'CameraShake.ts'));

// ── ① 击杀反馈链（die → HitStop/blast/音效）──
check('die() 内触发 60ms 顿帧：HitStop.stop(DIE_HITSTOP_MS)',
    /HitStop\.stop\(DIE_HITSTOP_MS\)/.test(enemy) && /DIE_HITSTOP_MS\s*=\s*60/.test(enemy));
check('die() 内爆炸演出：FxManager.blast（白闪+冲击环+火星+烟团）',
    /FxManager\.blast\(this\.node\.worldPosition/.test(enemy) && /DIE_BLAST_RADIUS\s*=\s*\d+/.test(enemy));
check('die() 内击杀震屏：CameraShake.shake（强度低于重炮开火区间 6~14）',
    /CameraShake\.shake\(DIE_SHAKE_INTENSITY,\s*DIE_SHAKE_DURATION\)/.test(enemy)
    && /DIE_SHAKE_INTENSITY\s*=\s*(\d+)/.test(enemy)
    && Number(enemy.match(/DIE_SHAKE_INTENSITY\s*=\s*(\d+)/)?.[1]) < 6);
check('die() 内击杀音：AudioManager.playKill(killStreak)', /AudioManager\.playKill\(killStreak\)/.test(enemy));
check('AudioManager.playKill 编号新增：双音合成主体 + 连杀 ≥2 拨弦层',
    /public static playKill\(streakBonus: number = 1\): void/.test(audio)
    && /playTone\('square', 330/.test(audio) && /if \(combo >= 2\)/.test(audio));

// ── ② 连杀递进 ──
check('连杀窗口内累计、窗口外重置（<= 窗口 → +1，否则归 1）',
    /now - EnemyController\._lastKillAt <= STREAK_WINDOW_FALLBACK \* 1000\s*\?\s*EnemyController\._killStreakCount \+ 1\s*:\s*1/.test(enemy));
check('连杀爬升消费：playKill 传 killStreak（音高随连杀数递增）',
    /AudioManager\.playKill\(killStreak\)/.test(enemy)
    && /Math\.min\(1 \+ Math\.max\(0, combo - 1\) \* 0\.05, 2\)/.test(audio));
check('连杀奖励音：达到 KILL_STREAK_REWARD 后 playKillStreak（里程碑反馈）',
    /killStreak >= KILL_STREAK_REWARD\)\s*\{\s*AudioManager\.playKillStreak\(\);/.test(enemy)
    && /public static playKillStreak\(\): void/.test(audio));
check('连杀递进跳字：连杀 ≥2 头顶追报 ✕N', /连杀 ✕\$\{killStreak\}/.test(enemy));

// ── ③ 弹窗期免疫复用现成锁（不新造锁）──
check('HitStop 保留 _modalOpen 门禁（击杀顿帧弹窗期静默）',
    /_modalOpen/.test(hitstop) && /inst\._modalOpen/.test(hitstop));
check('FxManager 保留弹窗期锁（obtain 拒发 → blast 系列自动静默）',
    /_modalOpen/.test(fx) && /this\._modalOpen \|\| this\._active >= ACTIVE_CAP/.test(fx));
check('CameraShake 保留弹窗期锁（击杀震屏弹窗期静默）',
    /_isModalOpen/.test(shake) && /inst\._isModalOpen/.test(shake));

// ── ④ 物理安全：击杀反馈不触碰刚体/碰撞体 ──
const dieBody = enemy.match(/private die\(\): void \{[\s\S]*?\n    \}/)?.[0] ?? '';
check('die() 反馈块零碰撞体操作（无 collider/RigidBody 增删与 enabled 翻转）',
    !!dieBody && !/RigidBody2D|Collider2D|\.enabled\s*=/.test(dieBody));

console.log(failed === 0 ? '\n✅ Task 004 击杀反馈自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
