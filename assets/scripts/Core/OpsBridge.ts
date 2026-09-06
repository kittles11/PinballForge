import { _decorator, Component, find, game, Game } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import type { GameEventMap } from './EventBus';
import { Analytics } from './Analytics';
import { DailyTaskManager } from './DailyTaskManager';
import { MetaManager } from './MetaManager';
import { LevelManager } from './LevelManager';
import { GoldManager } from './GoldManager';
import { CastleController } from '../Battle/CastleController';
import { DynamicDifficulty } from './DynamicDifficulty';
import { DailyChallenge } from './DailyChallenge';

const { ccclass } = _decorator;

/**
 * 运营埋点桥（OpsBridge，TutorialManager 同款 ensureMounted 自举，挂 Canvas；DeckManager.onLoad 调用）：
 * 附录 A 埋点事件表的统一挂钩层——监听既有 EventBus 事件翻译为 Analytics.track，
 * 每日任务进度上报（击杀 / 清波 / 入槽开火）也集中在此，WaveManager / EnemyController / OrbController 等业务系统零改动。
 *
 * 局（run）生命周期定义：场景加载 = 局开始（onLoad 记基准），GAME_OVER / GAME_VICTORY = 局终。
 * - run_start 挂首个 WAVE_START：此时 WaveManager.start() 的 loadFromSave 已完成，章节/关卡进度准确；
 * - run_end 延迟一帧上报：GAME_OVER 的同步调用链内 ResultDialog 才调 grantRunReward 发碎片，
 *   一帧后读数必然已入账；shardsEarned = 结算读数 − 局初读数，天然涵盖局内每日任务领奖。
 *
 * 埋点红线（附录 A）：只上报数值与 id，不采集任何个人身份信息。
 */
@ccclass('OpsBridge')
export class OpsBridge extends Component {
    /** 冷启动会话守卫：session_start 进程内只报一次（场景重载 = 同一会话，不重置） */
    private static _sessionReported = false;

    /** 本局开始时间戳（onLoad = 场景加载 = 局开始；重开局随场景重建重置） */
    private _runStartTs = 0;
    /** 本局开始时的碎片余额（run_end 的 shardsEarned 差值基准） */
    private _shardsAtRunStart = 0;
    /** 当前波开始时间戳（wave_clear 的 durationSec 基准） */
    private _waveStartTs = 0;
    /** run_start 是否已随首个 WAVE_START 上报 */
    private _runStartReported = false;

    /** 静态自举：幂等挂到 Canvas（DeckManager.onLoad 调用；场景重载后由本组件 onDestroy 复位 + 重挂） */
    public static ensureMounted(): void {
        const host = find('Canvas') ?? find('Canvas/UILayer');
        if (!host || host.getComponent(OpsBridge)) {
            return;
        }
        host.addComponent(OpsBridge); // 宿主已激活 → onLoad 同步执行并开始监听
    }

    protected onLoad(): void {
        // 局生命周期基准：每次场景加载（首局 / 重开局）都重置
        this._runStartTs = Date.now();
        this._shardsAtRunStart = MetaManager.getShards();
        this._waveStartTs = this._runStartTs;
        this._runStartReported = false;
        if (!OpsBridge._sessionReported) {
            OpsBridge._sessionReported = true;
            Analytics.track('session_start'); // ts 由 Analytics 记录自带
        }
        EventBus.on(GameEvents.WAVE_START, this.onWaveStart, this);
        EventBus.on(GameEvents.SHOW_REWARDS, this.onWaveCleared, this);
        EventBus.on(GameEvents.SHOW_SHOP, this.onShopView, this);
        EventBus.on(GameEvents.GAME_OVER, this.onGameOver, this);
        EventBus.on(GameEvents.GAME_VICTORY, this.onGameVictory, this);
        EventBus.on(GameEvents.ENEMY_KILLED, this.onEnemyKilled, this);
        EventBus.on(GameEvents.FIRE_TURRET, this.onFireTurret, this);
        // 切后台后进程随时可能被系统回收（小游戏尤甚）：立即落盘，避免节流窗口内的末段事件随之丢失。
        // run_end 只覆盖「正常打完一局」，本钩子兜住中途切走 / 直接杀进程的局。
        game.on(Game.EVENT_HIDE, Analytics.flush, Analytics);
        console.log('[Ops] 运营埋点桥就绪：附录 A 事件流 + 每日任务进度上报已挂接');
    }

