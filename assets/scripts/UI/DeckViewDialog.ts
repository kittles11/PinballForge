import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec3, tween, Tween, find,
    director, Director,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { DeckManager } from '../Core/DeckManager';
import { RelicManager } from '../Core/RelicManager';
import { OrbType, RelicType, RELIC_DATABASE, ALL_RELIC_TYPES } from '../Core/DataModels';
import { orbTrailColor, Theme } from '../Core/ArtTheme';
import { mountIcon } from '../Core/IconLib';
import { raisedButton } from '../Core/UiKit';
import { SignInDialog } from './SignInDialog'; // 模块导入即完成 SHOW_SIGNIN 接线（含 AFTER_SCENE_LAUNCH 自举）
import { SettingsDialog } from './SettingsDialog'; // 模块导入即完成 SHOW_SETTINGS 接线

const { ccclass } = _decorator;

// ---------- 纯代码 UI 样式（无 Inspector 布置时自动构建整套背包界面，与 ShopDialog 同款风格） ----------
const PANEL_WIDTH = 660;
const PANEL_HEIGHT = 760;
const PANEL_COLOR = Theme.ui.panel;
/** 全屏暗色半透明遮罩（防止点击穿透到背后钉板/发射器；远大于 720×1280 画布，任何分辨率下都铺满） */
const OVERLAY_WH = 2200;
const OVERLAY_COLOR = Theme.ui.overlay;
/** 标题金色 / 分区标题淡蓝 / 正文浅灰 */
const TITLE_COLOR = Theme.ui.gold;
const HEADER_COLOR = Theme.ui.header;
const TEXT_COLOR = Theme.ui.text;
/** 关闭按钮（绿底金边，与「继续下一关」同色系） */
const CLOSE_BTN_COLOR = Theme.ui.green;
const CLOSE_BTN_BORDER = Theme.ui.gold;
/** 内容区统一宽度 */
const CONTENT_WIDTH = 600;

/** 球种 → 图标（IconLib 图标名）/ 显示名（命名与战后卡牌奖励对齐：裂变雷球 / 重力熔岩球 / 霜冻冰球） */
const ORB_DISPLAY: { type: OrbType; icon: string; name: string }[] = [
    { type: OrbType.Normal, icon: 'orbPlain', name: '普通弹珠' },
    { type: OrbType.Lightning, icon: 'bolt', name: '裂变雷球' },
    { type: OrbType.Lava, icon: 'flame', name: '重力熔岩球' },
    { type: OrbType.Frost, icon: 'snow', name: '霜冻冰球' },
    { type: OrbType.Plasma, icon: 'plasma', name: '等离子球' },
    { type: OrbType.Magma, icon: 'magma', name: '熔核球' },
    { type: OrbType.Leech, icon: 'drop', name: '吸血球' },
];

/**
 * 🎒 牌库与遗物背包弹窗：挂载在 Canvas/UILayer/DeckViewDialog 节点上。
 * - 监听 SHOW_DECK_VIEW（顶部 🎒 牌库按钮广播）随时打开，局内查看完整卡组与遗物详情；
 * - showDialog：统计 DeckManager.instance.masterDeck 各球种数量格式化文本 +
 *   遍历 RelicManager.ownedRelics 从 RELIC_DATABASE 读取名称与被动效果描述 +
 *   广播 UI_MODAL_CHANGED true 冻结发射 + 播放弹性弹出动效；
 * - closeDialog：面板平滑收起（缩小淡出）后隐藏，广播 UI_MODAL_CHANGED false 恢复发射器瞄准发射；
 * - 场景未布置节点时由本模块底部自举（ensureMounted）纯代码创建，Inspector 拖入同名
 *   子节点 DeckContentLabel / RelicContentLabel 可定制布局。
 */
@ccclass('DeckViewDialog')
export class DeckViewDialog extends Component {
    /** 场景启动自举是否已注册（幂等，防重复监听） */
    private static _bootstrapped = false;

