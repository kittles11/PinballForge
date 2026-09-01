/**
 * 程序化音乐管理器（纯静态类，零音频素材、零 Inspector，与 AudioManager 同构）：
 * Web Audio 实时合成 BGM 循环 + 胜/负 stinger + 模态 ducking + Boss 强度层。
 *
 * 【设计依据（game-audio 原则）】
 *  - 混音层级：音乐是 -12dB 级打底（音符峰值增益 0.018~0.16，远低于玩家 SFX），
 *    模态弹窗打开时 duck 到 25%，关闭恢复（setTargetAtTime 平滑，无爆音）；
 *  - 「一首曲子无限循环」是反模式：8 小节 A/B 双乐句循环（A 琶音+低音+垫音，
 *    B 乐句叠加旋律线），Boss 波再叠低 tom 打击层——听感随战况推进；
 *  - 终局反馈用 stinger：GAME_OVER 下行小调 / GAME_VICTORY 上行大调，短促乐句
 *    即时压过 BGM（独立 stinger 总线，不受 duck 影响）；
 *  - 零外部音频文件：全合成，无版权、无打包路径问题；无 Web Audio 的环境整体静默降级。
 *
 * 【调度】25ms 轮询 + 120ms 前瞻的经典 Web Audio 排程（lookahead scheduler），
 * 96 BPM 八分音符步进；与 AudioManager 共享同一 AudioContext（浏览器单页上下文
 * 数量有限，且首次手势解锁链路已由 AudioManager.warmup / unlockAudio 打通）。
 *
 * 【生命周期】DeckManager.onLoad 每场景启动 ensureStarted()（清终局标记并起播）；
 * GAME_OVER / GAME_VICTORY 停播并置终局标记，重开一局随场景重载自然恢复。
 */
import { AudioManager } from './AudioManager';
import { EventBus, GameEvents } from './EventBus';
import type { GameEventMap } from './EventBus';

/** 96 BPM 的八分音符步长（秒）：60 / 96 / 2 */
const EIGHTH = 0.3125;
/** 调度轮询间隔（毫秒）与前瞻窗口（秒） */
const TICK_MS = 25;
const LOOKAHEAD = 0.12;
/** 循环长度：8 小节 × 每小节 8 个八分 = 64 步（前 4 小节 A 乐句，后 4 小节 B 乐句+旋律） */
const LOOP_STEPS = 64;
const BAR_STEPS = 8;

/** 每小节和弦表（Am–F–C–G 自然小调进行循环）：bass 为根音 MIDI，arp 为琶音四音 */
const CHORDS: ReadonlyArray<{ bass: number; arp: readonly number[] }> = [
    { bass: 45, arp: [57, 60, 64, 69] }, // Am：A2 根音，A3 C4 E4 A4
    { bass: 41, arp: [53, 57, 60, 65] }, // F ：F2 根音，F3 A3 C4 F4
    { bass: 48, arp: [52, 55, 60, 64] }, // C ：C3 根音，E3 G3 C4 E4
    { bass: 43, arp: [55, 59, 62, 67] }, // G ：G2 根音，G3 B3 D4 G4
];

/** B 乐句旋律线（32 个八分格，0=休止）：小调五声下行动机，与和弦表逐小节对齐 */
const MELODY: readonly number[] = [
    69, 0, 67, 0, 64, 0, 0, 0,   // Am 小节：A4 G4 E4
    65, 0, 64, 0, 60, 0, 0, 0,   // F  小节：F4 E4 C4
    64, 0, 62, 0, 60, 0, 64, 0,  // C  小节：E4 D4 C4 E4
    62, 0, 59, 0, 55, 0, 0, 0,   // G  小节：D4 B3 G3
];

/** 胜利 stinger：C 大调上行琶音 C5→E5→G5→C6 + 主和弦长音 */
const STINGER_WIN: readonly number[] = [72, 76, 79, 84];
/** 失败 stinger：A 小调下行 A4→F4→D4→A3 + 低音长坠 */
const STINGER_LOSE: readonly number[] = [69, 65, 62, 57];

export class MusicManager {
    /** wire() 幂等守卫（与 AudioManager._wired 同款：热更/重复 import 不重复注册） */
    private static _wired = false;
    /** 调度器运行中 */
    private static _running = false;
    /** 终局标记：GAME_OVER/VICTORY 停播；ensureStarted（新场景自举）时清除 */
    private static _ended = false;
    /** Boss 强度层：WAVE_START{isBoss} 置位，叠加低 tom 打击并抬亮琶音 */
    private static _bossMode = false;
    /** 模态 ducking 状态（UI_MODAL_CHANGED 驱动） */
    private static _ducked = false;
    /** setInterval 句柄（stop 时清除） */
    private static _timer = 0;
    /** 当前八分步（0~63 循环） */
    private static _step = 0;
    /** 下一步的排程时刻（ctx 时间轴）；0 = 待重新对齐（未解锁/暂停后恢复） */
    private static _nextTime = 0;
    /** BGM 音符总出口（ducking 唯一操作点） */
    private static _bus: GainNode | null = null;
    /** stinger 独立出口：终局反馈不受 duck 压制 */
    private static _stingerBus: GainNode | null = null;

