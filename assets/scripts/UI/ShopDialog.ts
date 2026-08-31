import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec3, tween, Tween,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { GoldManager } from '../Core/GoldManager';
import { DeckManager } from '../Core/DeckManager';
import { CastleController } from '../Battle/CastleController';
import { AudioManager } from '../Core/AudioManager';
import { OrbType } from '../Core/DataModels';

const { ccclass, property } = _decorator;

// ---------- 商品价格（金币） ----------
const BUY_LIGHTNING_PRICE = 85;
const BUY_LAVA_PRICE = 85;
const REMOVE_BASE_PRICE = 80;   // 删卡基础价（首次）
const REMOVE_STEP_PRICE = 25;   // 删卡阶梯涨幅
const REPAIR_CASTLE_PRICE = 50;

/** 维修城堡回复量 */
const REPAIR_CASTLE_HP = 40;

/** 商品 ID：售罄集合标记用（限购 1 次） */
const ITEM_LIGHTNING = 'lightning';
const ITEM_LAVA = 'lava';
const ITEM_REPAIR = 'repair';

// ---------- 纯代码 UI 样式（无 Inspector 时可自动构建整套商店界面） ----------
const PANEL_WIDTH = 620;
const PANEL_HEIGHT = 780;
const BTN_WIDTH = 260;
const BTN_HEIGHT = 145;
const PANEL_COLOR = new Color(26, 33, 48, 238);
/** 全屏暗色半透明遮罩（防止点击穿透到背后钉板/发射器），默认铺满画布 960×640 */
const OVERLAY_WH = 960;
const OVERLAY_COLOR = new Color(0, 0, 0, 160);
/** 按钮可用底色 */
const BTN_ACTIVE_COLOR = new Color(46, 84, 128, 255);
/** 按钮禁用（金币不足 / 无球可删 / 城堡已毁）底色 */
const BTN_DISABLED_COLOR = new Color(78, 82, 92, 255);
/** 继续下一波按钮强调色 */
const CONTINUE_COLOR = new Color(52, 118, 62, 255);
/** 按钮文字色 */
const TEXT_COLOR = new Color(255, 255, 255, 255);
/** 按钮禁用文字色 */
const BTN_TEXT_DISABLED_COLOR = new Color(185, 188, 194, 255);
/** 标题（金色） */
const TITLE_COLOR = new Color(255, 216, 120, 255);
/** 消息成功提示色 */
const MSG_SUCCESS_COLOR = new Color(140, 255, 160, 255);
/** 消息错误提示色 */
const MSG_ERROR_COLOR = new Color(255, 110, 110, 255);

/** 商品卡内部【顶部标题行】字号：图标 + 名称 */
const CARD_TITLE_SIZE = 18;
/** 商品卡内部【中部说明框】：强制多行配置 */
const CARD_DESC_WIDTH = 240;
const CARD_DESC_HEIGHT = 50;
const CARD_DESC_SIZE = 13;
const CARD_DESC_LINE_HEIGHT = 18;
/** 商品卡内部【底部按钮行】字号 */
const CARD_BTN_SIZE = 14;
/** 标题行金色（金黄粗体） */
const TITLE_GOLD_COLOR = new Color(255, 216, 70, 255);

/** 单个商店按钮的运行时句柄（支持动态置灰重绘） */
interface ShopButton {
    node: Node;
    graphics: Graphics;
    /** 顶部标题行 Label（图标 + 名称；单行按钮复用为主文字） */
    label: Label;
    /** 中部说明框 Label（多行换行）：无说明的单行按钮为 null */
    descLabel: Label | null;
    /** 底部按钮行 Label（购买 / 已拥有 / 已售罄等）：无底部按钮的单行按钮为 null */
    btnLabel: Label | null;
    /** 当前是否可用（false 时按钮置灰） */
    enabled: boolean;
    /** 可用状态底色 */
    activeColor: Color;
    width: number;
    height: number;
}