    /** SHOW_DECK_VIEW 监听是否已注册（幂等） */
    private _listening = false;
    /** UI 是否已构建 + 关闭按钮已绑定（幂等） */
    private _ready = false;
    /** 两个分区标题（代码创建，用于刷新「（X/8 颗）」计数） */
    private _deckHeader: Label | null = null;
    private _relicHeader: Label | null = null;

    /** 全局自举：幂等把本组件挂到 Canvas/UILayer/DeckViewDialog（模式与 RelicManager.ensureMounted 一致） */
    static ensureMounted(): void {
        const uiLayer = find('Canvas/UILayer');
        if (!uiLayer || !uiLayer.isValid) {
            return;
        }
        let node = uiLayer.getChildByName('DeckViewDialog');
        if (!node?.isValid) {
            node = new Node('DeckViewDialog');
            node.layer = uiLayer.layer;
            node.active = false; // 创建即隐藏：避免 start() 竞态（热重载时误关打开中的弹窗）
            uiLayer.addChild(node);
        }
        // 热重载防御：只保留首个组件实例，多余销毁（与 DailyTaskBadge 同款）
        const comps = node.getComponents(DeckViewDialog);
        for (let i = 1; i < comps.length; i++) {
            comps[i].destroy();
        }
        if (comps.length === 0) {
            node.addComponent(DeckViewDialog);
        }
    }

    /** 注册场景启动自举事件（幂等；模块加载时调用，模式同 BoardDeflectorManager.bootstrap） */
    static bootstrap(): void {
        if (DeckViewDialog._bootstrapped) {
            return;
        }
        DeckViewDialog._bootstrapped = true;
        director.on(Director.EVENT_AFTER_SCENE_LAUNCH, DeckViewDialog.ensureMounted, DeckViewDialog);
    }

    protected start(): void {
        // 默认隐藏弹窗：仅在 SHOW_DECK_VIEW 事件时展示
        this.node.active = false;
        this.ensureReady();
    }

    protected onEnable(): void {
        // 兜底：节点被外部隐藏/恢复时，保证监听与 UI 始终可用
        this.ensureReady();
    }

    protected onDestroy(): void {
        EventBus.off(GameEvents.SHOW_DECK_VIEW, this.showDialog, this);
        if (this.node?.isValid) {
            Tween.stopAllByTarget(this.node);
        }
    }

    /** 幂等初始化：注册 SHOW_DECK_VIEW 监听 + 构建整套装牌 UI（各自只执行一次） */
    private ensureReady(): void {
        if (!this._listening) {
            this._listening = true;
            EventBus.on(GameEvents.SHOW_DECK_VIEW, this.showDialog, this);
        }
        if (this._ready || !this.node?.isValid) {
            return;
        }
        this._ready = true;
        this.buildUI();
    }
    // ---------- 打开 / 关闭 ----------

