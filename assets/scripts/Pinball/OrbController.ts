import { _decorator, Component, Collider2D, Contact2DType, IPhysics2DContact, RigidBody2D,
    Vec3, Enum, find, Color } from 'cc';
import { AudioManager, FIRE_SFX_COIN } from '../Core/AudioManager';
import { FloatingTextManager } from '../Core/FloatingTextManager';
import { EventBus, GameEvents } from '../Core/EventBus';
import { DeckManager } from '../Core/DeckManager';
import { GoldManager } from '../Core/GoldManager';
import { PegComponent } from './PegComponent';
import { EnemyManager } from '../Battle/EnemyManager';
import { EnemyController } from '../Battle/EnemyController';
import { OrbType, FunnelType, RelicType } from '../Core/DataModels';
import { OrbBalance } from '../Core/OrbBalance';
import { LevelManager } from '../Core/LevelManager';
import { RelicManager } from '../Core/RelicManager';
import { orbTrailColor, Theme } from '../Core/ArtTheme';
import { FxManager } from '../Core/FxManager';
import { OrbView } from './OrbView';
import { OrbStuckGuard } from './OrbStuckGuard';

const { ccclass, property } = _decorator;

/**
 * 漏斗槽最小结构：替代直接 import FunnelSlot，避免 Pinball 目录内互相导入形成循环引用。
 * FunnelSlot 满足该结构，经漏斗侧 contact 路径（FunnelSlot.processOrb）把自身传入
 * triggerFunnelAndDestroy（精准槽位类型）；本类的名字兜底路径传 null，按 x 坐标自动判定
 * （布局常量一致，结果等价）。
 */
interface FunnelSlotLike {
    /** 槽位类型：重炮 / 急冻 / 金币 */
    funnelType: FunnelType;
    /** 槽位节点：金币入槽跳字以槽位世界坐标定位 */
    node: Node;
}

/** 漏斗槽位 x 边界：x < 左界 → 重炮；x > 右界 → 金币；中间 → 急冻 */
const FUNNEL_X_LEFT = -80;
const FUNNEL_X_RIGHT = 80;
/** 绝对防漏保底：弹珠世界 y 低于该值视为已掉入漏斗结算区 */
const FUNNEL_FALLBACK_Y = -380;
/** 🚀 反向深渊顶界：弹珠飞出屏幕最顶端（假设屏高 1280，上半屏缘 640 + 弹珠半径余量）即回收销毁 */
const CEILING_RECYCLE_Y = 680;
/** 金币槽入槽结算奖励金币数 */
const GOLD_REWARD_AMOUNT = 20;
/** 聚能漏斗（红）：本颗珠子入槽开火伤害倍率（漏斗只做数值修饰，特效仍跟随珠子） */
const FUNNEL_FOCUS_MULT = 2;
/** 精炼漏斗（蓝）：本颗珠子入槽开火伤害倍率 */
const FUNNEL_REFINE_MULT = 1.5;
/** 连击弹幕：雷球单次飞行连击达到该次数后免费追发 1 颗子弹 */
const LIGHTNING_COMBO_THRESHOLD = 8;
const LIGHTNING_COMBO_DAMAGE = 50;
/** ⚡ 天雷（流派质变）：雷球每次撞钉的概率 → 经 EventBus DAMAGE_ENEMY 对随机存活敌人落雷直伤。
 *  副球（三连发散弹）不吃此概率：一次发射 3 球，若都判定等效概率 ×3，雷球将无脑碾压其他流派。 */
const LIGHTNING_STRIKE_CHANCE = 0.15;
const LIGHTNING_STRIKE_DAMAGE = 40;
/** 碎冰（Task 008 协同）：冰封敌人被雷球击中时额外承受的固定碎冰伤害（经 takeFreeDamage 直伤）。
 *  设计：碎冰同时解除冻结（enemies have 破绽奖励、冻结易伤失去）——「引爆冰雕」的一次性高额回报，
 *  与雷球连击 8 次追发同价（50）；结算经 scheduleOnce 出物理锁，与连击追发同一管线惯例。 */
const SHATTER_BONUS_DAMAGE = 50;
/** 弹珠×敌人直接命中：伤害倍率（撞敌直伤 = accumulatedDamage × 此值，经 takeDamage 走同炮击通道） */
const ENEMY_HIT_DAMAGE_MULT = 0.5;
/** 弹珠×敌人直接命中冷却（秒）：物理贴脸抖动会连续触发 BEGIN_CONTACT，无冷却会一帧多次扣血 */
const ENEMY_HIT_COOLDOWN = 0.15;
/** 撞击镀金钉赏金（Task 008 协同）：镀金乘倍钉（潮汐镀金标记 gildedAtWave）每次被撞额外发金。
 *  ⚠️ 无每球硬上限：镀金钉全场至多 2 颗（TIDAL_GILD_COUNT）且每颗单波至多 6 次受击力竭，
 *  理论天花板 2×6×5=60 金/波，是金矿工（8/球）的 1/10——无需重复印钞防护。 */
const GILDED_PEG_GOLD_BOUNTY = 5;
/** 边缘高能钉的镀金赏金倍率（方案B①×镀金协同）：贴缘钉被镀金时赏金 ×2 */
const EDGE_GILD_BOUNTY_MULT = 2;
/** 过热钉能量倍率（方案B②）：本波目标钉第一次被撞时该次能量 ×3，受击即熄（PegComponent.onHit 置位清零） */
const OVERHEAT_ENERGY_MULT = 3;
/** 连击热流（方案B③）：同一次飞行第 N 次撞钉伤害 ×(1 + 0.1×(N-1))，封顶 ×2——
 *  过程反馈主药方：玩家第一次能看到「这球走位好 → 连击爬升 → 伤害翻倍」的因果链。
 *  乘区在入槽开火时兑现（与漏斗同层），不改 accumulatedDamage 语义。 */
