/**
 * Meta 永久进度管理器（模块级单例，与 LevelManager 同构；纯逻辑零 cc 依赖，自检可直接 import 跑行为）。
 *
 * 死亡补偿（P1-1）：城堡沦陷 / 通关结算时按当局进度发放「精铸碎片 ⚒」，
 * 碎片在「⚒ 锻造」区购买永久升级（解锁树：3 根轨 + 2 前置子轨），跨局生效、重开一局不清零。
 *
 * 存档：localStorage('pinballforge_meta')，与关卡进度存档（pinballforge_progress）完全独立——
 * LevelManager.resetProgress() 只清进度 key，绝不清 meta（死了买完强化，进度归零、强化留下）。
 */
import { Analytics } from './Analytics';

/** 永久进度存档键（独立于 pinballforge_progress，防 resetProgress 误清） */
const META_SAVE_KEY = 'pinballforge_meta';

/** 永久升级 id：三条根轨（castle/damage/gold）+ 五条前置解锁子轨（见 META_PREREQS 树形） */
export type MetaUpgradeId =
    | 'castle' | 'damage' | 'gold'
    | 'orbCap' | 'boardLab' | 'shard' | 'insight' | 'forbiddenPack';

/** 每级加成数值（单一真源：加成计算与 UI 文案都从这里取） */
export const META_UPGRADE_PER_LV: Record<MetaUpgradeId, number> = {
    castle: 10,  // 城堡血量上限 +10/级
    damage: 2,   // 全弹珠伤害 +2/级
    gold: 25,    // 开局金币 +25/级
    orbCap: 1,   // 牌库容量上限 +1/级（8 → 最多 13）
    boardLab: 1, // 钉板实验台：解锁档位（Lv1 版型D / Lv3 版型E，非线性，展示走 describe）
    shard: 15,   // 结算碎片获取 +15%/级
    insight: 1,  // 选牌保底档位（Lv1 稀有地板 / Lv3 史诗地板，非线性数值，展示走 describe）
    forbiddenPack: 1, // 禁忌卡包：解锁档位（Lv1 聚能奇点 / Lv3 猎神契约，非线性，展示走 describe）
};

/** 各升级首级价格：第 n 级价格 = 首价 × n（线性阶梯递增，买满一级比一级贵） */
const META_UPGRADE_BASE_PRICE: Record<MetaUpgradeId, number> = {
    castle: 20,  // 5 级共 300
    damage: 25,  // 5 级共 375
    gold: 15,    // 5 级共 225
    orbCap: 35,  // 5 级共 525（构筑宽度：牌库扩容）
    boardLab: 50, // 5 级共 750（内容解锁：新钉板版型）
    shard: 30,   // 5 级共 450（经济复利轨，中后期回本）
    insight: 60, // 5 级共 900（终局投资轨：构筑质量上限）
    forbiddenPack: 80, // 5 级共 1200（顶级内容解锁：跨局专属强力卡）
};

/**
 * 🌳 解锁树前置门控：子轨需父轨达到指定等级才开放购买（null = 根轨恒可用）。
 * 树形（三条深度链）：
 *   castle ─→ orbCap ─→ boardLab（结构→容量→钉板实验台）
 *   gold ───→ shard（经济复利）
 *   damage ─→ insight ─→ forbiddenPack（伤害→构筑质量→禁忌卡包）
 * 设计意图：给长线玩家清晰的加点路线感与「解锁新内容」的目标感，而非平行无差别轨道。
 */
export const META_PREREQS: Record<MetaUpgradeId, { id: MetaUpgradeId; lv: number } | null> = {
    castle: null,
    damage: null,
    gold: null,
    orbCap: { id: 'castle', lv: 3 },
    boardLab: { id: 'orbCap', lv: 2 },
    shard: { id: 'gold', lv: 3 },
    insight: { id: 'damage', lv: 3 },
    forbiddenPack: { id: 'insight', lv: 2 },
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
    /** 升级名（城堡加固 / 弹珠槽扩容 / 钉板实验台 / 弹珠打磨 / 开局资金 / 碎片收藏 / 战术洞察 / 禁忌卡包） */
    name: string;
    /** 加成项单位名（城堡血量 / 牌库容量 / 钉板版型 / 弹珠伤害 / 开局金币 / 碎片获取% / 选牌保底 / 禁忌卡牌） */
    unit: string;
    /** 每级加成数值 */
    perLv: number;
    /** 非线性效果的自定义展示（如战术洞察的保底档位文案）；缺省走「unit+lv×perLv」 */
    describe?: (lv: number) => string;
    /** 前置门控（null=根轨恒可用；子轨未达标时 UI 显示 🔒 并拒绝购买） */
    prereq: { id: MetaUpgradeId; lv: number } | null;
}

/** 锻造区渲染顺序：按解锁树分支排列，ResultDialog 前 4 条入左列、后 4 条入右列 */
const UPGRADE_IDS: MetaUpgradeId[] = ['castle', 'orbCap', 'boardLab', 'damage', 'gold', 'shard', 'insight', 'forbiddenPack'];