    /** 打开背包面板：刷新数据 → 冻结发射 → 激活并播放弹性动效 */
    public showDialog(): void {
        if (!this.node?.isValid) {
            return;
        }
        this.ensureReady();
        // 防御性重建：构建好的 UI 若被热重载/清理清掉子节点，_ready 仍为 true 会激活空节点
        if (this.node.children.length === 0) {
            console.warn('[诊断] DeckViewDialog 子节点丢失，重建 UI');
            this._ready = false;
            this.ensureReady();
        }
        this.refreshContent();
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true); // 弹窗打开：冻结发射
        this.node.active = true;
        this.playPopAnimation();
        console.log('[DeckView] 🎒 牌库与遗物背包已打开（发射已冻结）');
    }

    /** 关闭背包面板：平滑收起后隐藏，恢复发射器瞄准发射 */
    public closeDialog(): void {
        if (!this.node?.isValid || !this.node.activeInHierarchy) {
            return;
        }
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, false); // 弹窗关闭：恢复发射
        Tween.stopAllByTarget(this.node);
        tween(this.node)
            .to(0.1, { scale: new Vec3(0.85, 0.85, 1) })
            .call(() => {
                if (this.node?.isValid) {
                    this.node.active = false;
                    this.node.setScale(1, 1, 1);
                }
            })
            .start();
    }

    // ---------- 数据格式化 ----------

    /** 打开时刷新全部内容：牌库行 / 遗物行 / 分区计数（保证每次看到的是当前最新状态） */
    private refreshContent(): void {
        const deck = DeckManager.instance;
        if (this._deckHeader?.isValid) {
            this._deckHeader.string = `牌库（${deck?.getDeckSize() ?? 0}/${deck?.maxDeckSize ?? 8} 颗）`;
        }
        this.rebuildRows('DeckRows', 0, 200, 140, this.collectDeckRows(deck));
        if (this._relicHeader?.isValid) {
            this._relicHeader.string = `遗物（${RelicManager.getRelics().length}/${ALL_RELIC_TYPES.length}）`;
        }
        this.rebuildRows('RelicRows', 0, -42, 224, this.collectRelicRows());
    }

    // ---------- 逐行「矢量图标 + 文字」内容渲染（替代原 emoji 多行 Label：字形跨平台一致 + 可染色） ----------

    /** 牌库行：单遍统计 masterDeck 各球种数量，按固定球种顺序输出（数量为 0 的不显示；图标染球种主题色） */
    private collectDeckRows(deck: DeckManager | null): { icon: string; tint: Color | null; text: string }[] {
        const masterDeck = deck?.masterDeck;
        if (!masterDeck || masterDeck.length === 0) {
            return [{ icon: 'orbPlain', tint: Theme.ui.gray, text: '牌库为空' }];
        }
        const counts = new Map<number, number>();
        for (const type of masterDeck) {
            counts.set(type, (counts.get(type) ?? 0) + 1);
        }
        const rows: { icon: string; tint: Color | null; text: string }[] = [];
        for (const display of ORB_DISPLAY) {
            const count = counts.get(display.type) ?? 0;
            if (count > 0) {
                rows.push({ icon: display.icon, tint: orbTrailColor(display.type), text: `${display.name} × ${count}` });
            }
        }
        return rows;
    }

    /** 遗物行：遍历已拥有遗物，从 RELIC_DATABASE 读取图标与被动效果描述 */
    private collectRelicRows(): { icon: string; tint: Color | null; text: string }[] {
        const relics: RelicType[] = RelicManager.getRelics();
        if (relics.length === 0) {
            return [{ icon: 'gem', tint: Theme.ui.gray, text: '暂无遗物（通关第 5 / 10 关开启传奇藏宝箱获得）' }];
        }
        return relics.map((type) => {
            const info = RELIC_DATABASE[type];
            return { icon: info.icon, tint: Theme.ui.gold, text: `${info.name}：${info.desc}` };
        });
    }

    /** 重建一个行容器：n 行在 height 内均分布局，每行 = 左侧矢量图标 + 左对齐文本（幂等重建） */
    private rebuildRows(
        containerName: string, x: number, y: number, height: number,
        rows: { icon: string; tint: Color | null; text: string }[],
    ): void {
        let container = this.node.getChildByName(containerName);
        if (!container?.isValid) {
            container = new Node(containerName);
            container.layer = this.node.layer;
            container.addComponent(UITransform).setContentSize(CONTENT_WIDTH, height);
            container.setPosition(x, y, 0);
            this.node.addChild(container);
        }
        for (const child of [...container.children]) {
            child.destroy();
        }
        container.removeAllChildren();

        const rowH = Math.min(34, height / Math.max(rows.length, 1));
        const startY = height / 2 - rowH / 2;
        rows.forEach((row, i) => {
            const rowNode = new Node(`Row_${i}`);
            rowNode.layer = container!.layer;
            container!.addChild(rowNode);
            rowNode.setPosition(0, startY - i * rowH, 0);

            mountIcon(rowNode, row.icon, 22, row.tint ?? TEXT_COLOR, -CONTENT_WIDTH / 2 + 16, 0);
            const labelNode = new Node('Text');
            labelNode.layer = rowNode.layer;
            rowNode.addChild(labelNode);
            labelNode.addComponent(UITransform).setContentSize(CONTENT_WIDTH - 40, rowH - 4);
            const label = labelNode.addComponent(Label);
            label.string = row.text;
            label.fontSize = rowH >= 30 ? 19 : 17;
            label.lineHeight = rowH - 4;
            label.color = TEXT_COLOR;
            label.horizontalAlign = Label.HorizontalAlign.LEFT;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.overflow = Label.Overflow.SHRINK;
        });
    }

    // ---------- 纯代码 UI 构建（Editor 未布置同名子节点时兜底） ----------

    private buildUI(): void {
        // 0) 全屏暗色遮罩：置于最底层，拦截点击穿透到背后钉板/发射器；点遮罩任意处也可关闭
        const overlay = new Node('DeckOverlay');
        overlay.layer = this.node.layer;
        overlay.getComponent(UITransform) ?? overlay.addComponent(UITransform);
        overlay.getComponent(UITransform)!.setContentSize(OVERLAY_WH, OVERLAY_WH);
        const ovG = overlay.addComponent(Graphics);
        ovG.fillColor = OVERLAY_COLOR;
        ovG.rect(-OVERLAY_WH / 2, -OVERLAY_WH / 2, OVERLAY_WH, OVERLAY_WH);
        ovG.fill();
        this.node.addChild(overlay);
        overlay.setPosition(0, 0, 0);
        overlay.setSiblingIndex(0);
        overlay.on(Node.EventType.TOUCH_END, this.closeDialog, this);

        // 1) 面板背景：自身节点补 UITransform + Graphics 圆角矩形
        const ui = this.getComponent(UITransform) ?? this.addComponent(UITransform);
        ui.setContentSize(PANEL_WIDTH, PANEL_HEIGHT);
        const bg = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        bg.clear();
        bg.fillColor = PANEL_COLOR;
        bg.roundRect(-PANEL_WIDTH / 2, -PANEL_HEIGHT / 2, PANEL_WIDTH, PANEL_HEIGHT, 18);
        bg.fill();

        // 2) 标题 + 两个分区标题（纯文本；标题左侧挂矢量背包图标）
        const title = this.ensureLabel('DeckViewTitle', 0, 336, 30, '牌库与遗物背包', 520, 44);
        if (title?.isValid) {
            title.color = TITLE_COLOR;
            mountIcon(this.node, 'bag', 26, TITLE_COLOR, -140, 336);
        }
        this._deckHeader = this.ensureLabel('DeckHeader', 0, 278, 22, '牌库', 520, 34);
        if (this._deckHeader?.isValid) {
            this._deckHeader.color = HEADER_COLOR;
        }
        this._relicHeader = this.ensureLabel('RelicHeader', 0, 104, 22, '遗物', 520, 34);
        if (this._relicHeader?.isValid) {
            this._relicHeader.color = HEADER_COLOR;
        }

        // 3) 关闭按钮（凸起浮雕样式）+ 底部工具入口（📅 签到 / ⚙ 设置）
        this.createCloseButton();
        this.createUtilityButton('SignInEntryBtn', 237, '签到', GameEvents.SHOW_SIGNIN);
        this.createUtilityButton('SettingsEntryBtn', -237, '设置', GameEvents.SHOW_SETTINGS);
    }

    /**
     * 底部工具入口按钮（与 CloseBtn 同行两侧，x=±237 不与居中关闭钮重叠）：
     * 点击先关背包再广播对应 SHOW_* 事件（弹窗本体由各自模块自举挂载到 UILayer）。
     */
    private createUtilityButton(name: string, x: number, text: string, evt: GameEvents): void {
        let node = this.node.getChildByName(name);
        if (!node?.isValid) {
            node = new Node(name);
            node.layer = this.node.layer;
            this.node.addChild(node);
            node.addComponent(UITransform).setContentSize(150, 56);
            const g = node.addComponent(Graphics);
            raisedButton(g, 150, 56, Theme.ui.blueActive, 12);
            const labelNode = new Node('Label');
            labelNode.layer = node.layer;
            node.addChild(labelNode);
            labelNode.addComponent(UITransform).setContentSize(150, 56);
            const label = labelNode.addComponent(Label);
            label.fontSize = 20;
            label.lineHeight = 26;
            label.color = Theme.white.clone();
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            // 只在创建分支绑定一次（热重载重建子节点后走新建分支重新绑定）
            node.on(Node.EventType.TOUCH_END, () => {
                this.closeDialog();
                EventBus.emit(evt);
            }, this);
        }
        node.setPosition(x, -320, 0);
        const lbl = node.getChildByName('Label')?.getComponent(Label);
        if (lbl?.isValid) {
            lbl.string = text;
        }
    }

    /** 创建/复用分区标题等单行 Label：优先 Editor 已布置的同名子节点，否则纯代码创建 */
    private ensureLabel(name: string, x: number, y: number, fontSize: number, text: string, width: number, height: number): Label | null {
        let node = this.node.getChildByName(name);
        if (!node?.isValid) {
            node = new Node(name);
            node.layer = this.node.layer;
            this.node.addChild(node);
        }
        node.setPosition(x, y, 0);
        const ui = node.getComponent(UITransform) ?? node.addComponent(UITransform);
        ui.setContentSize(width, height);
        const label = node.getComponent(Label) ?? node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 8;
        label.color = TEXT_COLOR;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;
        return label;
    }

    /** 底部关闭按钮：凸起浮雕绿底 + 金描边 + 文字（幂等绑定 TOUCH_END） */
    private createCloseButton(): void {
        let node = this.node.getChildByName('CloseBtn');
        if (!node?.isValid) {
            node = new Node('CloseBtn');
            node.layer = this.node.layer;
            this.node.addChild(node);
            node.setPosition(0, -320, 0);
            const ui = node.addComponent(UITransform);
            ui.setContentSize(260, 56);
            const g = node.addComponent(Graphics);
            raisedButton(g, 260, 56, CLOSE_BTN_COLOR, 12);
            g.lineWidth = 2;
            g.strokeColor = CLOSE_BTN_BORDER;
            g.roundRect(-130, -28, 260, 56, 12);
            g.stroke();
            const labelNode = new Node('Label');
            labelNode.layer = node.layer;
            node.addChild(labelNode);
            const label = labelNode.addComponent(Label);
            label.string = '✕ 关 闭';
            label.fontSize = 22;
            label.lineHeight = 30;
            label.color = Theme.white;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
        }
        // 先解绑再绑，幂等安全
        node.off(Node.EventType.TOUCH_END, this.closeDialog, this);
        node.on(Node.EventType.TOUCH_END, this.closeDialog, this);
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

// ---------- 模块级自举（解除 DeckManager → 本弹窗的循环引用） ----------
// DeckManager 不再负责挂载本弹窗：模块加载即兜底挂载 + 每次场景启动后幂等重挂（重开局自动重建）。
// 依赖方向恒为 本弹窗 → DeckManager（单向），与 BoardDeflectorManager 的自举模式一致。
DeckViewDialog.bootstrap();
DeckViewDialog.ensureMounted();
// 显式加载两个子面板模块：其模块底部自举完成 SHOW_SIGNIN / SHOW_SETTINGS 接线（幂等）
SignInDialog.bootstrap();
SettingsDialog.bootstrap();