const COMBO_HEAT_STEP = 0.1;
const COMBO_HEAT_MULT_CAP = 2;
/** 连击热流里程碑跳字点位（撞钉次数）：半热 / 雷球连击门 / 满热 */
const COMBO_HEAT_MILESTONES = [4, 8, Math.ceil((COMBO_HEAT_MULT_CAP - 1) / COMBO_HEAT_STEP) + 1];

/**
 * 弹珠类型：统一定义于 Core/DataModels（0 普通 / 1 雷球 / 2 熔岩），此处仅再导出 + 注册序列化元数据。
 * 决定专属技能与能量累计。
 */
export { OrbType };

// 注册枚举元数据，供 Cocos 编辑器下拉识别
Enum(OrbType);



/**
 * 弹珠控制器（Task 006 拆分后的编排器）：
 *  - 渲染契约（配色命名 / 圆盘 / 辉光 / 拖尾 / 受击闪色）→ OrbView；卡球三重保底 → OrbStuckGuard；
 *  - 本文件保留：物理碰撞分发 / 能量累计 / 弹珠×敌人直伤 / 入槽结算与销毁 / 卡组守恒 / 回收。
 * 球种特性由 LauncherController 发射时调用 initOrbType(type) 纯代码动态赋予（雷球扇形三连发 /
 * 熔岩双倍重力密度 / 冰球入槽冰封全场 4s + 命中冻结 3s）；start() 内幂等补一次赋型，场景直放球也生效。
 */
@ccclass('OrbController')
export class OrbController extends Component {
    /** 弹珠类型：决定专属技能与能量累计（Normal / Lightning / Lava） */
    @property({ type: Enum(OrbType) })
    orbType: OrbType = OrbType.Normal;

    /** 弹珠唯一 id；留空时取节点 uuid */
    @property
    orbId = '';

    /** 当前累计伤害（入槽结算时作为炮弹伤害发射）；每颗球初始自带 40 点基础伤害 */
    accumulatedDamage = OrbBalance.normal.baseDamage;

    /** 副球标记（三连发散弹的左右弹）：入槽时不回收，保障卡组守恒 */
    isSplitChild = false;

    /** 是否已结算入槽（防重复触发 / 重复销毁的核心守卫） */
    private _funnelEntered = false;

    /** 本颗弹珠本次飞行的累计撞钉次数（连击计数；发声统一走 AudioManager 全局直播池） */
    hitCount = 0;

    /** 连击热流当前热度色（方案B③）：球种拖尾色 → 炽橙的渐变驱动状态（克隆持有，防改写共享 Theme 实例） */
    private _heatTint: Color = Theme.orb.normal.clone();

    /** 监听中的碰撞体，onDestroy 时用于注销 */
    private _collider: Collider2D | null = null;

    /** 连击弹幕：本颗雷球是否已触发过免费追发（防一颗球重复多次打连击爆多弹） */
    private _comboBurstFired = false;

    /** 黄金矿工单发金币累计：本次弹珠飞行中额外产出的金币数（硬限制 ≤8，根治印钞通胀） */
    private _goldGainedThisShot = 0;

    /** 已进入销毁流程：掉落保底与碰撞回调共用同一生命周期守卫 */
    private _destroying = false;

    /** 渲染契约载体（OrbView）：本体圆盘 / 球种配色命名 / 辉光 / 拖尾 / 受击闪色 */
    private _view: OrbView | null = null;
    /** 卡球三重保底看护（OrbStuckGuard）：顶开 / 递进力度 / 强制结算 / 12s 存活保底 */
    private _stuckGuard: OrbStuckGuard | null = null;

    protected onLoad(): void {
        // 拆分组件挂载（同节点）：渲染契约 + 卡球看护。热重载防复制：已存在则复用首个。
        this._view = this.getComponent(OrbView) ?? this.addComponent(OrbView);
        this._stuckGuard = this.getComponent(OrbStuckGuard) ?? this.addComponent(OrbStuckGuard);
        this._stuckGuard.onSettle = () => this.triggerFunnelAndDestroy(null);
        // 尽早开启接触监听：Box2D 只有 RigidBody2D.enabledContactListener === true 的刚体
        // 才会派发 BEGIN_CONTACT（见 shape-2d / physics-contact），任何来源的弹珠都保证能收到碰撞。
        this.enableContactListener();
    }

    protected start(): void {
        if (!this.orbId) {
            this.orbId = this.node.uuid;
        }

        // 兜底识别：场景中直接摆放、未走 LauncherController 发射流程的球也能得到正确特性
        if (this.orbType === OrbType.Normal) {
            this.detectOrbType();
        }
        // initOrbType 幂等：发射路径已调用则无副作用；统一无条件补一次，
        // 保证任何来源的球（含场景直放的普通球）都拿到一致的主题样式（白体 / glow / 拖尾）。
        this.initOrbType(this.orbType);
        if (this.orbType === OrbType.Lava || this.orbType === OrbType.Plasma || this.orbType === OrbType.Magma) {
            // 重质球（熔岩 / 等离子 / 熔核）密度重建延迟一帧执行，绕开物理 step 锁，100% 生效
            this.scheduleOnce(() => this.applyHeavyDensity(), 0);
        }

        // 碰撞体可为任意 Collider2D 子类（圆形 / 多边形）
        const collider = this.getComponent(Collider2D);
        if (collider) {
            this._collider = collider;
            collider.on(Contact2DType.BEGIN_CONTACT, this.onBeginContact, this);
        } else {
            console.warn('[OrbController] 未找到 Collider2D，碰撞事件不会触发！', this.node.name);
        }

        // 接触监听已由 onLoad / initOrbType 尽早开启，此处幂等补一次（兜底）
        this.enableContactListener();
    }

