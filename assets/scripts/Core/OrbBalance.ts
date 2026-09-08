import { OrbType, type ContractId } from './DataModels';
import { MetaManager } from './MetaManager';

/**
 * 弹珠战斗数值与本局升级状态。
 * 这里只提供轻量运行时配置，不引入额外数据驱动层；场景重载前由 ResultDialog 调用 reset()。
 */
export interface OrbConfig {
    baseDamage: number;
    pegEnergyGain: number;
}

export interface LightningConfig extends OrbConfig {
    scatterAngle: number;
    splitCount: number;
}

export interface LavaConfig extends OrbConfig {
    scale: number;
    gravityScale: number;
    density: number;
    splashRadius: number;
    splashEnergyMultiplier: number;
}

export interface FrostConfig extends OrbConfig {
    freezeDuration: number;
    freezeVulnerability: number;
    /** 寒霜导热（Task 008）：冰球入冰槽时冻结时长额外加成（秒） */
    funnelFreezeBonus: number;
}

export interface HeavyOrbConfig extends OrbConfig {
    scale: number;
    gravityScale: number;
    density: number;
}

export type OrbUpgradeId =
    | 'lightning_projectile'
    | 'lightning_scatter'
    | 'lava_energy'
    | 'lava_scale'
    | 'base_damage'
    | 'peg_multiplier'
    | 'funnel_bonus'
    | 'lava_splash'
    | 'lightning_combo';

const DEFAULT_NORMAL: OrbConfig = {
    baseDamage: 40,
    pegEnergyGain: 15,
};

const DEFAULT_LIGHTNING: LightningConfig = {
    baseDamage: 40,
    pegEnergyGain: 15,
    scatterAngle: 15 * Math.PI / 180,
    splitCount: 3,
};

const DEFAULT_LAVA: LavaConfig = {
    baseDamage: 40,
    pegEnergyGain: 60,
    scale: 1.4,
    gravityScale: 2,
    density: 2,
    splashRadius: 120,
    splashEnergyMultiplier: 1,
};

const DEFAULT_FROST: FrostConfig = {
    baseDamage: 40,
    pegEnergyGain: 15,
    freezeDuration: 4,
    // 冰球签名易伤：被冰封的敌人受到的伤害 ×(1+此值)（EnemyController.takeDamage 冰封乘区兑现）。
    // 2026-09-07 从 0 补全为 0.25：此前是死字段（无任何消费点），冰封只定身不加伤，冰球体系残缺；
    // 0.25 让「冻结 4s → 易伤窗口 → 灌伤害」成为完整闭环（与雷球连发/熔岩重压同档可玩）。
    freezeVulnerability: 0.25,
    // ⚗️ 寒霜导热（Task 008 协同）：冰球入冰槽（IceFreeze）时冻结时长额外 +2s（OrbController
    //   入槽结算消费；同系归位奖励，鼓励瞄准位选择）。reset 后随 DEFAULT 恢复。
    funnelFreezeBonus: 2,
};

// 🌳 等离子球（Meta 球种工坊解锁）：无视护盾是签名机制（在 EnemyController.takeDamage 兑现）。
//   代价是伤害吞吐更低：起始 30（< 普通 40）、每钉 +12（< 普通 15）→ 对无盾敌人明显弱于普通球，
//   对铁甲格挡 / Boss 坚盾则远强（直接透传）。是「针对护盾波次的特化选择」，非全面上位（防严格占优）。
const DEFAULT_PLASMA: HeavyOrbConfig = {
    baseDamage: 30,
    pegEnergyGain: 12,
    scale: 1.15,
    gravityScale: 1.3,
    density: 1.3,
};

// 🌳 熔核球（Meta 球种工坊 Lv3 高阶解锁）：走通用累积路径（无溅射分支），身份=超重重压 + 高能量 +
//   剥坚盾 3 层（EnemyController 兑现）。每钉 +75（> 熔岩 60）→ 单发重球砸穿 Boss；作为高阶 meta 奖励。
const DEFAULT_MAGMA: HeavyOrbConfig = {
    baseDamage: 45,
    pegEnergyGain: 75,
    scale: 1.5,
    gravityScale: 2.4,
    density: 2.4,
};

// 🌳 吸血球（Meta 球种工坊 Lv5 封顶解锁）：普通物理（非重球），身份=续航——入槽造成伤害后按
//   leechHealRatio 治疗城堡（TurretController 命中后兑现）。伤害中庸，价值全在续航延长局数。
const DEFAULT_LEECH: OrbConfig = {
    baseDamage: 40,
    pegEnergyGain: 18,
};

/**
 * 统一的弹珠配置入口。
 * 当前奖励不要求接入全部升级，但未来可通过 applyUpgrade() 跨波次修改这些运行时值。
 */
