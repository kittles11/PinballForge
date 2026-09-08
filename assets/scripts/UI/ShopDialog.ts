import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec3, tween, Tween, view,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { GoldManager } from '../Core/GoldManager';
import { DeckManager } from '../Core/DeckManager';
import { CastleController } from '../Battle/CastleController';
import { PegComponent, PegType } from '../Pinball/PegComponent';
import { AudioManager } from '../Core/AudioManager';
import { Analytics } from '../Core/Analytics';
import { OrbType } from '../Core/DataModels';
import { Theme } from '../Core/ArtTheme';
import { MetaManager } from '../Core/MetaManager';
import { LevelManager } from '../Core/LevelManager';
import { mountIcon } from '../Core/IconLib';
import { raisedButton } from '../Core/UiKit';

const { ccclass, property } = _decorator;

// ---------- 商品价格（金币） ----------
const BUY_LIGHTNING_PRICE = 85;
const BUY_LAVA_PRICE = 85;
const BUY_FROST_PRICE = 85;    // 冰霜弹珠（2026-09-07 上架：与雷/熔同档，冰系构筑入口）
const REMOVE_BASE_PRICE = 80;   // 删卡基础价（首次）
const REMOVE_STEP_PRICE = 25;   // 删卡阶梯涨幅
const REPAIR_CASTLE_PRICE = 50;
const REPAIR_STEP_PRICE = 25;    // 维修可重复购买，每次费用阶梯涨幅（难度调整：金币坑）

/** 维修城堡回复量 */
const REPAIR_CASTLE_HP = 40;

/** 商品 ID：售罄集合标记用（限购 1 次） */
const ITEM_LIGHTNING = 'lightning';
const ITEM_LAVA = 'lava';
const ITEM_FROST = 'frost';
const ITEM_REPAIR = 'repair';
/** 稀有商品 ①「命运重铸」（Task 007 商店二期）：整手牌球种随机重排（数量不变） */
const ITEM_REROLL = 'reroll';
/** 稀有商品 ②「镀金狂潮」（Task 007 商店二期）：本波再镀 2 颗普通钉为镀金乘倍钉（撞击 +5 金赏金） */
const ITEM_GILDRUSH = 'gildrush';

// ---------- 稀有商品（Task 007 商店二期） ----------
const REROLL_PRICE = 120;
/** 镀金狂潮单价（每次镀 2 颗） */
const GILDRUSH_PRICE = 100;
/** 镀金狂潮单次镀金钉数（与潮汐镀金遗物 TIDAL_GILD_COUNT 同款，2 颗） */
const GILDRUSH_GILD_COUNT = 2;
/** 稀有位解锁章节：第 3 章起上架（前两章货架保持 5 商品教学位） */
const RARE_SLOT_UNLOCK_CHAPTER = 3;
/** 「刷新货架」按钮价格：重掷两个稀有位的商品（50/50 掷定），不限购不叠加 */
const REFRESH_PRICE = 25;
/** 稀有商品展示文案（Task 007 商店二期；图标均取自 IconLib 已注册键） */
const RARE_OFFER_TEXT: Record<string, { title: string; desc: string; icon: string }> = {
    [ITEM_REROLL]: { title: '命运重铸', desc: '整手牌球种随机重排（数量不变）', icon: 'cards' },
    [ITEM_GILDRUSH]: { title: '镀金狂潮', desc: '本波再镀 2 颗镀金钉（撞击 +5 金）', icon: 'coin' },
};

// ---------- 纯代码 UI 样式（无 Inspector 时可自动构建整套商店界面） ----------
const PANEL_WIDTH = 620;
const PANEL_HEIGHT = 1040;     // 2×3 基础货架 + 稀有位行（Task 007）：三行卡排 + 稀有行 + 继续钮，720×1280 竖屏放得下
const BTN_WIDTH = 260;
const BTN_HEIGHT = 145;
const PANEL_COLOR = Theme.ui.panel;
/** 📐 稀有位两卡横向坐标（Task 010 自检消费：与首二行 2 列同轨，保证 260 宽卡片互不重叠） */
const RARE_X = [-140, 140];
/** 全屏暗色半透明遮罩（防止点击穿透到背后钉板/发射器）：fitHeight 下可视高度恒 1280，
 *  2200×2200 与 Settings/DailyTask/DeckView/SignIn 同规格，任何竖屏分辨率（含 20:9）都铺满 */