    /** 开启刚体接触监听（幂等）：onLoad / initOrbType / start 均会调用，保证最早时机生效 */
    private enableContactListener(): void {
        const rb = this.getComponent(RigidBody2D);
        if (rb) {
            rb.enabledContactListener = true;
        } else {
            console.warn('[OrbController] 未找到 RigidBody2D，弹珠不会受重力/物理影响！', this.node.name);
        }
    }

    /**
     * 纯代码动态赋型（幂等，球种特性的唯一入口）：视觉半程（配色/命名/缩放/圆盘/辉光/拖尾）
     * → OrbView.applyTypeVisual；物理半程（伤害快照 / gravityScale / density）保留在本文件。
     * 由 LauncherController 在实例化后、入树前调用：Box2D body 尚未创建，字段写入建体时一次采用。
     */
    public initOrbType(type: number): void {
        if (this._destroying) {
            return;
        }
        this.orbType = type;
        // 每颗球实例化时读取当前运行时配置，保证基础伤害升级跨波次生效。
        this.accumulatedDamage = OrbBalance.configFor(type as OrbType).baseDamage;
        // 赋型时同步开启接触监听（幂等）：确保实例化后任何时机都早于首次物理 step 生效
        this.enableContactListener();
        // 视觉半程交给渲染契约载体（OrbView 组件在 onLoad 已挂；场景直放球走 start 兜底同样生效）
        // 方案B③：热度状态复位（新发射/换球种回到球种本色，_heatTint 由 comboHeatMult 驱动渐变）
        this._heatTint.set(orbTrailColor(this.orbType));
        this._view?.applyTypeVisual(type as OrbType);
        // 🚀 反向深渊（2026-09-08）：全系零重力——统一按配置赋值（OrbBalance 七球 gravityScale 全 0），
        //   弹珠改打「匀速直线反弹」（打砖块式）。旧球种重力差（雷 0.3 / 熔岩 2.5 / 等离子 1.3 / 熔核 2.4）
        //   随布局反转退役；重质球身份保留在 density / 伤害通道上（下方分支只管密度与弹力）。
        const rb = this.getComponent(RigidBody2D);
        if (rb) {
            // ?? 0 兜底：normal/frost/leech 配置无 gravityScale 字段，undefined 直赋刚体会让
            // Box2D 重力缩放变 NaN（速度 NaN → 弹珠隐形且永不回收）——缺省即零重力
            rb.gravityScale = (OrbBalance.configFor(type as OrbType) as { gravityScale?: number }).gravityScale ?? 0;
        }
        if (type === OrbType.Lightning) {
            // ⚡ 流派极致化：高弹力 + 低密度 → 雷电球飞速乱窜（OrbBalance 单一真源）。
            //   弹性写在 Collider 夹具上（Box2D 恢复系数取两夹具较大值，自身夹具即决定反弹强度；
            //   与 BoardDeflectorManager 的 box.restitution 同款 API 路径，RigidBody2D 无 restitution 字段）。
            const collider = this.getComponent(Collider2D);
            if (collider) {
                collider.density = OrbBalance.lightning.density;
                collider.restitution = OrbBalance.lightning.restitution;
                collider.apply(); // 已在物理 step 中（场景直放球路径）：重建夹具让密度/弹力立即生效
            }
        } else if (type === OrbType.Lava) {
            const collider = this.getComponent(Collider2D);
            if (collider) {
                collider.density = OrbBalance.lava.density;
                collider.restitution = OrbBalance.lava.restitution;
            }
        } else if (type === OrbType.Plasma) {
            // 🌳 等离子球：略重物理（无视护盾的签名机制在 EnemyController.takeDamage 兑现）
            const collider = this.getComponent(Collider2D);
            if (collider) {
                collider.density = OrbBalance.plasma.density;
            }
        } else if (type === OrbType.Magma) {
            // 🌳 熔核球：超重重压（高能量累积 + 剥坚盾 3 层，在 EnemyController 兑现）
            const collider = this.getComponent(Collider2D);
            if (collider) {
                collider.density = OrbBalance.magma.density;
            }
        }
    }

    /** 兜底识别（防漏配）：仅在类型仍为 Normal 时按节点名识别；initOrbType 已赋型则不覆盖 */
    private detectOrbType(): void {
        if (this.orbType !== OrbType.Normal) {
            return;
        }
        const name = this.node.name.toUpperCase();
        if (name.includes('LIGHTNING')) {
            this.orbType = OrbType.Lightning;
        } else if (name.includes('LAVA')) {
            this.orbType = OrbType.Lava;
        } else if (name.includes('FROST')) {
            this.orbType = OrbType.Frost;
        }
    }

    /**
     * 重质球（熔岩 / 等离子）密度生效：按当前球种配置取 density 并重建 Box2D fixture
     * （质量 = 密度 × 面积，同速下动量成倍提升）。延迟一帧（见 start）绕开物理 step 锁。
     */
    private applyHeavyDensity(): void {
        if (!this.node?.isValid) {
            return;
        }
        const collider = this.getComponent(Collider2D);
        if (!collider) {
            return;
        }
        const cfg = OrbBalance.configFor(this.orbType) as { density?: number };
        const density = cfg.density;
        if (typeof density !== 'number') {
            return;
        }
        collider.density = density;
        collider.apply(); // 重新生成 box2d 夹具，让密度（质量）立即生效
        const rb = this.getComponent(RigidBody2D);
        if (rb) {
            console.log(`[OrbController] ${this.node.name} 重质生效：质量 ≈ ${rb.getMass().toFixed(1)}（密度 ×${density}）`);
        }
    }

