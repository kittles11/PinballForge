import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec2, Vec3, EventTouch, find, tween, Tween,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { Theme } from '../Core/ArtTheme';

const { ccclass } = _decorator;

// ---------- 纯代码按钮样式：右上角迷你圆形徽章（无 Inspector 布置时自动构建） ----------
/** 徽章直径：36×36 小巧圆形 */
const BTN_SIZE = 36;
/**
 * 坐标（720×1280 画布，锚点居中，最右上角、金币图标右侧）：
 * - Y = 600：顶部 HUD 行（城堡血量 -210 / 关卡标题 0 / 金币 210，y≈590）上方贴顶，远高于
 *   怪物行进走廊（Y ≈ 480），怪物从右向左行进全程零遮挡；上缘 618 距画布顶（640）仍有余量；
 * - X = 290：金币图标右侧（💰 文案右缘 ≈270）；窄屏（如 20:9 可视半宽 ≈284）时由 resolveX
 *   按右缘自动钳制内收，保证徽章完整可见。
 */
const BTN_X = 290;
const BTN_Y = 600;
/** 底板：半透明深暗色圆形 #1E2438CC */
const BTN_BG = Theme.ui.badgeBg;
/** 装饰：暗金细环描边（与全局金边 UI 语言一致） */
const BTN_RING = Theme.ui.gold;
/** 按钮文字：单个 Emoji，字号 20，水平/垂直绝对居中 */
const BTN_EMOJI = '🎒';
const EMOJI_FONT_SIZE = 20;
/** 按下瞬间缩放（轻微弹性反馈，抬起回弹 1.0） */
const PRESS_SCALE = 0.9;
/** 判定为「轻点」的最大位移（px）：从按钮/牌库文字处起始的瞄准拖拽松手时不会误开背包 */
export const TAP_SLOP = 15;

/**
 * 右上角 🎒 牌库背包徽章：挂载在 Canvas/UILayer/DeckBtn 节点上。
 * - 36×36 迷你圆形徽章钉在顶部 HUD 行右上角（Y=600，怪物走廊上方），轻点广播 SHOW_DECK_VIEW，
 *   由 DeckViewDialog 打开背包面板（战斗中随时可呼出；底部牌库文字轻点为第二通道，见 DeckManager）；
 * - 场景未布置 DeckBtn 节点时由 DeckManager.start 自举（ensureMounted）纯代码创建；
 *   onLoad 强制钉位，场景里即使误摆旧位置也会被纠正到 (290, 600)；
 * - 按下→抬起位移超过 TAP_SLOP 视为瞄准拖拽而非点击，避免误触打开弹窗。
 */
@ccclass('DeckButtonController')
export class DeckButtonController extends Component {
    /** 手指按下位置（UI 坐标）：用于区分「轻点」与「从按钮处起始的瞄准拖拽」 */
    private readonly _pressPos = new Vec2();
    /** 徽章常态缩放（弹性反馈的回弹基准，跟随节点实际缩放） */
    private readonly _baseScale = new Vec3(1, 1, 1);

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
        if (!node.getComponent(DeckButtonController)) {
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
        // 坐标安全化：无论节点来自场景布置还是代码自举，一律强制钉到右上角 HUD 位（Y=600 ≫ 怪物走廊 Y≈480）
        this.node.setPosition(DeckButtonController.resolveX(), BTN_Y, 0);
        this.buildUI();
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    protected onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        Tween.stopAllByTarget(this.node);
    }

    /** 记录按下位置（区分轻点与拖拽）+ 播放按下缩小反馈（scale → 0.9） */
    private onTouchStart(event: EventTouch): void {
        const pos = event.getUILocation();
        this._pressPos.set(pos.x, pos.y);
        Tween.stopAllByTarget(this.node);
        tween(this.node).to(0.06, { scale: this._baseScale.clone().multiplyScalar(PRESS_SCALE) }).start();
    }

    /** 抬起时位移仍在轻点范围内 → 打开背包面板；无论如何回弹常态缩放（scale → 1.0） */
    private onTouchEnd(event: EventTouch): void {
        this.restoreScale();
        const pos = event.getUILocation();
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

        let labelNode = this.node.getChildByName('Label');
        if (!labelNode?.isValid) {
            labelNode = new Node('Label');
            labelNode.layer = this.node.layer;
            this.node.addChild(labelNode);
            labelNode.addComponent(UITransform).setContentSize(BTN_SIZE, BTN_SIZE);
            const label = labelNode.addComponent(Label);
            label.string = BTN_EMOJI;
            label.fontSize = EMOJI_FONT_SIZE;
            label.lineHeight = EMOJI_FONT_SIZE + 2;
            label.color = Color.WHITE;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.overflow = Label.Overflow.SHRINK;
        }
    }
}