const OVERLAY_WH = 2200;
const OVERLAY_COLOR = Theme.ui.overlay;
/** 按钮可用底色 */
const BTN_ACTIVE_COLOR = Theme.ui.blueActive;
/** 按钮禁用（金币不足 / 无球可删 / 城堡已毁）底色 */
const BTN_DISABLED_COLOR = Theme.ui.disabled;
/** 继续下一波按钮强调色 */
const CONTINUE_COLOR = Theme.ui.green;
/** 按钮文字色 */
const TEXT_COLOR = Theme.ui.text;
/** 按钮禁用文字色 */
const BTN_TEXT_DISABLED_COLOR = Theme.ui.textDim;
/** 标题（金色） */
const TITLE_COLOR = Theme.ui.gold;
/** 消息成功提示色 */
const MSG_SUCCESS_COLOR = Theme.ui.greenBright;
/** 消息错误提示色 */
const MSG_ERROR_COLOR = Theme.ui.red;

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
const TITLE_GOLD_COLOR = Theme.ui.gold;

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
 * - 单页 2×3 货架陈列 5 大核心商品：
 *     ① 购买闪电弹珠（85💰，限购 1）→ 入卡组；
 *     ② 购买熔岩弹珠（85💰，限购 1）→ 入卡组；
 *     ③ 购买冰霜弹珠（85💰，限购 1）→ 入卡组（2026-09-07 补全上架：冰球此前只能靠战后卡牌获得）；
 *     ④ 精简卡组 / 删普通球（80💰，每次 +25）→ 移出卡组，普通球为 0 时置灰不可点；
 *     ⑤ 城堡维修（50💰，可重复购买，费用阶梯递增）→ CastleController.heal(40)；
 * - 「继续下一关」按钮：隐藏商店 → 广播 UI_MODAL_CHANGED false 恢复发射 → 广播 REWARD_SELECTED 开启下一关；
 * - 遗物已移至第 5、10 关击杀精英/Boss 后的【传奇藏宝箱】专属掉落，本商店不再售卖遗物；
 * - 每次成功购买播放金币扣除音效（AudioManager.playFire(2) 双音 Ching）并刷新各按钮可用状态（置灰 / 红色提示）。
 * 说明：按钮/文案默认纯代码构建；也可在 Inspector 拖入同名子节点按钮（BuyLightningBtn 等）实现定制布局。
 */
@ccclass('ShopDialog')
export class ShopDialog extends Component {
    /** 本商店累计删卡次数（静态，跨商店弹窗常驻）：删卡阶梯涨价依据；新开一局（ResultDialog 重开）时归 0 */
    static removeCardCount = 0;
    /** 本局已维修次数（维修可重复购买，费用阶梯递增；重开一局经 ResultDialog 清零） */
    static repairCount = 0;

    /** 按钮节点（可选；未配置时按同名字节点查找，找不到则纯代码创建） */
    @property(Node)
    buyLightningBtn: Node | null = null;

    @property(Node)
    buyLavaBtn: Node | null = null;

    @property(Node)
    buyFrostBtn: Node | null = null;

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
    private _buyFrost: ShopButton | null = null;
    private _removeNormal: ShopButton | null = null;
    private _repairCastle: ShopButton | null = null;
    private _continue: ShopButton | null = null;
    /** 稀有位商品卡 ×2（Task 007 商店二期）：第 3 章解锁，每波 50/50 掷定商品 */
    private _rareCards: (ShopButton | null)[] = [null, null];
    /** 「刷新货架」单行按钮（Task 007）：重掷稀有位商品，25💰 每次 */
    private _refreshBtn: ShopButton | null = null;
    /** 本波稀有位商品（50/50 掷定的两种排列） */
    private _rareOffers: string[] = [ITEM_REROLL, ITEM_GILDRUSH];
    /** 全屏暗色半透明遮罩节点（最底层，拦截穿透到背后钉板/发射器的触摸） */
    private _overlay: Node | null = null;

