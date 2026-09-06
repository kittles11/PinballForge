import { AudioClip, resources, sys } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import type { GameEventMap } from './EventBus';
import { OrbType } from './DataModels';

/** 开火音效独立编号：金币槽专属 Ching（珠子音效编号跟随 OrbType 0~3，金币音避开该区间单独编 9） */
export const FIRE_SFX_COIN = 9;

/**
 * 音频管理器：纯静态类，无需挂载到任何场景节点，import 即用。
 *
 * 【碰撞声音 = 全局纯代码直播方案】（完全不依赖任何 Inspector 面板拖拽）
 *  - 不找 Canvas / AudioSource、不需要拖拽引用 AudioClip、不在弹珠 / 钉子 Prefab 上配任何资源：
 *    全场零组件配置，单个 .ts 文件即可出声。
 *  - 直接创建 5 个原生 HTML5 <audio> 播放器组成“直播池”，轮转复用；
 *    弹珠连击高频撞钉时 5 声道无缝叠播，不丢音、不断流。
 *  - init() 同时挂 window.__playHitSound 全局钩子，任何代码都能一行触发。
 *
 * 【绝对解锁】修复浏览器自动播放策略导致的“撞钉无声”：
 *  - init() 后监听首次用户手势（pointerdown / touchstart），以 0 音量静默预热池内所有播放器，
 *    抢在自动播放策略放开窗口内完成解锁；之后任意时刻 play() 均被浏览器放行。
 *  - 弹珠发射本身就需要一次点击：那次点击正好完成预热，首次撞钉 100% 有声。
 *  - 原生端等无 HTMLAudioElement 的环境静默降级，不抛错不崩溃。
 *
 * 【保留】非碰撞类 Web Audio 合成特效（其余系统仍在使用，见 wire() 与 CastleController）：
 *  1. playMonsterAttack() —— 怪物撞击城堡：低沉肉搏重击；
 *  2. playCastleExplode() —— 城堡爆炸：深沉剧烈爆炸轰鸣；
 *  3. playFire(orbType)   —— 炮塔开火音效（音效跟随珠子类型，服务既有 FIRE_TURRET 事件）。
 */
export class AudioManager {
    /** 原生 HTML5 播放器池（直播池）：同一时刻最多 5 声叠播 */
    private static audioPool: HTMLAudioElement[] = [];
    /** 轮转下标：每次播放取 audioPool[poolIndex] 后 +1，实现 5 声道无缝轮播 */
    private static poolIndex: number = 0;
    /** 是否已预热（浏览器自动播放策略已解锁） */
    private static _warmed = false;
    /** 预热监听是否已挂上（幂等，避免重复注册） */
    private static _warmArmed = false;
    /** wire() 是否已接线（幂等，防止热更新/重复 import 重复注册） */
    private static _wired = false;

    /** 撞钉音效防抖时间戳（ms）：35ms 内连续碰撞静默跳过发声，避免多球同帧撞钉堵塞音频线程 */
    private static _lastHitSoundTime = 0;

    /** 全局复用并常驻的 Web Audio 上下文（仅非碰撞类特效使用） */
    private static ctx: AudioContext | null = null;
    /** 是否已完成解锁（resume 成功或本就在 running） */
    private static isUnlocked = false;

    // ---------- ⚙ 音频设置（设置面板开关；独立存档 key 即时持久化，与 CoinManager 主档解耦） ----------
    /** 音效开关缓存（启动时从存档读，key: sfx_enabled） */
    private static sfxOn = true;
    /** 音乐开关缓存（启动时从存档读，key: music_enabled） */
    private static musicOn = true;
    /** 两个开关的存档 key（system 数据卷） */
    private static readonly SFX_KEY = 'sfx_enabled';
    private static readonly MUSIC_KEY = 'music_enabled';
    /** 设置项是否已从存档加载（懒加载一次） */
    private static settingsLoaded = false;

    /** 音效开关（设置面板读写；true/false 即时生效：播放入口首行门禁消费） */
    public static get sfxEnabled(): boolean {
        AudioManager.ensureSettingsLoaded();
        return AudioManager.sfxOn;
    }

    /** 音乐开关（设置面板读写；true/false 即时生效：MusicManager.applyEnabled 消费） */
    public static get musicEnabled(): boolean {
        AudioManager.ensureSettingsLoaded();
        return AudioManager.musicOn;
    }