/**
 * 战后单页弹珠工坊（PinballForge）商店弹窗：挂载在 Canvas/UILayer/ShopDialog 节点上。
 * - 监听 SHOW_SHOP（RewardDialog 选完战后卡牌奖励后广播）打开商店，冻结发射并播放弹性入场动效；
 * - 单页 2×2 货架陈列 4 大核心商品：
 *     ① 购买闪电弹珠（85💰，限购 1）→ 入卡组；
 *     ② 购买熔岩弹珠（85💰，限购 1）→ 入卡组；
 *     ③ 精简卡组 / 删普通球（80💰，每次 +25）→ 移出卡组，普通球为 0 时置灰不可点；
 *     ④ 城堡维修（50💰，限购 1）→ CastleController.heal(40)；
 * - 「继续下一关」按钮：隐藏商店 → 广播 UI_MODAL_CHANGED false 恢复发射 → 广播 REWARD_SELECTED 开启下一关；
 * - 遗物已移至第 5、10 关击杀精英/Boss 后的【传奇藏宝箱】专属掉落，本商店不再售卖遗物；
 * - 每次成功购买播放金币扣除音效（AudioManager.playFire(2) 双音 Ching）并刷新各按钮可用状态（置灰 / 红色提示）。
 * 说明：按钮/文案默认纯代码构建；也可在 Inspector 拖入同名子节点按钮（BuyLightningBtn 等）实现定制布局。
 */
@ccclass('ShopDialog')
export class ShopDialog extends Component {
    /** 本商店累计删卡次数（静态，跨商店弹窗常驻）：删卡阶梯涨价依据；新开一局（ResultDialog 重开）时归 0 */
    static removeCardCount = 0;

    /** 按钮节点（可选；未配置时按同名字节点查找，找不到则纯代码创建） */
    @property(Node)
    buyLightningBtn: Node | null = null;

    @property(Node)
    buyLavaBtn: Node | null = null;

    @property(Node)
    removeNormalBtn: Node | null = null;

    @property(Node)
    repairCastleBtn: Node | null = null;

    @property(Node)
    continueBtn: Node | null = null;

    @property(Label)
    goldLabel: Label | null = null;

    @property(Label)
    messageLabel: Label | null = null;

    private _buyLightning: ShopButton | null = null;
    private _buyLava: ShopButton | null = null;
    private _removeNormal: ShopButton | null = null;
    private _repairCastle: ShopButton | null = null;
    private _continue: ShopButton | null = null;
    /** 全屏暗色半透明遮罩节点（最底层，拦截穿透到背后钉板/发射器的触摸） */
    private _overlay: Node | null = null;

    /** 本波已售罄商品 ID 集合（限购 1 次的球 / 维修等） */
    private _soldItems = new Set<string>();

    /** SHOW_SHOP 监听是否已注册（幂等） */
    private _listening = false;
    /** UI 是否已构建 + 按钮已绑定（幂等） */
    private _ready = false;

    protected start(): void {
        // 默认隐藏商店：仅在 SHOW_SHOP 事件时展示
        this.node.active = false;
        this.ensureReady();
    }

    protected onEnable(): void {
        // 兜底：节点被外部隐藏/恢复时，保证监听与 UI 始终可用
        this.ensureReady();
    }

    protected onDestroy(): void {
        EventBus.off(GameEvents.SHOW_SHOP, this.openShop, this);
        if (this.node?.isValid) {
            Tween.stopAllByTarget(this.node);
        }
    }

    /** 幂等初始化：注册 SHOW_SHOP 监听 + 构建 UI + 绑定按钮（各自只执行一次） */
    private ensureReady(): void {
        if (!this._listening) {
            this._listening = true;
            EventBus.on(GameEvents.SHOW_SHOP, this.openShop, this);
        }
        if (this._ready || !this.node?.isValid) {
            return;
        }
        this._ready = true;
        this.buildUI();
        this.bindButton(this._buyLightning, this.onBuyLightning);
        this.bindButton(this._buyLava, this.onBuyLava);
        this.bindButton(this._removeNormal, this.onRemoveNormal);
        this.bindButton(this._repairCastle, this.onRepairCastle);
        this.bindButton(this._continue, this.onContinue);
    }

    /** SHOW_SHOP 回调：打开商店（冻结发射）并播放弹性入场动效 */
    public openShop(): void {
        if (!this.node?.isValid) {
            return;
        }
        this.ensureReady();
        if (this.messageLabel?.isValid) {
            this.messageLabel.string = '';
        }
        this.refreshUi();
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true); // 商店打开：冻结发射
        this.node.active = true;
        this.playPopAnimation();
    }

