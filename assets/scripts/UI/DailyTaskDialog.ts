import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec3, tween, Tween,
    find, director, Director,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { DailyTaskManager } from '../Core/DailyTaskManager';
import type { DailyTaskInfo } from '../Core/DailyTaskManager';
import { Theme } from '../Core/ArtTheme';
import { mountIcon } from '../Core/IconLib';
import { raisedButton } from '../Core/UiKit';
import { closeAllModals } from '../Core/ModalGate';

const { ccclass } = _decorator;

// ---------- 面板样式（与 DeckViewDialog / ShopDialog 同一套 UI 语言：深蓝底 + 金标题 + 绿关闭） ----------
const PANEL_WIDTH = 620;
const PANEL_HEIGHT = 700;
const PANEL_COLOR = Theme.ui.panel;
const OVERLAY_WH = 2200;
const OVERLAY_COLOR = Theme.ui.overlay;
const TITLE_COLOR = Theme.ui.gold;
const SUBTITLE_COLOR = Theme.ui.header;
const TEXT_COLOR = Theme.ui.text;
/** 领取按钮三态：可领金色 / 未完成灰 / 已领暗灰 */
const CLAIM_COLOR = Theme.ui.goldDim;
const DISABLED_COLOR = Theme.ui.disabled;
const CLAIMED_COLOR = Theme.ui.disabledGray;
const CLOSE_BTN_COLOR = Theme.ui.green;
const CLOSE_BTN_BORDER = Theme.ui.gold;
const CONTENT_WIDTH = 520;

/**
 * 📋 每日任务面板：挂载在 Canvas/UILayer/DailyTaskDialog 节点上（ensureMounted 自举纯代码创建）。
 * - 监听 SHOW_DAILY_TASKS（📋 徽章轻点）打开面板：渲染当日 3 条任务（名称 / 进度 / 领取按钮），
 *   广播 UI_MODAL_CHANGED true 冻结发射，关闭时恢复；
 * - 领取：DailyTaskManager.claim 经 MetaManager.addShards 入账碎片（跨局生效），面板即时刷新；
 * - 弹窗为纯展示层，数据与状态全部来自 DailyTaskManager（跨日重置 / 存档均在其内部闭环）。
 */
@ccclass('DailyTaskDialog')
export class DailyTaskDialog extends Component {
    /** 场景启动自举是否已注册（幂等，防重复监听 director 事件） */
    private static _bootstrapped = false;

    /** SHOW_DAILY_TASKS 监听是否已注册（幂等） */
    private _listening = false;
    /** UI 是否已构建（幂等） */
    private _ready = false;
    /** 三行任务（与 DailyTaskManager.getTaskList() 固定顺序一一对应） */
    private _rows: { label: Label; btn: Node; btnLabel: Label }[] = [];

    /** 注册场景启动自举事件（幂等；模式同 DeckViewDialog.bootstrap，场景重载后幂等重挂） */
    static bootstrap(): void {
        if (DailyTaskDialog._bootstrapped) {
            return;
        }
        DailyTaskDialog._bootstrapped = true;
        director.on(Director.EVENT_AFTER_SCENE_LAUNCH, () => {
            // 📋 右上角每日任务徽章已下线（2026-09-04 用户要求取消）：面板保留，仅无呼出入口
            DailyTaskDialog.ensureMounted();
            // 场景刚启动完毕：全部模态弹窗一律复位为隐藏。场景文件可能残留 active=true 的
            // 弹窗节点（编辑器把热重载堆积的运行时脏数据固化进了场景，2026-09-04 排查），
            // 开场即常驻挡屏且未经 showDialog（任务行文字为空、模态状态错乱）。新场景加载完
            // 本就不该有任何弹窗开着，这是不变量；热重载不触发本事件，不影响调试中打开的弹窗。
            closeAllModals();
        });
    }