    /**
     * 🚀 反向深渊顶部回收（2026-09-08）：弹珠从屏底向上飞，越过屏幕最顶端（y ≥ CEILING_RECYCLE_Y）
     * 即回收销毁——与入槽结算同一条管线（弃牌堆回收 + scheduleOnce(0) 延迟销毁），保证卡组守恒，
     * 但不触发 FIRE_TURRET / 漏斗结算 / 跳字（顶部飞出 = 纯 miss，不产生任何战斗效果）。
     */
    private recycleAtCeiling(): void {
        if (this._funnelEntered || this._destroying || !this.node?.isValid) {
            return;
        }
        this._funnelEntered = true;
        this._destroying = true;
        this._stuckGuard?.suspend();
        // 回收其类型编号进牌库弃牌堆（副球不入牌库 → 卡组守恒；复用入槽同款管线）
        if (!this.isSplitChild) {
            DeckManager.instance?.discardOrbType(this.orbType);
        }
        console.log(`[OrbController] ${this.node.name} 飞出屏幕顶端（y=${Math.round(this.node.position.y)}），顶部回收`);
        // 与入槽结算同款：Node.destroy 首步失活会踩物理锁，scheduleOnce(0) 挪出物理 step
        this.scheduleOnce(() => {
            if (this.node?.isValid) {
                this.node.destroy();
            }
        }, 0);
    }

    protected onDestroy(): void {
        if (this._collider?.isValid) {
            this._collider.off(Contact2DType.BEGIN_CONTACT, this.onBeginContact, this);
        }
        this._collider = null;
    }

    /**
     * 绝对防漏保底：弹珠掉到漏斗高度即按 x 判定落槽并结算（物理漏检兜底）。
     * 卡球三重保底已委托同节点 OrbStuckGuard（onSettle 回调回本类）；
     * 入槽销毁 1 帧延迟窗口内 _funnelEntered 守卫保证本方法空跑。
     */
    protected update(_dt: number): void {
        if (!this.node?.isValid || this._funnelEntered) {
            return;
        }
        // 🚀 反向深渊顶界回收：向上飞出屏幕最顶端即销毁（turn 判空守卫在前，安全访问 position）
        if (this.node.position.y >= CEILING_RECYCLE_Y) {
            this.recycleAtCeiling();
            return;
        }
        // 绝对防漏保底（仅收下落球）：反向深渊发射座 (-560) 在保底线之下——出生上飞球
        //（vy > 0）必须放行，否则第一帧就被判「坠入漏斗」秒结算销毁（发射即消失的根因）；
        // 只有带下落速度坠回漏斗区的球才按 x 自动判槽结算（与旧重力布局「掉落进漏斗」语义一致）
        if (this.node.position.y < FUNNEL_FALLBACK_Y) {
            const vy = this.getComponent(RigidBody2D)?.linearVelocity.y ?? 0;
            if (vy < 0) {
                this.triggerFunnelAndDestroy(null); // 无槽位引用，按 x 自动判定槽位
                return;
            }
        }
    }

    /** 霜冻冰球技能：冰封全场所有存活敌人指定时长（管理器缺失时按路径兜底查找） */
    private freezeAllEnemies(duration: number): void {
        const manager = EnemyManager.instance
            || find('Canvas/BattleLayer/EnemyContainer')?.getComponent(EnemyManager);
        const targets = manager?.aliveEnemies ?? [];
        for (const e of targets) {
            e?.freeze(duration);
        }
        console.log(`[Frost] 霜冻冰球入槽：冰封全场 ${targets.length} 只敌人 ${duration} 秒`);
    }

    /** 上次命中敌人的时刻（ms，Date.now）：ENEMY_HIT_COOLDOWN 内不重复结算，防贴脸抖动连刷 */
    private _lastEnemyHitAt = -1e9;

    /**
     * ★ 弹珠×敌人直接命中（2026-09-07）：命中 = accumulatedDamage × 0.5 直伤，经 takeDamage
     * 与炮击同通道（铁甲格挡 / 坚盾剥层 / 破绽 / 冰封易伤 / 清剿令 / 猎首照常应答）；
     * 弹珠不销毁、反弹继续飞。结算 scheduleOnce(0) 出物理锁：同步击杀最后一只敌人会就地触发
     * 波次结算 → 钉板重建跑进物理 step（「Can not active RigidBody in contact listener」）。
     */
    private hitEnemy(enemy: EnemyController): void {
        if (this._funnelEntered || this._destroying || !enemy.node?.isValid || enemy.isDead) {
            return;
        }
        const now = Date.now();
        if (now - this._lastEnemyHitAt < ENEMY_HIT_COOLDOWN * 1000) {
            return;
        }
        this._lastEnemyHitAt = now;
        enemy.knockback(); // 击退反馈：敌人向右滑行一小段（推离防线）
        const dmg = this.accumulatedDamage * ENEMY_HIT_DAMAGE_MULT; // 快照：延迟结算期间撞钉增量不回溯
        this.scheduleOnce(() => {
            if (enemy.node?.isValid && !enemy.isDead && !this._destroying && !this._funnelEntered) {
                enemy.takeDamage(dmg, this.orbType);
            }
        }, 0);
    }