// ---------- 购买 / 按钮逻辑 ----------

    private onBuyLightning(): void {
        if (this._soldItems.has(ITEM_LIGHTNING)) {
            return; // 已售罄：限购 1 次
        }
        if (!DeckManager.instance?.canAddOrb()) {
            this.showMessage('牌库已满（8/8），请先删卡腾位！', false);
            return;
        }
        this.purchase(BUY_LIGHTNING_PRICE, ITEM_LIGHTNING, '⚡ 已购买闪电弹珠，永久加入卡组！', () => {
            DeckManager.instance?.addOrbToDeck(OrbType.Lightning);
        });
    }

    private onBuyLava(): void {
        if (this._soldItems.has(ITEM_LAVA)) {
            return; // 已售罄：限购 1 次
        }
        if (!DeckManager.instance?.canAddOrb()) {
            this.showMessage('牌库已满（8/8），请先删卡腾位！', false);
            return;
        }
        this.purchase(BUY_LAVA_PRICE, ITEM_LAVA, '🌋 已购买熔岩弹珠，永久加入卡组！', () => {
            DeckManager.instance?.addOrbToDeck(OrbType.Lava);
        });
    }

    private onRemoveNormal(): void {
        const count = DeckManager.instance?.getOrbCount(OrbType.Normal) ?? 0;
        if (count <= 0) {
            this.showMessage('没有普通球可删！', false);
            return;
        }
        // 删卡阶梯涨价：首次 80，第二次 105，第三次 130 …（删卡成功 count++，下一张更贵）
        const price = this.removePrice();
        const nextPrice = REMOVE_BASE_PRICE + (ShopDialog.removeCardCount + 1) * REMOVE_STEP_PRICE;
        this.purchase(price, null, `🗑 已删除 1 颗普通球！（下一张 ${nextPrice}💰）`, () => {
            DeckManager.instance?.removeOrbFromDeck(OrbType.Normal);
            ShopDialog.removeCardCount++;
        });
    }

    private onRepairCastle(): void {
        if (this._soldItems.has(ITEM_REPAIR)) {
            return; // 已售罄：限购 1 次
        }
        this.purchase(REPAIR_CASTLE_PRICE, ITEM_REPAIR, `🏰 城堡维修 +${REPAIR_CASTLE_HP} 生命！`, () => {
            CastleController.instance?.heal(REPAIR_CASTLE_HP);
        });
    }

    /** 当前删卡价格（金币）：80 + 已删次数 × 25（首次 80，第二次 105，第三次 130…） */
    private removePrice(): number {
        return REMOVE_BASE_PRICE + ShopDialog.removeCardCount * REMOVE_STEP_PRICE;
    }

    /**
     * 通用购买：校验金币 → 扣款 → 若给商品 ID 则标记该商品本波售罄 → 应用效果 → 播放音效 → 刷新。
     * 金币不足时不扣款，给出红色提示。
     */
    private purchase(price: number, soldId: string | null, successMsg: string, apply: () => void): void {
        const gold = GoldManager.instance;
        if (!gold || gold.currentGold < price) {
            this.showMessage(`金币不足（需要 ${price}💰）！`, false);
            this.refreshUi();
            return;
        }
        if (!gold.spendGold(price)) {
            this.showMessage(`金币不足（需要 ${price}💰）！`, false);
            this.refreshUi();
            return;
        }
        if (soldId) {
            this._soldItems.add(soldId); // 商品售罄：限购 1 次
        }
        apply();
        AudioManager.playFire(2); // 金币扣除音效：经典双音 Ching
        this.showMessage(successMsg, true);
        this.refreshUi();
    }

    /** 「继续下一关」：隐藏商店 → 取消冻结发射 → 广播 REWARD_SELECTED 开启下一关 */
    private onContinue(): void {
        if (!this.node?.isValid) {
            return;
        }
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, false); // 商店关闭：恢复发射
        EventBus.emit(GameEvents.REWARD_SELECTED); // 通知 WaveManager 开启下一关
        this.node.active = false;
    }

    /** 顶部提示消息（成功绿色 / 失败红色） */
    private showMessage(text: string, success: boolean): void {
        if (this.messageLabel?.isValid) {
            this.messageLabel.string = text;
            this.messageLabel.color = success ? MSG_SUCCESS_COLOR : MSG_ERROR_COLOR;
        }
        console.log(`[Shop] ${text}`);
    }

