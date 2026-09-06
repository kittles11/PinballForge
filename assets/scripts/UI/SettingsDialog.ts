/**
 * ⚙ 设置弹窗（纯代码 UI，ModalGate 模态模式）：音频开关（音乐 / 音效）。
 * - 监听 SHOW_SETTINGS（DeckViewDialog 底部「⚙ 设置」入口广播）打开面板；
 * - 开关读写 AudioManager.setMusicEnabled / setSfxEnabled（独立存档 key 即时持久化），
 *   音乐开关即时生效走 MusicManager.applyEnabled（关 → 停播 / 开 → 未终局则恢复起播）；
 * - 音效开关由 AudioManager 五个播放入口首行消费（playHit 等），零延迟生效。
 */
import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec3, tween, Tween, find,
    director, Director,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { AudioManager } from '../Core/AudioManager';
import { MusicManager } from '../Core/MusicManager';
import { Theme } from '../Core/ArtTheme';
import { raisedButton } from '../Core/UiKit';
import { closeAllModals } from '../Core/ModalGate';

const { ccclass } = _decorator;

// ---------- 面板样式（与 DeckViewDialog 同一套 UI 语言） ----------
const PANEL_WIDTH = 620;
const PANEL_HEIGHT = 460;
const OVERLAY_WH = 2200;
const CLOSE_BTN_COLOR = Theme.ui.green;
const CLOSE_BTN_BORDER = Theme.ui.gold;

@ccclass('SettingsDialog')
export class SettingsDialog extends Component {
    /** 场景启动自举是否已注册（幂等） */
    private static _bootstrapped = false;
    /** UI 是否已构建（幂等；热重载清空子节点后自动重建） */
    private _ready = false;

    /** 注册场景启动自举事件（幂等）：新场景重挂 + 全弹窗复位（模式同 DailyTaskDialog.bootstrap） */
    static bootstrap(): void {
        if (SettingsDialog._bootstrapped) {
            return;
        }
        SettingsDialog._bootstrapped = true;
        director.on(Director.EVENT_AFTER_SCENE_LAUNCH, () => {
            SettingsDialog.ensureMounted();
            closeAllModals();
        });
    }

    /** 幂等把本组件挂到 Canvas/UILayer/SettingsDialog（DailyTaskDialog.ensureMounted 同款） */
    static ensureMounted(): void {
        const uiLayer = find('Canvas/UILayer');
        if (!uiLayer || !uiLayer.isValid) {
            return;
        }
        let node = uiLayer.getChildByName('SettingsDialog');
        if (!node?.isValid) {
            node = new Node('SettingsDialog');
            node.layer = uiLayer.layer;
            node.active = false; // 创建即隐藏：showDialog 才激活
            uiLayer.addChild(node);
        }
        // 热重载防御：只保留首个组件实例，多余销毁
        const comps = node.getComponents(SettingsDialog);
        for (let i = 1; i < comps.length; i++) {
            comps[i].destroy();
        }
        if (comps.length === 0) {
            node.addComponent(SettingsDialog);
        }
    }

    /** SHOW_SETTINGS 回调（模块级接线）：确保挂载后打开面板 */
    static show(): void {
        SettingsDialog.ensureMounted();
        find('Canvas/UILayer/SettingsDialog')?.getComponent(SettingsDialog)?.showDialog();
    }

    /** 打开面板：幂等建 UI → 刷新开关文案 → 模态冻结发射 → 弹性浮现 */
    public showDialog(): void {
        if (!this.node?.isValid) {
            return;
        }
        this.ensureUI();
        this.refreshToggleLabels();
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true);
        this.node.active = true;
        Tween.stopAllByTarget(this.node);
        this.node.setScale(0.8, 0.8, 1);
        tween(this.node)
            .to(0.09, { scale: new Vec3(1.06, 1.06, 1) })
            .to(0.06, { scale: new Vec3(1, 1, 1) })
            .start();
        console.log('[Settings] ⚙ 设置面板已打开');
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