export class OrbBalance {
    static readonly normal: OrbConfig = { ...DEFAULT_NORMAL };
    static readonly lightning: LightningConfig = { ...DEFAULT_LIGHTNING };
    static readonly lava: LavaConfig = { ...DEFAULT_LAVA };
    static readonly frost: FrostConfig = { ...DEFAULT_FROST };
    static readonly plasma: HeavyOrbConfig = { ...DEFAULT_PLASMA };
    static readonly magma: HeavyOrbConfig = { ...DEFAULT_MAGMA };
    static readonly leech: OrbConfig = { ...DEFAULT_LEECH };

    /** 吸血球回血倍率：入槽伤害 × 此值治疗城堡（封顶 meta 奖励，需真机校准） */
    static readonly leechHealRatio = 0.25;

    /** 吸血球单发回血封顶（难度方案B）：高伤构筑下 25% 转化无上限会一发回数千，封顶保持续航定位而非无敌（TurretController 兑现） */
    static readonly leechHitHealCap = 60;

    /** Normal 的轻量连续撞击奖励；保持其基础定位，不与特殊球争夺强度。 */
    static readonly normalComboThreshold = 5;
    static readonly normalComboDamageBonus = 5;

    /** 统一升级倍率接口：升级状态在当前场景 / 波次间持续，重开时 reset。 */
    static pegMultiplier = 1;
    static funnelBonus = 0;
    static lavaAreaSplashEnabled = false;
    static lightningComboEnabled = false;

    // ---------- ⚑ 锻造契约（方案C：开局 Build Around） ----------

    /** 当前立约契约（null = 未立约）；增益已按 applyContract 一次性叠加、减益经查询式持续生效 */
    static activeContract: ContractId | null = null;
    /** 契约减益软启动缩放（0.5 = 文案承诺代价的 50%）：验证期旋钮，实机验证后转正改 1（三处消费共用单一真源） */
    static readonly CONTRACT_DEBUFF_SCALE = 0.5;
    /** 熔炉契约减益：金币槽产出倍率（无契约 ×1；软启动 1 - 0.5×SCALE = 0.75，OrbController 金币槽分支消费） */
    static contractGoldMult = 1;

    /** 寒霜契约减益：城堡生命上限倍率（无契约 ×1；软启动 1 - 0.2×SCALE = 0.9，CastleController.onLoad 消费） */
    static get castleHpMult(): number {
        return this.activeContract === 'contract_frost'
            ? 1 - 0.2 * this.CONTRACT_DEBUFF_SCALE
            : 1;
    }

    /**
     * ⚑ 立约（三选一，RewardDialog 契约分支调用）：增益一次性叠加在当前值上（与 applyUpgrade 同语义，
     * 本局已拿的强化不回滚）；减益为查询式（castleHpMult / contractGoldMult），随立约状态持续生效。
     * 重复立约由 UI 门（未立约才展示）防住；文案承诺的代价全额 ×CONTRACT_DEBUFF_SCALE 软启动。
     */
    static applyContract(id: ContractId): void {
        this.activeContract = id;
        this.contractGoldMult = 1;
        switch (id) {
            case 'contract_thunder': {
                // 增益：雷球伤害 ×1.5 + 散射 3→5（LauncherController.fireLightningBurst 消费 splitCount）
                this.lightning.baseDamage *= 1.5;
                this.lightning.splitCount = 5; // 基础 3 + 过载雷球卡 +2 同一终态；契约直接给满
                // 代价（文案「普通弹珠伤害 -40%」，软启动 ×0.8）：只打普通球——契约的强制定向，
                // 特殊球种不吞减益（雷球系统化 vs 普通球退场；文案↔实现一致性由 selfcheck-contracts 锁定）
                this.normal.baseDamage *= 1 - 0.4 * this.CONTRACT_DEBUFF_SCALE;
                break;
            }
            case 'contract_forge': {
                // 增益：熔岩溅射常驻（同 lava_splash 卡）+ 殉爆半径 ×1.5
                this.lavaAreaSplashEnabled = true;
                this.lava.splashRadius *= 1.5;
                // 代价（文案 -50%，软启动 ×0.75）：金币槽产出减额（OrbController GOLD_REWARD_AMOUNT 分支消费）
                this.contractGoldMult = 1 - 0.5 * this.CONTRACT_DEBUFF_SCALE;
                break;
            }
            case 'contract_frost': {
                // 增益：冰封易伤 0.25→0.5（EnemyController.takeDamage 冰封乘区自动放大）+ 冻结 4s→6s
                this.frost.freezeVulnerability += 0.25;
                this.frost.freezeDuration += 2;
                // 代价：城堡生命上限 ×castleHpMult（查询式，CastleController.onLoad 在 meta 加成后消费）
                break;
            }
            default:
                break;
        }
        console.log(`[OrbBalance] 契约生效: ${id}（减益软启动 ×${this.CONTRACT_DEBUFF_SCALE}）`);
    }