    /** 本次开店是否已购买（2026-09-07 用户拍板：每次开店全场商品合计限购 1 件，下次开店重置） */
    private _boughtThisVisit = false;

    /** SHOW_SHOP 监听是否已注册（幂等） */
    private _listening = false;
    /** UI 是否已构建 + 按钮已绑定（幂等） */
    private _ready = false;
    /** 展示中标记（同 RewardDialog._showing）：防启动期失活导致的 start 推迟自吞首次展示 */
    private _showing = false;
    /** 📐 面板整体缩放（Task 010 多分辨率）：窄屏（20:9 等）可视宽 < 面板宽时等比缩小，钳制 ≤1 */
    private _uiScale = 1;

    /** 监听注册提前到 onLoad：场景启动时 DailyTaskDialog 的 closeAllModals() 会把弹窗节点
     *  失活（EVENT_AFTER_SCENE_LAUNCH），若依赖 start() 注册，节点失活后 start 永不执行、
     *  SHOW_SHOP 无监听 → 第 3/6/9 关选完卡牌后无法进入商店（与 RewardDialog 同一回归）。 */
    protected onLoad(): void {
        this.ensureReady();
    }

    protected start(): void {
        // 默认隐藏商店：仅在 SHOW_SHOP 事件时展示（展示中不自吞，见 _showing 注释）
        if (!this._showing) {
            this.node.active = false;
        }
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
        this.bindButton(this._buyFrost, this.onBuyFrost);
        this.bindButton(this._removeNormal, this.onRemoveNormal);
        this.bindButton(this._repairCastle, this.onRepairCastle);
        this.bindButton(this._continue, this.onContinue);
        this.bindButton(this._refreshBtn, this.onRefreshRare);
        this._rareCards.forEach((card, i) => {
            const id = this._rareOffers[i] ?? ITEM_REROLL;
            this.bindButton(card, id === ITEM_REROLL ? this.onBuyReroll : this.onBuyGildRush);
        });
    }

    /** SHOW_SHOP 回调：打开商店（冻结发射）并播放弹性入场动效 */
    public openShop(): void {
        if (!this.node?.isValid) {
            return;
        }
        this._showing = true; // 先置位再激活：推迟执行的 start() 默认隐藏不得吞掉本次展示
        // 📐 Task 010：先按当前可视宽算整体缩放（窄屏 20:9 等比缩小防裁边），再掷稀有位
        this.applyScale(view.getVisibleSize().width);
        this.rollRareOffers(); // ⭐ Task 007：每次开店重掷稀有位商品（50/50）
        this._boughtThisVisit = false; // 每次开店重置全场限购：新店新额度
        // ★ 结算链加固（2026-09-04 1-3 回归）：UI 构建/刷新段整体异常隔离——refreshUi 抛错
        //   绝不能吞掉后面的「冻结发射 + 激活」，否则商店无声缺席 → REWARD_SELECTED 永不发出
        //   → 第 3/6/9 关选完卡永久卡死。素面板商店（错误见日志）好过无声死局。
        try {
            this.ensureReady();
            if (this.messageLabel?.isValid) {
                this.messageLabel.string = '';
            }
            this.refreshUi();
        } catch (e) {
            console.error('[Shop] 商店 UI 构建/刷新异常（已隔离，弹窗照常打开）', e);
        }
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true); // 商店打开：冻结发射
        this.node.active = true;
        this.playPopAnimation();
    }