    protected onDestroy(): void {
        EventBus.targetOff(this);
        game.off(Game.EVENT_HIDE, Analytics.flush, Analytics);
    }

    /** 波次开始：首次 = run_start（loadFromSave 之后进度才准确），此后逐波 wave_start */
    private onWaveStart(_payload: GameEventMap[GameEvents.WAVE_START]): void {
        const chapter = LevelManager.currentChapter;
        const level = LevelManager.currentLevel;
        if (!this._runStartReported) {
            this._runStartReported = true;
            Analytics.track('run_start', { chapter, level });
        }
        this._waveStartTs = Date.now();
        Analytics.track('wave_start', { chapter, level, wave: LevelManager.currentWave });
    }

    /** 波清空（非终局波：WaveManager 弹出战前奖励前广播）：清波任务进度 + wave_clear */
    private onWaveCleared(): void {
        DailyTaskManager.reportProgress('clear_waves');
        this.trackWaveClear();
    }

    /** wave_clear：波难度校准数据（本波耗时） */
    private trackWaveClear(): void {
        Analytics.track('wave_clear', {
            chapter: LevelManager.currentChapter,
            level: LevelManager.currentLevel,
            wave: LevelManager.currentWave,
            durationSec: Math.round((Date.now() - this._waveStartTs) / 1000),
        });
    }

    /** 商店打开（RewardDialog 第 3/6/9 关战后流转广播） */
    private onShopView(): void {
        Analytics.track('shop_view', { goldBalance: GoldManager.instance?.currentGold ?? 0 });
    }

    /** 城堡沦陷 → run_fail（动态难度的核心输入：卡点定位） */
    private onGameOver(): void {
        this.finishRun(false);
    }

    /** 通关 → 终局最后一波同为清波（补进度与 wave_clear），再走 run_win */
    private onGameVictory(): void {
        DailyTaskManager.reportProgress('clear_waves');
        this.trackWaveClear();
        // 🎯 每日挑战：目标关首胜领奖（非目标关内部自判返回 0）
        DailyChallenge.onRunWin(LevelManager.currentChapter, LevelManager.currentLevel);
        this.finishRun(true);
    }

    /** run_fail / run_win + run_end；run_end 延迟一帧，确保 ResultDialog 同步链内 grantRunReward 已入账 */
    private finishRun(win: boolean): void {
        // 🎚 动态难度：失败累加缓冲、胜利归零（LevelManager.getWaveConfig 消费修正系数）
        DynamicDifficulty.reportRun(win);
        const chapter = LevelManager.currentChapter;
        const level = LevelManager.currentLevel;
        const runDurationSec = Math.round((Date.now() - this._runStartTs) / 1000);
        if (win) {
            Analytics.track('run_win', { chapter, level, runDurationSec });
        } else {
            Analytics.track('run_fail', {
                chapter,
                level,
                wave: LevelManager.currentWave,
                castleHpLeft: CastleController.instance?.currentHp ?? 0,
                runDurationSec,
            });
        }
        this.scheduleOnce(() => {
            Analytics.track('run_end', {
                result: win ? 'win' : 'fail',
                shardsEarned: Math.max(0, MetaManager.getShards() - this._shardsAtRunStart),
                runDurationSec,
            });
            // run_end 是一局的终点事件、之后可能直接被杀进程：越过 Analytics 的 2s 节流窗口立即落盘
            Analytics.flush();
        }, 0);
    }

    /** 击杀 → 每日任务「弹幕扫荡」进度（忽略载荷；分裂小怪的死亡同样计一次击杀） */
    private onEnemyKilled(_enemy: GameEventMap[GameEvents.ENEMY_KILLED]): void {
        DailyTaskManager.reportProgress('kills');
    }

    /** 入槽开火 → 每日任务「锻造供能」进度（FIRE_TURRET 即弹珠入槽后的炮塔开火信源） */
    private onFireTurret(_payload: GameEventMap[GameEvents.FIRE_TURRET]): void {
        DailyTaskManager.reportProgress('funnels');
    }
}