/** 刷新商店显示：金币、四大商品（售罄/余额/删卡阶梯价/城堡状态） */
    private refreshUi(): void {
        const gold = GoldManager.instance?.currentGold ?? 0;
        if (this.goldLabel?.isValid) {
            this.goldLabel.string = `💰 金币: ${gold}`;
        }
        // 牌库容量软上限：满员时新购弹珠置灰并提示先删卡（配合 DeckManager.MAX_DECK_SIZE）
        const deckCapacity = DeckManager.instance?.maxDeckSize ?? 8;
        const deckSize = DeckManager.instance?.getDeckSize() ?? 0;
        const deckFull = deckSize >= deckCapacity;
        const deckFullSuffix = deckFull ? ` (${deckSize}/${deckCapacity})` : '';
        // 闪电弹珠：限购 1 次，售罄则置灰售罄文案
        this.refreshItemCard(this._buyLightning, ITEM_LIGHTNING, gold >= BUY_LIGHTNING_PRICE && !deckFull,
            '⚡ 闪电弹珠', `购买后永久加入牌库，发射瞬间扇形散射`, BUY_LIGHTNING_PRICE, deckFull);
        // 熔岩弹珠
        this.refreshItemCard(this._buyLava, ITEM_LAVA, gold >= BUY_LAVA_PRICE && !deckFull,
            '🌋 熔岩弹珠', `双倍重力重压砸击，每次撞钉 +60 能量`, BUY_LAVA_PRICE, deckFull);
        // 精简卡组：不限购，但需有普通球可删且金币充足；价格随删卡次数阶梯上涨
        const normalCount = DeckManager.instance?.getOrbCount(OrbType.Normal) ?? 0;
        const removePrice = this.removePrice();
        this.setButtonEnabled(this._removeNormal, normalCount > 0 && gold >= removePrice);
        if (this._removeNormal?.label?.isValid) {
            this._removeNormal.label.string = '🗑 精简卡组';
            this._removeNormal.label.color = this._removeNormal.enabled ? TEXT_COLOR : BTN_TEXT_DISABLED_COLOR;
        }
        if (this._removeNormal?.descLabel?.isValid) {
            this._removeNormal.descLabel.string = `从卡组移除 1 颗普通白球腾出牌位`;
        }
        if (this._removeNormal?.btnLabel?.isValid) {
            this._removeNormal.btnLabel.string = normalCount > 0
                ? `💰 ${removePrice} 删除 (余 ${normalCount}${deckFullSuffix})`
                : '✖ 无普通球可删';
        }
        // 城堡维修：限购 1 次，城堡已毁或金币不足时置灰
        const castle = CastleController.instance;
        const castleAlive = !!castle && castle.currentHp > 0;
        this.refreshItemCard(this._repairCastle, ITEM_REPAIR, castleAlive && gold >= REPAIR_CASTLE_PRICE,
            '🏰 城堡维修', `为城堡恢复 ${REPAIR_CASTLE_HP} 点生命`, REPAIR_CASTLE_PRICE);
    }

    /**
     * 刷新「限购 1 次」三层商品卡：已售罄 → 置灰 + 「已售罄」；牌库已满 → 置灰 + 「牌库已满」；
     * 未售罄但金币不足 / 条件不满足 → 置灰且价格标红。
     */
    private refreshItemCard(btn: ShopButton | null, soldId: string, affordable: boolean, title: string, sub: string, price: number, deckFull = false): void {
        if (!btn || !btn.label?.isValid) {
            return;
        }
        const sold = this._soldItems.has(soldId);
        const capacity = DeckManager.instance?.maxDeckSize ?? 8;
        const size = DeckManager.instance?.getDeckSize() ?? 0;
        if (btn.descLabel?.isValid) {
            btn.descLabel.string = sub;
        }
        if (btn.btnLabel?.isValid) {
            btn.btnLabel.string = sold
                ? '【已售罄】'
                : deckFull
                    ? `【牌库已满 (${size}/${capacity})】`
                    : `💰 ${price} 购买`;
        }
        btn.label.string = title;
        this.setButtonEnabled(btn, !sold && !deckFull && affordable);
        if (!sold && !affordable && btn.btnLabel?.isValid) {
            btn.btnLabel.color = MSG_ERROR_COLOR; // 金币不足 / 条件不满足 → 价格标红
        } else if (!sold && btn.btnLabel?.isValid) {
            btn.btnLabel.color = TEXT_COLOR; // 恢复默认副题色
        }
    }