    /** 幂等构建整块 UI：遮罩 + 面板 + 标题 + 音乐/音效开关行 + 提示 + 关闭按钮 */
    private ensureUI(): void {
        if (this._ready) {
            if (this.node.children.length === 0) {
                this._ready = false; // 热重载防御：子节点被清则重建
            } else {
                return;
            }
        }
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
        // 2) 面板底 + 标题
        const panel = new Node('Panel');
        panel.layer = this.node.layer;
        this.node.addChild(panel);
        panel.addComponent(UITransform).setContentSize(PANEL_WIDTH, PANEL_HEIGHT);
        const pg = panel.addComponent(Graphics);
        raisedButton(pg, PANEL_WIDTH, PANEL_HEIGHT, Theme.ui.panel, 18);
        this.makeLabel('Title', 0, PANEL_HEIGHT / 2 - 56, 26, '⚙ 设 置', Theme.ui.gold, 480);
        // 3) 音乐 / 音效开关行（左文案右开关；开关即时持久化 + 即时生效）
        this.makeLabel('MusicLabel', -70, 60, 22, '🎵 音乐', Theme.ui.text, 260);
        this.createToggle('MusicToggle', 150, 60, () => {
            AudioManager.setMusicEnabled(!AudioManager.musicEnabled);
            MusicManager.applyEnabled(); // 即时生效：关 → 停播；开 → 非终局则恢复起播
            this.refreshToggleLabels();
        });
        this.makeLabel('SfxLabel', -70, -30, 22, '🔔 音效', Theme.ui.text, 260);
        this.createToggle('SfxToggle', 150, -30, () => {
            AudioManager.setSfxEnabled(!AudioManager.sfxEnabled);
            this.refreshToggleLabels(); // 播放入口首行门禁消费，无需额外处理
        });
        // 4) 提示 + 关闭按钮
        this.makeLabel('Hint', 0, -100, 15, '设置即时保存，重启后仍生效', Theme.ui.disabled, 480);
        this.makeTextButton('CloseBtn', 0, -170, 260, 56, CLOSE_BTN_COLOR, '✕ 关 闭', () => this.closeDialog(), CLOSE_BTN_BORDER);
        this._ready = true;
    }

    /** 创建/复用凸起按钮（raisedButton 绿底金边等 + 居中文案，幂等绑 TOUCH_END） */
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

    /** 创建/复用开关按钮（raisedButton 蓝底 + 「开/关」文案，TOUCH_END 走传入回调） */
    private createToggle(name: string, x: number, y: number, onToggle: () => void): void {
        let node = this.node.getChildByName(name);
        if (node?.isValid) {
            return;
        }
        node = new Node(name);
        node.layer = this.node.layer;
        this.node.addChild(node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(150, 48);
        const g = node.addComponent(Graphics);
        raisedButton(g, 150, 48, Theme.ui.blueActive, 10);
        const labelNode = new Node('Label');
        labelNode.layer = node.layer;
        node.addChild(labelNode);
        labelNode.addComponent(UITransform).setContentSize(150, 48);
        const label = labelNode.addComponent(Label);
        label.fontSize = 20;
        label.lineHeight = 26;
        label.color = Theme.white.clone();
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        node.on(Node.EventType.TOUCH_END, onToggle, this);
    }

    /** 刷新两个开关文案（打开面板与每次点击后调用） */
    private refreshToggleLabels(): void {
        const set = (name: string, on: boolean) => {
            const lbl = this.node.getChildByName(name)?.getChildByName('Label')?.getComponent(Label);
            if (lbl?.isValid) {
                lbl.string = on ? '开 ✓' : '关';
            }
        };
        set('MusicToggle', AudioManager.musicEnabled);
        set('SfxToggle', AudioManager.sfxEnabled);
    }
}

// ---------- 模块级自举：DeckViewDialog import 本模块即完成接线（不依赖节点激活态） ----------
SettingsDialog.bootstrap();
EventBus.on(GameEvents.SHOW_SETTINGS, SettingsDialog.show, SettingsDialog);
SettingsDialog.ensureMounted(); // 场景已就绪（热重载）时立即挂；冷启动由 AFTER_SCENE_LAUNCH 重挂
