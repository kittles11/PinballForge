/**
 * 📅 七日签到弹窗（纯代码 UI，ModalGate 模态模式，与 DailyTaskDialog 同构）：
 * - 监听 SHOW_SIGNIN（DeckViewDialog 底部「📅 签到」入口广播）打开面板；
 * - 渲染 SIGNIN_REWARDS 七日奖励表三态（已签灰 ✓ / 今日可签金 / 未来暗），
 *   「签到领取」按钮走 SignInManager.sign()（碎片入账 / 埋点 / 循环制指针推进在其内部闭环）；
 * - 弹窗为纯展示层：签到状态 / 奖励表 / 断签循环全部由 SignInManager 持有并持久化。
 */
import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec3, tween, Tween, find,
    director, Director,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { SignInManager, SIGNIN_REWARDS } from '../Core/SignInManager';
import { Theme } from '../Core/ArtTheme';
import { raisedButton } from '../Core/UiKit';
import { closeAllModals } from '../Core/ModalGate';

const { ccclass } = _decorator;

// ---------- 面板样式（与 DailyTaskDialog / DeckViewDialog 同一套 UI 语言：深蓝底 + 金标题 + 绿关闭） ----------
const PANEL_WIDTH = 620;
const PANEL_HEIGHT = 640;
const OVERLAY_WH = 2200;
const CLAIM_COLOR = Theme.ui.goldDim;
const CLAIMED_COLOR = Theme.ui.disabledGray;
const DISABLED_COLOR = Theme.ui.disabled;
const CLOSE_BTN_COLOR = Theme.ui.green;
const CLOSE_BTN_BORDER = Theme.ui.gold;
/** 七日格：76×100，横向 7 枚（含间距总宽 568 < 620 面板宽） */
const CELL_W = 76;
const CELL_H = 100;
const CELL_GAP = 6;

@ccclass('SignInDialog')
export class SignInDialog extends Component {
    /** 场景启动自举是否已注册（幂等，防重复监听 director 事件） */
    private static _bootstrapped = false;
    /** UI 是否已构建（幂等；热重载清空子节点后自动重建） */
    private _ready = false;
    /** 七日格引用（refresh 按状态重画底色 / 描边与文案） */
    private _cells: { g: Graphics; rewardLabel: Label; stateLabel: Label }[] = [];
    private _signBtn: Node | null = null;
    private _signBtnLabel: Label | null = null;
    private _statusLabel: Label | null = null;

    /** 注册场景启动自举事件（幂等）：新场景重挂 + 全弹窗复位（模式同 DailyTaskDialog.bootstrap） */
    static bootstrap(): void {
        if (SignInDialog._bootstrapped) {
            return;
        }
        SignInDialog._bootstrapped = true;
        director.on(Director.EVENT_AFTER_SCENE_LAUNCH, () => {
            SignInDialog.ensureMounted();
            closeAllModals();
        });
    }

    /** 幂等把本组件挂到 Canvas/UILayer/SignInDialog（DailyTaskDialog.ensureMounted 同款） */
    static ensureMounted(): void {
        const uiLayer = find('Canvas/UILayer');
        if (!uiLayer || !uiLayer.isValid) {
            return;
        }
        let node = uiLayer.getChildByName('SignInDialog');
        if (!node?.isValid) {
            node = new Node('SignInDialog');
            node.layer = uiLayer.layer;
            node.active = false; // 创建即隐藏：showDialog 才激活
            uiLayer.addChild(node);
        }
        // 热重载防御：只保留首个组件实例，多余销毁
        const comps = node.getComponents(SignInDialog);
        for (let i = 1; i < comps.length; i++) {
            comps[i].destroy();
        }
        if (comps.length === 0) {
            node.addComponent(SignInDialog);
        }
    }

    /** SHOW_SIGNIN 回调（模块级接线）：确保挂载后打开面板 */
    static show(): void {
        SignInDialog.ensureMounted();
        find('Canvas/UILayer/SignInDialog')?.getComponent(SignInDialog)?.showDialog();
    }

