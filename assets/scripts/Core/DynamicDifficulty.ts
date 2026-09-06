/**
 * 动态难度调节（DDA，Dynamic Difficulty Adjustment，模块级单例，纯逻辑零 cc 依赖）。
 *
 * GAME_PLAN 3.3（Buster 原则：暗中调整、玩家不可感知）：
 * - 输入：run_fail / run_win（OpsBridge.finishRun 挂钩上报）；
 * - 输出：敌方血量 / 出怪间隔的隐藏修正系数（LevelManager.getWaveConfig 唯一数值出口消费）；
 * - 规则：连续失败第 2 次起缓冲（第 1 次失败是正常学习成本），每多败 1 次
 *   敌 HP -4%（封底 0.85）、出怪间隔 +8%（封顶 1.24）；任意一次胜利即归零重计。
 * - 红线：不显示「难度已降低」字样；攻城伤害不回调（漏怪必须有代价，防线压力不放松）。
 *
 * 存档：localStorage('pinballforge_dda')，与进度 / meta / 每日任务存档完全独立。
 */
import { Analytics } from './Analytics';

/** DDA 修正存档键（独立 key，防其它存档清理误伤） */
const DDA_SAVE_KEY = 'pinballforge_dda';

/** 触发缓冲的连续失败次数（含）：连续失败 ≥2 次开始生效 */
const TRIGGER_LOSSES = 2;
/** 每多败一次敌方血量下调步长（-4%） */
const HP_STEP = 0.04;
/** 血量修正下限（最多 -15%） */
const HP_FLOOR = 0.85;
/** 每多败一次出怪间隔上调步长（+8%） */
const SPAWN_STEP = 0.08;
/** 出怪间隔修正上限（最多 +24%） */
const SPAWN_CEIL = 1.24;

class DynamicDifficultyClass {
    /** 读档幂等守卫 */
    private _loaded = false;
    /** 当前连续失败次数（胜利归零） */
    private _loseStreak = 0;

    /** 从存档恢复（所有公共入口首行调用；损坏数据按 0 处理） */
    ensureLoaded(): void {
        if (this._loaded) {
            return;
        }
        this._loaded = true;
        try {
            const raw = localStorage.getItem(DDA_SAVE_KEY);
            if (raw) {
                const data = JSON.parse(raw) as { loseStreak?: unknown };
                const n = data?.loseStreak;
                this._loseStreak = typeof n === 'number' && Number.isFinite(n) && n > 0
                    ? Math.floor(n)
                    : 0;
            }
        } catch (e) {
            console.warn('[DDA] 读取存档失败，按零失败处理', e);
        }
    }

    /** 把连续失败计数写入存档 */
    private save(): void {
        try {
            localStorage.setItem(DDA_SAVE_KEY, JSON.stringify({ loseStreak: this._loseStreak }));
        } catch (e) {
            console.warn('[DDA] 存档写入失败', e);
        }
    }

    /**
     * 一局终了上报（win / fail）：失败累加计数、胜利归零。
     * 复活续战后再次终局会再次进入本方法——中间那次真实失败同样计入（符合"玩家确实卡住了"的事实）。
     */
    reportRun(win: boolean): void {
        this.ensureLoaded();
        this._loseStreak = win ? 0 : this._loseStreak + 1;
        this.save();
        Analytics.track('dda_report', { win, loseStreak: this._loseStreak });
    }

    /** 当前连续失败次数（诊断 / 自检用） */
    getLoseStreak(): number {
        this.ensureLoaded();
        return this._loseStreak;
    }

    /** 超出触发线的失败次数（loseStreak=2 → 1；loseStreak=1/0 → 0） */
    private get overTrigger(): number {
        return Math.max(0, this._loseStreak - (TRIGGER_LOSSES - 1));
    }

    /** 敌方血量修正系数（1.0 ~ 0.85，越小越松）；对玩家完全不可见 */
    getHpMult(): number {
        this.ensureLoaded();
        return Math.max(HP_FLOOR, 1 - this.overTrigger * HP_STEP);
    }

    /** 出怪间隔修正系数（1.0 ~ 1.24，越大同屏压力越低） */
    getSpawnIntervalMult(): number {
        this.ensureLoaded();
        return Math.min(SPAWN_CEIL, 1 + this.overTrigger * SPAWN_STEP);
    }

    /** 清零重计（自检 / 调试用；不影响其它存档） */
    reset(): void {
        this._loseStreak = 0;
        this.save();
    }
}

/** 全局单例（纯逻辑，无需场景挂载） */
export const DynamicDifficulty = new DynamicDifficultyClass();
