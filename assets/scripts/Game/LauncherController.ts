/**
 * 发射器（2026-09-07 随机角度改版）：固定在顶部中央的弹射座，出射角【每次发射前重新随机滚定】。
 *
 * 设计要点（用户拍板）：
 *  - 角度随机发生在 launchOrb 内部——每发独立均匀分布于 [-165°, -15°]（恒向上扇区，
 *    左右各留 15° 贴墙死区），连点冷却内的连按同样每发一随机，不是开局滚一次定死；
 *  - 触摸拖拽瞄准 / AimPreview 弹道预测线已整体移除：方向不可预知，预测线会构成误导；
 *  - 底部「发 射」按钮为唯一发射入口（ensureLaunchButton 纯代码自举，幂等，屏底漏斗下方），
 *    弹窗互斥（UI_MODAL_CHANGED / GAME_OVER + 现实同步）与连点冷却沿用原发射节流；
 *  - 按压手感（attachPressFx）：按下节点下沉 3px + pressed 态重绘（影子塌缩 / 暗边减半 /
 *    面部减光），松手 backOut 弹回——与 UiKit 浮雕语言配套的「按得进去」反馈；
 *  - DOM 级 R 键逃生门保留（输入系统整体坏死时强制重载场景的唯一自救手段）。
 */
import {
    _decorator, Component, Node, Prefab, Graphics, Vec2, Vec3, UITransform,
    Button, Label, instantiate, director, RigidBody2D, Color, Tween, tween,
} from 'cc';
import { DeckManager } from '../Core/DeckManager';
import { EventBus, GameEvents } from '../Core/EventBus';
import { anyModalOpen } from '../Core/ModalGate';
import { OrbController } from '../Pinball/OrbController';
import { OrbBalance } from '../Core/OrbBalance';
import { OrbType } from '../Core/DataModels';
import { Theme } from '../Core/ArtTheme';
import { raisedButton } from '../Core/UiKit';

const { ccclass, property } = _decorator;

/** 发射方向允许的角度范围（度）：-165°（左上偏左）~ -15°（右上偏右），恒向上扇区 */
const LAUNCH_ANGLE_MIN_DEG = -165;
const LAUNCH_ANGLE_MAX_DEG = -15;
/** 「发 射」按钮尺寸 / 位置（UILayer 局部坐标，屏底漏斗下方，锁定 720×1280 画布） */
const LAUNCH_BTN_W = 150;
const LAUNCH_BTN_H = 64;
const LAUNCH_BTN_POS_Y = -545;
/** 按压下沉量（px）：与 UiKit 暗边厚度同量级，压满再回弹才有「真按进去」的实体感 */
const LAUNCH_BTN_PRESS_DIP_Y = 3;

/**
 * 发射器：随机角度 + 按钮发射。orbPrefab / launcherNode / launchSpeed / launchCooldown
 * 沿用场景既有接线；trajectoryGraphics / previewSpeedScale / previewTime 随预测线一并退役。
 */
@ccclass('LauncherController')
export class LauncherController extends Component {
    @property({ type: Prefab })
    orbPrefab: Prefab | null = null;

    @property({ type: Node })
    launcherNode: Node | null = null;

    @property
    launchSpeed = 1200;

    /** 发射冷却（秒）：「发 射」按钮连点节流（原拖拽松手节流平移到按钮） */
    @property
    launchCooldown = 0.25;

    /** 模态互斥镜像（UI_MODAL_CHANGED / GAME_OVER 同步 + 现实纠偏） */
    private _modalOpen = false;
    /** 上次发射时刻（秒）：冷却节流基准 */
    private _lastLaunchTime = 0;
    /** 自举的「发 射」按钮节点（ensureLaunchButton 创建 / 复用） */
    private _launchBtn: Node | null = null;
    /** 复用暂存：弹珠出生点（世界坐标） */
    private readonly _tmpWorld = new Vec3();