    // ---------- 对外入口 ----------

    /**
     * 场景自举（DeckManager.onLoad 调用，与 TutorialManager/OpsBridge 同款时机）：
     * 接线事件 + 清终局标记 + 启动调度器。幂等；无 Web Audio 环境静默跳过。
     */
    public static ensureStarted(): void {
        MusicManager.wire();
        MusicManager._ended = false;
        MusicManager._start();
    }

    /** 事件接线（幂等）：波次强度 / 终局 stinger / 模态 ducking */
    public static wire(): void {
        if (MusicManager._wired) {
            return;
        }
        MusicManager._wired = true;
        EventBus.on(GameEvents.WAVE_START, MusicManager.onWaveStart, MusicManager);
        EventBus.on(GameEvents.GAME_OVER, MusicManager.onGameOver, MusicManager);
        EventBus.on(GameEvents.GAME_VICTORY, MusicManager.onGameVictory, MusicManager);
        EventBus.on(GameEvents.UI_MODAL_CHANGED, MusicManager.onModalChanged, MusicManager);
    }

    // ---------- 调度器 ----------

    private static _start(): void {
        if (MusicManager._running || MusicManager._ended) {
            return;
        }
        if (typeof window === 'undefined') {
            return; // 原生端 / node 等无 Web Audio 环境：静默降级
        }
        AudioManager.unlockAudio(); // 惰性创建共享 ctx（手势前创建为 suspended，解锁靠既有首触链路）
        const ctx = AudioManager.context;
        if (!ctx) {
            return;
        }
        MusicManager._ensureBuses(ctx);
        MusicManager._running = true;
        MusicManager._step = 0;
        MusicManager._nextTime = 0;
        MusicManager._timer = setInterval(() => MusicManager._tick(), TICK_MS) as unknown as number;
        console.log('🎵 [Music] 程序化 BGM 调度器已启动（96 BPM · Am-F-C-G · A/B 双乐句）');
    }

    private static _stop(): void {
        if (!MusicManager._running) {
            return;
        }
        MusicManager._running = false;
        clearInterval(MusicManager._timer);
        MusicManager._timer = 0;
    }

    /** 前瞻排程：把未来 LOOKAHEAD 秒内的八分步全部挂上 ctx 时间轴 */
    private static _tick(): void {
        const ctx = AudioManager.context;
        if (!ctx || ctx.state !== 'running' || !MusicManager._running) {
            MusicManager._nextTime = 0; // 未解锁/被挂起：不推进，恢复后从当前时刻重新对齐（杜绝爆发补排）
            return;
        }
        if (MusicManager._nextTime === 0) {
            MusicManager._nextTime = ctx.currentTime + 0.06;
        }
        while (MusicManager._nextTime < ctx.currentTime + LOOKAHEAD) {
            MusicManager._scheduleStep(MusicManager._step, MusicManager._nextTime);
            MusicManager._step = (MusicManager._step + 1) % LOOP_STEPS;
            MusicManager._nextTime += EIGHTH;
        }
    }

    /** 单个八分步：低音(拍1/3) + 琶音(每八分，B 段后半翻高八度) + 垫音(小节头) + B 段旋律 + Boss 打击层 */
    private static _scheduleStep(step: number, t: number): void {
        const chord = CHORDS[Math.floor(step / BAR_STEPS) % CHORDS.length];
        const inBar = step % BAR_STEPS;
        const phraseB = step >= LOOP_STEPS / 2;
        if (inBar === 0 || inBar === 4) {
            MusicManager._tone(chord.bass, t, 0.5, 0.16, 'triangle');
        }
        const arpNote = chord.arp[inBar % chord.arp.length] + (phraseB && inBar >= 4 ? 12 : 0);
        MusicManager._tone(arpNote, t, 0.14, MusicManager._bossMode ? 0.07 : 0.05, 'sine');
        if (inBar === 0) {
            for (const m of chord.arp.slice(0, 3)) {
                MusicManager._tone(m - 12, t, 1.7, 0.018, 'sine');
            }
        }
        if (phraseB) {
            const m = MELODY[step - LOOP_STEPS / 2];
            if (m > 0) {
                MusicManager._tone(m, t, 0.34, 0.075, 'triangle');
            }
        }
        if (MusicManager._bossMode && (inBar === 0 || inBar === 4)) {
            MusicManager._tom(t);
        }
    }

    // ---------- 发声 ----------

