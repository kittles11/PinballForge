import {
    _decorator, Component, Node, Prefab, Graphics, Vec2, Vec3, Color,
    input, Input, EventTouch, RigidBody2D, instantiate,
} from 'cc';
import { DeckManager } from '../Core/DeckManager';
import { EventBus, GameEvents } from '../Core/EventBus';
import { OrbController } from '../Pinball/OrbController';
import { OrbType } from '../Core/DataModels';

const { ccclass, property } = _decorator;

/** 虚线段长（px） */
const DASH_LENGTH = 20;
/** 虚线间隔（px） */
const DASH_GAP = 15;
/** 手指距发射点小于该值视为无效瞄准（不发射） */
const MIN_AIM_LENGTH = 15;
/** 发射方向允许的角度范围（度）：-165°（左下方）~ -15°（右下方） */
const MIN_LAUNCH_ANGLE = -165 * Math.PI / 180;
const MAX_LAUNCH_ANGLE = -15 * Math.PI / 180;
/** 裂变雷球左右散射角 15° */
const SCATTER_ANGLE = (15 * Math.PI) / 180;
const SCATTER_COS = Math.cos(SCATTER_ANGLE);
const SCATTER_SIN = Math.sin(SCATTER_ANGLE);

/** 各球种瞄准线颜色（使用纯数字键，彻底杜绝模块加载期循环引用未定义） */
const AIM_COLORS: Record<number, Color> = {
    0: new Color(255, 255, 255, 220),      // 普通球 (Normal=0)：银白
    1: new Color(0, 255, 255, 240),        // 闪电球 (Lightning=1)：青蓝电光
    2: new Color(255, 85, 0, 240),          // 熔岩球 (Lava=2)：炽热橙红
    3: new Color(224, 247, 250, 240),      // 霜冻球 (Frost=3)：雪白微蓝
};

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

    @property
    trajectoryLength = 400;

    /** 发射冷却（秒） */
    @property
    launchCooldown = 0.25;

    private _aimDir: Vec2 | null = null;
    private _inputRegistered = false;
    private _modalOpen = false;
    private _activeTouchId: number | null = null;
    private _lastLaunchTime = 0;

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
        if (this._activeTouchId !== null || this._modalOpen) return;
        this._activeTouchId = event.getID();
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
        const lineColor = AIM_COLORS[nextType] ?? AIM_COLORS[0];

        g.clear();
        g.lineWidth = 3;
        g.strokeColor = lineColor;

        const total = Math.max(0, this.trajectoryLength);
        let d = 0;
        while (d < total) {
            const seg = Math.min(DASH_LENGTH, total - d);
            g.moveTo(sx + dir.x * d, sy + dir.y * d);
            g.lineTo(sx + dir.x * (d + seg), sy + dir.y * (d + seg));
            d += seg + DASH_GAP;
        }
        g.stroke();
    }

    private clearTrajectory(): void {
        if (!this.trajectoryGraphics?.isValid) return;
        const g = this.trajectoryGraphics.getComponent(Graphics);
        g?.clear();
    }

    private launchOrb(): void {
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

    private fireLightningBurst(prefab: Prefab, dir: Vec2): void {
        const left = new Vec2(
            dir.x * SCATTER_COS - dir.y * SCATTER_SIN,
            dir.x * SCATTER_SIN + dir.y * SCATTER_COS,
        );
        const right = new Vec2(
            dir.x * SCATTER_COS + dir.y * SCATTER_SIN,
            -dir.x * SCATTER_SIN + dir.y * SCATTER_COS,
        );

        this.fireOrb(prefab, OrbType.Lightning, dir, false);
        this.fireOrb(prefab, OrbType.Lightning, left, true);
        this.fireOrb(prefab, OrbType.Lightning, right, true);
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