    static applyUpgrade(id: OrbUpgradeId, value = 1): void {
        switch (id) {
            case 'lightning_projectile':
                this.lightning.splitCount += Math.max(0, Math.floor(value));
                break;
            case 'lightning_scatter':
                this.lightning.scatterAngle += value * Math.PI / 180;
                break;
            case 'lava_energy':
                this.lava.pegEnergyGain += value;
                break;
            case 'lava_scale':
                this.lava.scale += value;
                break;
            case 'base_damage':
                this.normal.baseDamage += value;
                this.lightning.baseDamage += value;
                this.lava.baseDamage += value;
                // 2026-09-07（Task 007 协同）：frost 补齐——此前只有 applyMetaBonus 覆盖 frost，
                // applyUpgrade('base_damage') 漏掉 frost 造成两条伤害强化路径语义不一致（商店
                // 「全伤害强化」文案承诺全部弹珠，必须七球全覆盖）。
                this.frost.baseDamage += value;
                this.plasma.baseDamage += value;
                this.magma.baseDamage += value;
                this.leech.baseDamage += value;
                break;
            case 'peg_multiplier':
                this.pegMultiplier += value;
                break;
            case 'funnel_bonus':
                this.funnelBonus += value;
                break;
            case 'lava_splash':
                this.lavaAreaSplashEnabled = true;
                break;
            case 'lightning_combo':
                this.lightningComboEnabled = true;
                break;
            default:
                break;
        }
    }

    /**
     * 永久升级（meta「弹珠打磨」）伤害加成：赋值式（默认值 + 加成，幂等可重复调用），
     * 七种球全覆盖（含 applyUpgrade('base_damage') 未覆盖的 frost）。
     * 调用时机：DeckManager.onLoad（场景首局）与 reset() 末尾（重开一局），两处都套保证任何起点都生效。
     */
    static applyMetaBonus(): void {
        const bonus = MetaManager.getDamageBonus();
        this.normal.baseDamage = DEFAULT_NORMAL.baseDamage + bonus;
        this.lightning.baseDamage = DEFAULT_LIGHTNING.baseDamage + bonus;
        this.lava.baseDamage = DEFAULT_LAVA.baseDamage + bonus;
        this.frost.baseDamage = DEFAULT_FROST.baseDamage + bonus;
        this.plasma.baseDamage = DEFAULT_PLASMA.baseDamage + bonus;
        this.magma.baseDamage = DEFAULT_MAGMA.baseDamage + bonus;
        this.leech.baseDamage = DEFAULT_LEECH.baseDamage + bonus;
    }

    /**
     * 雷球扇形散射偏移角（弧度）序列：n 颗均匀分布，单颗间隔 angle。
     * n=3 → [-angle, 0, +angle]（与旧版 left/dir/right 三连发完全等价）；
     * n=5 → [-2a, -a, 0, +a, +2a]（过载雷球 5 连发）；偶数自动中心偏半档，无特判。
     * 纯函数（零 cc 依赖），供自检直接真跑。
     */
    static lightningSpread(count: number, angle: number): number[] {
        const n = Math.max(1, Math.floor(count));
        const offsets: number[] = [];
        for (let i = 0; i < n; i++) {
            offsets.push((i - (n - 1) / 2) * angle);
        }
        return offsets;
    }

    static reset(): void {
        Object.assign(this.normal, DEFAULT_NORMAL);
        Object.assign(this.lightning, DEFAULT_LIGHTNING);
        Object.assign(this.lava, DEFAULT_LAVA);
        Object.assign(this.frost, DEFAULT_FROST);
        Object.assign(this.plasma, DEFAULT_PLASMA);
        Object.assign(this.magma, DEFAULT_MAGMA);
        Object.assign(this.leech, DEFAULT_LEECH);
        this.pegMultiplier = 1;
        this.funnelBonus = 0;
        this.lavaAreaSplashEnabled = false;
        this.lightningComboEnabled = false;
        // ⚑ 锻造契约（方案C）：重开一局清运行时契约（解锁资格是跨局存档，互不影响）
        this.activeContract = null;
        this.contractGoldMult = 1;
        // ⚒ 重开一局后同样套用 meta 永久伤害加成（本局升级清零、永久强化保留）
        this.applyMetaBonus();
    }

    static configFor(type: OrbType): OrbConfig {
        if (type === OrbType.Lightning) {
            return this.lightning;
        }
        if (type === OrbType.Lava) {
            return this.lava;
        }
        if (type === OrbType.Frost) {
            return this.frost;
        }
        if (type === OrbType.Plasma) {
            return this.plasma;
        }
        if (type === OrbType.Magma) {
            return this.magma;
        }
        if (type === OrbType.Leech) {
            return this.leech;
        }
        return this.normal;
    }
}