    /** 单音：指数起振 + 指数衰减包络（全部走 vol 钳制，杜绝 Safari exponentialRamp 零值异常） */
    private static _tone(midi: number, t: number, dur: number, gain: number, type: OscillatorType): void {
        const ctx = AudioManager.context;
        if (!ctx || !MusicManager._bus) {
            return;
        }
        try {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(Math.max(1, MusicManager.hz(midi)), t);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.012);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            osc.connect(g);
            g.connect(MusicManager._bus);
            osc.start(t);
            osc.stop(t + dur + 0.02);
            osc.onended = () => {
                osc.disconnect();
                g.disconnect();
            };
        } catch (e) { /* 单音失败不拖垮调度器 */ }
    }

    /** Boss 低 tom：90Hz 坠至 45Hz 的短促鼓底 */
    private static _tom(t: number): void {
        const ctx = AudioManager.context;
        if (!ctx || !MusicManager._bus) {
            return;
        }
        try {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(90, t);
            osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
            g.gain.setValueAtTime(0.22, t);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
            osc.connect(g);
            g.connect(MusicManager._bus);
            osc.start(t);
            osc.stop(t + 0.16);
            osc.onended = () => {
                osc.disconnect();
                g.disconnect();
            };
        } catch (e) { /* 同上 */ }
    }

    /** 终局 stinger：等间隔上行/下行音阶 + 收尾长和弦（走独立总线，即时可闻） */
    private static _playStinger(notes: readonly number[], win: boolean): void {
        const ctx = AudioManager.context;
        if (!ctx) {
            return;
        }
        MusicManager._ensureBuses(ctx);
        const gap = win ? 0.14 : 0.2;
        const t0 = ctx.currentTime + 0.05;
        notes.forEach((m, i) => {
            MusicManager._toneBus(m, t0 + i * gap, win ? 0.16 : 0.3, 0.2, 'triangle', MusicManager._stingerBus);
        });
        if (win) {
            for (const m of [72, 76, 79]) {
                MusicManager._toneBus(m, t0 + notes.length * gap, 1.1, 0.12, 'sine', MusicManager._stingerBus);
            }
        } else {
            MusicManager._toneBus(45, t0 + notes.length * gap, 1.4, 0.18, 'triangle', MusicManager._stingerBus);
        }
    }

    /** stinger 版单音：目标总线可指定 */
    private static _toneBus(midi: number, t: number, dur: number, gain: number, type: OscillatorType, bus: GainNode | null): void {
        const ctx = AudioManager.context;
        if (!ctx || !bus) {
            return;
        }
        try {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(Math.max(1, MusicManager.hz(midi)), t);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.015);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            osc.connect(g);
            g.connect(bus);
            osc.start(t);
            osc.stop(t + dur + 0.02);
            osc.onended = () => {
                osc.disconnect();
                g.disconnect();
            };
        } catch (e) { /* 静默 */ }
    }

    /** 双总线惰性创建：BGM 总线（ducking 操作点）+ stinger 总线 */
    private static _ensureBuses(ctx: AudioContext): void {
        if (!MusicManager._bus) {
            MusicManager._bus = ctx.createGain();
            MusicManager._bus.gain.value = MusicManager._ducked ? 0.25 : 1;
            MusicManager._bus.connect(ctx.destination);
        }
        if (!MusicManager._stingerBus) {
            MusicManager._stingerBus = ctx.createGain();
            MusicManager._stingerBus.gain.value = 1;
            MusicManager._stingerBus.connect(ctx.destination);
        }
    }

    // ---------- 事件回调 ----------

    /** 波次开始：同步 Boss 强度层；顺带兜底起播（终局标记仍在位时不复活） */
    private static onWaveStart(d: GameEventMap[GameEvents.WAVE_START]): void {
        MusicManager._bossMode = !!d?.config?.isBoss;
        if (!MusicManager._ended) {
            MusicManager._start();
        }
    }

    /** 失败：停播 + 下行小调 stinger + 置终局标记 */
    private static onGameOver(): void {
        MusicManager._bossMode = false;
        MusicManager._ended = true;
        MusicManager._stop();
        MusicManager._playStinger(STINGER_LOSE, false);
    }

    /** 胜利：停播 + 上行大调 stinger + 置终局标记 */
    private static onGameVictory(): void {
        MusicManager._bossMode = false;
        MusicManager._ended = true;
        MusicManager._stop();
        MusicManager._playStinger(STINGER_WIN, true);
    }

    /** 模态弹窗：BGM duck 到 25%（setTargetAtTime 0.05s 时间常数，平滑无爆音） */
    private static onModalChanged(open: boolean): void {
        MusicManager._ducked = open;
        const ctx = AudioManager.context;
        if (!ctx || !MusicManager._bus) {
            return;
        }
        try {
            MusicManager._bus.gain.setTargetAtTime(open ? 0.25 : 1, ctx.currentTime, 0.05);
        } catch (e) { /* 静默 */ }
    }

    // ---------- 工具 ----------

    /** MIDI 音高 → 频率（A4=69=440Hz 十二平均律）；纯函数，自检可直接真跑 */
    public static hz(midi: number): number {
        return 440 * Math.pow(2, (midi - 69) / 12);
    }
}
