import {
    _decorator, Component, Node, Prefab, Graphics, Vec2, Vec3, Color,
    input, Input, EventTouch, RigidBody2D, instantiate, director,
    PhysicsSystem2D, CircleCollider2D,
} from 'cc';
import { DeckManager } from '../Core/DeckManager';
import { EventBus, GameEvents } from '../Core/EventBus';
import { anyModalOpen } from '../Core/ModalGate';
import { OrbController } from '../Pinball/OrbController';
import { PegComponent } from '../Pinball/PegComponent';
import { OrbBalance } from '../Core/OrbBalance';
import { simulateAimPreview, PreviewPeg } from '../Core/AimPreview';
import { OrbType } from '../Core/DataModels';
import { cloneColor, orbAimColor } from '../Core/ArtTheme';

const { ccclass, property } = _decorator;

/** 手指距发射点小于该值视为无效瞄准（不发射） */
const MIN_AIM_LENGTH = 15;
/** 发射方向允许的角度范围（度）：-165°（左下方）~ -15°（右下方） */
const MIN_LAUNCH_ANGLE = -165 * Math.PI / 180;
const MAX_LAUNCH_ANGLE = -15 * Math.PI / 180;

/** 弹珠半径（与钉子半径求和判定预测线相交；与 orbPrefab 碰撞体一致） */
const ORB_RADIUS = 16;
/** 预测线积分步长（半帧）：弹珠实际初速 ~2400px/s，粗步长会把钉子跳过去 */
const PREVIEW_DT = 1 / 120;
/** 预测线点列间距（px）：沿弧长均匀撒点 */
const PREVIEW_DOT_SPACING = 26;
/** 预测点半径 */
const PREVIEW_DOT_R = 3.5;
/** 场地左右半宽近似值（物理墙贴设计分辨率 720 边缘，留弹珠半径余量） */
const FIELD_HALF_W = 352;
/** 底部截断线：漏斗接收区上沿（y 低于此即进入漏斗区，预测到此为止） */
const FUNNEL_Y = -340;

/**
 * 发射器：触摸拖拽瞄准 + 松手发射弹珠。
 */
@ccclass('LauncherController')
export class LauncherController extends Component {
    @property({ type: Prefab })
    orbPrefab: Prefab | null = null;

    @property({ type: Node })
    launcherNode: Node | null = null;

    @property({ type: Node })
    trajectoryGraphics: Node | null = null;

    @property
    launchSpeed = 1200;

    /** 发射冷却（秒） */
    @property
    launchCooldown = 0.25;

    /**
     * 预测线初速倍率。fireOrb 实际是 linearVelocity 赋值 + 同值 impulse 的双重叠加
     * （引擎源码 applyLinearImpulseToCenter 零换算直传 Box2D，Δv=v）→ 理论初速 = 2×launchSpeed。
     * ponytail: 实机校准口——若预测线与真实弹道系统性偏短/偏长，微调此值（而非改发射逻辑）。
     */
    @property
    previewSpeedScale = 2;

    /** 预测线模拟总时长（秒）：决定预测线长度 */
    @property
    previewTime = 0.6;

    private _aimDir: Vec2 | null = null;
    private _inputRegistered = false;
    private _modalOpen = false;
    private _activeTouchId: number | null = null;
    private _lastLaunchTime = 0;
    /** 钉子快照（TOUCH_START 时收集一次；拖拽期间钉子不会变化） */
    private _pegSnapshot: PreviewPeg[] | null = null;

    private readonly _tmpUIPos = new Vec2();
    private readonly _tmpDir = new Vec2();
    private readonly _tmpWorld = new Vec3();
    private readonly _tmpLocal = new Vec3();

