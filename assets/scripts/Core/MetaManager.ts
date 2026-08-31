/**
 * Meta 永久进度管理器（模块级单例，与 LevelManager 同构；纯逻辑零 cc 依赖，自检可直接 import 跑行为）。
 *
 * 死亡补偿（P1-1）：城堡沦陷 / 通关结算时按当局进度发放「精铸碎片 ⚒」，
 * 碎片在「⚒ 锻造」区购买三条永久升级，跨局生效、重开一局不清零。
 *
 * 存档：localStorage('pinballforge_meta')，与关卡进度存档（pinballforge_progress）完全独立——
 * LevelManager.resetProgress() 只清进度 key，绝不清 meta（死了买完强化，进度归零、强化留下）。
 */
import { Analytics } from './Analytics';

/** 永久进度存档键（独立于 pinballforge_progress，防 resetProgress 误清） */
const META_SAVE_KEY = 'pinballforge_meta';

/** 三条永久升级的 id（castle=城堡加固 / damage=弹珠打磨 / gold=开局资金） */
export type MetaUpgradeId = 'castle' | 'damage' | 'gold';

/** 每级加成数值（单一真源：加成计算与 UI 文案都从这里取） */
export const META_UPGRADE_PER_LV: Record<MetaUpgradeId, number> = {
    castle: 10, // 城堡血量上限 +10/级
    damage: 2,  // 全弹珠伤害 +2/级
    gold: 25,   // 开局金币 +25/级
};

/** 各升级首级价格：第 n 级价格 = 首价 × n（线性阶梯递增，买满一级比一级贵） */
const META_UPGRADE_BASE_PRICE: Record<MetaUpgradeId, number> = {
    castle: 20, // 5 级共 300
    damage: 25, // 5 级共 375
    gold: 15,   // 5 级共 225
};

/** 碎片发放公式常量：15 + (章-1)×6 + (关-1)×2，胜利 ×3（自检锚点复核用） */
export const META_SHARDS_BASE = 15;
export const META_SHARDS_PER_CHAPTER = 6;
export const META_SHARDS_PER_LEVEL = 2;
export const META_WIN_MULT = 3;

/** 每条升级的等级封顶 */
export const META_MAX_LV = 5;

/** 升级展示信息（ResultDialog 锻造区遍历用） */
export interface MetaUpgradeInfo {
    id: MetaUpgradeId;
    /** 升级名（城堡加固 / 弹珠打磨 / 开局资金） */
    name: string;
    /** 加成项单位名（城堡血量 / 弹珠伤害 / 开局金币） */
    unit: string;
    /** 每级加成数值 */
    perLv: number;
}

const UPGRADE_IDS: MetaUpgradeId[] = ['castle', 'damage', 'gold'];

const UPGRADE_NAMES: Record<MetaUpgradeId, string> = {
    castle: '城堡加固',
    damage: '弹珠打磨',
    gold: '开局资金',
};

const UPGRADE_UNITS: Record<MetaUpgradeId, string> = {
    castle: '城堡血量',
    damage: '弹珠伤害',
    gold: '开局金币',
};

class MetaManagerClass {
    /** 当前持有碎片 */
    shards = 0;

    /** 三条永久升级等级（0 ~ META_MAX_LV），跨局持久 */
    levels: Record<MetaUpgradeId, number> = { castle: 0, damage: 0, gold: 0 };

    /** 读档幂等守卫：首次访问时从存档恢复，之后不再重复读 */
    private _loaded = false;

    /** 从存档恢复（首次访问时调用；无存档 / 解析失败则保持 0）——LevelManager.loadFromSave 同款容错 */
    ensureLoaded(): void {
        if (this._loaded) {
            return;
        }
        this._loaded = true;
        try {
            const raw = localStorage.getItem(META_SAVE_KEY);
            if (!raw) {
                return;
            }
            const data = JSON.parse(raw) as { shards?: unknown; castle?: unknown; damage?: unknown; gold?: unknown };
            const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
            this.shards = Math.max(0, Math.floor(num(data.shards)));
            for (const id of UPGRADE_IDS) {
                this.levels[id] = Math.min(META_MAX_LV, Math.max(0, Math.floor(num(data[id]))));
            }
        } catch (e) {
            console.warn('[Meta] 读取永久进度失败，从 0 开始', e);
        }
    }