const UPGRADE_NAMES: Record<MetaUpgradeId, string> = {
    castle: '城堡加固',
    orbCap: '弹珠槽扩容',
    boardLab: '钉板实验台',
    damage: '弹珠打磨',
    gold: '开局资金',
    shard: '碎片收藏',
    insight: '战术洞察',
    forbiddenPack: '禁忌卡包',
};

const UPGRADE_UNITS: Record<MetaUpgradeId, string> = {
    castle: '城堡血量',
    orbCap: '牌库容量',
    boardLab: '钉板版型',
    damage: '弹珠伤害',
    gold: '开局金币',
    shard: '碎片获取%',
    insight: '选牌保底',
    forbiddenPack: '禁忌卡牌',
};

class MetaManagerClass {
    /** 当前持有碎片 */
    shards = 0;

    /** 永久升级等级（0 ~ META_MAX_LV），跨局持久 */
    levels: Record<MetaUpgradeId, number> = {
        castle: 0, orbCap: 0, boardLab: 0, damage: 0, gold: 0, shard: 0, insight: 0, forbiddenPack: 0,
    };

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
            const data = JSON.parse(raw) as { shards?: unknown } & Partial<Record<MetaUpgradeId, unknown>>;
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
            const payload: Record<string, number> = { shards: this.shards };
            for (const id of UPGRADE_IDS) {
                payload[id] = this.levels[id];
            }
            localStorage.setItem(META_SAVE_KEY, JSON.stringify(payload));
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
        const base = META_SHARDS_BASE + (ch - 1) * META_SHARDS_PER_CHAPTER + (lv - 1) * META_SHARDS_PER_LEVEL;
        const amount = Math.round(
            base * (isWin ? META_WIN_MULT : 1) * (1 + this.getShardBonus() / 100),
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

    /** 🌳 前置门控：子轨需父轨达标才解锁（根轨恒解锁）。等级已投入的父轨变化会实时影响解锁态。 */
    isUnlocked(id: MetaUpgradeId): boolean {
        const pre = META_PREREQS[id];
        if (!pre) {
            return true;
        }
        return this.getLv(pre.id) >= pre.lv;
    }

    /** 下一级是否买得起（满级 / 未解锁视为不可买） */
    canAfford(id: MetaUpgradeId): boolean {
        if (!this.isUnlocked(id)) {
            return false;
        }
        const price = this.getPrice(id);
        return price >= 0 && this.shards >= price;
    }

    /** 购买下一级：成功扣费 + 升级 + 存档并返回 true；满级 / 未解锁 / 余额不足返回 false */
    buy(id: MetaUpgradeId): boolean {
        this.ensureLoaded();
        if (!this.isUnlocked(id)) {
            console.log(`[Meta] ${UPGRADE_NAMES[id]} 未解锁（需 ${UPGRADE_NAMES[META_PREREQS[id]!.id]} Lv${META_PREREQS[id]!.lv}）`);
            return false;
        }
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

    /** 碎片获取加成百分比（级数 × 15，作用于 grantRunReward 结算发放） */
    getShardBonus(): number {
        return this.getLv('shard') * META_UPGRADE_PER_LV.shard;
    }

    /** 战术洞察等级（RewardDialog 据此对三选一施加稀有度地板：Lv1+ 稀有、Lv3+ 史诗） */
    getInsightLv(): number {
        return this.getLv('insight');
    }

    /** 牌库容量加成（级数 × 1，DeckManager 叠加到基础软上限 8 之上） */
    getOrbCapBonus(): number {
        return this.getLv('orbCap') * META_UPGRADE_PER_LV.orbCap;
    }

    /** 钉板实验台等级（PegBoardManager 据此把版型 D(Lv1+)/E(Lv3+) 纳入随机池） */
    getBoardLabLv(): number {
        return this.getLv('boardLab');
    }

    /** 禁忌卡包等级（RewardDialog 据此放行 metaLock=forbiddenPack 的跨局专属卡：奇点 Lv1+ / 猎神 Lv3+） */
    getForbiddenPackLv(): number {
        return this.getLv('forbiddenPack');
    }

    /** 八条升级的展示信息（锻造区按此顺序渲染：三根轨 + 五子轨，树分支序） */
    getUpgradeList(): MetaUpgradeInfo[] {
        const describeInsight = (lv: number): string =>
            (lv >= 3 ? '保底史诗' : lv >= 1 ? '保底稀有' : '未激活');
        const describeBoardLab = (lv: number): string =>
            (lv >= 3 ? '版型D+E' : lv >= 1 ? '版型D' : '未解锁');
        const describeForbidden = (lv: number): string =>
            (lv >= 3 ? '奇点+猎神' : lv >= 1 ? '聚能奇点' : '未解锁');
        const describers: Partial<Record<MetaUpgradeId, (lv: number) => string>> = {
            insight: describeInsight,
            boardLab: describeBoardLab,
            forbiddenPack: describeForbidden,
        };
        return UPGRADE_IDS.map((id) => ({
            id,
            name: UPGRADE_NAMES[id],
            unit: UPGRADE_UNITS[id],
            perLv: META_UPGRADE_PER_LV[id],
            prereq: META_PREREQS[id],
            describe: describers[id],
        }));
    }
}

/** 全局单例（纯逻辑，无需场景挂载；消费方按需 ensureLoaded） */
export const MetaManager = new MetaManagerClass();