// ---------- 购买 / 按钮逻辑 ----------

    private onBuyLightning(): void {
        if (!DeckManager.instance?.canAddOrb()) {
            this.showMessage(`牌库已满（${DeckManager.instance?.getDeckSize() ?? 8}/${DeckManager.instance?.maxDeckSize ?? 8}），请先删卡腾位！`, false);
            return;
        }
            this.purchase(BUY_LIGHTNING_PRICE, ITEM_LIGHTNING, '已购买闪电弹珠，永久加入卡组！', () => {
            DeckManager.instance?.addOrbToDeck(OrbType.Lightning);
        });
    }

    private onBuyLava(): void {
        if (!DeckManager.instance?.canAddOrb()) {
            this.showMessage(`牌库已满（${DeckManager.instance?.getDeckSize() ?? 8}/${DeckManager.instance?.maxDeckSize ?? 8}），请先删卡腾位！`, false);
            return;
        }
            this.purchase(BUY_LAVA_PRICE, ITEM_LAVA, '已购买熔岩弹珠，永久加入卡组！', () => {
            DeckManager.instance?.addOrbToDeck(OrbType.Lava);
        });
    }

    private onBuyFrost(): void {
        if (!DeckManager.instance?.canAddOrb()) {
            this.showMessage(`牌库已满（${DeckManager.instance?.getDeckSize() ?? 8}/${DeckManager.instance?.maxDeckSize ?? 8}），请先删卡腾位！`, false);
            return;
        }
        this.purchase(BUY_FROST_PRICE, ITEM_FROST, '已购买冰霜弹珠，永久加入卡组！', () => {
            DeckManager.instance?.addOrbToDeck(OrbType.Frost);
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
        const nextPrice = this.finalPrice(REMOVE_BASE_PRICE + (ShopDialog.removeCardCount + 1) * REMOVE_STEP_PRICE);
        this.purchase(price, null, `🗑 已删除 1 颗普通球！（下一张 ${nextPrice}💰）`, () => {
            DeckManager.instance?.removeOrbFromDeck(OrbType.Normal);
            ShopDialog.removeCardCount++;
        });
    }

    private onRepairCastle(): void {
        // 难度调整：维修从限购 1 次改为可重复购买（费用阶梯递增），成为中后期金币的主要消耗口
        this.purchase(this.repairPrice(), null, `🏰 城堡维修 +${REPAIR_CASTLE_HP} 生命！`, () => {
            CastleController.instance?.heal(REPAIR_CASTLE_HP);
            ShopDialog.repairCount++;
        });
    }

    // ---------- 稀有位（Task 007 商店二期：第 3 章解锁 + 50/50 掷定 + 25💰 刷新） ----------

    /** 稀有位是否已解锁（第 RARE_SLOT_UNLOCK_CHAPTER 章起） */
    private rareUnlocked(): boolean {
        return LevelManager.currentChapter >= RARE_SLOT_UNLOCK_CHAPTER;
    }

    /** 每次开店重掷稀有位商品：50/50 掷定两种排列之一（两商品不同，位序随机）。
     *  ★ 掷定后按新位序重绑点击处理器（createCard 首绑的是当时的位序，换位后必须重绑防点错商品）。 */
    private rollRareOffers(): void {
        const first = Math.random() < 0.5 ? ITEM_REROLL : ITEM_GILDRUSH;
        this._rareOffers = first === ITEM_REROLL
            ? [ITEM_REROLL, ITEM_GILDRUSH]
            : [ITEM_GILDRUSH, ITEM_REROLL];
        this._rareOffers.forEach((itemId, i) => {
            this.bindButton(this._rareCards[i],
                itemId === ITEM_REROLL ? this.onBuyReroll : this.onBuyGildRush);
        });
    }

    /** 「刷新货架」：重掷稀有位商品 + 重置本波售罄标记，每次 25💰 */
    private onRefreshRare(): void {
        if (!this.rareUnlocked()) {
            return;
        }
        this.purchase(REFRESH_PRICE, null, '货架已刷新！', () => {
            this.rollRareOffers();
            // 刷新语义：重掷商品位（全场限购下刷新仅在未购买时可用，重掷商品天然可买）
        });
    }

    /** ⭐ 命运重铸：整手牌球种随机重排（数量不变，DeckManager 单一真源） */
    private onBuyReroll(): void {
        this.purchase(REROLL_PRICE, ITEM_REROLL, '整手牌已重铸！', () => {
            DeckManager.instance?.rerollDeckComposition();
        });
    }

    /** ⭐ 镀金狂潮：本波再镀 GILDRUSH_GILD_COUNT 颗普通钉（与潮汐镀金遗物同管线） */
    private onBuyGildRush(): void {
        this.purchase(GILDRUSH_PRICE, ITEM_GILDRUSH, '镀金狂潮已生效！', () => {
            // 商店在 UILayer、钉子在 PegboardLayer：跨层全局搜索（PegComponent 静态方法同惯例）
            const gilded = PegComponent.gildRandomNormalPegs(GILDRUSH_GILD_COUNT);
            if (gilded.length === 0) {
                this.showMessage('场上没有普通钉可镀（下一波再来！）', false);
            }
        });
    }

    /** 刷新稀有位商品卡（Task 007）：未解锁整卡隐藏；本波已购显示已售罄；金币不足标红 */
    private refreshRareCards(gold: number): void {
        if (!this.rareUnlocked()) {
            for (const card of this._rareCards) {
                if (card?.node?.isValid) {
                    card.node.active = false;
                }
            }
            if (this._refreshBtn?.node?.isValid) {
                this._refreshBtn.node.active = false;
            }
            return;
        }
        this._rareOffers.forEach((itemId, i) => {
            const card = this._rareCards[i];
            if (!card?.node?.isValid) {
                return;
            }
            card.node.active = true;
            const text = RARE_OFFER_TEXT[itemId];
            const price = this.finalPrice(itemId === ITEM_REROLL ? REROLL_PRICE : GILDRUSH_PRICE);
            this.refreshItemCard(card, itemId, gold >= price && !this._boughtThisVisit, text.title, text.desc, price);
        });
        // 「刷新货架」按钮：价格显示 + 金币不足 / 已购置灰
        if (this._refreshBtn?.node?.isValid) {
            this._refreshBtn.node.active = true;
            const pRefresh = this.finalPrice(REFRESH_PRICE);
            this.setButtonEnabled(this._refreshBtn, gold >= pRefresh && !this._boughtThisVisit);
            if (this._refreshBtn.label?.isValid) {
                this._refreshBtn.label.string = '刷新货架';
            }
            if (this._refreshBtn.btnLabel?.isValid) {
                this._refreshBtn.btnLabel.string = this._boughtThisVisit
                    ? '【已售罄】'
                    : gold >= pRefresh
                        ? `${pRefresh} 刷新稀有商品`
                        : `${pRefresh} 刷新（金币不足）`;
            }
        }
    }

    /** 当前删卡价格（金币）：80 + 已删次数 × 25（首次 80，第二次 105，第三次 130…） */
    private removePrice(): number {
        return REMOVE_BASE_PRICE + ShopDialog.removeCardCount * REMOVE_STEP_PRICE;
    }

    /** 当前维修价格（金币）：50 + 已修次数 × 25（难度调整：从限购 1 次改为可重复的阶梯价） */
    private repairPrice(): number {
        return REPAIR_CASTLE_PRICE + ShopDialog.repairCount * REPAIR_STEP_PRICE;
    }

    /** ⚒ meta「商道」折扣 × 章节通胀：定价随章节上浮（难度调整：金币收入随进程增长，定价同步通胀防中盘买空） */
    private finalPrice(base: number): number {
        const chapterInflation = 1 + 0.06 * (LevelManager.currentChapter - 1);
        return Math.max(1, Math.round(base * chapterInflation * (1 - MetaManager.getBargainDiscount())));
    }

    /**
     * 通用购买：校验金币 → 扣款 → 若给商品 ID 则标记该商品本波售罄 → 应用效果 → 播放音效 → 刷新。
     * 金币不足时不扣款，给出红色提示。
     */
    private purchase(price: number, soldId: string | null, successMsg: string, apply: () => void): void {
        if (this._boughtThisVisit) {
            return; // 本次开店已购 1 件：全场限购（按钮已置灰，此处兜底防线）
        }
        price = this.finalPrice(price); // 商道折扣：实付价（与 refreshUi 显示价一致）
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
        this._boughtThisVisit = true; // 全场限购：本次开店已购 1 件，其余商品全部置灰
        apply();
        // 附录 A shop_buy：商店转化与定价埋点（删卡无商品 id，固定 remove_card；goldBalance 为扣款后余额）
        Analytics.track('shop_buy', { itemId: soldId ?? 'remove_card', price, goldBalance: gold.currentGold });
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
            this.goldLabel.string = `金币: ${gold}`;
        }
        // 牌库容量软上限：满员时新购弹珠置灰并提示先删卡（配合 DeckManager.MAX_DECK_SIZE）
        const deckCapacity = DeckManager.instance?.maxDeckSize ?? 8;
        const deckSize = DeckManager.instance?.getDeckSize() ?? 0;
        const deckFull = deckSize >= deckCapacity;
        const deckFullSuffix = deckFull ? ` (${deckSize}/${deckCapacity})` : '';
        // 闪电弹珠（价格经「商道」折扣，与 purchase 实付一致）；全场限购：已购 1 件则全部置灰
        const pLight = this.finalPrice(BUY_LIGHTNING_PRICE);
        this.refreshItemCard(this._buyLightning, ITEM_LIGHTNING, gold >= pLight && !deckFull && !this._boughtThisVisit,
            '闪电弹珠', `购买后永久加入牌库，发射瞬间扇形散射`, pLight, deckFull);
        // 熔岩弹珠
        const pLava = this.finalPrice(BUY_LAVA_PRICE);
        this.refreshItemCard(this._buyLava, ITEM_LAVA, gold >= pLava && !deckFull && !this._boughtThisVisit,
            '熔岩弹珠', `双倍重力重压砸击，每次撞钉 +60 能量`, pLava, deckFull);
        // 冰霜弹珠（2026-09-07 上架：售罄 / 牌库满置灰，与闪电/熔岩同管线）
        const pFrost = this.finalPrice(BUY_FROST_PRICE);
        this.refreshItemCard(this._buyFrost, ITEM_FROST, gold >= pFrost && !deckFull && !this._boughtThisVisit,
            '冰霜弹珠', `入任意槽冰封全场 4 秒，冰封中的敌人受伤 +25%`, pFrost, deckFull);
        // 精简卡组：需有普通球可删且金币充足；价格随删卡次数阶梯上涨（同样吃商道折扣）
        const normalCount = DeckManager.instance?.getOrbCount(OrbType.Normal) ?? 0;
        const removePrice = this.finalPrice(this.removePrice());
        this.setButtonEnabled(this._removeNormal, normalCount > 0 && gold >= removePrice && !this._boughtThisVisit);
        if (this._removeNormal?.label?.isValid) {
            this._removeNormal.label.string = '精简卡组';
            this._removeNormal.label.color = this._removeNormal.enabled ? TEXT_COLOR : BTN_TEXT_DISABLED_COLOR;
        }
        if (this._removeNormal?.descLabel?.isValid) {
            this._removeNormal.descLabel.string = `从卡组移除 1 颗普通白球腾出牌位`;
        }
        if (this._removeNormal?.btnLabel?.isValid) {
            this._removeNormal.btnLabel.string = normalCount > 0
                ? `${removePrice} 删除 (余 ${normalCount}${deckFullSuffix})`
                : '✖ 无普通球可删';
        }
        // 城堡维修：可重复购买（阶梯递增价），城堡已毁或金币不足时置灰
        const castle = CastleController.instance;
        const castleAlive = !!castle && castle.currentHp > 0;
        const pRepair = this.finalPrice(this.repairPrice());
        this.refreshItemCard(this._repairCastle, null, castleAlive && gold >= pRepair,
            '城堡维修', `为城堡恢复 ${REPAIR_CASTLE_HP} 点生命（费用递增）`, pRepair);
        // ⭐ 稀有位（Task 007 商店二期）：第 3 章解锁，50/50 掷定，25💰 可刷新
        this.refreshRareCards(gold);
    }

    /**
     * 刷新「限购 1 次」三层商品卡：已售罄 → 置灰 + 「已售罄」；牌库已满 → 置灰 + 「牌库已满」；
     * 未售罄但金币不足 / 条件不满足 → 置灰且价格标红。
     */
    private refreshItemCard(btn: ShopButton | null, soldId: string, affordable: boolean, title: string, sub: string, price: number, deckFull = false): void {
        if (!btn || !btn.label?.isValid) {
            return;
        }
        const bought = this._boughtThisVisit; // 全场限购：任一商品购后全部置灰显示售罄
        const capacity = DeckManager.instance?.maxDeckSize ?? 8;
        const size = DeckManager.instance?.getDeckSize() ?? 0;
        if (btn.descLabel?.isValid) {
            btn.descLabel.string = sub;
        }
        if (btn.btnLabel?.isValid) {
            btn.btnLabel.string = bought
                ? '【已售罄】'
                : deckFull
                    ? `【牌库已满 (${size}/${capacity})】`
                    : `💰 ${price} 购买`;
        }
        btn.label.string = title;
        this.setButtonEnabled(btn, !bought && !deckFull && affordable);
        if (btn.btnLabel?.isValid) {
            btn.btnLabel.color = bought
                ? BTN_TEXT_DISABLED_COLOR // 购后全场售罄：灰字（并修复此前售罄态颜色残留红色的旧问题）
                : affordable ? TEXT_COLOR : MSG_ERROR_COLOR;
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

        // 标题 / 金币 / 消息提示（顶部预留板块；标题与金币左侧挂矢量图标）
        const title = this.ensureLabel('ShopTitle', 0, 332, 34, '弹珠工坊', 400);
        if (title?.isValid) {
            title.color = TITLE_COLOR;
            mountIcon(this.node, 'bag', 30, TITLE_COLOR, -104, 332);
        }
        this.goldLabel = this.ensureLabel('ShopGoldLabel', 0, 286, 26, '金币: 0', 360);
        mountIcon(this.node, 'coin', 24, Theme.ui.gold, -88, 286);
        this.messageLabel = this.ensureLabel('ShopMessageLabel', 0, 242, 20, '', 520);

        // ---------- 单页 2×3 货架：闪电 / 熔岩 / 冰霜 / 删卡 / 修城（无 Tab 切换） ----------
        // 商品卡 2 列 × 3 行：第 5 格（维修）独占第三行左位，右位由稀有行的「刷新货架」补位；行距 180，面板已加高至 1040
        const cardPos = (col: number, row: number) => ({ x: col === 0 ? -140 : 140, y: [110, -70, -250][row] });
        this._buyLightning = this.createCard(this.buyLightningBtn, 'BuyLightningBtn',
            cardPos(0, 0).x, cardPos(0, 0).y, '闪电弹珠', `购买后永久加入牌库，发射瞬间扇形散射`,
            'bolt', BTN_ACTIVE_COLOR);
        this._buyLava = this.createCard(this.buyLavaBtn, 'BuyLavaBtn',
            cardPos(1, 0).x, cardPos(1, 0).y, '熔岩弹珠', `双倍重力重压砸击，每次撞钉 +60 能量`,
            'flame', BTN_ACTIVE_COLOR);
        this._buyFrost = this.createCard(this.buyFrostBtn, 'BuyFrostBtn',
            cardPos(0, 1).x, cardPos(0, 1).y, '冰霜弹珠', `入任意槽冰封全场 4 秒，冰封中的敌人受伤 +25%`,
            'snow', BTN_ACTIVE_COLOR);
        this._removeNormal = this.createCard(this.removeNormalBtn, 'RemoveNormalBtn',
            cardPos(1, 1).x, cardPos(1, 1).y, '精简卡组', `从卡组移除 1 颗普通白球腾出牌位`,
            'trash', BTN_ACTIVE_COLOR);
        this._repairCastle = this.createCard(this.repairCastleBtn, 'RepairCastleBtn',
            cardPos(0, 2).x, cardPos(0, 2).y, '城堡维修', `为城堡恢复 ${REPAIR_CASTLE_HP} 点生命`,
            'castle', BTN_ACTIVE_COLOR);

        // ⭐ 稀有位行（Task 007 商店二期）：两稀有卡占 -140/+140（与首二行 2 列同轨，跨距 620）；
        //    「刷新货架」落第三行右留白位（此前 x=0 三卡 260 宽两两重叠 120px 且总跨 780>面板 620）；
        //    未解锁章节整行隐藏（refreshRareCards 控制 active）
        const rarePos = (col: number) => ({ x: RARE_X[col], y: -390 });
        const rareDefs: { id: string; name: string; handler: () => void }[] = [
            { id: ITEM_REROLL, name: 'RareRerollCard', handler: this.onBuyReroll },
            { id: ITEM_GILDRUSH, name: 'RareGildRushCard', handler: this.onBuyGildRush },
        ];
        rareDefs.forEach((def, i) => {
            const text = RARE_OFFER_TEXT[def.id];
            this._rareCards[i] = this.createCard(null, def.name,
                rarePos(i).x, rarePos(i).y, text.title, text.desc,
                text.icon, BTN_ACTIVE_COLOR, this.node);
            this.bindButton(this._rareCards[i], def.handler);
        });
        this._refreshBtn = this.createCard(null, 'RareRefreshCard',
            140, -250, '刷新货架', '重掷两个稀有位商品',
            'gear', CONTINUE_COLOR, this.node);
        this.bindButton(this._refreshBtn, this.onRefreshRare);

        // 继续下一关按钮（置底，宽 420 高 52；Y:-470 随面板加高（1040）下移，让位稀有位行不重叠）
        this._continue = this.ensureButton(this.continueBtn, 'ContinueBtn', 0, -470,
            '继续下一关', 420, 52, CONTINUE_COLOR);
        if (this._continue?.node?.isValid) {
            mountIcon(this._continue.node, 'arrowRight', 22, Theme.white, -100, 0);
        }
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
        icon: string, activeColor: Color, parent: Node | null = null,
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

        // ---- 1.5) 标题左侧商品图标（IconLib 矢量染色，替代 emoji 前缀） ----
        mountIcon(node, icon, 26, TITLE_GOLD_COLOR, -BTN_WIDTH / 2 + 22, 48);

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
        descLabel.color = Theme.ui.text;

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

/** 重绘按钮底色：凸起浮雕（可用 = 强调色，置灰 = 禁用色） */
    private drawButtonBg(btn: ShopButton, enabled: boolean): void {
        if (!btn.graphics?.isValid) {
            return;
        }
        btn.graphics.clear();
        raisedButton(btn.graphics, btn.width, btn.height, enabled ? btn.activeColor : BTN_DISABLED_COLOR, 10);
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

    /** 📐 面板整体缩放（Task 010 多分辨率）：fitHeight 下可视宽 = 720×(1280/屏高)，
     *  20:9 竖屏仅 ≈576——商店内容需求 660（面板 620 / 卡跨度 660）超出可视宽会裁边。
     *  整体等比缩小到刚好放下（钳制 ≤1，720×1280 基线不受影响）；输入用 openShop 已算好的可视宽。 */
    private applyScale(visW: number): void {
        const need = Math.max(PANEL_WIDTH, 2 * (Math.abs(RARE_X[1]) + BTN_WIDTH / 2)) + 40; // 面板宽 / 稀有卡跨度 取大者 + 两侧 20px 呼吸
        this._uiScale = Math.min(1, visW / need);
        this.node.setScale(this._uiScale, this._uiScale, 1);
    }

    /** 弹窗浮现动效：整体 0.8 → 1.06 → uiScale 弹性放大（与 RewardDialog 保持一致手感） */
    private playPopAnimation(): void {
        const node = this.node;
        if (!node?.isValid) {
            return;
        }
        Tween.stopAllByTarget(node);
        node.setScale(0.8, 0.8, 1);
        tween(node)
            .to(0.09, { scale: new Vec3(1.06, 1.06, 1) })
            .to(0.06, { scale: new Vec3(this._uiScale, this._uiScale, 1) })
            .start();
    }
}
