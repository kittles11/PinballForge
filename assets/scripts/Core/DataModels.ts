/**
 * 全局数据结构定义（纯数据，不依赖 cc 运行时）。
 * 目的：关卡配置 / 序列化 / 存档 与事件载荷共用同一套形状。
 */

/** 通用二维坐标（字段与 cc.Vec2 保持同名，避免引入引擎依赖） */
export interface Vec2Like {
    x: number;
    y: number;
}

/** 游戏阶段 */
export enum GamePhase {
    /** 开局/等待发射 */
    Ready = 'Ready',
    /** 进行中 */
    Playing = 'Playing',
    /** 战后选牌阶段 */
    Reward = 'Reward',
    /** 通关胜利 */
    Victory = 'Victory',
    /** 游戏结束 */
    GameOver = 'GameOver',
}

/** 漏斗槽类型（0 聚能 / 1 精炼 / 2 金币）：只做入槽数值修饰，炮弹外观与受击特效始终跟随珠子类型 */
export enum FunnelType {
    /** 聚能（红）：本颗珠子入槽开火伤害 ×2（可被「重炮超载」卡进一步加成） */
    HeavyCannon = 0,
    /** 精炼（蓝）：本颗珠子入槽开火伤害 ×1.5 */
    IceFreeze = 1,
    /** 金币：入槽即发 +20 金币（OrbController 结算时发放），弹珠伤害不变 */
    GoldCoin = 2,
}

/** 弹珠类型（与 OrbController 对齐）：决定专属技能与能量累计 */
export enum OrbType {
    /** 普通白球：无特殊技能，基础伤害 40 */
    Normal = 0,
    /** 裂变雷球：发射瞬间扇形 3 连发散射（#00FFFF 电光球） */
    Lightning = 1,
    /** 重力熔岩球：双倍重力重压砸击，每次撞钉 +60 能量 */
    Lava = 2,
    /** 霜冻冰球：入任意槽冰封全场敌人 4 秒，命中单体冻结 3 秒 */
    Frost = 3,
}

/** 钉子类型 */
export enum PegType {
    /** 普通木钉：正常计分 */
    Normal = 0,
    /** 乘倍钉：受击能量 ×2 */
    Multiplier = 1,
    /** 炸药红钉：命中后引爆周围 120px 内钉子，一次性 */
    Bomb = 2,
    /** 刷新绿钉：命中后复活全场其它钉子 */
    Refresh = 3,
}

/** 战后卡牌奖励基础数据 */
export interface CardRewardData {
    /** 卡牌唯一 id */
    id: string;
    /** 卡牌标题 */
    title: string;
    /** 效果描述 */
    desc: string;
}

/** 敌人类型：普通怪 + 四大特色怪（外观 / 数值 / 机制配置唯一真源见 ENEMY_TYPE_STATS） */
export enum EnemyType {
    Normal = 'Normal',       // 普通红怪（平衡）
    Shield = 'Shield',       // 🛡️ 重装铁甲怪（自带 2 层护盾，免疫前 2 次伤害）
    Speed = 'Speed',         // ⚡ 暗影突袭怪（移速 85 px/s，移速极快）
    Slime = 'Slime',         // 🦠 分裂史莱姆（死亡时分裂出 2 只小怪）
    Boss = 'Boss',           // 👹 章节大 Boss（体型 2.2 倍，带特殊技能）
}

/** 单波定义（WaveManager 波次表用） */
export interface WaveDef {
    /** 本波生成数量 */
    count: number;
    /** 本波敌人血量 */
    hp: number;
    /** 本波敌人移速（px/s） */
    speed: number;
    /** 相邻出怪间隔（秒），0 表示同帧全部生成 */
    spawnInterval: number;
    /** 是否高血量 Boss 波（isBoss = true 时本波固定出 EnemyType.Boss） */
    isBoss: boolean;
    /** 体型缩放（兼容保留：类型体型已统一由 ENEMY_TYPE_STATS.scale 接管） */
    scale?: number;
    /** 本波敌人类型（缺省时由 WaveManager 按波次权重池混合随机；Boss 波固定 Boss） */
    enemyType?: EnemyType;
}

/** 各敌人类型的外观 / 数值配置（WaveManager 出怪与 EnemyController 行为共用） */
export interface EnemyTypeStats {
    /** 日志 / 界面标识图标 */
    icon: string;
    /** 身体染色（Sprite 染色与 Graphics 兜底绘制共用） */
    color: { readonly r: number; readonly g: number; readonly b: number };
    /** 血量倍率（相对波次基础 HP；Boss 波 ×4.5 已由 LevelManager 结算，此处保持 1 防二次叠加） */
    hpMult: number;
    /** 移速覆盖（px/s），0 表示沿用波次默认移速 */
    speedOverride: number;
    /** 体型缩放 */
    scale: number;
    /** 攻城伤害倍率（相对基础 10 点） */
    attackDamageMult: number;
    /** 出场护盾层数（仅 Shield > 0：免疫前 N 次伤害，每挡一次 -1 层） */
    shieldLayers: number;
    /** 死亡分裂数量（仅 Slime > 0：分裂出的小怪不再分裂） */
    splitCount: number;
}