    /** 全局自举：幂等把本组件挂到 Canvas/UILayer/DailyTaskDialog（DeckManager.onLoad 主入口调用） */
    static ensureMounted(): void {
        const uiLayer = find('Canvas/UILayer');
        if (!uiLayer || !uiLayer.isValid) {
            return;
        }
        let node = uiLayer.getChildByName('DailyTaskDialog');
        if (!node?.isValid) {
            node = new Node('DailyTaskDialog');
            node.layer = uiLayer.layer;
            node.active = false; // 创建即隐藏：避免 start() 竞态（见下方注释）
            uiLayer.addChild(node);
        }
        // 热重载防御：只保留首个组件实例，多余销毁（与 DailyTaskBadge 同款——
        // 否则每次热重载重挂一个实例，buildUI 就会再堆一组子节点）
        const comps = node.getComponents(DailyTaskDialog);
        for (let i = 1; i < comps.length; i++) {
            comps[i].destroy();
        }
        if (comps.length === 0) {
            node.addComponent(DailyTaskDialog);
        }
    }

    protected start(): void {
        // 不再无条件 this.node.active = false：节点在 ensureMounted 创建时即为隐藏态，
        // 若热重载时弹窗正处于打开状态，start() 强行关闭会丢掉 UI_MODAL_CHANGED false
        // 广播，导致徽章/发射器模态镜像卡 true（弹窗消失但发射永久冻结）。
        this.ensureReady();
    }

    protected onEnable(): void {
        this.ensureReady();
    }

    protected onDestroy(): void {
        this._listening = false;
        EventBus.off(GameEvents.SHOW_DAILY_TASKS, this.showDialog, this);
    }

    /** 幂等初始化：注册监听 + 构建 UI（各自只执行一次） */
    private ensureReady(): void {
        if (!this._listening) {
            this._listening = true;
            EventBus.on(GameEvents.SHOW_DAILY_TASKS, this.showDialog, this);
        }
        if (!this._ready) {
            this._ready = true;
            this.buildUI();
        }
    }