    /** 写音效开关：缓存 + 立即落存档（下一帧起所有 play* 入口静默） */
    public static setSfxEnabled(on: boolean): void {
        AudioManager.ensureSettingsLoaded();
        AudioManager.sfxOn = on;
        try {
            sys.localStorage.setItem(AudioManager.SFX_KEY, on ? '1' : '0');
        } catch (e) { /* 存档失败不阻断开关（与 DailyTaskManager.save 同款降级） */ }
        console.log(`[AudioManager] ⚙ 音效开关 → ${on ? '开' : '关'}（已存档）`);
    }

    /** 写音乐开关：缓存 + 立即落存档（调用方紧接着走 MusicManager.applyEnabled 即时停播/恢复） */
    public static setMusicEnabled(on: boolean): void {
        AudioManager.ensureSettingsLoaded();
        AudioManager.musicOn = on;
        try {
            sys.localStorage.setItem(AudioManager.MUSIC_KEY, on ? '1' : '0');
        } catch (e) { /* 存档失败不阻断开关 */ }
        console.log(`[AudioManager] ⚙ 音乐开关 → ${on ? '开' : '关'}（已存档）`);
    }

    /** 懒加载音频设置（首次读取开关时执行一次；读档失败保持默认开） */
    private static ensureSettingsLoaded(): void {
        if (AudioManager.settingsLoaded) {
            return;
        }
        AudioManager.settingsLoaded = true;
        try {
            AudioManager.sfxOn = sys.localStorage.getItem(AudioManager.SFX_KEY) !== '0'; // 无记录(null) → 开
            AudioManager.musicOn = sys.localStorage.getItem(AudioManager.MUSIC_KEY) !== '0';
        } catch (e) { /* 读档失败保持默认开 */ }
    }

    // ---------- 绝对解锁 ----------

    /**
     * 共享 AudioContext 出口（unlockAudio 惰性创建后非空）：
     * MusicManager 等其它合成系统统一复用同一 ctx，规避浏览器单页上下文数量上限，
     * 且首次手势解锁链路（warmup / unlockAudio）一次打通全部音频系统。
     */
    public static get context(): AudioContext | null {
        return AudioManager.ctx;
    }

