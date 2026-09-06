/**
 * 七日签到管理器（模块级单例，与 DailyTaskManager 同构；纯逻辑零 cc 依赖）。
 *
 * GAME_PLAN 3.1 D1-D7 留存钩子（节奏控制：可预期固定奖励打底）：
 * - 奖励 7 日递增循环（⚒20/30/40/50/60/80/120），签到进度累计、断签不清零——
 *   断签惩罚会把"补不上"变成放弃理由（玩家错误处理原理），循环制让任意一天回归都从低门槛重新起步；
 * - 奖励经 MetaManager.addShards 入账碎片（与死亡补偿同一货币，跨局生效）；
 * - 无补签（YAGNI：补签需要代币/广告等配套经济，当前规模不做）。
 *
 * 存档：localStorage('pinballforge_signin')，与进度 / meta / 每日任务存档完全独立。
 */
import { MetaManager } from './MetaManager';
import { Analytics } from './Analytics';

/** 签到存档键（独立 key） */
const SIGNIN_SAVE_KEY = 'pinballforge_signin';

/** 七日签到奖励表（⚒ 精铸碎片，下标 = (累计签到次数 mod 7)） */
export const SIGNIN_REWARDS: readonly number[] = [20, 30, 40, 50, 60, 80, 120];

/** 本地日期键：YYYY-MM-DD（与 DailyTaskManager 同款手拼，避免宿主差异） */
function todayKey(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

class SignInManagerClass {
    /** 读档幂等守卫 */
    private _loaded = false;
    /** 累计签到次数（驱动第 N 格奖励与周期展示） */
    private _totalSigns = 0;
    /** 最近签到日期键（跨日判定） */
    private _lastSignDay = '';

    /** 从存档恢复（所有公共入口首行调用） */
    ensureLoaded(): void {
        if (this._loaded) {
            return;
        }
        this._loaded = true;
        try {
            const raw = localStorage.getItem(SIGNIN_SAVE_KEY);
            if (raw) {
                const data = JSON.parse(raw) as { totalSigns?: unknown; lastSignDay?: unknown };
                const n = data?.totalSigns;
                this._totalSigns = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
                this._lastSignDay = typeof data?.lastSignDay === 'string' ? data.lastSignDay : '';
            }
        } catch (e) {
            console.warn('[SignIn] 读取签到存档失败，按新档处理', e);
        }
    }

    /** 把签到数据写入存档 */
    private save(): void {
        try {
            localStorage.setItem(
                SIGNIN_SAVE_KEY,
                JSON.stringify({ totalSigns: this._totalSigns, lastSignDay: this._lastSignDay }),
            );
        } catch (e) {
            console.warn('[SignIn] 签到存档写入失败', e);
        }
    }

    /** 今天是否可签（每天一次；跨日自动可签） */
    canSign(): boolean {
        this.ensureLoaded();
        return this._lastSignDay !== todayKey();
    }

    /** 累计签到总次数 */
    getTotalSigns(): number {
        this.ensureLoaded();
        return this._totalSigns;
    }

    /** 周期内展示天数（1~7 循环） */
    getCycleDay(): number {
        return (this.getTotalSigns() % SIGNIN_REWARDS.length) + 1;
    }

    /** 本次签到可得的奖励（下一格） */
    getNextReward(): number {
        return SIGNIN_REWARDS[this.getTotalSigns() % SIGNIN_REWARDS.length];
    }

    /**
     * 签到领奖：碎片经 MetaManager.addShards 入账（跨局生效）。
     * 返回实际入账碎片数（今日已签返回 0）。
     */
    sign(): number {
        if (!this.canSign()) {
            return 0;
        }
        const got = this.getNextReward();
        const day = this.getCycleDay(); // 本次填掉的格子（自增前）
        this._totalSigns += 1;
        this._lastSignDay = todayKey();
        this.save();
        MetaManager.addShards(got);
        Analytics.track('daily_task_progress', { taskId: 'signin', progress: day, claimed: true });
        console.log(`[SignIn] 第 ${day} 天签到 +⚒${got}（累计 ${this._totalSigns} 天）`);
        return got;
    }

    /** 重置（自检 / 调试用） */
    reset(): void {
        this._totalSigns = 0;
        this._lastSignDay = '';
        this.save();
    }
}

/** 全局单例（纯逻辑，无需场景挂载） */
export const SignInManager = new SignInManagerClass();