    protected onLoad(): void {
        if (!this.launcherNode) {
            this.launcherNode = this.node;
        }
        EventBus.on(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
        EventBus.on(GameEvents.GAME_OVER, this.onGameOver, this);
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
        this.ensureLaunchButton();
    }

    protected onDestroy(): void {
        EventBus.targetOff(this);
    }

    private onUiModalChanged(open: boolean): void {
        this.syncModalOpen(open);
    }

    private onGameOver(): void {
        this.syncModalOpen(true);
    }

    /** 模态现实同步：镜像说开但实际弹窗全关 → 自愈复位（历史 missed-false 卡死教训） */
    private syncModalOpen(open: boolean): void {
        this._modalOpen = open === true;
        if (this._modalOpen && !anyModalOpen()) {
            this._modalOpen = false;
        }
    }

    /**
     * 「发 射」按钮点按链路（唯一发射入口）：弹窗互斥 → 冷却节流 → 发射。
     * 看门狗已随全局输入退役——模态镜像卡死的现实同步在 syncModalOpen 完成。
     */
    private onLaunchClicked(): void {
        if (this._modalOpen) {
            return; // 弹窗期禁发（结算/奖励/商店等覆盖层打开时）
        }
        const now = Date.now() / 1000;
        if (now - this._lastLaunchTime < this.launchCooldown) {
            return; // 连点节流
        }
        this._lastLaunchTime = now;
        this.launchOrb();
    }

    /**
     * 自举屏底「发 射」按钮（幂等，场景无需布置）：Canvas/UILayer/LaunchBtn。
     * 金色凸起（raisedButton + Theme.ui.gold）——发射是主动进攻动作，走金色 CTA
     * 语言；Label 居中「发 射」。热重载时复用同名节点（事件随旧组件销毁，需重挂）。
     */
    private ensureLaunchButton(): void {
        const uiLayer = director.getScene()?.getChildByName('Canvas')?.getChildByName('UILayer');
        if (!uiLayer?.isValid) {
            console.warn('[Launcher] 未找到 Canvas/UILayer，「发 射」按钮未自举');
            return;
        }
        const existing = uiLayer.getChildByName('LaunchBtn');
        if (existing?.isValid) {
            this._launchBtn = existing;
            return;
        }
        const btn = new Node('LaunchBtn');
        btn.layer = uiLayer.layer; // 与 UILayer 同 layer，确保被同一 UI 相机渲染
        btn.addComponent(UITransform).setContentSize(LAUNCH_BTN_W, LAUNCH_BTN_H);
        btn.setPosition(0, LAUNCH_BTN_POS_Y, 0);
        const g = btn.addComponent(Graphics);
        raisedButton(g, LAUNCH_BTN_W, LAUNCH_BTN_H, Theme.ui.gold);
        // ⚠️ cc.Label 与 cc.Graphics 同为 UIRenderer 派生组件、同节点互斥——直加会抛
        // "conflicts with the existing 'cc.Graphics'" 中断创建链（按钮从未挂进场景）。
        // 文字一律挂子节点（与 RewardDialog 换一批按钮等全库既有按钮同款结构）。
        const labelNode = new Node('Label');
        labelNode.layer = btn.layer;
        btn.addChild(labelNode);
        labelNode.addComponent(UITransform).setContentSize(LAUNCH_BTN_W, LAUNCH_BTN_H);
        const label = labelNode.addComponent(Label);
        label.string = '发 射';
        label.fontSize = 26;
        label.lineHeight = 30;
        label.isBold = true;
        label.color = Theme.white;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        btn.addComponent(Button).transition = Button.Transition.NONE;
        btn.on(Button.EventType.CLICK, this.onLaunchClicked, this);
        this.attachPressFx(btn, LAUNCH_BTN_W, LAUNCH_BTN_H, Theme.ui.gold, LAUNCH_BTN_PRESS_DIP_Y);
        uiLayer.addChild(btn);
        this._launchBtn = btn;
    }

    /**
     * 按钮按压手感（通用，吃任何 raisedButton 凸起按钮）：
     * 按下 → 节点下沉 dipY + 按压态重绘（影子塌缩 / 暗边减半 / 面部减光，UiKit.raisedButton pressed）；
     * 松手/滑出 → 弹回原位 + 静止态重绘，backOut 缓动带一点「弹起」的活泼劲。
     * 监听挂按钮节点（闭包持原坐标，随节点销毁回收，无组件无 this）；底位取挂载时现值，热重载位移后仍准。
     */
    private attachPressFx(btn: Node, w: number, h: number, body: Color, dipY: number): void {
        const restY = btn.position.y;
        const repaint = (pressed: boolean): void => {
            const g = btn.getComponent(Graphics);
            if (!g?.isValid) {
                return;
            }
            g.clear();
            raisedButton(g, w, h, body, undefined, pressed);
        };
        btn.on(Node.EventType.TOUCH_START, (): void => {
            Tween.stopAllByTarget(btn);
            btn.setPosition(btn.position.x, restY - dipY, 0);
            repaint(true);
        }, this);
        const release = (): void => {
            Tween.stopAllByTarget(btn);
            repaint(false);
            tween(btn)
                .to(0.06, { position: new Vec3(btn.position.x, restY, 0) }, { easing: 'backOut' })
                .start();
        };
        btn.on(Node.EventType.TOUCH_END, release, this);
        btn.on(Node.EventType.TOUCH_CANCEL, release, this);
    }

    /** 滚定一次随机出射角（度）：[-165°, -15°] 均匀分布，恒向上扇区（左右各留 15° 贴墙死区）。 */
    private rollLaunchAngle(): number {
        return LAUNCH_ANGLE_MIN_DEG
            + Math.random() * (LAUNCH_ANGLE_MAX_DEG - LAUNCH_ANGLE_MIN_DEG);
    }

    /**
     * 发射当前弹珠（唯一调用方：onLaunchClicked）。
     * ★ 每发先重滚随机出射角——随机发生在本函数内部，冷却外的每次点按都拿到新方向
     * （用户拍板：每次发射都随机，不是开局滚一次定死），再按球种走雷球散射或单球发射。
     */
    private launchOrb(): void {
        const deg = this.rollLaunchAngle();
        const rad = deg * Math.PI / 180;
        const dir = new Vec2(Math.cos(rad), Math.sin(rad));
        const prefab = this.orbPrefab;
        if (!prefab?.isValid || !this.launcherNode?.isValid) {
            console.warn('[Launcher] 弹珠 Prefab 或发射点无效！');
            return;
        }
        // 🎯 发射免费（2026-09-03 回滚发射经济）：金币回归纯商店货币（击杀掉落 + 金币槽 +20 + 波次补贴）。
        // DeckManager 为纯类型化卡组（不持有 Prefab），发射统一使用本组件配置的 orbPrefab
        const orbType = DeckManager.instance?.drawNextOrbType() ?? 0;
        console.log(`[Launcher] 🚀 成功发射弹珠: 类型=${orbType} 角度=${Math.round(deg)}°`);

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
