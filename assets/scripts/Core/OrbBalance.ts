import { OrbType } from './DataModels';
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
    freezeVulnerability: 0,
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

    /** Normal 的轻量连续撞击奖励；保持其基础定位，不与特殊球争夺强度。 */
    static readonly normalComboThreshold = 5;
    static readonly normalComboDamageBonus = 5;

    /** 统一升级倍率接口：升级状态在当前场景 / 波次间持续，重开时 reset。 */
    static pegMultiplier = 1;
    static funnelBonus = 0;
    static lavaAreaSplashEnabled = false;
    static lightningComboEnabled = false;

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
     * 四种球全覆盖（含 applyUpgrade('base_damage') 未覆盖的 frost）。
     * 调用时机：DeckManager.onLoad（场景首局）与 reset() 末尾（重开一局），两处都套保证任何起点都生效。
     */
    static applyMetaBonus(): void {
        const bonus = MetaManager.getDamageBonus();
        this.normal.baseDamage = DEFAULT_NORMAL.baseDamage + bonus;
        this.lightning.baseDamage = DEFAULT_LIGHTNING.baseDamage + bonus;
        this.lava.baseDamage = DEFAULT_LAVA.baseDamage + bonus;
        this.frost.baseDamage = DEFAULT_FROST.baseDamage + bonus;
    }

    static reset(): void {
        Object.assign(this.normal, DEFAULT_NORMAL);
        Object.assign(this.lightning, DEFAULT_LIGHTNING);
        Object.assign(this.lava, DEFAULT_LAVA);
        Object.assign(this.frost, DEFAULT_FROST);
        this.pegMultiplier = 1;
        this.funnelBonus = 0;
        this.lavaAreaSplashEnabled = false;
        this.lightningComboEnabled = false;
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
        return this.normal;
    }
}