// ---------- 纯代码 UI 构建（Editor 未布置同名子节点时兜底） ----------

    private buildUI(): void {
        // 0) 全屏暗色遮罩：置于最底层，拦截点击穿透到背后钉板/发射器
        this._overlay = new Node('ShopOverlay');
        this._overlay.layer = this.node.layer;
        this._overlay.getComponent(UITransform) ?? this._overlay.addComponent(UITransform);
        this._overlay.getComponent(UITransform)!.setContentSize(OVERLAY_WH, OVERLAY_WH);
        const ovG = this._overlay.addComponent(Graphics);
        ovG.fillColor = OVERLAY_COLOR;
        ovG.rect(-OVERLAY_WH / 2, -OVERLAY_WH / 2, OVERLAY_WH, OVERLAY_WH);
        ovG.fill();
        this.node.addChild(this._overlay);
        this._overlay.setPosition(0, 0, 0);
        // 遮罩置底（排在自身面板之后加入的其它子节点之前）
        this._overlay.setSiblingIndex(0);

        // 面板背景：自身节点补 UITransform + Graphics 圆角矩形
        const ui = this.getComponent(UITransform) ?? this.addComponent(UITransform);
        ui.setContentSize(PANEL_WIDTH, PANEL_HEIGHT);
        const bg = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        bg.clear();
        bg.fillColor = PANEL_COLOR;
        bg.roundRect(-PANEL_WIDTH / 2, -PANEL_HEIGHT / 2, PANEL_WIDTH, PANEL_HEIGHT, 18);
        bg.fill();

        // 标题 / 金币 / 消息提示（顶部预留板块）
        const title = this.ensureLabel('ShopTitle', 0, 332, 34, '🎒 弹珠工坊', 400);
        if (title?.isValid) {
            title.color = TITLE_COLOR;
        }
        this.goldLabel = this.ensureLabel('ShopGoldLabel', 0, 286, 26, '💰 金币: 0', 360);
        this.messageLabel = this.ensureLabel('ShopMessageLabel', 0, 242, 20, '', 520);

        // ---------- 单页 2×2 货架：闪电 / 熔岩 / 删卡 / 修城（无 Tab 切换） ----------
        // 商品卡 2×2：第0/1张在上排、第2/3张在下排；左右列各占一半宽度
        const cardPos = (col: number, row: number) => ({ x: col === 0 ? -140 : 140, y: row === 0 ? 70 : -90 });
        this._buyLightning = this.createCard(this.buyLightningBtn, 'BuyLightningBtn',
            cardPos(0, 0).x, cardPos(0, 0).y, '⚡ 闪电弹珠', `购买后永久加入牌库，发射瞬间扇形散射`,
            BTN_ACTIVE_COLOR);
        this._buyLava = this.createCard(this.buyLavaBtn, 'BuyLavaBtn',
            cardPos(1, 0).x, cardPos(1, 0).y, '🌋 熔岩弹珠', `双倍重力重压砸击，每次撞钉 +60 能量`,
            BTN_ACTIVE_COLOR);
        this._removeNormal = this.createCard(this.removeNormalBtn, 'RemoveNormalBtn',
            cardPos(0, 1).x, cardPos(0, 1).y, '🗑 精简卡组', `从卡组移除 1 颗普通白球腾出牌位`,
            BTN_ACTIVE_COLOR);
        this._repairCastle = this.createCard(this.repairCastleBtn, 'RepairCastleBtn',
            cardPos(1, 1).x, cardPos(1, 1).y, '🏰 城堡维修', `为城堡恢复 ${REPAIR_CASTLE_HP} 点生命`,
            BTN_ACTIVE_COLOR);

        // 继续下一关按钮（置底，宽 420 高 52，Y:-320，不与下边缘重叠）
        this._continue = this.ensureButton(this.continueBtn, 'ContinueBtn', 0, -320,
            '➡ 继续下一关', 420, 52, CONTINUE_COLOR);
    }