    private onBeginContact(
        _selfCollider: Collider2D | null,
        otherCollider: Collider2D | null,
        _contact: IPhysics2DContact | null,
    ): void {
        if (!otherCollider?.node?.isValid) {
            return;
        }

        // 撞中钉子（挂有 PegComponent 或节点名含 'Peg'）：全局直播池发声 + 钉子受击逻辑
        const peg = otherCollider.node.getComponent(PegComponent);
        if (peg || otherCollider.node.name.includes('Peg')) {
            // 全局直播池发声（零 Inspector 零组件依赖，节点名匹配的钉子也必响一声，避免双响）；
            // 连击音高爬升：传已撞钉次数（onHitPeg 稍后 +1，首撞为 1）。
            AudioManager.playHit(this.hitCount + 1);
            if (peg) {
                // ★ 方案B②：过热标记必须在 peg.onHit 之前捕获——onHit 内部受击即熄灭过热，
                //   撞后再读取恒为 false，×3 能量将永远失效
                this.onHitPeg(peg, peg.isOverheated);
            }
            return;
        }

        // 弹珠×敌人直接命中（挂有 EnemyController）：直伤 + 击退，弹珠反弹继续飞不销毁（见 hitEnemy）
        const enemy = otherCollider.node.getComponent(EnemyController);
        if (enemy) {
            this.hitEnemy(enemy);
            return;
        }

        // 进入漏斗槽（节点名包含 'Funnel'）→ 结算开火。
        // 槽位类型优先由漏斗侧 contact 路径把 FunnelSlot 自身传入（精准）；
        // 本兜底路径不再 import FunnelSlot（解除循环引用），传 null 按 x 自动判定，结果等价。
        if (otherCollider.node.name.includes('Funnel')) {
            this.triggerFunnelAndDestroy(null);
        }
    }

    /** 连击热流当前乘区（方案B③）：×(1 + 0.1×(N-1)) 封顶 ×2；N 为本次飞行已撞钉次数（0 次时恒 ×1） */
    private comboHeatMult(): number {
        return Math.min(
            COMBO_HEAT_MULT_CAP,
            1 + COMBO_HEAT_STEP * Math.max(0, this.hitCount - 1),
        );
    }