    /** 打开面板：确保 UI 已构建（子节点丢失时重建）→ 刷新三行 → 冻结发射 → 弹性入场 */
    private showDialog(): void {
        if (!this.node?.isValid) {
            return;
        }
        // 防御性重建：start 时构建的 UI 若被中途清掉（热重载堆叠清理等），_ready 仍是 true 会
        // 激活一个空节点——模态锁上、屏幕无物。子节点数为 0 即强制重建（2026-09-03 排查）。
        this.ensureReady();
        if (this.node.children.length === 0) {
            console.warn('[诊断] DailyTaskDialog 子节点丢失，重建 UI');
            this._ready = false;
            this.ensureReady();
        }
        this.refreshRows();
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true); // 面板打开：冻结发射
        this.node.active = true;
        this.node.setPosition(0, 0, 0);
        this.node.setScale(1, 1, 1);
        this.playPopAnimation();
        const wp = this.node.worldPosition;
        console.log(`[诊断] DailyTaskDialog 打开: 层级有效=${this.node.activeInHierarchy} ` +
            `world=(${wp.x.toFixed(0)},${wp.y.toFixed(0)}) scale=${this.node.scale.x.toFixed(2)} ` +
            `children=${this.node.children.length} parent=${this.node.parent?.name ?? '无'}`);
    }

    /** 关闭面板：恢复发射 */
    private closeDialog(): void {
        if (!this.node?.isValid) {
            return;
        }
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, false); // 面板关闭：恢复发射
        this.node.active = false;
    }

    /** 渲染三行任务：主 Label（名称+奖励+进度）+ 按钮状态（可领金 / 未完成灰 / 已领暗灰） */
    private refreshRows(): void {
        const list = DailyTaskManager.getTaskList();
        list.forEach((info: DailyTaskInfo, i: number) => {
            const row = this._rows[i];
            if (!row?.label?.isValid) {
                return;
            }
            row.label.string = `${info.name}（奖励 ◆${info.reward}）\n${info.desc} · ${info.progress}/${info.target}`;
            const canClaim = DailyTaskManager.canClaim(info.id);
            const btnG = row.btn.getComponent(Graphics);
            if (btnG) {
                btnG.clear();
                raisedButton(btnG, 180, 44, info.claimed ? CLAIMED_COLOR : canClaim ? CLAIM_COLOR : DISABLED_COLOR, 10);
            }
            row.btnLabel.string = info.claimed ? '已领取 ✓' : canClaim ? '领 取' : '未完成';
        });
    }

    /** 点击领取行：可领则入账碎片并刷新；未完成 / 已领取静默忽略（按钮状态已示意） */
    private onClaimClick(index: number): void {
        const info = DailyTaskManager.getTaskList()[index];
        if (!info || !DailyTaskManager.canClaim(info.id)) {
            return;
        }
        const got = DailyTaskManager.claim(info.id);
        console.log(`[DailyTaskUI] 领取「${info.name}」奖励 ⚒${got}`);
        this.refreshRows();
    }

    // ---------- 纯代码 UI 构建（零 Inspector 配置；ShopDialog / DeckViewDialog 同款手法） ----------

    private buildUI(): void {
        // 幂等重建：热重载/重复挂载会让本函数反复执行（_ready 标志随实例重建丢失）。
        // Overlay/ClaimBtn 每次都是新建，若不先清旧节点，几十层全屏半透明遮罩会叠压到
        // 面板之上——屏幕被压黑、触摸全部被最上层遮罩拦截（关闭按钮/徽章点不动）。
        this.node.removeAllChildren();
        this._rows = [];
        // 0) 全屏暗色遮罩：拦截点击穿透到背后钉板/发射器（点遮罩不关闭，防战斗中误触丢失面板）
        const overlay = new Node('Overlay');
        overlay.layer = this.node.layer;
        this.node.addChild(overlay);
        const ovUi = overlay.addComponent(UITransform);
        ovUi.setContentSize(OVERLAY_WH, OVERLAY_WH);
        const ovG = overlay.addComponent(Graphics);
        ovG.fillColor = OVERLAY_COLOR;
        ovG.rect(-OVERLAY_WH / 2, -OVERLAY_WH / 2, OVERLAY_WH, OVERLAY_WH);
        ovG.fill();

        // 1) 面板底：圆角矩形
        const ui = this.getComponent(UITransform) ?? this.addComponent(UITransform);
        ui.setContentSize(PANEL_WIDTH, PANEL_HEIGHT);
        const bg = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        bg.clear();
        bg.fillColor = PANEL_COLOR;
        bg.roundRect(-PANEL_WIDTH / 2, -PANEL_HEIGHT / 2, PANEL_WIDTH, PANEL_HEIGHT, 18);
        bg.fill();

        // 2) 标题 / 副标题（标题左侧挂矢量写字板图标，与顶部徽章同源）
        const title = this.ensureLabel('Title', 0, 292, 34, '每日任务');
        title.color = TITLE_COLOR;
        mountIcon(this.node, 'clipboard', 30, TITLE_COLOR, -96, 292);
        const subtitle = this.ensureLabel('Subtitle', 0, 246, 18, '进度跨对局累计 · 每日 0 点刷新');
        subtitle.color = SUBTITLE_COLOR;

        // 3) 三行任务：主 Label（两行文本）+ 领取按钮（整钮可点）
        this._rows = [0, 1, 2].map((i) => {
            const rowY = 158 - i * 130;
            const label = this.ensureLabel(`Task${i}`, 0, rowY + 24, 20, '');
            label.color = TEXT_COLOR;
            const labelUi = label.getComponent(UITransform)!;
            labelUi.setContentSize(CONTENT_WIDTH, 64);

            const btn = new Node(`ClaimBtn${i}`);
            btn.layer = this.node.layer;
            this.node.addChild(btn);
            btn.addComponent(UITransform).setContentSize(180, 44);
            btn.setPosition(0, rowY - 34, 0);
            const g = btn.addComponent(Graphics);
            raisedButton(g, 180, 44, DISABLED_COLOR, 10);
            const btnLabelNode = new Node('BtnLabel');
            btnLabelNode.layer = btn.layer;
            btn.addChild(btnLabelNode);
            btnLabelNode.addComponent(UITransform).setContentSize(180, 44);
            const btnLabel = btnLabelNode.addComponent(Label);
            btnLabel.string = '未完成';
            btnLabel.fontSize = 20;
            btnLabel.lineHeight = 26;
            btnLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
            btnLabel.verticalAlign = Label.VerticalAlign.CENTER;
            btn.on(Node.EventType.TOUCH_END, () => this.onClaimClick(i), this);
            return { label, btn, btnLabel };
        });

        // 4) 关闭按钮：绿底金边（先解绑再绑，幂等安全）
        let closeBtn = this.node.getChildByName('CloseBtn');
        if (!closeBtn?.isValid) {
            closeBtn = new Node('CloseBtn');
            closeBtn.layer = this.node.layer;
            this.node.addChild(closeBtn);
            closeBtn.setPosition(0, -250, 0);
            closeBtn.addComponent(UITransform).setContentSize(260, 56);
            const cg = closeBtn.addComponent(Graphics);
            raisedButton(cg, 260, 56, CLOSE_BTN_COLOR, 12);
            cg.lineWidth = 2;
            cg.strokeColor = CLOSE_BTN_BORDER;
            cg.roundRect(-130, -28, 260, 56, 12);
            cg.stroke();
            const cl = new Node('Label');
            cl.layer = closeBtn.layer;
            closeBtn.addChild(cl);
            const clUi = cl.addComponent(UITransform);
            clUi.setContentSize(260, 56);
            const closeLabel = cl.addComponent(Label);
            closeLabel.string = '✕ 关 闭';
            closeLabel.fontSize = 22;
            closeLabel.lineHeight = 30;
            closeLabel.color = Theme.white;
            closeLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
            closeLabel.verticalAlign = Label.VerticalAlign.CENTER;
        }
        closeBtn.off(Node.EventType.TOUCH_END, this.closeDialog, this);
        closeBtn.on(Node.EventType.TOUCH_END, this.closeDialog, this);
    }

    /** 创建/复用文本 Label（显式宽度 + SHRINK 自缩：默认 100px 宽会把标题折行压到副标题上——字体叠加根源） */
    private ensureLabel(name: string, x: number, y: number, fontSize: number, text: string, width = 460): Label {
        let node = this.node.getChildByName(name);
        if (!node?.isValid) {
            node = new Node(name);
            node.layer = this.node.layer;
            this.node.addChild(node);
            node.setPosition(x, y, 0);
            node.addComponent(UITransform).setContentSize(width, fontSize + 16);
            const label = node.addComponent(Label);
            label.string = text;
            label.fontSize = fontSize;
            label.lineHeight = fontSize + 10;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.overflow = Label.Overflow.SHRINK;
        }
        return node.getComponent(Label)!;
    }

    /** 弹窗浮现动效：整体 0.8 → 1.06 → 1 弹性放大（与 RewardDialog / ShopDialog 保持一致手感） */
    private playPopAnimation(): void {
        const node = this.node;
        if (!node?.isValid) {
            return;
        }
        Tween.stopAllByTarget(node);
        node.setScale(0.8, 0.8, 1);
        tween(node)
            .to(0.09, { scale: new Vec3(1.06, 1.06, 1) })
            .to(0.06, { scale: new Vec3(1, 1, 1) })
            .start();
    }
}

// ---------- 模块级自举（DeckManager import 本模块即激活；onLoad 的 ensureMounted 为主入口，此处兜底场景重载重挂） ----------
DailyTaskDialog.bootstrap();
DailyTaskDialog.ensureMounted();

