import {
    _decorator, Component, Node, UITransform, Graphics, Vec2, EventTouch, find,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { DailyTaskManager } from '../Core/DailyTaskManager';
import { TAP_SLOP } from './DeckButtonController';
import { Theme } from '../Core/ArtTheme';
import { mountIcon } from '../Core/IconLib';
import { anyModalOpen } from '../Core/ModalGate';

const { ccclass } = _decorator;

// ---------- 徽章样式：DeckButtonController 同款 44×44 圆形徽章，位于 🎒 徽章左侧 50px ----------
const BADGE_SIZE = 44;
const BADGE_X = 264;
const BADGE_Y = 606;
const BADGE_BG = Theme.ui.badgeBg;
const BADGE_RING = Theme.ui.gold;
/** 徽章图标：写字板矢量图形（IconLib 染色，替代 emoji Label） */
const BADGE_ICON = 'clipboard';
const BADGE_ICON_SIZE = 24;
/** 可领取红点（右上角小圆） */
const DOT_COLOR = Theme.ui.redDot;
const DOT_OFFSET_X = 11;
const DOT_OFFSET_Y = 11;
const DOT_RADIUS = 6;
/** 红点轮询间隔（秒）：hasClaimable 为纯内存读，低频轮询足够（领奖后 ≤2s 红点消失） */
const DOT_POLL_INTERVAL = 2;

/**
 * 📋 每日任务徽章：挂载在 Canvas/UILayer/DailyTaskBadge 节点上（ensureMounted 自举纯代码创建）。
 * - 44×44 圆形徽章钉在顶部 HUD 第一行（🎒 背包徽章左侧，Y=606 怪物走廊上方），
 *   轻点广播 SHOW_DAILY_TASKS；与 DeckButtonController 同一套 TAP_SLOP 轻点判定 + 弹窗互斥守卫；
 * - 右上角红点 = 存在可领取任务（hasClaimable，低频轮询 2s 刷新；领奖后 ≤2s 消失）。
 *
 * 注：Cocos Creator 规定每个脚本资产最多注册一个 Component（引擎 errorID 3615），
 * 因此本类必须与 DailyTaskDialog 分文件存放。
 */
@ccclass('DailyTaskBadge')
export class DailyTaskBadge extends Component {
    private _dot: Node | null = null;
    /** 手指按下位置（UI 坐标）：区分「轻点」与「从按钮处起始的瞄准拖拽」 */
    private readonly _pressPos = new Vec2();
    /** 弹窗互斥守卫：结算/奖励/商店/面板任一打开期间不响应徽章 */
    private _modalOpen = false;

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
            // 水平钉位：优先 BADGE_X（🎒 徽章 314 左侧 50px）；窄屏按右缘钳制内收，与 🎒 徽章不重叠
            const halfW = (find('Canvas')?.getComponent(UITransform)?.width ?? 720) / 2;
            node.setPosition(Math.min(BADGE_X, halfW - 76), BADGE_Y, 0);
        }
        // 热重载防御：脚本热更后 getComponent 按新类匹配不到旧实例，会反复 addComponent——
        // 只保留首个实例、多余销毁（RelicBar 曾因同类问题堆出数十个重复组件）
        const comps = node.getComponents(DailyTaskBadge);
        for (let i = 1; i < comps.length; i++) {
            comps[i].destroy();
        }
        if (comps.length === 0) {
            node.addComponent(DailyTaskBadge);
        }
    }

    protected onLoad(): void {
        // 钉位安全化：热重载/旧数据可能把徽章摆回旧坐标，一律强制钉到第一行 HUD 位（与 🎒 同高对齐）
        const halfW = (find('Canvas')?.getComponent(UITransform)?.width ?? 720) / 2;
        this.node.setPosition(Math.min(BADGE_X, halfW - 76), BADGE_Y, 0);
        this.buildUI();
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        EventBus.on(GameEvents.UI_MODAL_CHANGED, this.onModalChanged, this);
        this.schedule(this.refreshDot, DOT_POLL_INTERVAL);
        this.refreshDot();
    }

    protected onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        EventBus.off(GameEvents.UI_MODAL_CHANGED, this.onModalChanged, this);
        this.unschedule(this.refreshDot);
    }

    /** 按下记录起点：与 🎒 徽章同一套 TAP_SLOP 判定，瞄准拖拽起始不误开面板 */
    private onTouchStart(event: EventTouch): void {
        const pos = event.getUILocation();
        this._pressPos.set(pos.x, pos.y);
    }

    /** 抬起：弹窗期间不响应；位移仍在轻点范围内才广播 SHOW_DAILY_TASKS */
    private onTouchEnd(event: EventTouch): void {
        const pos = event.getUILocation();
        console.log(`[诊断] TaskBadge 触摸抬起 ui=(${pos.x.toFixed(0)},${pos.y.toFixed(0)}) modal=${this._modalOpen} node活动=${this.node.activeInHierarchy}`);
        // 现实纠偏：事件镜像说有弹窗，但实际所有弹窗都已关闭 → 复位（自愈 missed-false 卡死）
        if (this._modalOpen && !anyModalOpen()) {
            console.warn('[诊断] TaskBadge 模态镜像卡 true，已按现实复位');
            this._modalOpen = false;
        }
        if (this._modalOpen) {
            return; // 弹窗打开期间：不响应徽章点击，避免叠层误开
        }
        if (Vec2.distance(this._pressPos, pos) > TAP_SLOP) {
            return; // 位移过大：是从按钮处起始的瞄准拖拽，不当作点击
        }
        EventBus.emit(GameEvents.SHOW_DAILY_TASKS);
    }

    /** 手指滑出节点（取消触摸）：不触发点击 */
    private onTouchCancel(): void {}

    /** UI_MODAL_CHANGED：结算/奖励/商店/面板开合时同步互斥守卫（卡 true 由 onTouchEnd 现实纠偏自愈） */
    private onModalChanged(open: boolean): void {
        this._modalOpen = open === true;
    }

    /** 红点状态刷新：存在「已完成未领取」任务时点亮 */
    private refreshDot(): void {
        if (this._dot?.isValid) {
            this._dot.active = DailyTaskManager.hasClaimable();
        }
    }

    /** 纯代码构建徽章外观：半透明深暗色圆形底板 + 暗金细环 + 居中矢量图标 + 右上角红点（幂等重绘） */
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

        // 居中矢量写字板图标（幂等：mountIcon 同名子节点清空重绘；顺带清理历史 emoji Label）
        this.node.children.filter((c) => c.name === 'Label').forEach((c) => c.destroy());
        mountIcon(this.node, BADGE_ICON, BADGE_ICON_SIZE, Theme.white, 0, 0);
        // 热重载防御：历史实例遗留的旧红点先清空（曾堆出 130 个叠成粉圆色块），保证红点恒为 1 个
        this.node.children.filter((c) => c.name === 'ClaimDot').forEach((c) => c.destroy());
        this._dot = null;
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