    /**
     * 手指触摸屏幕瞬间强制解锁：创建（若未建）并 resume（若 suspended）AudioContext。
     * 每次播放前调用即可保证浏览器自动播放策略放行；幂等，可反复调用。
     */
    public static unlockAudio(): void {
        if (!AudioManager.ctx) {
            const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioCtx) {
                return; // 原生端等无 Web Audio API：静默降级
            }
            try {
                AudioManager.ctx = new AudioCtx();
            } catch (e) {
                console.warn('[Audio] AudioContext 创建失败，音效已禁用', e);
                AudioManager.ctx = null;
                return;
            }
        }
        const ctx = AudioManager.ctx;
        if (!AudioManager.isUnlocked && ctx.state === 'suspended') {
            // 手势窗口内调用 resume 会被浏览器放行；成功后标记解锁
            ctx.resume()
                .then(() => {
                    AudioManager.isUnlocked = true;
                    console.log('🔊 [Audio] 浏览器音频已成功激活！');
                })
                .catch((e) => console.warn('[Audio] resume 失败，稍后再次触摸可重试', e));
        } else if (ctx.state === 'running') {
            AudioManager.isUnlocked = true;
        }
    }

    // ---------- 1. 碰撞声音：全局纯代码直播池 ----------

    /** 资源加载中标记：防止 resources.load 回调返回前 playHit 反复触发重复加载 */
    private static _poolLoading = false;

    /**
     * 初始化直播池：经 resources.load 拿到打包后 ding.mp3 的真实 URL（web 构建会重命名/合并资源，
     * 硬编码 'assets/ding.mp3' 在构建产物中必然 404），再创建 5 个原生 HTML5 <audio> 播放器 +
     * 挂全局钩子 + 首触预热。资源加载失败回退旧路径（预览环境直放仍可用）；池依旧不可用时由
     * playHit 自动降级为 Web Audio 合成叮当声。幂等；无 HTMLAudioElement 的环境整体静默降级。
     */
    public static init() {
        if (this.audioPool.length > 0 || AudioManager._poolLoading) return;
        AudioManager._poolLoading = true;
        const createPool = (src: string): void => {
            try {
                // 创建 5 个原生 HTML5 播放器池
                for (let i = 0; i < 5; i++) {
                    const a = new Audio(src);
                    a.volume = 0.8;
                    a.preload = 'auto'; // 提前加载，首次撞钉不卡顿
                    a.load();
                    this.audioPool.push(a);
                }
                (window as any).__playHitSound = () => AudioManager.playHit();
                AudioManager.warmup();
                console.log(`[AudioManager] 撞钉直播池就绪（5 声道）: ${src}`);
            } catch (e) {
                this.audioPool = []; // 无 HTMLAudioElement：清空池子，让 playHit 静默跳过
            } finally {
                AudioManager._poolLoading = false;
            }
        };
        // 打包资源优先：resources.load 在 web 构建下返回重命名后的真实地址（'audio/ding' ← assets/resources/audio/ding.mp3）
        try {
            resources.load('audio/ding', AudioClip, (err, clip) => {
                if (!err && clip?.nativeUrl) {
                    createPool(clip.nativeUrl);
                } else {
                    createPool('assets/ding.mp3'); // 旧路径兜底（预览环境直放 / 资源缺失）
                }
            });
        } catch (e) {
            createPool('assets/ding.mp3'); // 原生端等无 resources 管线：直接旧路径
        }
    }

    /**
     * 首触预热（幂等）：浏览器自动播放策略要求首次播放必须发生在用户手势窗口内。
     * 监听首次 pointerdown / touchstart，用 0 音量静默 play 一下再暂停，即可完成解锁且不发出噪音；
     * 之后弹珠撞钉触发 playHit 必然被浏览器放行。
     */
    public static warmup(): void {
        if (AudioManager._warmed || AudioManager._warmArmed || AudioManager.audioPool.length === 0) {
            return;
        }
        if (typeof document === 'undefined') {
            return; // 非浏览器环境（原生端）无自动播放策略，无需预热
        }
        AudioManager._warmArmed = true;
        const fire = (): void => {
            if (AudioManager._warmed) {
                return;
            }
            AudioManager._warmed = true;
            // 首次手势窗口内同步解锁 Web Audio：抢在自动播放策略放开前完成 AudioContext resume，
            // 否则 playSynthDing（mp3 404 降级路径）与特效音在移动端/iOS 上会因 suspended 而无声。
            AudioManager.unlockAudio();
            for (const a of AudioManager.audioPool) {
                try {
                    a.volume = 0;
                    a.currentTime = 0;
                    const p = a.play();
                    if (p && typeof p.then === 'function') {
                        p.then(() => {
                            a.pause();
                            a.volume = 0.8;
                        }).catch(() => {});
                    }
                } catch (e) { /* 单个播放器预热失败不影响其余 */ }
            }
            console.log('[Sound] 音频已解锁（首次手势预热完成）');
        };
        document.addEventListener('pointerdown', fire, { capture: true, once: true });
        document.addEventListener('touchstart', fire, { capture: true, once: true });
    }

    /**
     * 撞钉碰撞声：从直播池轮转取一个播放器即时播放（连击叠播、不留间隙）。
     * @param combo 连击计数（1 起）：播放速率随连击爬升，听感越来越高亢；mp3 不可用/404 时自动降级为合成叮当。
     */
    public static playHit(combo = 1): void {
        if (!AudioManager.sfxEnabled) {
            return; // ⚙ 音效关：静默（设置面板开关，独立存档即时生效）
        }
        // ★ 音效节流：35ms 内连续碰撞静默跳过发声，避免雷球分裂多球/高频连击同时撞钉
        //   导致音频线程被大量 <audio>.play() 调用堵塞，造成掉帧卡顿。
        if (typeof performance !== 'undefined' && performance.now) {
            const now = performance.now();
            if (now - AudioManager._lastHitSoundTime < 35) {
                return;
            }
            AudioManager._lastHitSoundTime = now;
        }
        if (this.audioPool.length === 0) {
            this.init();
        }
        // mp3 源不可用（无 HTMLAudioElement / 打包 404）：直接走 Web Audio 合成降级
        if (this.audioPool.length === 0) {
            AudioManager.playSynthDing(combo);
            return;
        }
        AudioManager.warmup(); // 兜底解锁：若 init 时未挂上首次手势，此处再补一次
        try {
            const a = this.audioPool[this.poolIndex];
            // 连击音调爬升：拉高播放速率（playbackRate 同步变快变尖）；钳制不超过 2×
            a.playbackRate = Math.min(1 + Math.max(0, combo - 1) * 0.05, 2);
            a.currentTime = 0;
            const p = a.play();
            // 播放失败（如 404 加载失败）：降级为 Web Audio 合成叮当声，保证有声
            if (p && typeof p.catch === 'function') {
                p.catch(() => AudioManager.playSynthDing(combo));
            }
            this.poolIndex = (this.poolIndex + 1) % this.audioPool.length;
        } catch (e) {
            AudioManager.playSynthDing(combo);
        }
    }

    /**
     * Web Audio 纯代码合成叮当声（mp3 404 / 无 HTMLAudioElement 时的降级发声）。
     * @param combo 连击计数：基频随连击爬升，合成锐利清脆的高频「叮」。
     */
    public static playSynthDing(combo = 1): void {
        if (!AudioManager.sfxEnabled) {
            return; // ⚙ 音效关：静默
        }
        AudioManager.unlockAudio();
        const ctx = AudioManager.ctx;
        if (!ctx) {
            return; // 无 Web Audio API：静默降级
        }
        try {
            const t0 = ctx.currentTime;
            // 连击音调爬升：880Hz 起，每连击 +6%，上限 1760Hz（不刺耳上限）
            const base = Math.min(1 + Math.max(0, combo - 1) * 0.06, 2);
            const f = Math.min(880 * base, 1760);
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t0);
            // 音量统一钳制到 >0，杜绝 Safari exponentialRamp 抛 IndexSizeError
            gain.gain.setValueAtTime(AudioManager.vol(0.22), t0);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.10);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + 0.14);
            osc.onended = () => {
                osc.disconnect();
                gain.disconnect();
            };
        } catch (e) {}
    }

    /**
     * 静态接线：全局事件 → 对应特效音（幂等，热更新 / 重复 import 不会重复注册）。
     * 撞钉声不走事件：由 OrbController 碰撞点直连 playHit()，保证最稳、无中间层。
     */
    public static wire(): void {
        if (AudioManager._wired) {
            return;
        }
        AudioManager._wired = true;
        EventBus.on(GameEvents.FIRE_TURRET, AudioManager.onFireTurret, AudioManager);
        EventBus.on(GameEvents.ATTACK_CASTLE, AudioManager.onAttackCastle, AudioManager);
        console.log('[AudioManager] 音效就绪：撞钉=HTML5 直播池，特效=Web Audio 合成（零 Inspector 配置）');
    }

    // ---------- 事件监听 ----------

    /** 开火：按【珠子类型】播放对应炮弹音（音效跟随珠子，不再跟随漏斗槽位） */
    private static onFireTurret(d: GameEventMap[GameEvents.FIRE_TURRET]): void {
        AudioManager.playFire(d?.orbType ?? 0);
    }

    /** 怪物攻击城堡：低沉肉搏重击（ATTACK_CASTLE 由 EnemyController 头槌冲撞时广播） */
    private static onAttackCastle(_d: GameEventMap[GameEvents.ATTACK_CASTLE]): void {
        AudioManager.playMonsterAttack();
    }

    // ---------- 弹珠撞钉声已由上方全局直播池 playHit() 接管 ----------

    // ---------- 2. 怪物撞击城堡 ----------

    /** 怪物撞击城堡：低沉肉搏重击声（三角波 160Hz 深坠到 40Hz） */
    public static playMonsterAttack(): void {
        if (!AudioManager.sfxEnabled) {
            return; // ⚙ 音效关：静默
        }
        AudioManager.unlockAudio();
        const ctx = AudioManager.ctx;
        if (!ctx) {
            return;
        }
        try {
            const t0 = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(160, t0);
            osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.12);
            gain.gain.setValueAtTime(AudioManager.vol(0.4), t0);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + 0.12);
            osc.onended = () => {
                osc.disconnect();
                gain.disconnect();
            };
        } catch (e) {
            console.warn('[Audio] 播放异常:', e);
        }
    }

    // ---------- 3. 城堡爆炸 ----------

    /** 城堡爆炸：深沉剧烈爆炸轰鸣（锯齿波 220Hz 深坠到 30Hz，0.5s 长震） */
    public static playCastleExplode(): void {
        if (!AudioManager.sfxEnabled) {
            return; // ⚙ 音效关：静默
        }
        AudioManager.unlockAudio();
        const ctx = AudioManager.ctx;
        if (!ctx) {
            return;
        }
        try {
            const t0 = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(220, t0);
            osc.frequency.exponentialRampToValueAtTime(30, t0 + 0.5);
            gain.gain.setValueAtTime(AudioManager.vol(0.6), t0);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + 0.5);
            osc.onended = () => {
                osc.disconnect();
                gain.disconnect();
            };
        } catch (e) {}
    }

    // ---------- 保留：炮塔开火（FIRE_TURRET 三型音效） ----------

    /**
     * 火炮开火音效：编号跟随【珠子类型】（OrbType 0 普通 / 1 雷 / 2 熔岩 / 3 霜冻），
     * 金币槽专属 Ching 用独立编号 FIRE_SFX_COIN（漏斗不再决定音效）。
     */
    public static playFire(type: number): void {
        if (!AudioManager.sfxEnabled) {
            return; // ⚙ 音效关：静默
        }
        AudioManager.unlockAudio(); // 绝对解锁：与钉子音保持一致的强制激活
        if (!AudioManager.ctx) {
            return;
        }
        if (type === FIRE_SFX_COIN) {
            // 金币：经典双音 Ching —— B5 短促起音，0.08s 后接 E6 长音
            AudioManager.playTone('square', 988, 0.08, 0.22);
            AudioManager.playTone('square', 1319, 0.3, 0.22, { delay: 0.08 });
        } else if (type === OrbType.Lightning) {
            // 雷球：短促高频电滋上扫
            AudioManager.playTone('sawtooth', 1400, 0.16, 0.16, { endFreq: 2800 });
        } else if (type === OrbType.Frost) {
            // 霜冻：双 sine 错峰高频上扫的冰晶声
            AudioManager.playTone('sine', 1800, 0.22, 0.2, { endFreq: 2600 });
            AudioManager.playTone('sine', 2400, 0.16, 0.12, { endFreq: 3200, delay: 0.05 });
        } else if (type === OrbType.Lava) {
            // 熔岩：三角波低坠轰鸣 + 更低的 sine 打底，制造沉重感
            AudioManager.playTone('triangle', 130, 0.5, 0.45, { endFreq: 45 });
            AudioManager.playTone('sine', 65, 0.55, 0.38, { endFreq: 30 });
        } else if (type === OrbType.Plasma) {
            // 等离子：上扬能量嗡鸣（sine 上扫 + 高次泛音，区别于其它球种）
            AudioManager.playTone('sine', 300, 0.4, 0.2, { endFreq: 1200 });
            AudioManager.playTone('sine', 600, 0.3, 0.1, { endFreq: 2400, delay: 0.03 });
        } else if (type === OrbType.Magma) {
            // 熔核：比熔岩更沉的超重轰鸣（更低频三角波 + 次声打底）
            AudioManager.playTone('triangle', 95, 0.6, 0.5, { endFreq: 32 });
            AudioManager.playTone('sine', 48, 0.65, 0.42, { endFreq: 22 });
        } else if (type === OrbType.Leech) {
            // 吸血：下探后回勾的"汲取"音（sine 先降后升）
            AudioManager.playTone('sine', 520, 0.28, 0.18, { endFreq: 220 });
            AudioManager.playTone('sine', 300, 0.34, 0.16, { endFreq: 660, delay: 0.1 });
        } else {
            // 普通：轻量弹射叮声（复用直播池降级合成音，音色与撞钉一致）
            AudioManager.playSynthDing(1);
        }
    }

    // ---------- 工具 ----------

    /** 音量钳制：Safari 的 exponentialRampToValueAtTime 不允许当前值/目标值为 0，统一钳制到最小正数 */
    private static vol(volume: number): number {
        return Math.max(0.0001, volume);
    }

    /**
     * 合成单个音符：设振荡器类型 / 频率（可下滑）/ 时长 / 音量，指数衰减包络收尾。
     * 播放完毕后断开节点，避免长期运行动态分配泄漏。
     */
    private static playTone(
        type: OscillatorType,
        freq: number,
        duration: number,
        volume: number,
        opts: { endFreq?: number; delay?: number } = {},
    ): void {
        const ctx = AudioManager.ctx;
        if (!ctx) {
            return;
        }
        const t0 = ctx.currentTime + (opts.delay ?? 0);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(Math.max(1, freq), t0);
        if (opts.endFreq !== undefined) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.endFreq), t0 + duration);
        }
        // 音量统一走 vol() 钳制：杜绝 0 值触发 Safari exponentialRamp 的 IndexSizeError
        gain.gain.setValueAtTime(AudioManager.vol(volume), t0);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + duration + 0.02);
        osc.onended = () => {
            osc.disconnect();
            gain.disconnect();
        };
    }
}

// 纯静态类无需组件/场景节点：模块加载即完成直播池初始化与全局事件接线
AudioManager.init();
AudioManager.wire();
