import { _decorator, Component, Node, Collider2D, Contact2DType, IPhysics2DContact, RigidBody2D,
    Vec2, Vec3, Color, Graphics, Sprite, Enum, gfx, instantiate, find, MotionStreak, builtinResMgr,
    SpriteFrame, Texture2D, UITransform } from 'cc';
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
import { RuntimeTex } from '../Core/RuntimeTex';
import { FxManager } from '../Core/FxManager';

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
/** 卡球判定速度阈值（px/s）：低于该值视为静止 / 卡在钉子上 */
const STUCK_SPEED_THRESHOLD = 15;
/** 卡球计时阈值（秒）：达到后施加斜上脉冲顶开 */
const STUCK_TIMEOUT = 1.8;
/** 顶开脉冲：x 随机 ±200 幅度（400 跨距），y 固定 300 斜上（力度随顶开失败次数递增） */
const STUCK_IMPULSE_X = 400;
const STUCK_IMPULSE_Y = 300;
/** 连顶该次数仍卡死 → 判定彻底死锁，直接入槽结算销毁（比 ORB_MAX_ALIVE 保底更早腾出发射槽位） */
const STUCK_MAX_BUMPS = 3;
/** 弹珠最大存活时长（秒）：超过后强制入槽结算销毁，防无限弹跳软死锁 */
const ORB_MAX_ALIVE = 12;
/** 金币槽入槽结算奖励金币数 */
const GOLD_REWARD_AMOUNT = 20;
/** 聚能漏斗（红）：本颗珠子入槽开火伤害倍率（漏斗只做数值修饰，特效仍跟随珠子） */
const FUNNEL_FOCUS_MULT = 2;
/** 精炼漏斗（蓝）：本颗珠子入槽开火伤害倍率 */
const FUNNEL_REFINE_MULT = 1.5;
/** 连击弹幕：雷球单次飞行连击达到该次数后免费追发 1 颗子弹 */
const LIGHTNING_COMBO_THRESHOLD = 8;
const LIGHTNING_COMBO_DAMAGE = 50;

/** 拖尾流光（MotionStreak）：持续时长（秒） */
const STREAK_FADE_TIME = 0.2;
/** 拖尾流光：最小采样间距（px），越小轨迹越顺滑 */
const STREAK_MIN_SEG = 2;
/** 拖尾流光：粗细（px） */
const STREAK_STROKE = 14;

/**
 * 弹珠类型：统一定义于 Core/DataModels（0 普通 / 1 雷球 / 2 熔岩），此处仅再导出 + 注册序列化元数据。
 * 决定专属技能与能量累计。
 */
export { OrbType };

// 注册枚举元数据，供 Cocos 编辑器下拉识别
Enum(OrbType);