    /**
     * 撞钉：能量累积 + 实时广播；熔岩球 +60 并爆燃受击钉（发声已由 onBeginContact 统一走 AudioManager 直播池，避免双响）。
     * @param overheated 方案B②：撞钉前捕获的过热标记（调用方必须在 peg.onHit 之前读取，
     *   onHit 内部受击即熄灭，撞后再读恒为 false）——本次撞钉能量 ×OVERHEAT_ENERGY_MULT。
     */
    private onHitPeg(peg: PegComponent, overheated: boolean = false): void {
        if (this._funnelEntered || this._destroying || !peg?.node?.isValid || peg.isExhausted) {
            return;
        }
        // ★ 副球减负：副球（isSplitChild）撞钉只累加能量，不触发钉子弹性 Tween（消除高频碰撞下
        //   70% 的运行时 Tween 实例创建开销）。
        peg.onHit(this.isSplitChild);

        // 累计撞钉次数（连击计数；发声由 onBeginContact 统一走 AudioManager 直播池）
        this.hitCount += 1;

        // 黄金矿工被动：每次撞钉额外 +1 金币（唯一入口，复用 GoldManager 单例防重复累加）。
        // ★ 硬限制单次弹珠飞行最多额外产出 8 金币：杜绝海量撞钉疯狂印钞的严重通胀！
        if (RelicManager.hasRelic(RelicType.GoldMiner) && this._goldGainedThisShot < 8) {
            this._goldGainedThisShot += 1;
            if (GoldManager.instance) {
                GoldManager.instance.addGold(1);
            } else {
                EventBus.emit(GameEvents.GAIN_GOLD, { amount: 1 });
            }
        }

        // 🌟 镀金钉赏金（Task 008 协同）：撞到带潮汐镀金标记的乘倍钉额外发金；
        //   ★ 方案B①：边缘高能钉被镀金时赏金 ×2（EDGE_GILD_BOUNTY_MULT）——高能钉本身已是瞄点，
        //   镀金重叠时构成「冒掉槽风险换双倍金」的显式赌注。走金矿工同一 GAIN_GOLD 管线；
        //   每球无去重（钉子 6 次受击力竭 + 赏金一次性即天然封顶）。
        const bounty = GILDED_PEG_GOLD_BOUNTY * (peg.edgeBonus ? EDGE_GILD_BOUNTY_MULT : 1);
        if (peg.gildedAtWave > 0) {
            if (GoldManager.instance) {
                GoldManager.instance.addGold(bounty);
            } else {
                EventBus.emit(GameEvents.GAIN_GOLD, { amount: bounty });
            }
            FloatingTextManager.instance?.showText(
                `+${bounty} 金`, peg.node.worldPosition, Theme.ui.gold,
            );
            // 赏金一次性：标记失效防同一颗钉重复刷金（钉板重建自然恢复）
            peg.gildedAtWave = 0;
        }

        // ⚡ 天雷（流派质变）：雷球主球撞钉 15% 概率经事件总线对随机存活敌人落雷直伤——
        //   跨层联动走 DAMAGE_ENEMY（EnemyManager 消费），本类不 import 敌人系统（.clinerules 解耦红线）。
        //   发射路径在物理回调栈内：EnemyManager 落雷侧 takeDamage 自带 scheduleOnce 出锁（与 hitEnemy 同惯例）。
        if (this.orbType === OrbType.Lightning && !this.isSplitChild
            && Math.random() < LIGHTNING_STRIKE_CHANCE) {
            EventBus.emit(GameEvents.DAMAGE_ENEMY, LIGHTNING_STRIKE_DAMAGE);
        }

        // 广播撞钉事件：hitCount = 本颗弹珠本次飞行的连击数（音效多巴胺：AudioManager 等订阅方
        // 据此做音高/爆点反馈；原「该钉累计受击数」语义废弃——全库无消费者，安全切换）
        EventBus.emit(GameEvents.ORB_HIT_PEG, {
            pegId: peg.node.uuid,
            orbId: this.orbId,
            points: this.accumulatedDamage,
            hitCount: this.hitCount,
        });

        // ★ 撞钉火花：粒数随该钉累计受击数爬升（与音效音高爬升对齐）；
        //   副球（雷球分裂散弹）只发 1 粒，防高频爆池
        FxManager.spark(
            peg.node.worldPosition,
            orbTrailColor(this.orbType),
            this.isSplitChild ? 1 : Math.min(5, 2 + Math.floor(peg.currentHitCount / 2)),
        );

        // 🔥 方案B②：过热钉命中反馈（×3 能量已随本次 gain 结算）——金环即目标，撞中即熄。
        //   唯一插入点：熔岩 / 普通 / 雷球三分支共享此反馈（熔岩分支提前 return 也能看到）。
        if (overheated) {
            FloatingTextManager.instance?.showText(
                `过热 ×${OVERHEAT_ENERGY_MULT}`,
                new Vec3(peg.node.worldPosition.x, peg.node.worldPosition.y + 32, peg.node.worldPosition.z),
                Theme.peg.multiplier, true,
            );
        }

        // ★ 乘倍钉结算修复：伤害/能量必须乘以 peg.multiplier（乘倍钉 ×2），否则乘倍钉完全不生效
        const mult = peg.multiplier;

        if (this.orbType === OrbType.Lava) {
            // 重力熔岩球：当前默认每颗钉 +60；范围伤害 / 灼烧接口暂不执行。
            const lavaGain = OrbBalance.lava.pegEnergyGain * mult;
            this.accumulatedDamage += lavaGain;
            peg.lavaHit();
            if (OrbBalance.lavaAreaSplashEnabled) {
                this.applyLavaSplash(peg);
            }
            this.playLavaHitFeedback();
            // ★ 撞钉跳字：熔岩球金红暴击字样，在钉子位置跳出本次 +能量
            FloatingTextManager.instance?.showText(
                `+${lavaGain}`, peg.node.worldPosition, Theme.orb.lavaText, true,
            );
            EventBus.emit(GameEvents.UPDATE_ENERGY, this.accumulatedDamage);
            return;
        }

            // 普通弹珠 / 雷球：每颗钉 +15（乘倍钉 ×2）。普通球 5 连击后仅获得小额稳定奖励。
        const config = OrbBalance.configFor(this.orbType);
        const gain = config.pegEnergyGain * mult;
        this.accumulatedDamage += gain;
        // ★ 撞钉跳字：普通 / 雷球浅绿字样，在钉子位置跳出本次 +能量
        FloatingTextManager.instance?.showText(
            `+${gain}`, peg.node.worldPosition, Theme.orb.textOk,
        );
        if (this.orbType === OrbType.Normal
            && this.hitCount % OrbBalance.normalComboThreshold === 0) {
            this.accumulatedDamage += OrbBalance.normalComboDamageBonus;
        }

        // 🔥 方案B③ 连击热流反馈（三分支共享，熔岩提前 return 也能看到）：
        //   ① 本体热度渐变：球种本色 → 炽橙（Theme.fx.ember），随 comboHeatMult 归一化推进；
        //     闪色（flashTint）还原目标即当前热度色，新球发射经 initOrbType 复位（applyTypeVisual 前重置）。
        //   ② 里程碑大字：半热 / 雷球连击门 / 满热各弹一次「连击 ×N」（结算大字同款暴击样式）。
        const t = (this.comboHeatMult() - 1) / (COMBO_HEAT_MULT_CAP - 1);
        const from = orbTrailColor(this.orbType);
        // 手动 lerp（cc Color.lerp 为静态四参 out 形态，代码库无既有用法——不赌 API 签名）
        this._heatTint.set(
            Math.round(from.r + (Theme.fx.ember.r - from.r) * t),
            Math.round(from.g + (Theme.fx.ember.g - from.g) * t),
            Math.round(from.b + (Theme.fx.ember.b - from.b) * t),
            from.a,
        );
        this._view?.setHeatTint(this._heatTint);
        if (COMBO_HEAT_MILESTONES.includes(this.hitCount)) {
            const pos = peg.node.worldPosition;
            FloatingTextManager.instance?.showText(
                `连击 ×${this.hitCount}`,
                new Vec3(pos.x, pos.y + 58, pos.z), Theme.fx.ember, true,
            );
        }
        if (this.orbType === OrbType.Lightning && this.hitCount >= LIGHTNING_COMBO_THRESHOLD
            && !this.isSplitChild && !this._comboBurstFired && OrbBalance.lightningComboEnabled) {
            const enemy = EnemyManager.instance?.getFrontEnemy();
            if (enemy) {
                this._comboBurstFired = true;
                // ★ scheduleOnce(0) 出物理锁（2026-09-05 根修）：同步击杀最后一只敌人会就地触发
                //   波次结算 → 钉板在物理 step 内重建并刷「Can not active RigidBody」警告。
                this.scheduleOnce(() => {
                    if (enemy.node?.isValid && !this._destroying) {
                        enemy.takeFreeDamage(LIGHTNING_COMBO_DAMAGE);
                    }
                }, 0);
            }
        }
// ⚗️ 碎冰（Task 008 协同）：雷球撞钉时若最靠前敌人处于冰封状态 = 碎冰直伤 + 解除冻结。
        //   「引爆冰雕」决策：放弃冻结易伤窗口换一次性 50 固定伤（与连击追发同价），
        //   ★ scheduleOnce(0) 出物理锁：同步击杀最后一只敌人会就地触发波次结算 →
        //     钉板在物理 step 内重建（与连击追发 2026-09-05 根修同一教训）。
        //   跳字挂敌人头顶（pos 兜底钉位），避免与镀金/能量跳字同点叠字。
        if (this.orbType === OrbType.Lightning) {
            const frozenTarget = EnemyManager.instance?.getFrontEnemy();
            if (frozenTarget?.isFrozen) {
                this.scheduleOnce(() => {
                    if (frozenTarget.node?.isValid && !this._destroying) {
                        frozenTarget.takeFreeDamage(SHATTER_BONUS_DAMAGE * EnemyController.shatterBonusMult);
                        frozenTarget.breakFreeze();
                        const fxPos = frozenTarget.node.worldPosition ?? peg.node.worldPosition;
                        FloatingTextManager.instance?.showText(
                            `碎冰! -${SHATTER_BONUS_DAMAGE}`, fxPos, Theme.white, true,
                        );
                    }
                }, 0);
            }
        }
        if (this.orbType === OrbType.Lightning) {
            this.playLightningHitFeedback();
        }
        EventBus.emit(GameEvents.UPDATE_ENERGY, this.accumulatedDamage);

    }

