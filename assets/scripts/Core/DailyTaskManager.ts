/**
 * 每日任务数据模型（模块级单例，与 MetaManager 同构；纯逻辑零 cc 依赖，自检可直接 import 跑行为）。
 *
 * M2 运营基建（GAME_PLAN.md 3.1 D3-D7 留存钩子）：每天 3 条任务，进度跨对局累计，
 * 完成后领取「精铸碎片 ⚒」（经 MetaManager.addShards 入账，与死亡补偿同一货币、跨局生效）。
 * 按本地日期跨日自动重置（进度与领取状态清零；碎片归 Meta 存档不受影响）。
 *
 * 存档：localStorage('pinballforge_daily')，与进度 / meta / 埋点缓冲完全独立。
 * UI（任务面板）与上报挂钩点（击杀 / 清波 / 入槽开火，附录 A daily_task_progress）由 M2 后续接线。
 */
import { MetaManager } from './MetaManager';
import { Analytics } from './Analytics';

/** 每日任务存档键（独立 key，防进度 / meta 清理误伤） */
const DAILY_SAVE_KEY = 'pinballforge_daily';

/** 单条任务定义 */
export interface DailyTaskDef {
    /** 任务 id（上报与存档用，snake_case，上线不改名） */
    id: string;
    /** 任务名 */
    name: string;
    /** 目标描述（含数字，UI 直接展示） */
    desc: string;
    /** 目标进度 */
    target: number;
    /** 领取奖励（精铸碎片） */
    reward: number;
}

/**
 * 每日任务定义表（3 条/天）。
 * 选型：全部为既有系统可天然计数的进度（击杀 / 清波 / 漏斗开火）；
 * 不放广告位任务——广告 SDK M4 才接入，先放会形成"永远差一格"的挫败任务（原理：玩家错误处理）。
 */
export const DAILY_TASK_DEFS: DailyTaskDef[] = [
    { id: 'kills', name: '弹幕扫荡', desc: '击毁 20 只怪物', target: 20, reward: 20 },
    { id: 'clear_waves', name: '守城先锋', desc: '守住 6 波攻势', target: 6, reward: 20 },
    { id: 'funnels', name: '锻造供能', desc: '弹珠入槽开火 15 次', target: 15, reward: 20 },
];

/** UI 展示用任务信息（定义 + 当日进度 + 领取状态） */
export interface DailyTaskInfo extends DailyTaskDef {
    /** 当日进度（封顶到 target） */
    progress: number;
    /** 是否已领取奖励 */
    claimed: boolean;
}

/** 本地日期键：YYYY-MM-DD（手拼避免 toLocaleDateString 的宿主差异） */
function todayKey(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

class DailyTaskManagerClass {
    /** 存档记录的日期键（跨日比对用） */
    private day = '';
    /** 当日各任务进度（按任务 id） */
    private progress: Record<string, number> = {};
    /** 当日各任务领取状态（按任务 id） */
    private claimed: Record<string, boolean> = {};

    /** 读档幂等守卫 */
    private _loaded = false;

    /**
     * 从存档恢复 + 跨日重置检查（所有公共入口首行调用）。
     * 读档部分幂等（进程内只读一次）；跨日检查每次执行——覆盖两种真实跨天场景：
     * ① 次日重新启动（读档后 day 为昨日 → 重置）② 长会话切后台过夜（内存 day 为昨日 → 重置）。
     */
    ensureLoaded(): void {
        if (!this._loaded) {
            this._loaded = true;
            try {
                const raw = localStorage.getItem(DAILY_SAVE_KEY);
                if (raw) {
                    const data = JSON.parse(raw) as {
                        day?: unknown; progress?: Record<string, unknown>; claimed?: Record<string, unknown>;
                    };
                    this.day = typeof data?.day === 'string' ? data.day : '';
                    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
                    for (const def of DAILY_TASK_DEFS) {
                        this.progress[def.id] = Math.max(0, Math.floor(num(data?.progress?.[def.id])));
                        this.claimed[def.id] = data?.claimed?.[def.id] === true;
                    }
                }
            } catch (e) {
                console.warn('[DailyTask] 读取每日任务存档失败，重建当日数据', e);
            }
        }
        // 跨日重置：进度与领取清零、日期翻新；碎片在 Meta 存档不受影响
        const today = todayKey();
        if (this.day !== today) {
            this.day = today;
            this.progress = {};
            this.claimed = {};
            this.save();
        }
    }

    /** 把当日任务数据写入存档 */
    private save(): void {
        try {
            localStorage.setItem(
                DAILY_SAVE_KEY,
                JSON.stringify({ day: this.day, progress: this.progress, claimed: this.claimed }),
            );
        } catch (e) {
            console.warn('[DailyTask] 每日任务存档写入失败', e);
        }
    }

    /** 当前日期键（调试 / UI 展示用） */
    getDay(): string {
        this.ensureLoaded();
        return this.day;
    }

    /**
     * 上报任务进度（附录 A daily_task_progress 的数据侧入口；事件上报由挂钩点自行调 Analytics）。
     * 未知任务 id / 非法增量 / 已领奖：静默忽略（已领奖后停止计数，杜绝无意义写入）。
     */
    reportProgress(taskId: string, delta = 1): void {
        this.ensureLoaded();
        const def = DAILY_TASK_DEFS.find((t) => t.id === taskId);
        if (!def || delta <= 0 || this.claimed[taskId]) {
            return;
        }
        this.progress[taskId] = Math.min(def.target, (this.progress[taskId] ?? 0) + Math.floor(delta));
        this.save();
        // 附录 A daily_task_progress：任务漏斗（完成率）上报；已领奖后不再进入本行（上方 claimed 拦截）
        Analytics.track('daily_task_progress', { taskId, progress: this.progress[taskId], claimed: false });
    }

    /** 任务是否已完成且未领奖 */
    canClaim(taskId: string): boolean {
        this.ensureLoaded();
        const def = DAILY_TASK_DEFS.find((t) => t.id === taskId);
        return !!def && !this.claimed[taskId] && (this.progress[taskId] ?? 0) >= def.target;
    }

    /**
     * 领取奖励：碎片经 MetaManager.addShards 入账（跨局生效）。
     * 返回实际入账碎片数（未完成 / 已领取 / 未知 id 返回 0）。
     */
    claim(taskId: string): number {
        this.ensureLoaded();
        const def = DAILY_TASK_DEFS.find((t) => t.id === taskId);
        if (!def || !this.canClaim(taskId)) {
            return 0;
        }
        this.claimed[taskId] = true;
        this.save();
        const got = MetaManager.addShards(def.reward);
        // 附录 A daily_task_progress：领取达成（claimed: true），与进度事件同表完成漏斗
        Analytics.track('daily_task_progress', { taskId, progress: def.target, claimed: true });
        console.log(`[DailyTask] 领取「${def.name}」奖励 ⚒${got}`);
        return got;
    }

    /** 三条任务的当日展示信息（UI 面板按此渲染） */
    getTaskList(): DailyTaskInfo[] {
        this.ensureLoaded();
        return DAILY_TASK_DEFS.map((def) => ({
            ...def,
            progress: this.progress[def.id] ?? 0,
            claimed: this.claimed[def.id] === true,
        }));
    }

    /** 是否存在可领取（未领且已完成）的任务（红点提示用） */
    hasClaimable(): boolean {
        this.ensureLoaded();
        return DAILY_TASK_DEFS.some((def) => this.canClaim(def.id));
    }
}

/** 全局单例（纯逻辑，无需场景挂载；各读方法内部已带 ensureLoaded） */
export const DailyTaskManager = new DailyTaskManagerClass();
