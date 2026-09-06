import {
    _decorator, Component, Node, UITransform, Graphics, Vec2, Vec3, EventTouch, find, tween, Tween,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { Theme } from '../Core/ArtTheme';
import { mountIcon } from '../Core/IconLib';
import { anyModalOpen } from '../Core/ModalGate';

const { ccclass } = _decorator;

// ---------- 纯代码按钮样式：右上角迷你圆形徽章（无 Inspector 布置时自动构建） ----------
/** 徽章直径：44×44 圆形（加大命中区，避免点偏变成瞄准发射、或误以为按钮失灵） */
const BTN_SIZE = 44;
/**
 * 坐标（720×1280 画布，锚点居中，顶部 HUD 第一行最右）：
 * - Y = 606：第一行（城堡 -250 / 金币 176 / 📋 264 / 🎒 314），远高于怪物行进走廊（Y ≈ 480）；
 * - X = 314：金币与 📋 任务徽章右侧，44px 命中区互不重叠，不再遮挡金币数字；
 *   窄屏（如 20:9 可视半宽不足）时由 resolveX 按右缘自动钳制内收，保证徽章完整可见。
 */
const BTN_X = 314;
const BTN_Y = 606;
/** 底板：半透明深暗色圆形 #1E2438CC */
const BTN_BG = Theme.ui.badgeBg;
/** 装饰：暗金细环描边（与全局金边 UI 语言一致） */
const BTN_RING = Theme.ui.gold;
/** 徽章图标：背包矢量图标（IconLib 染色，替代 emoji Label——跨平台字形一致） */
const BTN_ICON = 'bag';
const BTN_ICON_SIZE = 24;
/** 按下瞬间缩放（轻微弹性反馈，抬起回弹 1.0） */
const PRESS_SCALE = 0.9;
/** 判定为「轻点」的最大位移（px）：从按钮/牌库文字处起始的瞄准拖拽松手时不会误开背包 */
export const TAP_SLOP = 15;

/**
 * 右上角 🎒 牌库背包徽章：挂载在 Canvas/UILayer/DeckBtn 节点上。
 * - 44×44 圆形徽章钉在顶部 HUD 第一行最右（Y=606，怪物走廊上方），轻点广播 SHOW_DECK_VIEW，
 *   由 DeckViewDialog 打开背包面板（战斗中随时可呼出；底部牌库文字轻点为第二通道，见 DeckManager）；
 * - 场景未布置 DeckBtn 节点时由 DeckManager.start 自举（ensureMounted）纯代码创建；
 *   onLoad 强制钉位，场景里即使误摆旧位置也会被纠正到 (314, 606)；
 * - 按下→抬起位移超过 TAP_SLOP 视为瞄准拖拽而非点击，避免误触打开弹窗。
 */
@ccclass('DeckButtonController')
export class DeckButtonController extends Component {
    /** 手指按下位置（UI 坐标）：用于区分「轻点」与「从按钮处起始的瞄准拖拽」 */
    private readonly _pressPos = new Vec2();
    /** 徽章常态缩放（弹性反馈的回弹基准，跟随节点实际缩放） */
    private readonly _baseScale = new Vec3(1, 1, 1);
    /** 弹窗互斥守卫：结算/奖励/商店/面板任一打开期间不响应徽章，避免叠层误开 */
    private _modalOpen = false;

    /** 全局自举：幂等把本组件挂到 Canvas/UILayer/DeckBtn（场景已有同名节点则复用，onLoad 会纠正钉位） */
    static ensureMounted(): void {
        const uiLayer = find('Canvas/UILayer');
        if (!uiLayer || !uiLayer.isValid) {
            return;
        }
        let node = uiLayer.getChildByName('DeckBtn');
        if (!node?.isValid) {
            node = new Node('DeckBtn');
            node.layer = uiLayer.layer;
            uiLayer.addChild(node);
            node.setPosition(DeckButtonController.resolveX(), BTN_Y, 0);
        }
        // 热重载防御：与 DailyTaskBadge 同款——只保留首个实例，多余销毁
        const comps = node.getComponents(DeckButtonController);
        for (let i = 1; i < comps.length; i++) {
            comps[i].destroy();
        }
        if (comps.length === 0) {
            node.addComponent(DeckButtonController);
        }
    }

    /** 水平钉位：优先 BTN_X；窄屏（可视宽不足）按右缘钳制内收，保证 36px 徽章完整可见 */
    private static resolveX(): number {
        const halfW = (find('Canvas')?.getComponent(UITransform)?.width ?? 720) / 2;
        return Math.min(BTN_X, halfW - BTN_SIZE / 2 - 8);
    }

    protected onLoad(): void {
        this._baseScale.set(this.node.scale);
        // 坐标安全化：无论节点来自场景布置还是代码自举，一律强制钉到右上角 HUD 位
        this.node.setPosition(DeckButtonController.resolveX(), BTN_Y, 0);
        this.buildUI();
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        EventBus.on(GameEvents.UI_MODAL_CHANGED, this.onModalChanged, this);
    }

    protected onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        EventBus.off(GameEvents.UI_MODAL_CHANGED, this.onModalChanged, this);
        Tween.stopAllByTarget(this.node);
    }

    /** UI_MODAL_CHANGED：结算/奖励/商店/面板开合时同步互斥守卫 */
    private onModalChanged(open: boolean): void {
        this._modalOpen = open === true;
    }

    /** 记录按下位置（区分轻点与拖拽）+ 播放按下缩小反馈（scale → 0.9） */
    private onTouchStart(event: EventTouch): void {
        const pos = event.getUILocation();
        this._pressPos.set(pos.x, pos.y);
        Tween.stopAllByTarget(this.node);
        tween(this.node).to(0.06, { scale: this._baseScale.clone().multiplyScalar(PRESS_SCALE) }).start();
    }

    /** 抬起时位移仍在轻点范围内 → 打开背包面板；弹窗期间不响应；无论如何回弹常态缩放（scale → 1.0） */
    private onTouchEnd(event: EventTouch): void {
        this.restoreScale();
        const pos = event.getUILocation();
        console.log(`[诊断] DeckBtn 触摸抬起 ui=(${pos.x.toFixed(0)},${pos.y.toFixed(0)}) modal=${this._modalOpen} node活动=${this.node.activeInHierarchy}`);
        // 现实纠偏：事件镜像说有弹窗，但实际所有弹窗都已关闭 → 复位（自愈 missed-false 卡死）
        if (this._modalOpen && !anyModalOpen()) {
            console.warn('[诊断] DeckBtn 模态镜像卡 true，已按现实复位');
            this._modalOpen = false;
        }
        if (this._modalOpen) {
            return; // 弹窗打开期间：不响应徽章点击，避免叠层误开
        }
        if (Vec2.distance(this._pressPos, pos) > TAP_SLOP) {
            return; // 位移过大：是从按钮处起始的瞄准拖拽，不当作点击
        }
        EventBus.emit(GameEvents.SHOW_DECK_VIEW);
    }

    /** 手指滑出节点（取消触摸）：仅回弹缩放，不触发点击 */
    private onTouchCancel(): void {
        this.restoreScale();
    }

    private restoreScale(): void {
        Tween.stopAllByTarget(this.node);
        tween(this.node).to(0.08, { scale: this._baseScale.clone() }).start();
    }

    /** 纯代码构建徽章外观：半透明深暗色圆形底板 + 暗金细环 + 绝对居中 🎒（幂等，重入时先清空重绘） */
    private buildUI(): void {
        const ui = this.getComponent(UITransform) ?? this.addComponent(UITransform);
        ui.setContentSize(BTN_SIZE, BTN_SIZE);
        const g = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        g.clear();
        const r = BTN_SIZE / 2;
        g.fillColor = BTN_BG;
        g.circle(0, 0, r);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = BTN_RING;
        g.circle(0, 0, r - 1);
        g.stroke();

        // 居中矢量背包图标（幂等：mountIcon 同名子节点清空重绘）
        mountIcon(this.node, BTN_ICON, BTN_ICON_SIZE, Theme.white, 0, 0);
    }
}