    /** Lightning 轻微电击反馈（受击闪色委托 OrbView；未来可在此接入连锁目标选择） */
    private playLightningHitFeedback(): void {
        this._view?.flashTint(Theme.orb.lightningFlash, 0.05);
    }

    /**
     * 地心熔核：一次撞钉内对范围内钉子各处理一次，调用 PegComponent 既有受击入口，绝不递归。
     */
    private applyLavaSplash(origin: PegComponent): void {
        const pegs = this.node.parent?.getComponentsInChildren(PegComponent) ?? [];
        const hit = new Set<string>([origin.node.uuid]);
        const visited = new Set<PegComponent>([origin]);
        const originPos = origin.node.worldPosition;
        for (const other of pegs) {
            if (!other?.node?.isValid || other.isExhausted || hit.has(other.node.uuid)) {
                continue;
            }
            if (Vec3.distance(originPos, other.node.worldPosition) <= OrbBalance.lava.splashRadius) {
                hit.add(other.node.uuid);
                other.onHit(true, visited);
                this.accumulatedDamage += OrbBalance.lava.pegEnergyGain
                    * OrbBalance.lava.splashEnergyMultiplier;
            }
        }
    }

    /** Lava 小型爆燃反馈（受击闪色委托 OrbView；未来范围伤害 / 灼烧可从此扩展） */
    private playLavaHitFeedback(): void {
        this._view?.flashTint(Theme.orb.lavaFlash, 0.08);
    }