/** 四大特色敌人 + 普通怪的数值表 */
export const ENEMY_TYPE_STATS: Record<EnemyType, EnemyTypeStats> = {
    // 🔴 普通红怪：各项均衡，无特殊机制
    [EnemyType.Normal]: { icon: '🔴', color: { r: 255, g: 80, b: 80 }, hpMult: 1, speedOverride: 0, scale: 1, attackDamageMult: 1, shieldLayers: 0, splitCount: 0 },
    // 🛡️ 重装铁甲怪：2 层护盾免疫前 2 次伤害，血厚体大但同样步速
    [EnemyType.Shield]: { icon: '🛡️', color: { r: 158, g: 168, b: 186 }, hpMult: 1.4, speedOverride: 0, scale: 1.15, attackDamageMult: 1, shieldLayers: 2, splitCount: 0 },
    // ⚡ 暗影突袭怪：移速 85 px/s 极速突进，血薄攻低——漏一只很快就能撞到城下
    [EnemyType.Speed]: { icon: '⚡', color: { r: 128, g: 96, b: 176 }, hpMult: 0.7, speedOverride: 85, scale: 0.85, attackDamageMult: 0.8, shieldLayers: 0, splitCount: 0 },
    // 🦠 分裂史莱姆：死亡分裂出 2 只小怪（小怪血量为母体 35%、体型 0.55、不再分裂）
    [EnemyType.Slime]: { icon: '🦠', color: { r: 108, g: 214, b: 92 }, hpMult: 1.2, speedOverride: 0, scale: 1, attackDamageMult: 0.8, shieldLayers: 0, splitCount: 2 },
    // 👹 章节大 Boss：2.2 倍体型 + 狂暴回复技能（EnemyController 实现）；血量 ×4.5 已由 LevelManager 结算
    [EnemyType.Boss]: { icon: '👹', color: { r: 255, g: 60, b: 60 }, hpMult: 1, speedOverride: 0, scale: 2.2, attackDamageMult: 2, shieldLayers: 0, splitCount: 0 },
};

/** 运行时兜底手搓怪的身体半径（WaveManager 绘制与 EnemyController 重绘共用，保证染色一致） */
export const ENEMY_BODY_RADIUS = 22;

/** 各敌人类型的解锁章节：Slime 第 2 章登场；Boss 不参与混合池（由 Boss 波固定出） */
export const ENEMY_UNLOCK_CHAPTER: Record<EnemyType, number> = {
    [EnemyType.Normal]: 1,
    [EnemyType.Shield]: 1,
    [EnemyType.Speed]: 1,
    [EnemyType.Slime]: 2,
    [EnemyType.Boss]: 99,
};

/** 波次混合出怪权重池（key = 波次 1~3）：[类型, 权重]，未解锁类型按剩余类型归一化 */
export const WAVE_TYPE_POOLS: Readonly<Record<number, ReadonlyArray<readonly [EnemyType, number]>>> = {
    1: [[EnemyType.Normal, 70], [EnemyType.Speed, 30]],
    2: [[EnemyType.Normal, 40], [EnemyType.Shield, 30], [EnemyType.Speed, 30]],
    3: [[EnemyType.Normal, 25], [EnemyType.Shield, 35], [EnemyType.Slime, 40]],
};

/**
 * 波次混合出怪：按当前波次的权重池随机挑选一种敌人类型。
 * - 第 1 章第 1 波固定普通怪（新手引导，先认识基础怪）；
 * - 未解锁类型（如第 1 章的 Slime）从池中剔除、权重按剩余类型归一化，池永不为空。
 * @param waveIndex      当前波次（1~3）
 * @param currentChapter 当前章节（1~50）
 * @param rnd            随机源（默认 Math.random；自检可注入固定序列）
 */
export function rollEnemyType(waveIndex: number, currentChapter: number, rnd: () => number = Math.random): EnemyType {
    if (currentChapter <= 1 && waveIndex <= 1) {
        return EnemyType.Normal;
    }
    const w = Math.max(1, Math.min(3, Math.floor(waveIndex)));
    const pool = WAVE_TYPE_POOLS[w] ?? WAVE_TYPE_POOLS[1];
    const available = pool.filter(([t]) => ENEMY_UNLOCK_CHAPTER[t] <= currentChapter);
    const finalPool = available.length > 0 ? available : WAVE_TYPE_POOLS[1];
    const total = finalPool.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = rnd() * total;
    for (const [type, weight] of finalPool) {
        roll -= weight;
        if (roll < 0) {
            return type;
        }
    }
    return finalPool[finalPool.length - 1][0];
}