    protected onLoad(): void {
        if (!this.launcherNode) {
            this.launcherNode = this.node;
        }
        EventBus.on(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
        EventBus.on(GameEvents.GAME_OVER, this.onGameOver, this);
        // 输入看门狗：全局输入监听理论上只在 onDisable/onGameOver 注销，但曾出现「新局输入全死、
        // 无诊断日志」（引擎输入模块被此前的 Button 崩溃打断进坏状态/监听静默丢失）——每 2s
        // 幂等重挂一次（off+on 同回调同 target），监听健在时是无感的，丢了就自愈。
        this.schedule(this.inputWatchdog, 2);
        // DOM 级逃生门（绕过引擎输入系统）：按 R 强制重开一局——输入系统整体坏死时唯一的自救手段
        if (typeof window !== 'undefined' && !(window as any).__pfPanicKey) {
            (window as any).__pfPanicKey = true;
            window.addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key === 'r' || e.key === 'R') {
                    console.log('[诊断] 逃生键 R：强制重载场景');
                    director.loadScene(director.getScene()?.name || 'MainScene');
                }
            });
        }
    }

    /** 看门狗心跳（全时运行）：先做模态现实同步（镜像卡 true 但弹窗实际全关 → 复位），再幂等重挂全局输入 */
    private inputWatchdog(): void {
        if (this._modalOpen && !anyModalOpen()) {
            console.warn('[诊断] Launcher 模态镜像卡 true，已按现实复位并恢复输入');
            this._modalOpen = false;
            this.registerInput();
        }
        if (this._modalOpen || !this._inputRegistered) {
            return;
        }
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    protected onEnable(): void {
        this.registerInput();
    }

    protected start(): void {
        this.registerInput();
    }

    protected onDisable(): void {
        this.unregisterInput();
        this._aimDir = null;
        this.clearTrajectory();
    }

    protected onDestroy(): void {
        this.unregisterInput();
        EventBus.targetOff(this);
    }

    private onUiModalChanged(open: boolean): void {
        if (open) {
            console.warn('[诊断] Launcher 收到 MODAL=true，调用栈：',
                (new Error().stack ?? '').split('\n').slice(1, 5).join('\n'));
        }
        this._modalOpen = open;
        if (open) {
            this.unregisterInput();
            this._aimDir = null;
            this.clearTrajectory();
        } else {
            this.registerInput();
        }
    }

    private onGameOver(): void {
        this._modalOpen = true;
        this.unregisterInput();
        this.clearTrajectory();
    }

    private registerInput(): void {
        if (this._inputRegistered || this._modalOpen) return;
        this._inputRegistered = true;
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    private unregisterInput(): void {
        if (!this._inputRegistered) return;
        this._inputRegistered = false;
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        this._activeTouchId = null;
    }

    private onTouchStart(event: EventTouch): void {
        const loc = event.getUILocation();
        console.log(`[诊断] 全局触点按下 ui=(${loc.x.toFixed(0)},${loc.y.toFixed(0)}) modal=${this._modalOpen}`);
        if (this._activeTouchId !== null || this._modalOpen) return;
        this._activeTouchId = event.getID();
        this.refreshPegSnapshot();
        this.updateAim(event);
        this.drawTrajectory();
    }

    private onTouchMove(event: EventTouch): void {
        if (event.getID() !== this._activeTouchId || this._modalOpen) return;
        this.updateAim(event);
        this.drawTrajectory();
    }

    private onTouchEnd(event: EventTouch): void {
        if (event.getID() !== this._activeTouchId) return;
        this._activeTouchId = null;
        if (this._modalOpen) return;

        const now = Date.now() / 1000;
        if (now - this._lastLaunchTime >= this.launchCooldown) {
            this.updateAim(event);
            if (this._aimDir) {
                this._lastLaunchTime = now;
                this.launchOrb();
            }
        }
        this._aimDir = null;
        this.clearTrajectory();
    }

    private onTouchCancel(): void {
        this._activeTouchId = null;
        this._aimDir = null;
        this.clearTrajectory();
    }

    private updateAim(event: EventTouch): void {
        if (!this.launcherNode?.isValid) return;
        event.getUILocation(this._tmpUIPos);
        this.launcherNode.getWorldPosition(this._tmpWorld);

        const dx = this._tmpUIPos.x - this._tmpWorld.x;
        const dy = this._tmpUIPos.y - this._tmpWorld.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < MIN_AIM_LENGTH) {
            this._aimDir = null;
            return;
        }
        this._tmpDir.set(dx / len, dy / len);

        const angle = Math.atan2(this._tmpDir.y, this._tmpDir.x);
        let clamped: number;
        if (angle >= MIN_LAUNCH_ANGLE && angle <= MAX_LAUNCH_ANGLE) {
            clamped = angle;
        } else if (this._tmpDir.x >= 0) {
            clamped = MAX_LAUNCH_ANGLE;
        } else {
            clamped = MIN_LAUNCH_ANGLE;
        }
        this._tmpDir.set(Math.cos(clamped), Math.sin(clamped));
        this._aimDir = this._tmpDir;
    }

    /** 收集全场钉子快照（世界坐标 → trajectoryGraphics 本地系；力竭钉 Collider 已禁用，物理上不存在，过滤掉） */
    private refreshPegSnapshot(): void {
        this._pegSnapshot = null;
        const layer = this.launcherNode?.parent;
        const graphics = this.trajectoryGraphics;
        if (!layer?.isValid || !graphics?.isValid) return;

        const comps = layer.getComponentsInChildren(PegComponent);
        const pegs: PreviewPeg[] = [];
        for (const c of comps) {
            const n = c.node;
            if (!n?.isValid || !n.activeInHierarchy || c.isExhausted) continue;
            n.getWorldPosition(this._tmpWorld);
            graphics.inverseTransformPoint(this._tmpLocal, this._tmpWorld);
            // 半径取 CircleCollider2D 真值，异常回退 16
            const col = n.getComponent(CircleCollider2D);
            pegs.push({ x: this._tmpLocal.x, y: this._tmpLocal.y, r: col ? col.radius : ORB_RADIUS });
        }
        this._pegSnapshot = pegs;
    }

    private drawTrajectory(): void {
        if (!this.trajectoryGraphics?.isValid || !this.launcherNode?.isValid || !this._aimDir) {
            return;
        }
        const g = this.trajectoryGraphics.getComponent(Graphics);
        if (!g) return;

        const dir = this._aimDir;
        this.launcherNode.getWorldPosition(this._tmpWorld);
        this.trajectoryGraphics.inverseTransformPoint(this._tmpLocal, this._tmpWorld);
        const sx = this._tmpLocal.x;
        const sy = this._tmpLocal.y;

        const nextType = DeckManager.instance?.peekNextOrbType() ?? 0;
        const lineColor = orbAimColor(nextType); // 球种瞄准线色（ArtTheme 语义色板）

        // 首段重力抛物线模拟：初速 = launchSpeed×倍率（对齐 fireOrb 的 velocity+impulse 叠加），
        // 重力取物理系统真值；命中钉子/出界/进漏斗即截断（不做反弹链）
        const sim = simulateAimPreview({
            startX: sx,
            startY: sy,
            vx: dir.x * this.launchSpeed * this.previewSpeedScale,
            vy: dir.y * this.launchSpeed * this.previewSpeedScale,
            gravity: PhysicsSystem2D.instance?.gravity?.y ?? -320,
            orbR: ORB_RADIUS,
            maxTime: this.previewTime,
            dt: PREVIEW_DT,
            fieldHalfW: FIELD_HALF_W,
            floorY: FUNNEL_Y,
            pegs: this._pegSnapshot ?? [],
        });

        g.clear();

        // 沿弧长均匀撒点（Peggle 式点列：弯曲轨迹上等距实心点，起点处不画）
        const pts = sim.points;
        const dots: Array<[number, number]> = [];
        let px = pts[0][0];
        let py = pts[0][1];
        let need = PREVIEW_DOT_SPACING;
        for (let i = 1; i < pts.length; i++) {
            const qx = pts[i][0];
            const qy = pts[i][1];
            const dx = qx - px;
            const dy = qy - py;
            let segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen > 0) {
                const ux = dx / segLen;
                const uy = dy / segLen;
                while (segLen >= need) {
                    px += ux * need;
                    py += uy * need;
                    dots.push([px, py]);
                    segLen -= need;
                    need = PREVIEW_DOT_SPACING;
                }
                px += ux * segLen;
                py += uy * segLen;
            }
            need -= segLen;
        }

        // ★ 柔光瞄准点：大而淡的底光 + 小而实的芯（同 Graphics 两层绘制，零额外 draw call）
        const soft = cloneColor(lineColor);
        soft.a = 70;
        g.fillColor = soft;
        for (const [sx, sy] of dots) {
            g.circle(sx, sy, PREVIEW_DOT_R * 2.6);
        }
        g.fill();
        g.fillColor = lineColor;
        for (const [cx, cy] of dots) {
            g.circle(cx, cy, PREVIEW_DOT_R);
        }
        g.fill();

        // 命中高亮：目标钉子外圈描边（含弹珠半径余量，视觉上「球将撞到这里」）
        if (sim.hitPeg) {
            g.lineWidth = 4;
            g.strokeColor = lineColor;
            g.circle(sim.hitPeg.x, sim.hitPeg.y, sim.hitPeg.r + ORB_RADIUS + 4);
            g.stroke();
        }
    }

    private clearTrajectory(): void {
        if (!this.trajectoryGraphics?.isValid) return;
        const g = this.trajectoryGraphics.getComponent(Graphics);
        g?.clear();
    }

    private launchOrb(): void {
        // 🎯 发射免费（2026-09-03 回滚发射经济）：每发扣 3 金曾造成「0 金拒发 → 打不到金币槽 →
        // 永远 0 金」的死锁（发射是核心动作，不该被货币卡脖子；补贴 9 金只兜 3 发根本不够）。
        // 金币回归纯商店货币：收入 = 击杀掉落 + 金币槽 +20 + 波次补贴 9。
        // DeckManager 为纯类型化卡组（不持有 Prefab），发射统一使用本组件配置的 orbPrefab
        // （原代码引用了不存在的 DeckManager.baseOrbPrefab，运行时恒走 fallback，此处清理为直接取值）
        const prefab = this.orbPrefab;
        if (!prefab?.isValid || !this.launcherNode?.isValid || !this._aimDir) {
            console.warn('[Launcher] 弹珠 Prefab 或发射点无效！');
            return;
        }
        const dir = this._aimDir;

        const orbType = DeckManager.instance?.drawNextOrbType() ?? 0;
        console.log(`[Launcher] 🚀 成功发射弹珠: 类型=${orbType}`);

        if (orbType === OrbType.Lightning) {
            this.fireLightningBurst(prefab, dir);
            return;
        }
        this.fireOrb(prefab, orbType, dir, false);
    }

    /**
     * 雷球扇形散射：数量与间隔消费 OrbBalance.lightning（splitCount/scatterAngle）。
     * 基础 3 连发（-15°/0/+15°）；「过载雷球」卡经 applyUpgrade('lightning_projectile', 2)
     * 把 splitCount 推到 5 → ±30° 五连发。中心球为主球（入槽回收），其余为副球（不回收，卡组守恒）。
     */
    private fireLightningBurst(prefab: Prefab, dir: Vec2): void {
        const { splitCount, scatterAngle } = OrbBalance.lightning;
        const offsets = OrbBalance.lightningSpread(splitCount, scatterAngle);
        const centerIdx = (offsets.length - 1) / 2;
        offsets.forEach((offset, i) => {
            const cos = Math.cos(offset);
            const sin = Math.sin(offset);
            // 平面旋转（与旧版 left/right 手算公式一致）
            const rotated = new Vec2(
                dir.x * cos - dir.y * sin,
                dir.x * sin + dir.y * cos,
            );
            this.fireOrb(prefab, OrbType.Lightning, rotated, i !== centerIdx);
        });
    }

    private fireOrb(prefab: Prefab, orbType: number, dir: Vec2, isSideKick: boolean): boolean {
        const orb = instantiate(prefab);
        if (!orb.isValid) return false;

        const orbCtrl = orb.getComponent(OrbController);
        if (orbCtrl) {
            orbCtrl.initOrbType(orbType);
            if (isSideKick) {
                orbCtrl.isSplitChild = true;
            }
        }

        orb.setParent(this.node.parent);
        this.launcherNode.getWorldPosition(this._tmpWorld);
        orb.setWorldPosition(this._tmpWorld);

        const rb = orb.getComponent(RigidBody2D);
        if (!rb) {
            console.warn('[Launcher] 弹珠缺少 RigidBody2D！');
            return false;
        }

        const vx = dir.x * this.launchSpeed;
        const vy = dir.y * this.launchSpeed;

        rb.linearVelocity = new Vec2(vx, vy);
        const mass = rb.getMass();
        if (mass > 0) {
            rb.applyLinearImpulseToCenter(new Vec2(vx * mass, vy * mass), true);
        }
        return true;
    }
}