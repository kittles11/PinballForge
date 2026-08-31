/**
 * 埋点抽象层（模块级单例，与 MetaManager 同构；纯逻辑零 cc 依赖，自检可直接 import 跑行为）。
 *
 * M2 运营基建（GAME_PLAN.md 附录 A）：统一 Analytics.track(event, props) 入口，
 * 当前落地为 console 即时输出 + localStorage 环形缓冲（≤BUF_MAX 条，真机调试可 getRecent 导出核对）；
 * M4 软启动接入微信/抖音小游戏 SDK 时只替换 track 内部实现，全部挂钩点签名零改动。
 *
 * 红线（附录 A）：只上报数值与 id，不采集任何个人身份信息；事件名与字段名一旦上线不改名（只增不改）。
 */

/** 埋点属性白名单类型：值只能是标量或字符串数组（禁嵌套对象，从类型层挡住违规字段） */
export type AnalyticsProps = Record<string, string | number | boolean | string[]>;

/** 环形缓冲上限：超出裁掉最旧（高频 wave 事件全量保留 200 条足够真机回捞排查） */
export const BUF_MAX = 200;

/** 埋点缓冲存档键（独立于进度 / meta / 每日任务） */
const ANALYTICS_BUF_KEY = 'pinballforge_analytics_buf';

/** 单条埋点记录 */
export interface AnalyticsEntry {
    /** 事件名（附录 A 定义的 snake_case 事件表） */
    event: string;
    /** 事件属性 */
    props: AnalyticsProps;
    /** 本地时间戳（ms） */
    ts: number;
}

class AnalyticsClass {
    /** 环形缓冲（内存 + localStorage 双写） */
    private _buf: AnalyticsEntry[] = [];

    /** 读档幂等守卫：首次访问时从存档恢复（与 MetaManager.ensureLoaded 同构） */
    private _loaded = false;

    /** 从存档恢复环形缓冲（首次 track / getRecent 时调用；无存档 / 解析失败则从空开始） */
    ensureLoaded(): void {
        if (this._loaded) {
            return;
        }
        this._loaded = true;
        try {
            const raw = localStorage.getItem(ANALYTICS_BUF_KEY);
            if (!raw) {
                return;
            }
            const data = JSON.parse(raw) as unknown;
            if (Array.isArray(data)) {
                // 只收合法形状（event 非空字符串），防御旧版本 / 脏数据
                this._buf = (data as unknown[])
                    .filter((e): e is AnalyticsEntry =>
                        !!e && typeof e === 'object'
                        && typeof (e as AnalyticsEntry).event === 'string'
                        && (e as AnalyticsEntry).event.length > 0)
                    .slice(-BUF_MAX);
            }
        } catch (e) {
            console.warn('[Analytics] 读取埋点缓冲失败，从空开始', e);
            this._buf = [];
        }
    }

    /** 把缓冲写入 localStorage（裁剪在前，存档体量恒 ≤BUF_MAX 条） */
    private save(): void {
        try {
            localStorage.setItem(ANALYTICS_BUF_KEY, JSON.stringify(this._buf));
        } catch (e) {
            console.warn('[Analytics] 埋点缓冲写入失败', e);
        }
    }

    /**
     * 埋点统一入口：console 即时输出 + 入环形缓冲 + 写存档。
     * M4 接 SDK 时只改本方法内部，挂钩点签名零改动。
     */
    track(event: string, props: AnalyticsProps = {}): void {
        this.ensureLoaded();
        const entry: AnalyticsEntry = { event, props, ts: Date.now() };
        this._buf.push(entry);
        if (this._buf.length > BUF_MAX) {
            this._buf.splice(0, this._buf.length - BUF_MAX);
        }
        this.save();
        console.log(`[Track] ${event}`, entry.props);
    }

    /** 调试导出：最近 n 条（默认全缓冲） */
    getRecent(n = BUF_MAX): AnalyticsEntry[] {
        this.ensureLoaded();
        return this._buf.slice(-Math.max(1, n));
    }

    /** 调试清空（测试用；线上无调用方） */
    clear(): void {
        this._buf = [];
        try {
            localStorage.removeItem(ANALYTICS_BUF_KEY);
        } catch (e) { /* stub / 隐私模式：忽略 */ }
    }
}

/** 全局单例（纯逻辑，无需场景挂载；消费方直接 Analytics.track(...)） */
export const Analytics = new AnalyticsClass();