/** 钉子数据 */
export interface PegData {
    id: string;
    pos: Vec2Like;
    /** 碰撞半径 */
    radius: number;
    /** 撞击一次获得的分数 */
    points: number;
    /** 需要撞击多少次才会消失 */
    neededHits: number;
    /** false 表示已被清除，不参与碰撞 */
    active: boolean;
}

/** 珠子（弹球）数据 */
export interface OrbData {
    id: string;
    pos: Vec2Like;
    vel: Vec2Like;
    /** 碰撞半径 */
    radius: number;
    /** false 表示已回收/失效 */
    active: boolean;
}

/** 炮塔数据 */
export interface TurretData {
    id: string;
    pos: Vec2Like;
    /** 朝向角度（弧度，0 = 朝 +x） */
    angle: number;
    /** 冷却间隔（秒） */
    cooldown: number;
    /** 剩余冷却（秒），>0 时不可开火 */
    cooldownLeft: number;
}

/** 单波配置 */
export interface WaveConfig {
    index: number;
    /** 本波激活的炮塔 id */
    turretIds: readonly string[];
    /** 持续时间（秒） */
    duration: number;
    /** 珠子出球间隔（秒） */
    spawnInterval: number;
}

/** 对局实时状态（UI / 结算用快照） */
export interface GameState {
    phase: GamePhase;
    score: number;
    lives: number;
    waveIndex: number;
}

/** 肉鸽被动遗物类型：全局常驻被动，商店购买获得，每种仅可拥有一次，效果贯穿整局直至重开 */
export enum RelicType {
    /** 黄金矿工：每次撞钉额外 +1 金币 */
    GoldMiner = 'GoldMiner',
    /** 高能烈药：全场炸药钉爆炸半径由 120px 扩大至 180px */
    HighExplosive = 'HighExplosive',
    /** 荆棘要塞：怪物头槌撞城时自动反弹 35 点真实伤害 */
    ThornCastle = 'ThornCastle',
    /** 潮汐镀金：每波开始时随机 2 颗普通钉镀金为乘倍钉，随波末钉板重建退潮 */
    TidalGild = 'TidalGild',
    /** 王者之冕：通关关卡结算时额外获得 +30 金币与 15 点要塞护盾 */
    CrownOfKings = 'CrownOfKings',
}

/** 遗物数据表项：名称 / 图标 / 效果描述 / 售价（商店展示与购买共用） */
export interface RelicData {
    name: string;
    icon: string;
    desc: string;
    price: number;
}

/** 全部遗物的数据表（单价统一 130 金币，全局常驻被动，无需装填发射） */
export const RELIC_DATABASE: Record<RelicType, RelicData> = {
    [RelicType.GoldMiner]: { name: '黄金矿工', icon: '⛏️', desc: '全场每次撞钉额外 +1 金币', price: 130 },
    [RelicType.HighExplosive]: { name: '高能烈药', icon: '💥', desc: '炸药钉爆炸半径扩大至 180px', price: 130 },
    [RelicType.ThornCastle]: { name: '荆棘要塞', icon: '🛡️', desc: '怪物撞城自动反弹 35 点真实伤害', price: 130 },
    [RelicType.TidalGild]: { name: '潮汐镀金', icon: '🌊', desc: '每波开始时随机 2 颗普通钉镀金为乘倍钉，波末退潮复原', price: 130 },
    [RelicType.CrownOfKings]: { name: '王者之冕', icon: '👑', desc: '通关结算额外 +30 金币与 15 点要塞护盾', price: 130 },
};

/** 全部遗物（商店展示顺序） */
export const ALL_RELIC_TYPES: RelicType[] = [
    RelicType.GoldMiner,
    RelicType.HighExplosive,
    RelicType.ThornCastle,
    RelicType.TidalGild,
    RelicType.CrownOfKings,
];

/** 卡牌流派（三大流派 + 中立通用） */
export enum CardArchetype {
    Lava = '🔥 爆裂熔岩流',
    Lightning = '⚡ 裂变电光流',
    Frost = '❄️ 极寒冰封流',
    Universal = '⚙️ 中立通用',
}

