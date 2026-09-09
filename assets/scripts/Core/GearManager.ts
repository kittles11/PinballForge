/**
 * ⚙️ 局外成长（Meta-Progression）——齿轮（Gears）代币管理器（模块级单例，与 LevelManager / MetaManager 同构；
 * 纯逻辑零 cc 依赖，自检可直接 import 跑行为）。
 *
 * 结算（ResultDialog.onGameOver / onGameVictory 共同汇聚点 showResult）转化齿轮：
 *   获得齿轮 = 存活波次总数 × 5 + 单局未花完金币 ÷ 10（向下取整）
 * 其中「存活波次总数」= 进度轴上的累计波次数（(章-1)×30 + (关-1)×3 + 当前波 − 未清波修正）：
 *   - 失败时当前波未清 → −1（只算完整打完的波）；
 *   - 胜利时当前波已清且 nextLevel 尚未推进（GAME_VICTORY 在 LevelManager.nextLevel 之前广播）→ 无修正。
 *   无尽模式 currentChapter > 50 也按同一线性公式外推，无需特判。
 *
 * 存档：localStorage('pinballforge_gears')，独立 key（防 LevelManager.resetProgress 误清；
 * 与 MetaManager 的 pinballforge_meta 同款隔离策略）。消费：CastleController 初始化时
 * 每 GEAR_HP_THRESHOLD（100）齿轮 → 城堡 maxHp 永久 +GEAR_HP_BONUS（10）。
 */

/** 齿轮存档键（独立于进度 / meta 存档，防重开一局误清） */
export const GEARS_SAVE_KEY = 'pinballforge_gears';
/** 每存活 1 波的齿轮转化量 */
export const GEARS_PER_WAVE = 5;
/** 未花完金币 → 齿轮的除数（10 金 = 1 齿轮） */
export const GEARS_PER_GOLD = 10;
/** 城堡血量加成门槛：每累计该数量齿轮，maxHp 永久 +10 */
export const GEAR_HP_THRESHOLD = 100;
/** 每达到一次门槛的城堡 maxHp 提升量 */
export const GEAR_HP_BONUS = 10;

/** 存活波次总数（进度轴累计波次；波清完由调用方以 clearedWave=false 修正未清波） */
export function wavesSurvived(chapter: number, level: number, wave: number): number {
    const ch = Math.max(1, Math.floor(chapter) || 1);
    const lv = Math.max(1, Math.floor(level) || 1);
    const w = Math.max(1, Math.floor(wave) || 1);
    return (ch - 1) * 30 + (lv - 1) * 3 + w;
}

/** 齿轮结算公式（纯函数，自检锚点）：存活波次×5 + 未花完金币÷10（向下取整），失败且当前波未清时波次 −1 */
export function calcGears(waves: number, goldLeft: number, clearedWave: boolean): number {
    const w = Math.max(0, Math.floor(waves) - (clearedWave ? 0 : 1));
    const g = Math.max(0, Math.floor(goldLeft) || 0);
    return w * GEARS_PER_WAVE + Math.floor(g / GEARS_PER_GOLD);
}

class GearManagerClass {
    /** 跨局累计的齿轮总数 */
    private _gears = 0;
    /** 懒加载标记：MetaManager 同款惯例——模块加载期不读档（自检需先装 localStorage stub） */
    private _loaded = false;

    /** 从 localStorage 恢复累计齿轮（首次访问时执行一次；损坏/缺失静默归零） */
    private ensureLoaded(): void {
        if (this._loaded) {
            return;
        }
        this._loaded = true;
        try {
            const raw = localStorage.getItem(GEARS_SAVE_KEY);
            if (!raw) {
                return;
            }
            const data = JSON.parse(raw) as { gears?: number };
            this._gears = typeof data?.gears === 'number' && data.gears > 0 ? Math.floor(data.gears) : 0;
        } catch (e) {
            console.warn('[Gear] 读取齿轮存档失败，按 0 处理', e);
        }
    }

    /** 累计齿轮总数 */
    public getGears(): number {
        this.ensureLoaded();
        return this._gears;
    }

    /** 结算入账：累加并落盘，返回入账后的总数 */
    public addGears(amount: number): number {
        this.ensureLoaded();
        if (!Number.isFinite(amount) || amount <= 0) {
            return this._gears;
        }
        this._gears += Math.floor(amount);
        this.save();
        console.log(`[Gear] 齿轮 +${Math.floor(amount)}，累计 ${this._gears}`);
        return this._gears;
    }

    /** 局外天赋：每 100 齿轮 → 城堡 maxHp +10（CastleController 初始化时消费） */
    public getCastleBonus(): number {
        this.ensureLoaded();
        return Math.floor(this._gears / GEAR_HP_THRESHOLD) * GEAR_HP_BONUS;
    }

    private save(): void {
        try {
            localStorage.setItem(GEARS_SAVE_KEY, JSON.stringify({ gears: this._gears }));
        } catch (e) {
            console.warn('[Gear] 齿轮存档写入失败', e);
        }
    }
}

/** 全局单例齿轮管理器（纯逻辑，无需场景挂载） */
export const GearManager = new GearManagerClass();