    /** 打开面板：幂等建 UI → 刷新 → 模态冻结发射 → 弹性浮现 */
    public showDialog(): void {
        if (!this.node?.isValid) {
            return;
        }
        this.ensureUI();
        this.refresh();
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true);
        this.node.active = true;
        Tween.stopAllByTarget(this.node);
        this.node.setScale(0.8, 0.8, 1);
        tween(this.node)
            .to(0.09, { scale: new Vec3(1.06, 1.06, 1) })
            .to(0.06, { scale: new Vec3(1, 1, 1) })
            .start();
        console.log('[SignIn] 📅 七日签到面板已打开');
    }

    /** 关闭面板：恢复发射 */
    private closeDialog(): void {
        if (!this.node?.isValid || !this.node.activeInHierarchy) {
            return;
        }
        this.node.active = false;
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, false);
    }

    protected onDestroy(): void {
        this._ready = false;
    }

    /** 幂等构建整块 UI（纯 Graphics + Label）：遮罩 + 面板 + 标题 + 七日格 + 双按钮 */
    private ensureUI(): void {
        if (this._ready) {
            if (this.node.children.length === 0) {
                this._ready = false; // 热重载防御：子节点被清则重建
            } else {
                return;
            }
        }
        this._cells = [];
        // 1) 全屏遮罩（防点击穿透；点击遮罩即关闭）
        const overlay = new Node('Overlay');
        overlay.layer = this.node.layer;
        this.node.addChild(overlay);
        overlay.addComponent(UITransform).setContentSize(OVERLAY_WH, OVERLAY_WH);
        const og = overlay.addComponent(Graphics);
        og.fillColor = Theme.ui.overlay;
        og.rect(-OVERLAY_WH / 2, -OVERLAY_WH / 2, OVERLAY_WH, OVERLAY_WH);
        og.fill();
        overlay.on(Node.EventType.TOUCH_END, () => this.closeDialog(), this);
        // 2) 面板底（凸起浮雕深蓝）
        const panel = new Node('Panel');
        panel.layer = this.node.layer;
        this.node.addChild(panel);
        panel.addComponent(UITransform).setContentSize(PANEL_WIDTH, PANEL_HEIGHT);
        const pg = panel.addComponent(Graphics);
        raisedButton(pg, PANEL_WIDTH, PANEL_HEIGHT, Theme.ui.panel, 18);
        // 3) 标题 / 副标题
        this.makeLabel('Title', 0, PANEL_HEIGHT / 2 - 56, 26, '📅 七日签到', Theme.ui.gold, 480);
        this.makeLabel('Subtitle', 0, PANEL_HEIGHT / 2 - 96, 16, '连续签到奖励递增 · 断签不清零 · 第 8 天循环回第 1 格', Theme.ui.header, 540);
        // 4) 七日格（位置固定，refresh 只重画与改文案）
        const totalW = 7 * CELL_W + 6 * CELL_GAP;
        for (let i = 0; i < 7; i++) {
            const cell = new Node(`Day${i + 1}`);
            cell.layer = this.node.layer;
            this.node.addChild(cell);
            cell.setPosition(-totalW / 2 + CELL_W / 2 + i * (CELL_W + CELL_GAP), 70, 0);
            cell.addComponent(UITransform).setContentSize(CELL_W, CELL_H);
            const g = cell.addComponent(Graphics);
            this.makeLabel(`DayLabel${i + 1}`, cell.position.x, 70 + CELL_H / 2 - 18, 15, `D${i + 1}`, Theme.ui.text, CELL_W);
            const rewardLabel = this.makeLabel(`RewardLabel${i + 1}`, cell.position.x, 68, 18, `⚒${SIGNIN_REWARDS[i] ?? 0}`, Theme.white, CELL_W);
            const stateLabel = this.makeLabel(`StateLabel${i + 1}`, cell.position.x, 70 - CELL_H / 2 + 16, 13, '', Theme.ui.text, CELL_W);
            this._cells.push({ g, rewardLabel, stateLabel });
        }
        // 5) 状态行 + 领取按钮 + 关闭按钮
        this._statusLabel = this.makeLabel('Status', 0, -34, 18, '', Theme.ui.text, 560);
        this._signBtn = this.makeTextButton('SignBtn', 0, -120, 260, 56, CLAIM_COLOR, '', () => this.onSignClick());
        this._signBtnLabel = this._signBtn.getChildByName('Label')?.getComponent(Label) ?? null;
        this.makeTextButton('CloseBtn', 0, -230, 260, 56, CLOSE_BTN_COLOR, '✕ 关 闭', () => this.closeDialog(), CLOSE_BTN_BORDER);
        this._ready = true;
    }

    /** 创建/复用单行 Label（显式宽度 + SHRINK 自缩，防窄宽折行叠加） */
    private makeLabel(name: string, x: number, y: number, fontSize: number, text: string, color: Color, width: number): Label {
        let node = this.node.getChildByName(name);
        if (!node?.isValid) {
            node = new Node(name);
            node.layer = this.node.layer;
            this.node.addChild(node);
            node.addComponent(UITransform).setContentSize(width, fontSize + 16);
        }
        node.setPosition(x, y, 0);
        const label = node.getComponent(Label) ?? node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 8;
        label.color = color.clone();
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;
        return label;
    }

    /** 创建/复用凸起按钮（raisedButton 金/绿底 + 居中文案，幂等绑 TOUCH_END） */
    private makeTextButton(name: string, x: number, y: number, w: number, h: number, color: Color, text: string, onClick: () => void, border?: Color): Node {
        let node = this.node.getChildByName(name);
        if (!node?.isValid) {
            node = new Node(name);
            node.layer = this.node.layer;
            this.node.addChild(node);
            node.addComponent(UITransform).setContentSize(w, h);
            const g = node.addComponent(Graphics);
            raisedButton(g, w, h, color, 12);
            if (border) {
                g.lineWidth = 2;
                g.strokeColor = border;
                g.roundRect(-w / 2, -h / 2, w, h, 12);
                g.stroke();
            }
            const labelNode = new Node('Label');
            labelNode.layer = node.layer;
            node.addChild(labelNode);
            labelNode.addComponent(UITransform).setContentSize(w, h);
            const label = labelNode.addComponent(Label);
            label.fontSize = 21;
            label.lineHeight = 28;
            label.color = Theme.white.clone();
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            node.on(Node.EventType.TOUCH_END, onClick, this);
        }
        node.setPosition(x, y, 0);
        const lbl = node.getChildByName('Label')?.getComponent(Label);
        if (lbl?.isValid && text) {
            lbl.string = text;
        }
        return node;
    }

    /** 按签到状态刷新：七日格三态（金=今日可签 / 灰✓=已签 / 暗=未来）+ 按钮可用性 + 状态行 */
    private refresh(): void {
        const canSign = SignInManager.canSign();
        const cycleDay = SignInManager.getCycleDay(); // 循环制指针：下一签落在第几格（1~7）
        for (let i = 0; i < this._cells.length; i++) {
            const cell = this._cells[i];
            if (!cell.g?.isValid) {
                continue;
            }
            const day = i + 1;
            const isToday = canSign && day === cycleDay;
            const isDone = day < cycleDay;
            const g = cell.g;
            g.clear();
            g.fillColor = isToday ? CLAIM_COLOR : (isDone ? CLAIMED_COLOR : DISABLED_COLOR);
            g.roundRect(-CELL_W / 2, -CELL_H / 2, CELL_W, CELL_H, 10);
            g.fill();
            if (isToday) {
                g.lineWidth = 2;
                g.strokeColor = Theme.ui.gold;
                g.roundRect(-CELL_W / 2, -CELL_H / 2, CELL_W, CELL_H, 10);
                g.stroke();
            }
            cell.rewardLabel.string = `⚒${SIGNIN_REWARDS[i] ?? 0}`;
            cell.stateLabel.string = isToday ? '今日' : (isDone ? '✓' : (!canSign && day === cycleDay ? '明天' : ''));
        }
        if (this._signBtn?.isValid) {
            this._signBtn.active = canSign;
        }
        if (this._signBtnLabel?.isValid) {
            this._signBtnLabel.string = `签 到 领取 ⚒${SignInManager.getNextReward()}`;
        }
        if (this._statusLabel?.isValid) {
            this._statusLabel.string = canSign
                ? `即将进行第 ${SignInManager.getTotalSigns() + 1} 次签到`
                : `今日已签 ✓（累计 ${SignInManager.getTotalSigns()} 次）· 明天再来`;
        }
    }

    /** 签到：SignInManager.sign 内部完成入账 / 埋点 / 指针推进，这里只刷新展示 */
    private onSignClick(): void {
        const got = SignInManager.sign();
        if (got > 0) {
            console.log(`[SignIn] 签到成功 ⚒${got}（面板即时刷新）`);
        }
        this.refresh();
    }
}

// ---------- 模块级自举：DeckViewDialog import 本模块即完成接线（不依赖节点激活态） ----------
SignInDialog.bootstrap();
EventBus.on(GameEvents.SHOW_SIGNIN, SignInDialog.show, SignInDialog);
SignInDialog.ensureMounted(); // 场景已就绪（热重载）时立即挂；冷启动由 AFTER_SCENE_LAUNCH 重挂