/** 战后三选一卡牌：定义卡牌的唯一效果与展现信息 */
export interface CardData {
    /** 卡牌唯一 id */
    id: string;
    /** 卡牌标题 */
    title: string;
    /** 所属流派 */
    archetype: CardArchetype;
    /** 稀有度标签 */
    rarity: '普通' | '稀有' | '史诗';
    /** 卡牌效果详细描述 */
    desc: string;
    /** 生效动作类型（RewardDialog 据此执行效果） */
    actionType:
        | 'AddOrb'
        | 'BuffHeavy'
        | 'IceShield'
        | 'IceVulnerable'
        | 'Heal'
        | 'MaxHp'
        | 'UpgradePeg'
        | 'GainGold'
        | 'LavaSplash'
        | 'LightningCombo';
    /** AddOrb 型卡牌要加入的弹珠类型编号（OrbType），其余动作可为空 */
    orbType?: number;
    /** 效果数值：护甲值 / 回复量 / 金币数 / 倍率等 */
    value?: number;
}

/** 标准卡库：战后三选一从中随机抽 3 张不重复（三大流派 + 中立通用共 12 张） */
export const CARD_DATABASE: CardData[] = [
    // —— 熔岩流 ——
    {
        id: 'lava_orb', title: '重力熔岩球', archetype: CardArchetype.Lava, rarity: '史诗',
        desc: '获得 1 颗【重力熔岩球】：双倍重力重压砸击，每次撞钉 +60 能量。',
        actionType: 'AddOrb', orbType: OrbType.Lava,
    },
    {
        id: 'lava_overload', title: '聚能超载', archetype: CardArchetype.Lava, rarity: '稀有',
        desc: '聚能漏斗（红）伤害倍率提升 50%，重击更猛。',
        actionType: 'BuffHeavy', value: 0.5,
    },
    {
        id: 'lava_core', title: '地心熔核', archetype: CardArchetype.Lava, rarity: '稀有',
        desc: '重力熔岩球撞钉时溅射周围相邻钉子一同引爆。',
        actionType: 'LavaSplash',
    },
    // —— 电光流 ——
    {
        id: 'lightning_split', title: '裂变雷球', archetype: CardArchetype.Lightning, rarity: '史诗',
        desc: '获得 1 颗【裂变雷球】：发射瞬间扇形 3 连发散射。',
        actionType: 'AddOrb', orbType: OrbType.Lightning,
    },
    {
        id: 'lightning_combo', title: '连击弹幕', archetype: CardArchetype.Lightning, rarity: '稀有',
        desc: '连击满 8 次后免费追发 1 颗子弹轰炸最靠前敌人。',
        actionType: 'LightningCombo',
    },
    {
        id: 'lightning_rage', title: '过载雷球', archetype: CardArchetype.Lightning, rarity: '稀有',
        desc: '获得 1 颗【裂变雷球】：下发的雷球升级为 5 连发狂暴散射。',
        actionType: 'AddOrb', orbType: OrbType.Lightning,
    },
    // —— 极寒流 ——
    {
        id: 'frost_orb', title: '霜冻冰球', archetype: CardArchetype.Frost, rarity: '史诗',
        desc: '获得 1 颗【霜冻冰球】：入槽冰封全场敌人 4 秒，命中单体冻结 3 秒。',
        actionType: 'AddOrb', orbType: OrbType.Frost,
    },
    {
        id: 'frost_shield', title: '冰霜护甲', archetype: CardArchetype.Frost, rarity: '稀有',
        desc: '急冻槽为要塞提供 30 点护盾值。',
        actionType: 'IceShield', value: 30,
    },
    {
        id: 'frost_vuln', title: '极寒易伤', archetype: CardArchetype.Frost, rarity: '稀有',
        desc: '被冰封的敌人受到伤害提升 50%。',
        actionType: 'IceVulnerable', value: 0.5,
    },
    // —— 中立通用 ——
    {
        id: 'univ_gold', title: '点石成金', archetype: CardArchetype.Universal, rarity: '稀有',
        desc: '将 3 颗普通钉升级为金色乘倍钉（能量 ×2）。',
        actionType: 'UpgradePeg', value: 3,
    },
    {
        id: 'univ_heal', title: '战地抢修', archetype: CardArchetype.Universal, rarity: '普通',
        desc: '当场修复要塞，恢复 35 点生命。',
        actionType: 'Heal', value: 35,
    },
    {
        id: 'univ_hp', title: '城墙加固', archetype: CardArchetype.Universal, rarity: '普通',
        desc: '要塞生命上限提升 25 点并补满当前生命。',
        actionType: 'MaxHp', value: 25,
    },
    {
        id: 'univ_gold_get', title: '战役赏金', archetype: CardArchetype.Universal, rarity: '普通',
        desc: '直接获得 60 金币。',
        actionType: 'GainGold', value: 60,
    },
];