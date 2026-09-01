import {
    _decorator, Component, Node, Color, Collider2D, Contact2DType, IPhysics2DContact,
    RigidBody2D, PolygonCollider2D, UIOpacity, Graphics, UITransform,
    Vec2, Vec3, tween, Tween,
} from 'cc';
import { AudioManager } from '../Core/AudioManager';
import { OrbController } from './OrbController';
import { EASE_PUNCH, Theme } from '../Core/ArtTheme';

const { ccclass } = _decorator;

// ---------- 侧翼弹力蹦床行为常量 ----------
// （几何常量 WING_X / WING_Y / WING_RESTITUTION 属于机关装配，留在 BoardDeflectorManager）
/** 蹦床定向补冲：撞击后朝场地中央偏上的额外速度增量（px/s），保证「高速反弹向场地中央」的街机手感 */
const WING_BOOST_DELTA_V = 620;
/** 同一颗弹珠的补冲防抖（ms）：贴面持续接触不重复加速，防无限叠速 */
const WING_BOOST_COOLDOWN_MS = 220;
/** 蹦床受击闪光色（亮白青，统一取自 ArtTheme） */
const FLASH_COLOR = Theme.wing.flash;

/**
 * 侧翼弹力蹦床受击组件（挂在左右蹦床节点上，由 BoardDeflectorManager.buildWingTrampoline 装配）：
 *  - 撞击瞬间播放受击闪光（描边高亮淡出 + punch 缩放）与清脆金属撞击声 AudioManager.playHit()；
 *  - 额外给弹珠一个「朝场地中央偏上」的定向补冲（Δv 恒定，重质熔岩球同样获得同速弹射），
 *    配合 0.9 高弹性，把球高速弹回钉群制造滞空与连击爽快感。
 * 依赖：宿主节点已挂 RigidBody2D（Static）与 PolygonCollider2D。
 * （单文件单组件规范：从 BoardDeflectorManager.ts 拆分而来；描边走线为免模块循环在此内联）
 */
@ccclass('WingTrampoline')
export class WingTrampoline extends Component {
    /** 监听中的碰撞体，onDestroy 时注销 */
    private _collider: Collider2D | null = null;
    /** 受击闪光层（高亮描边子节点）的透明度，命中瞬间拉满再淡出 */
    private _glow: UIOpacity | null = null;
    /** 初始缩放（punch 弹性动画基准） */
    private _baseScale: Vec3 = new Vec3(1, 1, 1);
    /** 各弹珠上次被补冲的时间戳（ms），实现单球防抖 */
    private _lastBoostAt: Map<string, number> = new Map();

    protected start(): void {
        // 静态刚体也必须开启接触监听，BEGIN_CONTACT 才会派发到本组件（同 OrbController 的结论）
        const rb = this.getComponent(RigidBody2D);
        if (rb) {
            rb.enabledContactListener = true;
        }
        this._baseScale = this.node.scale.clone();
        this.buildGlowLayer();
        this._collider = this.getComponent(Collider2D);
        if (this._collider) {
            this._collider.on(Contact2DType.BEGIN_CONTACT, this.onBeginContact, this);
        }
    }

    protected onDestroy(): void {
        if (this._collider?.isValid) {
            this._collider.off(Contact2DType.BEGIN_CONTACT, this.onBeginContact, this);
        }
        this._collider = null;
        Tween.stopAllByTarget(this.node);
    }

    private onBeginContact(
        _selfCollider: Collider2D | null,
        otherCollider: Collider2D | null,
        _contact: IPhysics2DContact | null,
    ): void {
        if (!otherCollider?.node?.isValid) {
            return;
        }
        // 只对弹珠（OrbController）生效；钉子 / 其它机关忽略
        const orb = otherCollider.node.getComponent(OrbController);
        if (!orb) {
            return;
        }
        AudioManager.playHit();
        this.playFlash();
        this.boostTowardCenter(orb.node);
    }

    /** 构建受击闪光层：按蹦床多边形顶点画一圈高亮描边，平时全透明 */
    private buildGlowLayer(): void {
        const poly = this.getComponent(PolygonCollider2D);
        if (!poly || poly.points.length < 3) {
            return;
        }
        const glowNode = new Node('WingGlow');
        glowNode.layer = this.node.layer;
        glowNode.addComponent(UITransform);
        const g = glowNode.addComponent(Graphics);
        g.lineWidth = 5;
        g.strokeColor = FLASH_COLOR;
        // 按顶点序列走线（闭合多边形路径）：同 BoardDeflectorManager.tracePoly，
        // 为免与该文件互相导入形成循环引用，在此内联同款实现。
        const pts = poly.points;
        g.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            g.lineTo(pts[i].x, pts[i].y);
        }
        g.close();
        g.stroke();
        glowNode.setParent(this.node);
        const op = glowNode.addComponent(UIOpacity);
        op.opacity = 0;
        this._glow = op;
    }

    /** 受击闪光：描边高亮瞬间拉满后淡出 + 节点 punch 缩放（轻微、干脆） */
    private playFlash(): void {
        const glow = this._glow;
        if (glow?.isValid) {
            Tween.stopAllByTarget(glow);
            glow.opacity = 235;
            tween(glow).to(0.18, { opacity: 0 }).start();
        }
        Tween.stopAllByTarget(this.node);
        const base = this._baseScale;
        tween(this.node)
            .to(0.05, { scale: new Vec3(base.x * 1.12, base.y * 0.86, base.z) }, { easing: EASE_PUNCH })
            .to(0.14, { scale: new Vec3(base.x, base.y, base.z) })
            .start();
    }

    /**
     * 定向补冲：把弹珠高速弹向场地中央（带向上分量制造滞空）。
     * 冲量 = Δv × 质量 → 速度增量恒定，熔岩重质球与普通球获得同样的弹射手感。
     */
    private boostTowardCenter(orbNode: Node): void {
        const key = orbNode.uuid;
        const now = Date.now();
        const last = this._lastBoostAt.get(key) ?? 0;
        if (now - last < WING_BOOST_COOLDOWN_MS) {
            return; // 贴面连续接触不重复加速
        }
        this._lastBoostAt.set(key, now);
        if (this._lastBoostAt.size > 64) {
            this._lastBoostAt.clear(); // ponytail: 粗暴容量兜底；单局场上弹珠量级远达不到，量大时改 LRU
        }
        const rb = orbNode.getComponent(RigidBody2D);
        if (!rb) {
            return;
        }
        // 球在蹦床哪一侧就往反方向推：左蹦床(+1)、右蹦床(-1)，再叠加 0.6 向上分量
        const towardCenter = this.node.worldPosition.x <= orbNode.worldPosition.x ? 1 : -1;
        const dir = new Vec2(towardCenter * 0.8, 0.6).normalize();
        const impulse = WING_BOOST_DELTA_V * (rb.getMass() || 1);
        rb.applyLinearImpulseToCenter(new Vec2(dir.x * impulse, dir.y * impulse), true);
    }
}