    /** 把碎片与升级等级写入本地存档 */
    private save(): void {
        try {
            localStorage.setItem(META_SAVE_KEY, JSON.stringify({
                shards: this.shards,
                castle: this.levels.castle,
                damage: this.levels.damage,
                gold: this.levels.gold,
            }));
        } catch (e) {
            console.warn('[Meta] 永久进度写入失败', e);
        }
    }

    /**
     * 结算发放碎片：按结算时的章节 / 关卡进度线性计发，胜利 ×3。
     * 返回本局获得量（已入账并写存档）。
     */
    grantRunReward(chapter: number, level: number, isWin: boolean): number {
        this.ensureLoaded();
        const ch = Math.max(1, Math.floor(chapter) || 1);
        const lv = Math.max(1, Math.floor(level) || 1);
        const amount = Math.round(
            (META_SHARDS_BASE + (ch - 1) * META_SHARDS_PER_CHAPTER + (lv - 1) * META_SHARDS_PER_LEVEL)
            * (isWin ? META_WIN_MULT : 1),
        );
        this.shards += amount;
        this.save();
        console.log(`[Meta] 结算发放 ⚒${amount}（${ch}-${lv}${isWin ? ' 通关' : ''}），持有 ${this.shards}`);
        return amount;
    }

    /**
     * 直接入账碎片（每日任务奖励等运营系统共用入口；grantRunReward 仍走自身发放+日志）。
     * 非法值（负数 / NaN / 无穷）按 0 处理返回 0；成功入账并写存档，返回实际入账值。
     */
    addShards(amount: number): number {
        this.ensureLoaded();
        const n = typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
        if (n <= 0) {
            return 0;
        }
        this.shards += n;
        this.save();
        return n;
    }

    /** 当前持有碎片 */
    getShards(): number {
        this.ensureLoaded();
        return this.shards;
    }

    /** 某条升级当前等级 */
    getLv(id: MetaUpgradeId): number {
        this.ensureLoaded();
        return this.levels[id];
    }

    /** 某条升级下一级价格；已满级返回 -1 */
    getPrice(id: MetaUpgradeId): number {
        const lv = this.getLv(id);
        return lv >= META_MAX_LV ? -1 : META_UPGRADE_BASE_PRICE[id] * (lv + 1);
    }

    /** 是否已满级 */
    isMaxed(id: MetaUpgradeId): boolean {
        return this.getLv(id) >= META_MAX_LV;
    }

    /** 下一级是否买得起（满级视为不可买） */
    canAfford(id: MetaUpgradeId): boolean {
        const price = this.getPrice(id);
        return price >= 0 && this.shards >= price;
    }

    /** 购买下一级：成功扣费 + 升级 + 存档并返回 true；满级 / 余额不足返回 false */
    buy(id: MetaUpgradeId): boolean {
        this.ensureLoaded();
        const price = this.getPrice(id);
        if (price < 0 || this.shards < price) {
            return false;
        }
        this.shards -= price;
        this.levels[id] += 1;
        this.save();
        // 附录 A meta_buy：meta 消耗节奏埋点（Analytics 纯逻辑零 cc 依赖，不破坏本模块的 node 自检）
        Analytics.track('meta_buy', { upgradeId: id, toLv: this.levels[id], price });
        console.log(`[Meta] ${UPGRADE_NAMES[id]} → Lv${this.levels[id]}，花费 ⚒${price}，剩余 ${this.shards}`);
        return true;
    }

    /** 城堡血量加成（级数 × 10） */
    getCastleBonus(): number {
        return this.getLv('castle') * META_UPGRADE_PER_LV.castle;
    }

    /** 全弹珠伤害加成（级数 × 2） */
    getDamageBonus(): number {
        return this.getLv('damage') * META_UPGRADE_PER_LV.damage;
    }

    /** 开局金币加成（级数 × 25） */
    getGoldBonus(): number {
        return this.getLv('gold') * META_UPGRADE_PER_LV.gold;
    }

    /** 三条升级的展示信息（锻造区按此顺序渲染） */
    getUpgradeList(): MetaUpgradeInfo[] {
        return UPGRADE_IDS.map((id) => ({
            id,
            name: UPGRADE_NAMES[id],
            unit: UPGRADE_UNITS[id],
            perLv: META_UPGRADE_PER_LV[id],
        }));
    }
}

/** 全局单例（纯逻辑，无需场景挂载；消费方按需 ensureLoaded） */
export const MetaManager = new MetaManagerClass();