    /**
     * 结算入槽：广播开火事件并销毁弹珠。
     * 有槽位引用（FunnelSlotLike）时以其槽位类型为准；否则（保底路径）按 x 自动判定。
     * ★ 漏斗只做数值修饰（聚能红 ×2 / 精炼蓝 ×1.5 / 金币不修饰），珠子类型 orbType 原样透传：
     *   炮弹外观与受击特效均由 orbType 决定，珠子自身能力绝不因入槽漏斗而改变。
     */
    public triggerFunnelAndDestroy(funnel: FunnelSlotLike | null): void {
        if (this._funnelEntered || this._destroying || !this.node?.isValid) {
            return;
        }
        this._funnelEntered = true;
        this._destroying = true;
        // 停止卡球看护：销毁 1 帧延迟窗口内不再顶开 / 强制结算（OrbStuckGuard.suspend）
        this._stuckGuard?.suspend();

        // 伤害保底随章节衰减（难度方案A：第 1~3 章教学期 50，第 4 章起 25）。漏斗倍率在此处一次性乘入（含「重炮超载」卡倍率），
        // 敌方 takeDamage 只收最终伤害 + 珠子类型，不再感知漏斗语义。
        const type = funnel ? funnel.funnelType : this.inferFunnelType();
        const base = Math.max(this.accumulatedDamage, LevelManager.getDamageFloor());
        // 方案B③ 连击热流：与漏斗同层的乘区（在漏斗分支前乘入，funnel-orb 自检锁定的分支形状不动），
        // 伤害管道 accumulatedDamage 语义保持不变（撞钉跳字仍是原始每钉增量）
        let damage = base * this.comboHeatMult();
        if (type === FunnelType.HeavyCannon) {
            damage = damage * FUNNEL_FOCUS_MULT * EnemyController.heavyOverloadMult;
        } else if (type === FunnelType.IceFreeze) {
            damage *= FUNNEL_REFINE_MULT;
        }
        // funnelType 随载荷透传：伤害倍率已乘入，但 Boss「破阵坚盾」需要漏斗语义做剥盾判定。
        // 🌋 核弹（流派质变）：熔岩球入槽附加 isLavaBlast 标记 → TurretController 拦截后
        //   不发普通子弹，改为一次大范围爆炸 AoE（伤害取本次聚能伤害）。
        EventBus.emit(GameEvents.FIRE_TURRET, {
            damage: Math.round(damage),
            orbType: this.orbType,
            funnelType: type,
            isLavaBlast: this.orbType === OrbType.Lava,
        });

        // ★ 结算大字（Balatro 式明牌）：伤害槽入槽即弹出「⚡基础 ×倍率」+「总伤 💥」两段跳字，
        //   玩家不用心算也能看懂漏斗的价值；金币槽保留专属「+20 💰」跳字（下方分支），不重复弹。
        if (type !== FunnelType.GoldCoin) {
            const pos = funnel?.node.worldPosition ?? this.node.worldPosition;
            const mult = type === FunnelType.HeavyCannon
                ? FUNNEL_FOCUS_MULT * EnemyController.heavyOverloadMult
                : FUNNEL_REFINE_MULT;
            const multStr = (Math.round(mult * 100) / 100).toString();
            // 第一段：基础伤害 × 漏斗倍率（普通小字，白色）
            FloatingTextManager.instance?.showText(
                `${Math.round(base)} ×${multStr}`, pos, Theme.white, false,
            );
            // 第二段：最终总伤（暴击大字，颜色跟随球种拖尾色）
            FloatingTextManager.instance?.showText(
                `${Math.round(damage)} 💥`,
                new Vec3(pos.x, pos.y + 46, pos.z),
                orbTrailColor(this.orbType),
                true,
            );
        }

        // ★ 霜冻冰球固有技能：入【任意】槽都冰封全场所有敌人（与漏斗类型解耦；珠子命中单体另有 3s 冻结）。
        //   ⚗️ 寒霜导热（Task 008 协同）：冰球入冰槽（IceFreeze）冻结时长 +2s——「同系归位」奖励，
        //   槽位侧 if 分支一次性加成（7-1 组合包自检锁定）。
        if (this.orbType === OrbType.Frost) {
            const duration = OrbBalance.frost.freezeDuration
                + (type === FunnelType.IceFreeze ? OrbBalance.frost.funnelFreezeBonus : 0);
            this.freezeAllEnemies(duration);
        }

        // ★ 金币槽入槽即发：直接发放金币，不再等金币弹命中敌人（避免波次空档期打空不出金币）。
        // EnemyController.takeDamage 中的旧金币分支已移除，此处是唯一发金币入口，防重复发放。
        if (type === FunnelType.GoldCoin) {
            // ★ 金币槽入槽即发：优先走单例 addGold（内部广播携带 total，UI 立即实时刷新）；
            // 单例缺失时退回事件总线直接广播。此路径是唯一发金币入口（EnemyController 已移除旧分支），防重复。
            // ⚑ 熔炉契约（方案C）：产出 ×contractGoldMult（软启动 0.75 = 文案 -50% 的半额；无契约 ×1），
            //   取整发放（GOLD_REWARD_AMOUNT=20 → 20×0.75=15 整，永不出现零碎金币）。
            const payout = Math.round(GOLD_REWARD_AMOUNT * OrbBalance.contractGoldMult);
            if (GoldManager.instance) {
                GoldManager.instance.addGold(payout);
            } else {
                EventBus.emit(GameEvents.GAIN_GOLD, { amount: payout });
            }
            // ★ 金币槽入槽跳字：+N 金色暴击大字（漏斗槽位置；保底路径用弹珠自身位置兜底）
            const coinTextPos = funnel?.node.worldPosition ?? this.node.worldPosition;
            FloatingTextManager.instance?.showText(`+${payout} 金币`, coinTextPos, Theme.ui.gold, true);
            // ★ 金币槽专属 Ching 音效：开火音已改为跟随珠子类型，此处补发金币槽入槽声
            AudioManager.playFire(FIRE_SFX_COIN);
        }

        // 弹珠已消耗：回收其类型编号进牌库弃牌堆（纯数字回收，无 Prefab 依赖）。
        // 副球（isSplitChild，三连发散弹的左右弹）不入牌库 → 每发射一张雷球只回收一张，卡组恒为 2 普通 + 1 雷 + 1 熔岩。
        if (!this.isSplitChild) {
            DeckManager.instance?.discardOrbType(this.orbType);
        }

        // ★ 延迟销毁（2026-09-05 根修）：Node.destroy() 第一步即 this.active=false（同步失活），
        //   物理锁定栈内销毁必刷「Can not active RigidBody in contract listener」；scheduleOnce(0)
        //   挪到物理 step 之外，存续窗口内 _funnelEntered/_destroying 双守卫保证回调全部空跑。
        this.scheduleOnce(() => {
            if (this.node?.isValid) {
                this.node.destroy();
            }
        }, 0);
    }

    /** 按 x 坐标判定落槽：x < -80 聚能（红），x > 80 金币，中间精炼（蓝） */
    private inferFunnelType(): FunnelType {
        const x = this.node.position.x;
        if (x < FUNNEL_X_LEFT) {
            return FunnelType.HeavyCannon;
        }
        if (x > FUNNEL_X_RIGHT) {
            return FunnelType.GoldCoin;
        }
        return FunnelType.IceFreeze;
    }









    /**
     * ★ 战后弹窗瞬间安全回收全场存活弹珠（WaveManager 广播 SHOW_REWARDS 前调用）：
     * 先禁用碰撞体再销毁；不触发 FIRE_TURRET / 不发金币 / 不回牌库（那是「入槽消耗」结算）。
     */
    public static recycleAllOrbs(): void {
        // 弹珠统一挂在发射器宿主的父节点（= Canvas）下：宿主查找必须与 LauncherController
        // 的 spawn 落点一致（此前误写 'Canvas/BattleLayer' 导致恒空转；与 PegComponent 同约定）。
        const host = find('Canvas');
        const list = host?.getComponentsInChildren(OrbController) ?? [];
        for (const orb of list) {
            if (!orb?.node?.isValid) {
                continue;
            }
            if (orb._collider?.isValid) {
                orb._collider.enabled = false; // 立即断交，阻止本帧剩余 contact 回调
            }
            orb.node.destroy();
        }
        if (list.length > 0) {
            console.log(`[OrbController] 弹窗开启：安全回收场上 ${list.length} 颗残余弹珠`);
        }
    }
}