/**
 * 弹珠控制器：挂在【唯一】弹珠 Prefab 上，球种特性由 LauncherController 发射时调用
 * initOrbType(type) 纯代码动态赋予（无需按球种准备多个 Prefab）：
 *  - 1 裂变雷球：#00FFFF 电光球；发射瞬间由 LauncherController 一次性扇形三连发（中 ± 15°），无碰撞依赖；
 *  - 2 重力熔岩球：火红放大 1.4 倍、双倍重力/密度重压，每钉 +60 能量；
 *  - 3 霜冻冰球：#E0F7FA 淡冰蓝；入任意槽冰封全场敌人 4 秒，命中单体冻结 3 秒；
 *  - 归位兜底：start() 内按 orbType 幂等补一次 initOrbType，场景直放球也能生效。
 * 职责：
 *  - 撞中带 PegComponent 的物体 → 累计能量并实时派发 UPDATE_ENERGY；
 *  - 进入漏斗槽（物理接触或 y 坐标保底）→ 统一经 triggerFunnelAndDestroy 触发开火并销毁自身，
 *    同时把已消耗弹珠的类型编号回收进牌库弃牌堆。
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

    /** 卡球计时器（秒）：速度低于阈值时累计；达到 STUCK_TIMEOUT 后施加斜上脉冲顶开 */
    private _stuckTimer = 0;
    /** 顶开失败累计：力度随次数递增（1x→2x→3x，重质熔岩球也顶得开）；达 STUCK_MAX_BUMPS 仍卡 → 强制结算 */
    private _stuckBumps = 0;
    /** 存活计时器（秒）：场上超 ORB_MAX_ALIVE 秒强制结算销毁，防无限弹跳软死锁 */
    private _aliveTimer = 0;

    /** 监听中的碰撞体，onDestroy 时用于注销 */
    private _collider: Collider2D | null = null;

    /** 连击弹幕：本颗雷球是否已触发过免费追发（防一颗球重复多次打连击爆多弹） */
    private _comboBurstFired = false;

    /** 黄金矿工单发金币累计：本次弹珠飞行中额外产出的金币数（硬限制 ≤8，根治印钞通胀） */
    private _goldGainedThisShot = 0;

    /** 已进入销毁流程：掉落保底与碰撞回调共用同一生命周期守卫 */
    private _destroying = false;

    /**
     * ★ 渲染契约（2026-09-05 选项B根修，与 PegComponent 同构）：球体本体的可见性由子节点
     *   OrbBody 的 Graphics 矢量实心圆盘无条件保证，不挂、不依赖主节点 Sprite / 任何贴图。
     *   必须挂子节点——Graphics 与 MotionStreak 同为 renderable，同节点互斥（见 setupMotionStreak）。
     */
    private _bodyArt: Graphics | null = null;
    /** 本体当前填充色（球种主题色 / 受击闪色）；克隆持有，避免改写 Theme 共享实例 */
    private _tint: Color = Theme.orb.normal.clone();
    /** 本体绘制半径（UITransform 半宽，兜底 12） */
    private _bodyRadius = 12;

    protected onLoad(): void {
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
     * 纯代码动态赋型：按类型编号即时把本体变身（球种特性的唯一入口，幂等）。
     * - 0 普通：无样式；
     * - 1 裂变雷球：青蓝电光色 + 改名 'LightningOrb'（保留名称兜底识别）；
     * - 2 重力熔岩球：火红色 + 放大 1.4 倍 + 双倍重力，并写入双倍密度（质量重压）；
     * - 3 霜冻冰球：极淡冰蓝 #E0F7FA + 改名 'FrostOrb'（入槽冰封全场敌人）。
     * 由 LauncherController 在实例化后、入树前调用：此刻 Box2D body 尚未创建，
     * scale / gravityScale / density 均以纯字段写入，onLoad 建体时一次性采用，无需 apply()。
     */
    public initOrbType(type: number): void {
        if (this._destroying) {
            return;
        }
        // ★ 选项B根修（2026-09-05）：不再自愈主节点 Sprite——Orb.prefab 的悬空贴图引用
        //   （uuid f12a23c4…）已随 Sprite 组件一并移除；球体可见性由 redrawBody 的 Graphics
        //   实心圆盘无条件保证（零贴图、零运行时纹理上传），受击闪色链路同步迁至 _tint。
        this.orbType = type;
        // 每颗球实例化时读取当前运行时配置，保证基础伤害升级跨波次生效。
        this.accumulatedDamage = OrbBalance.configFor(type as OrbType).baseDamage;
        // 赋型时同步开启接触监听（幂等）：确保实例化后任何时机都早于首次物理 step 生效
        this.enableContactListener();
        // 本体绘制半径：取 UITransform 半宽（球体 24×24 → 12），兜底 12
        const ui = this.node.getComponent(UITransform);
        this._bodyRadius = ui && ui.contentSize.width > 0 ? ui.contentSize.width / 2 : 12;
        const rb = this.getComponent(RigidBody2D);
        if (type === OrbType.Lightning) {
            this._tint.set(Theme.orb.lightning); // 纯青蓝电光色
            this.node.name = 'LightningOrb';
        } else if (type === OrbType.Lava) {
            this._tint.set(Theme.orb.lava); // 熔岩火红色
            this.node.setScale(new Vec3(OrbBalance.lava.scale, OrbBalance.lava.scale, 1));
            if (rb) {
                rb.gravityScale = OrbBalance.lava.gravityScale;
            }
            const collider = this.getComponent(Collider2D);
            if (collider) {
                collider.density = OrbBalance.lava.density;
            }
        } else if (type === OrbType.Frost) {
            this._tint.set(Theme.orb.frost); // 极淡冰蓝 #E0F7FA
            this.node.name = 'FrostOrb';
        } else if (type === OrbType.Plasma) {
            // 🌳 等离子球：等离紫 + 略重物理（无视护盾的签名机制在 EnemyController.takeDamage 兑现）
            this._tint.set(Theme.orb.plasma);
            this.node.setScale(new Vec3(OrbBalance.plasma.scale, OrbBalance.plasma.scale, 1));
            if (rb) {
                rb.gravityScale = OrbBalance.plasma.gravityScale;
            }
            const collider = this.getComponent(Collider2D);
            if (collider) {
                collider.density = OrbBalance.plasma.density;
            }
            this.node.name = 'PlasmaOrb';
        } else if (type === OrbType.Magma) {
            // 🌳 熔核球：洋红 + 超重重压（高能量累积 + 剥坚盾 3 层，在 EnemyController 兑现）
            this._tint.set(Theme.orb.magma);
            this.node.setScale(new Vec3(OrbBalance.magma.scale, OrbBalance.magma.scale, 1));
            if (rb) {
                rb.gravityScale = OrbBalance.magma.gravityScale;
            }
            const collider = this.getComponent(Collider2D);
            if (collider) {
                collider.density = OrbBalance.magma.density;
            }
            this.node.name = 'MagmaOrb';
        } else if (type === OrbType.Leech) {
            // 🌳 吸血球：翠绿 + 普通物理（回血机制在 TurretController 命中后兑现，不改伤害分配）
            this._tint.set(Theme.orb.leech);
            this.node.name = 'LeechOrb';
        } else if (type === OrbType.Normal) {
            // ★ 美术修复：普通球本体此前沿用 Prefab 烘焙的 #2DACE7 蓝，
            //   与「银白」拖尾/瞄准线语义矛盾 → 统一为主题银白
            this._tint.set(Theme.orb.normal);
        }

        // ★ 本体实心圆盘 + 高光（可见性的唯一保证，幂等）
        this.redrawBody();

        // ★ 弹珠辉光叠层（柔光体积感，幂等）
        this.setupOrbGlow(type);

        // ★ 动态拖尾流光：按球种挂 MotionStreak（幂等），发射下落全程跟随对应属性的光迹
        this.setupMotionStreak(type);
    }

    /**
     * 取（幂等创建）OrbBody 绘制层子节点。
     * ★ 必须挂子节点：Graphics 与 MotionStreak 同为 renderable 组件，同节点互斥
     *   （见 setupMotionStreak 的历史坑）；子节点随父节点移动，位置天然跟随。
     */
    private ensureBodyArt(): Graphics | null {
        if (this._bodyArt?.isValid) {
            return this._bodyArt;
        }
        if (!this.node?.isValid) {
            return null;
        }
        let child = this.node.getChildByName('OrbBody');
        if (!child?.isValid) {
            child = new Node('OrbBody');
            child.layer = this.node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
            child.addComponent(UITransform);
            this.node.addChild(child);
        }
        this._bodyArt = child.getComponent(Graphics) ?? child.addComponent(Graphics);
        return this._bodyArt;
    }

    /**
     * 重绘球体本体（状态变化时整体重绘，零逐帧开销）：
     * ⓪ 实心圆盘：球体可见性的**唯一保证**，纯矢量填充，不依赖任何贴图 / 运行时纹理上传；
     * ① 左上高光小圆点：给实心圆盘一点球体立体感（同样零贴图）。
     */
    private redrawBody(): void {
        const g = this.ensureBodyArt();
        if (!g?.isValid) {
            return;
        }
        const r = Math.max(1, this._bodyRadius);
        g.clear();
        g.fillColor = this._tint;
        g.circle(0, 0, r);
        g.fill();
        g.fillColor = Theme.orb.normal;
        g.circle(-r * 0.3, r * 0.3, r * 0.28);
        g.fill();
    }

    /**
     * 按球种动态挂载/更新 MotionStreak 拖尾（幂等：重复赋型不会重复添加组件）。
     * ★ 必须挂子节点 OrbTrail（2026-09-05 根修）：MotionStreak 与 Sprite 同为 renderable 组件，
     *   同节点互斥——此前直接 addComponent 到本节点（已挂 Sprite），引擎每次激活都拒绝注册并
     *   刷屏「Can't add renderable component to this node because it already have one.」（每次发射
     *   一条），且拖尾注册被拒后从未真正渲染。与 TurretController.createBulletNode 的
     *   BulletTrail 同款子节点方案；子节点随父节点移动，拖尾跟随正确。
     * 纯代码零资源依赖：拖尾纹理优先 RuntimeTex 程序化截面（横向柔边 + 两端收口），
     * 生成失败时回退内置纯白贴图（ui-sprite-frame）；fastMode 保持 false → 顶点色随
     * fadeTime 渐隐，拖尾尾端自然消散。
     */
    private setupMotionStreak(type: number): void {
        if (this._destroying) {
            return;
        }
        let trail = this.node.getChildByName('OrbTrail');
        if (!trail?.isValid) {
            trail = new Node('OrbTrail');
            trail.layer = this.node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
            trail.addComponent(UITransform);
            this.node.addChild(trail);
        }
        const streak = trail.getComponent(MotionStreak) ?? trail.addComponent(MotionStreak);
        if (!streak) {
            return;
        }
        // ★ 柔边拖尾：优先用 RuntimeTex 程序化截面纹理（横向柔边 + 两端收口），
        //   生成失败时回退内置纯白贴图（ui-sprite-frame）
        const softTex = RuntimeTex.streakTexture();
        if (softTex) {
            streak.texture = softTex;
        } else {
            const splash = builtinResMgr.get<SpriteFrame>('ui-sprite-frame');
            streak.texture = (splash?.texture as Texture2D | null) ?? null;
        }
        streak.fadeTime = STREAK_FADE_TIME;
        streak.minSeg = STREAK_MIN_SEG;
        streak.stroke = STREAK_STROKE;
        streak.fastMode = false;
        streak.color = orbTrailColor(type);
    }

    /**
     * 弹珠辉光叠层（幂等）：主体之上叠一团加法混合 glow（径向体积光）+ 左上高光点，
     * 把内置白圆硬边球升级为「辉光玻璃珠」。子节点无物理组件，不影响碰撞与染色链路。
     */
    private setupOrbGlow(type: number): void {
        if (this._destroying) {
            return;
        }
        const glowSF = RuntimeTex.glow();
        if (!glowSF || !this.node?.isValid) {
            return; // 纹理不可用时静默跳过：硬边球体也可接受
        }
        const tint = orbTrailColor(type);
        // ① 主体辉光（径向柔光，熔岩球更大更烫）
        let glow = this.node.getChildByName('OrbGlow');
        if (!glow?.isValid) {
            glow = new Node('OrbGlow');
            glow.layer = this.node.layer;
            glow.addComponent(UITransform);
            const sp = glow.addComponent(Sprite);
            sp.spriteFrame = glowSF;
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            // ★ 加法混合（2026-09-05）：直接设 Sprite 混合因子（引擎原生路径，_updateBlendFunc
            //   会在材质实例上正确叠加）。自建 customMaterial 的 blendState 覆盖会整体替换
            //   BlendTarget，实测把辉光渲染成不透明方块（弹珠变方块的回归根因）。
            sp.srcBlendFactor = gfx.BlendFactor.SRC_ALPHA;
            sp.dstBlendFactor = gfx.BlendFactor.ONE;
            glow.setParent(this.node);
        }
        const glowSp = glow.getComponent(Sprite);
        if (glowSp?.isValid) {
            glowSp.color = tint;
        }
        const glowSize = type === OrbType.Lava ? 62 : type === OrbType.Magma ? 66 : type === OrbType.Plasma ? 56 : 52;
        glow.getComponent(UITransform)?.setContentSize(glowSize, glowSize);
        // ② 左上高光点（镜面反射小亮斑）
        let dot = this.node.getChildByName('OrbHighlight');
        if (!dot?.isValid) {
            dot = new Node('OrbHighlight');
            dot.layer = this.node.layer;
            dot.addComponent(UITransform);
            const dsp = dot.addComponent(Sprite);
            dsp.spriteFrame = glowSF;
            dsp.sizeMode = Sprite.SizeMode.CUSTOM;
            dsp.trim = false;
            // 加法混合：同 OrbGlow，走 Sprite 混合因子（引擎原生路径）
            dsp.srcBlendFactor = gfx.BlendFactor.SRC_ALPHA;
            dsp.dstBlendFactor = gfx.BlendFactor.ONE;
            dot.getComponent(UITransform)?.setContentSize(14, 14);
            dot.setPosition(-6, 6, 0);
            dot.setParent(this.node);
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
     * 重质球（熔岩 / 等离子）密度生效：按当前球种配置取 density 并重建 Box2D fixture。
     * Box2D 质量 = 密度 × 面积；重建夹具时刚体速度不变 → 同样速度下动量成倍提升，砸击又沉又狠。
     * 延迟一帧调用（见 start），绕开物理 step 锁，保证 density 改动 100% 生效。
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

    protected onDestroy(): void {
        if (this._collider?.isValid) {
            this._collider.off(Contact2DType.BEGIN_CONTACT, this.onBeginContact, this);
        }
        this._collider = null;
    }

    /**
     * 绝对防漏保底：无论物理引擎是否判定到碰撞，只要弹珠已掉到漏斗高度
     * 就按 x 坐标自动判定落槽、触发开火并销毁。
     */
    protected update(dt: number): void {
        if (!this.node?.isValid || this._funnelEntered) {
            return;
        }
        // 绝对防漏保底：掉到漏斗高度即按 x 自动判定落槽（原有逻辑）
        if (this.node.position.y < FUNNEL_FALLBACK_Y) {
            this.triggerFunnelAndDestroy(null); // 无槽位引用，按 x 自动判定槽位
            return;
        }
        const rb = this.getComponent(RigidBody2D);
        // 防卡死：速度极慢（静止 / 卡在钉子上）累计卡球计时，超时施加斜上脉冲顶开。
        // 递进式顶开：力度随失败次数升级（1x→2x→3x），重质熔岩球（密度 ×2）也能被顶开；
        // 连顶 STUCK_MAX_BUMPS 次仍卡 → 判定彻底死锁，直接入槽结算销毁，尽早腾出发射槽位。
        const v = rb?.linearVelocity;
        const speed = v ? v.length() : 0;
        if (speed < STUCK_SPEED_THRESHOLD) {
            this._stuckTimer += dt;
            if (this._stuckTimer >= STUCK_TIMEOUT) {
                this._stuckTimer = 0;
                if (this._stuckBumps >= STUCK_MAX_BUMPS) {
                    console.log(`[OrbController] ${this.node.name} 连顶 ${this._stuckBumps} 次仍卡死，强制入槽结算腾位`);
                    this.triggerFunnelAndDestroy(null);
                    return;
                }
                this._stuckBumps++;
                const boost = this._stuckBumps; // 第 1 次 1x（原有力度），失败后 2x、3x 递增
                if (rb) {
                    rb.applyLinearImpulseToCenter(
                        new Vec2((Math.random() - 0.5) * STUCK_IMPULSE_X * boost, STUCK_IMPULSE_Y * boost),
                        true,
                    );
                    console.log(`[OrbController] ${this.node.name} 检测到卡死，第 ${this._stuckBumps} 次斜上顶开（力度 ×${boost}）`);
                }
            }
        } else {
            this._stuckTimer = 0; // 恢复运动即清零，避免累计误判
            this._stuckBumps = 0; // 真正恢复运动后递进力度也归位
        }
        // 最大存活保底：场上超 ORB_MAX_ALIVE 秒强制入槽结算销毁，防无限弹跳软死锁
        this._aliveTimer += dt;
        if (this._aliveTimer >= ORB_MAX_ALIVE) {
            console.log(`[OrbController] ${this.node.name} 超时 ${ORB_MAX_ALIVE}s 未入槽，强制结算销毁（防无限弹跳）`);
            this.triggerFunnelAndDestroy(null);
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
            // 【全局纯代码直播池发声】：零 Inspector 配置、零组件依赖，任何碰撞路径
            // （含无 PegComponent、仅节点名匹配的钉子）都必定响一声；
            // PegComponent.onHit 不再自行发声，避免双响。
            // 连击音高爬升：传本颗弹珠已撞钉次数（onHitPeg 稍后 +1，首撞为 1），
            // playbackRate / 合成音基频随连击递增（Peglin 式越连越尖）
            AudioManager.playHit(this.hitCount + 1);
            if (peg) {
                this.onHitPeg(peg);
            }
            return;
        }

        // 进入漏斗槽（节点名包含 'Funnel'）→ 结算开火。
        // 槽位类型优先由漏斗侧 contact 路径把 FunnelSlot 自身传入（精准）；
        // 本兜底路径不再 import FunnelSlot（解除循环引用），传 null 按 x 自动判定，结果等价。
        if (otherCollider.node.name.includes('Funnel')) {
            this.triggerFunnelAndDestroy(null);
        }
    }

    /** 撞钉：能量累积 + 实时广播；熔岩球 +60 并爆燃受击钉（发声已由 onBeginContact 统一走 AudioManager 直播池，避免双响） */
    private onHitPeg(peg: PegComponent): void {
        if (this._funnelEntered || this._destroying || !peg?.node?.isValid || peg.isExhausted) {
            return;
        }
        // ★ 副球减负：雷球分裂的左右副球（isSplitChild）撞钉只累加能量数值，不触发钉子的弹性
        //   Tween 缩放动画（仅主球播放），直接消除高频碰撞下 70% 的运行时 Tween 实例创建开销。
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

        // 广播撞钉事件（含该钉累计受击数，供其它系统统计）
        EventBus.emit(GameEvents.ORB_HIT_PEG, {
            pegId: peg.node.uuid,
            orbId: this.orbId,
            points: this.accumulatedDamage,
            hitCount: peg.currentHitCount,
        });

        // ★ 撞钉火花：粒数随该钉累计受击数爬升（与音效音高爬升对齐）；
        //   副球（雷球分裂散弹）只发 1 粒，防高频爆池
        FxManager.spark(
            peg.node.worldPosition,
            orbTrailColor(this.orbType),
            this.isSplitChild ? 1 : Math.min(5, 2 + Math.floor(peg.currentHitCount / 2)),
        );

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
        if (this.orbType === OrbType.Lightning && this.hitCount >= LIGHTNING_COMBO_THRESHOLD
            && !this.isSplitChild && !this._comboBurstFired && OrbBalance.lightningComboEnabled) {
            const enemy = EnemyManager.instance?.getFrontEnemy();
            if (enemy) {
                this._comboBurstFired = true;
                // ★ 延迟一帧结算（2026-09-05 根修）：本方法跑在 onBeginContact 的物理锁定栈内，
                //   同步击杀最后一只敌人会就地触发波次结算 → recycleAllOrbs / REWARD_SELECTED →
                //   PegBoardManager.generateBoard（21 颗带 RigidBody2D 的新钉在物理 step 中途
                //   激活），刷屏「Can not active RigidBody in contract listener」且钉板在 step 内
                //   被整体替换。scheduleOnce(0) 把伤害结算挪到物理 step 之后
                //   （守卫：敌人仍存活、弹珠未进入销毁流程）。
                this.scheduleOnce(() => {
                    if (enemy.node?.isValid && !this._destroying) {
                        enemy.takeFreeDamage(LIGHTNING_COMBO_DAMAGE);
                    }
                }, 0);
            }
        }
        if (this.orbType === OrbType.Lightning) {
            this.playLightningHitFeedback();
        }
        EventBus.emit(GameEvents.UPDATE_ENERGY, this.accumulatedDamage);

    }

    /** Lightning 轻微电击反馈；未来可在此接入连锁目标选择，不改变当前伤害流程。 */
    private playLightningHitFeedback(): void {
        const origin = this._tint.clone();
        this._tint.set(Theme.orb.lightningFlash);
        this.redrawBody();
        this.scheduleOnce(() => {
            if (this.node?.isValid && !this._destroying) {
                this._tint.set(origin);
                this.redrawBody();
            }
        }, 0.05);
    }

    /** 地心熔核：一次撞钉内对范围内钉子各处理一次，调用 PegComponent 既有受击入口，绝不递归。 */
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

    /** Lava 小型爆燃反馈；未来范围伤害 / 灼烧可从此扩展，不在本阶段改变战斗结算。 */
    private playLavaHitFeedback(): void {
        const origin = this._tint.clone();
        this._tint.set(Theme.orb.lavaFlash);
        this.redrawBody();
        this.scheduleOnce(() => {
            if (this.node?.isValid && !this._destroying) {
                this._tint.set(origin);
                this.redrawBody();
            }
        }, 0.08);
    }

    /** 预留：未来范围伤害升级的唯一入口，当前不执行任何伤害。 */
    protected applyAreaDamage(_radius: number, _damage: number): void {}

    /** 预留：未来灼烧升级的唯一入口，当前不施加状态。 */
    protected applyBurn(_duration: number, _damagePerSecond: number): void {}

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

        // 伤害保底随章节衰减（难度方案A：第 1~3 章教学期 50，第 4 章起 25）。漏斗倍率在此处一次性乘入（含「重炮超载」卡倍率），
        // 敌方 takeDamage 只收最终伤害 + 珠子类型，不再感知漏斗语义。
        const type = funnel ? funnel.funnelType : this.inferFunnelType();
        const base = Math.max(this.accumulatedDamage, LevelManager.getDamageFloor());
        let damage = base;
        if (type === FunnelType.HeavyCannon) {
            damage = damage * FUNNEL_FOCUS_MULT * EnemyController.heavyOverloadMult;
        } else if (type === FunnelType.IceFreeze) {
            damage *= FUNNEL_REFINE_MULT;
        }
        // funnelType 随载荷透传：伤害倍率已乘入，但 Boss「破阵坚盾」需要漏斗语义做剥盾判定
        EventBus.emit(GameEvents.FIRE_TURRET, { damage: Math.round(damage), orbType: this.orbType, funnelType: type });

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

        // ★ 霜冻冰球固有技能：入【任意】槽都冰封全场所有敌人 4 秒（与漏斗类型解耦；珠子命中单体另有 3s 冻结）
        if (this.orbType === OrbType.Frost) {
            this.freezeAllEnemies(OrbBalance.frost.freezeDuration);
        }

        // ★ 金币槽入槽即发：直接发放金币，不再等金币弹命中敌人（避免波次空档期打空不出金币）。
        // EnemyController.takeDamage 中的旧金币分支已移除，此处是唯一发金币入口，防重复发放。
        if (type === FunnelType.GoldCoin) {
            // ★ 金币槽入槽即发：优先走单例 addGold（内部广播携带 total，UI 立即实时刷新）；
            // 单例缺失时退回事件总线直接广播。此路径是唯一发金币入口（EnemyController 已移除旧分支），防重复。
            if (GoldManager.instance) {
                GoldManager.instance.addGold(GOLD_REWARD_AMOUNT);
            } else {
                EventBus.emit(GameEvents.GAIN_GOLD, { amount: GOLD_REWARD_AMOUNT });
            }
            // ★ 金币槽入槽跳字：+20 金色暴击大字（漏斗槽位置；保底路径用弹珠自身位置兜底）
            const coinTextPos = funnel?.node.worldPosition ?? this.node.worldPosition;
            FloatingTextManager.instance?.showText(`+${GOLD_REWARD_AMOUNT} 金币`, coinTextPos, Theme.ui.gold, true);
            // ★ 金币槽专属 Ching 音效：开火音已改为跟随珠子类型，此处补发金币槽入槽声
            AudioManager.playFire(FIRE_SFX_COIN);
        }

        // 弹珠已消耗：回收其类型编号进牌库弃牌堆（纯数字回收，无 Prefab 依赖）。
        // 副球（isSplitChild，三连发散弹的左右弹）不入牌库 → 每发射一张雷球只回收一张，卡组恒为 2 普通 + 1 雷 + 1 熔岩。
        if (!this.isSplitChild) {
            DeckManager.instance?.discardOrbType(this.orbType);
        }

        // ★ 延迟销毁（2026-09-05 第二轮根修）：引擎 Node.destroy() 内部第一步就是
        //   this.active = false（同步失活！只有内存销毁才延迟到帧末）——在漏斗 onBeginContact
        //   的物理锁定栈内销毁自己，会立即触发 RigidBody2D.onDisable → b2 setActive(false)，
        //   刷屏「Can not active RigidBody in contract listener」。scheduleOnce(0) 把失活挪到
        //   物理 step 之外；这 1 帧物理存续期内 _funnelEntered/_destroying 双守卫保证其余
        //   contact 回调与 update 兜底全部空跑，不会重复结算。
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
     * ★ 战后弹窗（波次全灭 / 胜利）瞬间安全回收全场所有存活的弹珠：
     * - 遍历弹珠宿主容器下所有 OrbController 节点；先禁用碰撞体（同一帧不再触发 contact，
     *   避免帧尾物理残留继续撞钉发声），再直接销毁；
     * - 不触发 FIRE_TURRET / 不发金币 / 不回牌库（这些是「入槽消耗」才走的结算）；
     *   弹窗展开时应静默回收残球，杜绝弹珠在弹窗背后继续撞钉发声、浪费物理开销。
     * 由 WaveManager 在广播 SHOW_REWARDS 前调用。
     */
    public static recycleAllOrbs(): void {
        // 弹珠统一挂在发射器宿主的父节点（= Canvas）下：宿主查找必须与 LauncherController
        // 的 spawn 落点一致。此前误写 'Canvas/BattleLayer'（弹珠不在其下）导致本方法恒空转，
        // 弹窗背后残球继续撞钉发声；与 PegComponent 全量遍历保持同一 find('Canvas') 约定。
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