/** 创建/复用商店 Label：优先 Editor 已布置的同名子节点，否则纯代码创建 */
    private ensureLabel(name: string, x: number, y: number, fontSize: number, text: string, width: number): Label | null {
        let node = this.node.getChildByName(name);
        if (!node?.isValid) {
            node = new Node(name);
        }
        node.layer = this.node.layer;
        this.node.addChild(node);
        node.setPosition(x, y, 0);
        const ui = node.getComponent(UITransform) ?? node.addComponent(UITransform);
        ui.setContentSize(width, 44);
        const label = node.getComponent(Label) ?? node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 10;
        label.color = TEXT_COLOR;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;
        return label;
    }

    /** 创建/复用商店按钮节点（背景 Graphics 圆角矩形 + 文字子节点），并记录到句柄 */
    private ensureButton(
        pref: Node | null, name: string,
        x: number, y: number, text: string,
        width: number, height: number, activeColor: Color,
        parent: Node | null = null,
    ): ShopButton | null {
        let node = pref?.isValid ? pref : this.node.getChildByName(name);
        if (!node?.isValid) {
            node = new Node(name);
        }
        node.layer = this.node.layer;
        (parent ?? this.node).addChild(node);
        node.setPosition(x, y, 0);
        const ui = node.getComponent(UITransform) ?? node.addComponent(UITransform);
        ui.setContentSize(width, height);

        const graphics = node.getComponent(Graphics) ?? node.addComponent(Graphics);

        // 文字子节点
        let labelNode = node.getChildByName('Label');
        let label: Label;
        if (!labelNode?.isValid) {
            labelNode = new Node('Label');
            labelNode.layer = node.layer;
            node.addChild(labelNode);
            const lUi = labelNode.addComponent(UITransform);
            lUi.setContentSize(width - 12, height - 8);
            label = labelNode.addComponent(Label);
        } else {
            label = labelNode.getComponent(Label) ?? labelNode.addComponent(Label);
        }
        label.string = text;
        label.fontSize = 22;
        label.lineHeight = 28;
        label.color = TEXT_COLOR;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;

        const btn: ShopButton = { node, graphics, label, descLabel: null, btnLabel: null, enabled: true, activeColor, width, height };
        this.drawButtonBg(btn, true);
        return btn;
    }

