import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, find,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { DailyTaskManager } from '../Core/DailyTaskManager';
import { Theme } from '../Core/ArtTheme';

const { ccclass } = _decorator;

// ---------- 徽章样式：DeckButtonController 同款 36×36 圆形徽章，位于 🎒 徽章左侧 44px ----------
const BADGE_SIZE = 36;
const BADGE_X = 244;
const BADGE_Y = 600;
const BADGE_BG = Theme.ui.badgeBg;
const BADGE_RING = Theme.ui.gold;
const BADGE_EMOJI = '📋';
const BADGE_EMOJI_SIZE = 20;
/** 可领取红点（右上角小圆） */
const DOT_COLOR = Theme.ui.redDot;
const DOT_OFFSET_X = 11;
const DOT_OFFSET_Y = 11;
const DOT_RADIUS = 6;
/** 红点轮询间隔（秒）：hasClaimable 为纯内存读，低频轮询足够（领奖后 ≤2s 红点消失） */
const DOT_POLL_INTERVAL = 2;

/**
 * 📋 每日任务徽章：挂载在 Canvas/UILayer/DailyTaskBadge 节点上（ensureMounted 自举纯代码创建）。
 * - 36×36 圆形徽章钉在顶部 HUD 行（🎒 牌库徽章左侧 44px，Y=600 怪物走廊上方），轻点广播 SHOW_DAILY_TASKS；
 * - 右上角红点 = 存在可领取任务（hasClaimable，低频轮询 2s 刷新；领奖后 ≤2s 消失）。
 *
 * 注：Cocos Creator 规定每个脚本资产最多注册一个 Component（引擎 errorID 3615），
 * 因此本类必须与 DailyTaskDialog 分文件存放。
 */
@ccclass('DailyTaskBadge')
export class DailyTaskBadge extends Component {
    private _dot: Node | null = null;

    /** 全局自举：幂等把本组件挂到 Canvas/UILayer/DailyTaskBadge（窄屏时随 🎒 徽章同步内收） */
    static ensureMounted(): void {
        const uiLayer = find('Canvas/UILayer');
        if (!uiLayer || !uiLayer.isValid) {
            return;
        }
        let node = uiLayer.getChildByName('DailyTaskBadge');
        if (!node?.isValid) {
            node = new Node('DailyTaskBadge');
            node.layer = uiLayer.layer;
            uiLayer.addChild(node);
            // 水平钉位：优先 BADGE_X（🎒 徽章 290 左侧 44px）；窄屏按右缘钳制内收，与 🎒 徽章不重叠
            const halfW = (find('Canvas')?.getComponent(UITransform)?.width ?? 720) / 2;
            node.setPosition(Math.min(BADGE_X, halfW - 70), BADGE_Y, 0);
        }
        if (!node.getComponent(DailyTaskBadge)) {
            node.addComponent(DailyTaskBadge);
        }
    }

    protected onLoad(): void {
        this.buildUI();
        this.node.on(Node.EventType.TOUCH_END, this.onTap, this);
        this.schedule(this.refreshDot, DOT_POLL_INTERVAL);
        this.refreshDot();
    }

    protected onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_END, this.onTap, this);
        this.unschedule(this.refreshDot);
    }

    private onTap(): void {
        EventBus.emit(GameEvents.SHOW_DAILY_TASKS);
    }

    /** 红点状态刷新：存在「已完成未领取」任务时点亮 */
    private refreshDot(): void {
        if (this._dot?.isValid) {
            this._dot.active = DailyTaskManager.hasClaimable();
        }
    }

    /** 纯代码构建徽章外观：半透明深暗色圆形底板 + 暗金细环 + 居中 📋 + 右上角红点（幂等重绘） */
    private buildUI(): void {
        const ui = this.getComponent(UITransform) ?? this.addComponent(UITransform);
        ui.setContentSize(BADGE_SIZE, BADGE_SIZE);
        const g = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        g.clear();
        const r = BADGE_SIZE / 2;
        g.fillColor = BADGE_BG;
        g.circle(0, 0, r);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = BADGE_RING;
        g.circle(0, 0, r - 1);
        g.stroke();

        let labelNode = this.node.getChildByName('Label');
        if (!labelNode?.isValid) {
            labelNode = new Node('Label');
            labelNode.layer = this.node.layer;
            this.node.addChild(labelNode);
            labelNode.addComponent(UITransform).setContentSize(BADGE_SIZE, BADGE_SIZE);
            const label = labelNode.addComponent(Label);
            label.string = BADGE_EMOJI;
            label.fontSize = BADGE_EMOJI_SIZE;
            label.lineHeight = BADGE_EMOJI_SIZE + 2;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
        }
        if (!this._dot?.isValid) {
            const dot = new Node('ClaimDot');
            dot.layer = this.node.layer;
            this.node.addChild(dot);
            dot.addComponent(UITransform).setContentSize(DOT_RADIUS * 2, DOT_RADIUS * 2);
            dot.setPosition(DOT_OFFSET_X, DOT_OFFSET_Y, 0);
            const dg = dot.addComponent(Graphics);
            dg.fillColor = DOT_COLOR;
            dg.circle(0, 0, DOT_RADIUS);
            dg.fill();
            this._dot = dot;
        }
    }
}