/**
     * 创建三层商品卡按钮（背景圆角矩形 + 顶部标题行 + 中部说明框 + 底部按钮行）。
     * 每一层都是独立 Label 节点，避免全部挤进单个 Label 造成文字被挤压发糊 / 截断：
     *  - Title：图标 + 名称，粗体金黄，换行居中；
     *  - Desc：独立说明框，强制 RESIZE_HEIGHT + 自动换行，多行展示完整说明；
     *  - Btn：独立底部按钮行，显示购买 / 已售罄等态。
     */
    private createCard(
        pref: Node | null, name: string,
        x: number, y: number, title: string, desc: string,
        activeColor: Color, parent: Node | null = null,
    ): ShopButton | null {
        let node = pref?.isValid ? pref : this.node.getChildByName(name);
        if (!node?.isValid) {
            node = new Node(name);
        }
        node.layer = this.node.layer;
        (parent ?? this.node).addChild(node);
        node.setPosition(x, y, 0);
        const ui = node.getComponent(UITransform) ?? node.addComponent(UITransform);
        ui.setContentSize(BTN_WIDTH, BTN_HEIGHT);

        const graphics = node.getComponent(Graphics) ?? node.addComponent(Graphics);

        // ---- 1) 顶部标题行：图标 + 名称（粗体金黄，自动换行居中，溢出裁剪） ----
        let titleNode = node.getChildByName('TitleLabel');
        let titleLabel: Label;
        if (!titleNode?.isValid) {
            titleNode = new Node('TitleLabel');
            titleNode.layer = node.layer;
            node.addChild(titleNode);
            const tUi = titleNode.addComponent(UITransform);
            tUi.setContentSize(BTN_WIDTH - 16, 30);
            titleLabel = titleNode.addComponent(Label);
        } else {
            titleLabel = titleNode.getComponent(Label) ?? titleNode.addComponent(Label);
        }
        titleNode.setPosition(0, 48, 0);
        titleLabel.getComponent(UITransform)?.setContentSize(BTN_WIDTH - 16, 30);
        titleLabel.string = title;
        titleLabel.fontSize = CARD_TITLE_SIZE;
        titleLabel.lineHeight = 24;
        titleLabel.color = TITLE_GOLD_COLOR;
        titleLabel.isBold = true;
        titleLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        titleLabel.verticalAlign = Label.VerticalAlign.CENTER;
        titleLabel.enableWrapText = true; // 长标题自动换行，绝不挤压重叠发糊
        titleLabel.overflow = Label.Overflow.CLAMP;

// ---- 2) 中部说明框：独立 Label，强制纵向撑高 + 自动换行，展示完整说明 ----
        let descNode = node.getChildByName('DescLabel');
        let descLabel: Label;
        if (!descNode?.isValid) {
            descNode = new Node('DescLabel');
            descNode.layer = node.layer;
            node.addChild(descNode);
            descLabel = descNode.addComponent(Label);
        } else {
            descLabel = descNode.getComponent(Label) ?? descNode.addComponent(Label);
        }
        descNode.setPosition(0, 14, 0);
        descLabel.getComponent(UITransform)?.setContentSize(CARD_DESC_WIDTH, CARD_DESC_HEIGHT);
        descLabel.overflow = Label.Overflow.RESIZE_HEIGHT;
        descLabel.enableWrapText = true;
        descLabel.fontSize = CARD_DESC_SIZE;
        descLabel.lineHeight = CARD_DESC_LINE_HEIGHT;
        descLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        descLabel.verticalAlign = Label.VerticalAlign.CENTER;
        descLabel.string = desc;
        descLabel.color = new Color(226, 230, 236, 255);

        // ---- 3) 底部按钮行：独立按钮节点，显示购买 / 已售罄 ----
        let btnNode = node.getChildByName('BtnLabel');
        let btnLabel: Label;
        if (!btnNode?.isValid) {
            btnNode = new Node('BtnLabel');
            btnNode.layer = node.layer;
            node.addChild(btnNode);
            btnLabel = btnNode.addComponent(Label);
        } else {
            btnLabel = btnNode.getComponent(Label) ?? btnNode.addComponent(Label);
        }
        btnLabel.getComponent(UITransform)?.setContentSize(BTN_WIDTH - 20, 22);
        btnNode.setPosition(0, -46, 0);
        btnLabel.string = '';
        btnLabel.fontSize = CARD_BTN_SIZE;
        btnLabel.lineHeight = 20;
        btnLabel.color = TEXT_COLOR;
        btnLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        btnLabel.verticalAlign = Label.VerticalAlign.CENTER;
        btnLabel.overflow = Label.Overflow.CLAMP;

        const btn: ShopButton = { node, graphics, label: titleLabel, descLabel, btnLabel, enabled: true, activeColor, width: BTN_WIDTH, height: BTN_HEIGHT };
        this.drawButtonBg(btn, true);
        return btn;
    }

/** 重绘按钮底色：可用 = 强调色，置灰 = 禁用色 */
    private drawButtonBg(btn: ShopButton, enabled: boolean): void {
        if (!btn.graphics?.isValid) {
            return;
        }
        btn.graphics.clear();
        btn.graphics.fillColor = enabled ? btn.activeColor : BTN_DISABLED_COLOR;
        btn.graphics.roundRect(-btn.width / 2, -btn.height / 2, btn.width, btn.height, 10);
        btn.graphics.fill();
    }

    /** 切换按钮可用状态（置灰 + 文字变暗；状态未变化时跳过，避免无谓重绘） */
    private setButtonEnabled(btn: ShopButton | null, enabled: boolean): void {
        if (!btn || btn.enabled === enabled) {
            return;
        }
        btn.enabled = enabled;
        this.drawButtonBg(btn, enabled);
        const fontColor = enabled ? TEXT_COLOR : BTN_TEXT_DISABLED_COLOR;
        if (btn.label?.isValid) {
            btn.label.color = fontColor;
        }
        if (btn.descLabel?.isValid) {
            btn.descLabel.color = fontColor;
        }
        if (btn.btnLabel?.isValid) {
            btn.btnLabel.color = fontColor;
        }
    }

    /** 绑定按钮点击（先解绑再绑，幂等安全） */
    private bindButton(btn: ShopButton | null, handler: () => void): void {
        if (!btn?.node?.isValid) {
            return;
        }
        btn.node.off(Node.EventType.TOUCH_END);
        btn.node.on(Node.EventType.TOUCH_END, handler, this);
    }

    /** 弹窗浮现动效：整体 0.8 → 1.06 → 1 弹性放大（与 RewardDialog 保持一致手感） */
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
