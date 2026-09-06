import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec3, tween, Tween, Sprite, Button, find,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { ShopDialog } from './ShopDialog';
import { CastleController } from '../Battle/CastleController';
import { EnemyController } from '../Battle/EnemyController';
import { PegComponent } from '../Pinball/PegComponent';
import { DeckManager } from '../Core/DeckManager';
import { OrbController } from '../Pinball/OrbController';
import { OrbBalance } from '../Core/OrbBalance';
import { CardData, CARD_DATABASE, META_UNLOCKED_CARDS, drawWeightedCards, enforceRarityFloor, OrbType, RelicType } from '../Core/DataModels';
import { MetaManager } from '../Core/MetaManager';
import type { MetaUpgradeId } from '../Core/MetaManager';
import { LevelManager, WAVES_PER_LEVEL } from '../Core/LevelManager';
import { RelicManager, RELIC_INFO, ALL_RELIC_TYPES } from '../Core/RelicManager';
import { GoldManager } from '../Core/GoldManager';
import { Analytics } from '../Core/Analytics';
import { AdService } from '../Core/AdService';
import { Theme } from '../Core/ArtTheme';
import { mountIcon } from '../Core/IconLib';
import { attachEpicGlow, cardFrame, rarityTier, removeEpicGlow, raisedButton, type RarityTier } from '../Core/UiKit';
import { loadTex } from '../Core/TexCache';

const { ccclass, property } = _decorator;

/** 流派色条映射：熔岩=橙红 / 电光=冰蓝 / 冰封=霜白 / 中立=金（全部取自 ArtTheme 语义色） */
function archetypeAccent(archetype: string): Color {
    if (archetype.includes('熔岩')) {
        return Theme.orb.lava;
    }
    if (archetype.includes('电光')) {
        return Theme.orb.lightning;
    }
    if (archetype.includes('冰封')) {
        return Theme.orb.frost;
    }
    return Theme.ui.gold;
}

/** 赛后三选一卡牌展示所需的最小数据切片（由 CARD_DATABASE 提供池子） */
interface RewardCard {
    id: string;
    title: string;
    desc: string;
    archetype: string;
    /** 与 CardData.rarity 同型（drawWeightedCards 的泛型约束依赖它查权重表） */
    rarity: CardData['rarity'];
    actionType: CardData['actionType'];
    orbType?: number;
    value?: number;
}

// ---------- 竖版卡牌版式（卡框贴图为竖版设计 ~2:3，三连排横放） ----------
const CARD_W = 200;
const CARD_H = 300;
/** 三张卡的横排位置（代码强制钉位，场景旧纵向堆叠坐标一律覆盖） */
const CARD_SLOTS: Array<[number, number]> = [[-210, 30], [0, 30], [210, 30]];
/** 框窗文字区（卡框贴图的内窗范围）：居中偏上 */
const CARD_TEXT_W = 148;
const CARD_TEXT_H = 165;
const CARD_TEXT_Y = 6;

/** 五卡池抽三：每次展示可选项数量 */
const REWARD_CHOICE_COUNT = 3;
/** 【传奇藏宝箱】遗物二选一：每次展示的可选遗物数量（第 5 / 10 关） */
const RELIC_CHEST_COUNT = 2;

/** 标准卡库（DataModels.CARD_DATABASE）：战后三选一的公共抽卡池 */
const REWARD_CARD_POOL: RewardCard[] = CARD_DATABASE.map((c) => ({
    id: c.id, title: c.title, desc: c.desc,
    archetype: c.archetype, rarity: c.rarity,
    actionType: c.actionType, orbType: c.orbType, value: c.value,
}));

/**
 * 战后肉鸽三选一卡牌奖励弹窗：挂载在 UILayer/RewardDialog 节点上。
 * - 监听 SHOW_REWARDS：随机展示 3 张不重复奖励卡牌；
 * - 玩家点击任意卡牌：应用强化 → 隐藏弹窗 → 广播 REWARD_SELECTED 让 WaveManager 开启下一波。
 */
@ccclass('RewardDialog')
export class RewardDialog extends Component {
    /** 三张卡牌按钮节点（在 Inspector 拖入 UILayer/RewardDialog 下的 card A/B/C） */
    @property(Node)
    cardA: Node | null = null;

    @property(Node)
    cardB: Node | null = null;

    @property(Node)
    cardC: Node | null = null;

    /** 当前展示的三个奖励（与 cardA/B/C 一一对应） */
    private _currentRewards: RewardCard[] = [];
    /** SHOW_REWARDS 监听是否已注册（start / onEnable 入口幂等） */
    private _listening = false;
    /** 卡牌点击监听是否已绑定（重复激活只绑一次，避免多次点击触发） */
    private _bound = false;
    /** 选择防抖：一次展示只允许选择一张（拦截连点/双回调重复结算） */
    private _selecting = false;
    /** 展示中标记：DailyTaskDialog.bootstrap 在场景启动期 closeAllModals() 会把本节点失活，
     *  导致 start()（默认隐藏）推迟到首次激活才执行——不加守卫会把刚打开的弹窗当场藏回去
     *  （自吞尾，2026-09-04 实测回归）。 */
    private _showing = false;
    /** 当前是否为【传奇藏宝箱】模式（第 5 / 10 关）：true 时展示 2 张未拥有遗物免费二选一 */
    private _chestMode = false;
    /** 宝箱模式当前展示的 2 个未拥有遗物（与 cardA/cardB 一一对应；cardC 隐藏） */
    private _chestRelics: RelicType[] = [];
    /** 📺 本关「换一批」广告是否已用（每关一次；showRewards() 常规重入时重置） */
    private _adRefreshUsed = false;
    /** 📺 换一批按钮节点（updateRefreshBtn 幂等创建复用；宝箱模式 / 已用时隐藏） */
    private _adRefreshBtn: Node | null = null;

    /** 监听注册提前到 onLoad：场景启动时 DailyTaskDialog 的 closeAllModals() 会把弹窗节点
     *  失活（EVENT_AFTER_SCENE_LAUNCH），若依赖 start() 注册，节点失活后 start 永不执行、
     *  SHOW_REWARDS 无监听 → 第三波后无法进入下一关（2026-09-04 实测回归）。 */
    protected onLoad(): void {
        this.ensureReady();
    }

    start() {
        // 默认隐藏弹窗：仅在 SHOW_REWARDS 事件时展示。
        // ★ 展示中不自吞：场景启动期 closeAllModals() 失活本节点会把本 start 推迟到
        //   首次激活（showRewards）时才执行，此时绝不能再把自己藏回去（见 _showing 注释）。
        if (!this._showing) {
            this.node.active = false;
        }
        this.ensureReady();
    }

    onEnable() {
        // 兜底：节点被外部隐藏/恢复时，保证监听与卡牌点击始终可用
        this.ensureReady();
    }

    onDestroy() {
        this._listening = false;
        EventBus.off(GameEvents.SHOW_REWARDS, this.showRewards, this);
    }

    /** 幂等初始化：注册 SHOW_REWARDS 监听 + 绑定三张卡牌点击（各自只执行一次） */
    private ensureReady(): void {
        if (!this._listening) {
            this._listening = true;
            EventBus.on(GameEvents.SHOW_REWARDS, this.showRewards, this);
        }
        if (!this._bound) {
            this._bound = true;
            this.bindCard(this.cardA, 0);
            this.bindCard(this.cardB, 1);
            this.bindCard(this.cardC, 2);
        }
    }

    /** SHOW_REWARDS 回调：战后分流转场——本关最后一波且为第 5/10 关 → 遗物宝箱；否则 → 卡牌三选一 */
    public showRewards(fromAdRefresh = false): void {
        // 📺 换一批重入不重置（本关已用过）；常规展示（新关卡 / 看门狗重发）恢复可用。
        // 重发只发生在弹窗未打开时（watchdog 对 anyModalOpen 短路），不会误重置已用状态。
        if (!fromAdRefresh) {
            this._adRefreshUsed = false;
        }
        if (!this.node?.isValid) {
            return;
        }
        // 先置位再激活：启动期被失活导致推迟执行的 start() 默认隐藏，不得吞掉本次展示
        this._showing = true;
        console.log('[Reward] 收到 SHOW_REWARDS：准备战后奖励弹窗');
        this._selecting = false;
        // ★ 双保险：弹窗展示瞬间再回收一次场上残余弹珠（WaveManager 已在派发前回收过），
        //    确保任何来源（商店 / 直接触发）打开弹窗时屏幕都绝对平稳、无残球撞钉发声。
        try {
            OrbController.recycleAllOrbs();
        } catch (e) {
            console.error('[Reward] 残珠回收异常（已隔离，不阻断展示）', e);
        }
        // ★ 战后面板复新（2026-09-05 根修）：最后一波（精英/Boss）打到通关时钉板已近乎
        //   全场力竭变灰——奖励弹窗背后展示的正是这块「只剩一颗可用」的残板。
        //   （UI_MODAL_CHANGED 只是同一弹窗链中的伴随日志，全监听方均不触碰钉板，属时间相关非因果。）
        //   弹窗打开瞬间整板复新：弹窗背后的钉板永远是满血彩色；选卡后 advanceToNextLevel
        //   仍会经 REWARD_SELECTED 重排钉板，此处纯展示层修复、无竞态。
        try {
            PegComponent.resetAllPegs();
        } catch (e) {
            console.error('[Reward] 钉板复新异常（已隔离，不阻断展示）', e);
        }
        // 审计：弹窗打开时的钉板构成——总数不足预期=生成失败（回查 [诊断] 钉板生成日志），
        //   总数满但力竭≈总数=战损力竭（本次修复覆盖的正是此态），据此区分两类根因。
        const boardPegs = (find('Canvas')?.getComponentsInChildren(PegComponent) ?? []).filter((p) => p?.node?.isValid);
        console.log(`[诊断] 奖励弹窗打开时钉板审计：总数 ${boardPegs.length}，力竭 ${boardPegs.filter((p) => p.isExhausted).length}`);
        // ★ 结算链加固（2026-09-04）：数据准备段整体异常隔离——任何一环抛错只降级为
        //   「空白卡弹窗」，绝不卡死波次推进链（弹窗激活在 catch 之外保证执行）。
        let chestShown = false;
        try {
            // 本关最后一波（currentWave >= maxWaves）才判定精英/Boss 宝箱；中途波次照常 3 选 1
            const levelCleared = LevelManager.currentWave >= WAVES_PER_LEVEL;
            // ☆ 第 5 / 10 关为精英关 / Boss关，通关后开启【传奇藏宝箱】：从未拥有遗物里随机 2 件免费二选一。
            //   ★ 软锁修复：5 件遗物收集齐后（第 3 章起必然到达）unowned 为空 → 两张卡全隐藏 →
            //     弹窗无可点目标、REWARD_SELECTED 永不发出、游戏卡死。空池时回退常规卡牌三选一。
            const unownedCount = ALL_RELIC_TYPES.filter((t) => !RelicManager.hasRelic(t)).length;
            if (levelCleared && (LevelManager.currentLevel === 5 || LevelManager.currentLevel === 10) && unownedCount > 0) {
                this.showRelicChest();
                chestShown = true;
            } else {
                // 常规关卡 / 中途波次：战后卡牌三选一
                this._chestMode = false;
                this.updateRefreshBtn(); // 📺 换一批按钮：仅三选一模式显示（宝箱模式隐藏）
                // ★ 卡库按稀有度加权抽三（100/40/15）：史诗球卡低频、普通救急卡高频；
                //   无放回不重复；牌库满时池已滤掉 AddOrb（史诗层为空自动退化）
                const canAddOrb = DeckManager.instance?.canAddOrb() ?? true;
                // 🌳 Meta 跨局解锁卡：把 metaLock 子轨已达档位的专属卡并入池（未解锁档位不入池 → 常规局抽不到）
                const unlockedSpecials: RewardCard[] = META_UNLOCKED_CARDS
                    .filter((c) => !c.metaLock || MetaManager.getLv(c.metaLock.track as MetaUpgradeId) >= c.metaLock.lv)
                    .map((c) => ({
                        id: c.id, title: c.title, desc: c.desc, archetype: c.archetype,
                        rarity: c.rarity, actionType: c.actionType, orbType: c.orbType, value: c.value,
                    }));
                const pool = [...REWARD_CARD_POOL, ...unlockedSpecials].filter((card) => canAddOrb || card.actionType !== 'AddOrb');
                this._currentRewards = drawWeightedCards(pool, REWARD_CHOICE_COUNT);
                // ⚒ Meta「战术洞察」（解锁树子轨）稀有度地板：Lv1+ 保证至少 1 张稀有、Lv3+ 追加至少 1 张史诗
                //   （池内无达标卡自动原样返回——如牌库满滤掉 AddOrb 后史诗层变薄的情形）
                const insight = MetaManager.getInsightLv();
                if (insight >= 1) {
                    this._currentRewards = enforceRarityFloor(this._currentRewards, pool, '稀有');
                }
                if (insight >= 3) {
                    this._currentRewards = enforceRarityFloor(this._currentRewards, pool, '史诗');
                }
                this.setCardLabel(this.cardA, 0);
                this.setCardLabel(this.cardB, 1);
                this.setCardLabel(this.cardC, 2);
                if (this.cardC?.isValid) {
                    this.cardC.active = true; // 常规三选一：三张卡全显示
                }
                // 附录 A card_offer：卡牌曝光（offers 为卡牌 id 数组；与 card_pick 对齐算弃选率 → 冷门卡重做）
                Analytics.track('card_offer', {
                    chapter: LevelManager.currentChapter,
                    offers: this._currentRewards.map((c) => c.id),
                });
                console.log('[Reward] 展示奖励:', this._currentRewards.map((c) => c.title).join(' / '));
            }
        } catch (e) {
            console.error('[Reward] 奖励数据准备异常，降级展示空白卡（点任意卡仍可推进流程）', e);
            this._chestMode = false;
            this._currentRewards = [];
        }
        if (chestShown) {
            return; // 宝箱模式已在 showRelicChest 内完成激活与动效
        }
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true); // 弹窗打开：冻结发射
        this.node.active = true;
        console.log('[Reward] 奖励弹窗已激活（模态冻结发射）');
        this.playPopAnimation();
    }

    /**
     * 【传奇藏宝箱】模式：从未拥有的遗物中随机抽 2 件免费二选一（第 5 / 10 关精英/Boss 战后专属）。
     * 选完后直接 RelicManager.addRelic(picked) 并推进下一关/下一章。
     */
    private showRelicChest(): void {
        this._chestMode = true;
        this.updateRefreshBtn(); // 宝箱模式：隐藏换一批按钮
        const unowned = ALL_RELIC_TYPES.filter((t) => !RelicManager.hasRelic(t));
        // 从未拥有的遗物里洗牌取 2 件；若不足 2 件则全部给出（留空位隐藏对应卡）
        this.shuffleType(unowned);
        this._chestRelics = unowned.slice(0, RELIC_CHEST_COUNT);
        if (this.cardC?.isValid) {
            this.cardC.active = false; // 宝箱模式只显示 2 张（cardA / cardB）
        }
        this.setRelicCard(this.cardA, 0);
        this.setRelicCard(this.cardB, 1);
        console.log('[Reward] 传奇藏宝箱：遗物二选一', this._chestRelics.map((t) => RELIC_INFO[t]?.name).join(' / '));
        // 附录 A relic_offer：遗物曝光（第 5/10 关精英/Boss 战后宝箱二选一）
        Analytics.track('relic_offer', { types: this._chestRelics });
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true); // 冻结发射
        this.node.active = true;
        this.playPopAnimation();
    }

    // ---------- 📺 换一批广告点位（第 3 步 UI 接线）：战后三选一可看广告重抽一次 ----------

    /** 📺 换一批按钮：幂等创建（挂弹窗根节点底部），宝箱模式 / 已用过时隐藏 */
    private updateRefreshBtn(): void {
        let btn = this._adRefreshBtn;
        if (!btn || !btn.isValid) {
            btn = new Node('AdRefreshBtn');
            btn.layer = this.node.layer;
            this.node.addChild(btn);
            btn.setPosition(0, -300, 0);
            btn.addComponent(UITransform).setContentSize(210, 52);
            const g = btn.addComponent(Graphics);
            raisedButton(g, 210, 52, Theme.ui.goldDim, 12);
            const labelNode = new Node('Label');
            labelNode.layer = btn.layer;
            btn.addChild(labelNode);
            labelNode.addComponent(UITransform).setContentSize(210, 52);
            const label = labelNode.addComponent(Label);
            label.fontSize = 18;
            label.lineHeight = 22;
            label.color = Theme.white.clone();
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.string = '📺 看广告 换一批';
            btn.on(Node.EventType.TOUCH_END, this.onRefreshClick, this);
            this._adRefreshBtn = btn;
        }
        btn.active = !this._chestMode && !this._adRefreshUsed;
    }

    /** 📺 换一批：看完整广告 → 重跑 showRewards 重抽三张（每关一次；漏斗埋点由 AdService 上报） */
    private onRefreshClick(): void {
        if (this._adRefreshUsed || this._chestMode) {
            return;
        }
        AdService.showRewarded('card_refresh', () => {
            this._adRefreshUsed = true;
            if (this._adRefreshBtn?.isValid) {
                this._adRefreshBtn.active = false;
            }
            console.log('[Reward] 广告换一批：重抽战后三选一（本关额度已用）');
            this.showRewards(true);
        });
    }

    /** 绑定单张卡牌的点击事件（点击下标即奖励下标，闭包捕获保证一一对应）+ 竖版钉位 */
    private bindCard(card: Node | null, index: number): void {
        if (!card?.isValid) {
            console.warn(`[Reward] 卡牌节点 card${['A', 'B', 'C'][index] ?? index} 未配置，点击该卡无效`);
            return;
        }
        // 竖版三连排钉位（覆盖场景遗留的纵向堆叠坐标）+ 触摸尺寸
        const [x, y] = CARD_SLOTS[index] ?? [0, 0];
        card.setPosition(x, y, 0);
        card.getComponent(UITransform)?.setContentSize(CARD_W, CARD_H);
        // 场景遗留的白色 panel Sprite 退役：卡面视觉全部由 Graphics（深底）+ FrameImg（卡框贴图）承担——
        // 否则贴图透明窗透出白底，浅色框窗文字完全不可读（2026-09-03 预览实测）。
        card.getComponent(Sprite)?.destroy();
        // 场景遗留的 Button（SPRITE 过渡）一并退役：它会把空状态帧写进已销毁的卡面 Sprite，
        // 悬停/按下即抛 "null (reading '_uiProps')"，且崩在中断事件派发链时会跳过 selectReward
        // → REWARD_SELECTED 不发 → 下一关/钉板不加载（2026-09-03 预览实测）。选卡走本类的
        // TOUCH_END 监听，Button 纯冗余。
        card.getComponent(Button)?.destroy();
        card.getComponent(UITransform) ?? card.addComponent(UITransform);
        card.on(Node.EventType.TOUCH_END, () => {
            this.selectReward(index);
        }, this);
    }

    private setCardLabel(card: Node | null, index: number): void {
        if (!card?.isValid) {
            return;
        }
        const reward = this._currentRewards[index];
        if (!reward) {
            return; // 降级模式（数据准备异常）：卡面保持空白，selectReward 走直通推进
        }
        const label = card.getComponentInChildren(Label);
        if (label) {
            // 框窗文字区：卡框贴图的内窗（代码强制排版；SHRINK 保证空间不足时自缩不截断）
            const transform = label.getComponent(UITransform) || label.addComponent(UITransform);
            transform.setContentSize(CARD_TEXT_W, CARD_TEXT_H);
            label.node.setPosition(0, CARD_TEXT_Y, 0);

            label.overflow = Label.Overflow.SHRINK;
            label.enableWrapText = true;
            label.fontSize = 14;
            label.lineHeight = 19;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.color = Theme.ui.text;
            // 三段式：流派·稀有度 / 名称 / 说明（卡框窗内展示）
            label.string = `【${reward.archetype}·${reward.rarity}】\n${reward.title}\n${reward.desc}`;
        }
        // 竖版卡面：深底 + 流派色条 + 稀有度边框（矢量兜底）→ 卡框贴图加载成功后盖过矢量层
        const tf = card.getComponent(UITransform) ?? card.addComponent(UITransform);
        tf.setContentSize(CARD_W, CARD_H);
        const g = card.getComponent(Graphics) ?? card.addComponent(Graphics);
        g.clear();
        g.fillColor = Theme.ui.panelOpaque; // #1E2230 深暗底色
        g.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 16);
        g.fill();
        // 流派色条（左缘竖条，语义色暗示流派）→ 稀有度边框 → 史诗贵气脉冲
        const tier: RarityTier = rarityTier(reward.rarity);
        g.fillColor = archetypeAccent(reward.archetype);
        g.roundRect(-CARD_W / 2 + 8, -CARD_H / 2 + 14, 4.5, CARD_H - 28, 2.25);
        g.fill();
        cardFrame(g, CARD_W, CARD_H, tier);
        if (tier === 2) {
            attachEpicGlow(card, CARD_W, CARD_H);
        } else {
            removeEpicGlow(card);
        }
        // 生成卡框底图优先（textures/card_frame_<tier>）：加载成功盖过矢量边框（垫在文字之下），失败保持矢量
        this.attachCardFrameImage(card, tier);
    }

    /** 卡框底图：FrameImg 子节点垫底（sibling 0 = 渲染最底），铺满竖版卡面；幂等，重绘时复用 */
    private attachCardFrameImage(card: Node, tier: RarityTier): void {
        const file = ['card_frame_common', 'card_frame_rare', 'card_frame_epic'][tier];
        loadTex(file, (sf) => {
            if (!sf || !card?.isValid) {
                return; // 失败：矢量稀有度边框保持原样
            }
            let img = card.getChildByName('FrameImg');
            if (!img?.isValid) {
                img = new Node('FrameImg');
                img.layer = card.layer;
                img.addComponent(UITransform);
                card.addChild(img);
                img.setSiblingIndex(0); // 垫底：在文字/图标之下
            }
            const sp = img.getComponent(Sprite) ?? img.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            sp.spriteFrame = sf;
            img.getComponent(UITransform)?.setContentSize(CARD_W, CARD_H);
            img.setPosition(0, 0, 0);
        });
    }
/** 【传奇藏宝箱】卡牌填充：把第 index 个候选遗物渲染到 card 节点；无候选则隐藏该卡 */
    private setRelicCard(card: Node | null, index: number): void {
        if (!card?.isValid) {
            return;
        }
        const type = this._chestRelics[index];
        if (type === undefined) {
            if (card?.isValid) {
                card.active = false;
            }
            return;
        }
        card.active = true;
        const info = RELIC_INFO[type];
        const label = card.getComponentInChildren(Label);
        if (label) {
            // 框窗文字区（与常规卡同一版式）
            const transform = label.getComponent(UITransform) || label.addComponent(UITransform);
            transform.setContentSize(CARD_TEXT_W, CARD_TEXT_H);
            label.node.setPosition(0, CARD_TEXT_Y, 0);
            label.overflow = Label.Overflow.SHRINK;
            label.enableWrapText = true;
            label.fontSize = 14;
            label.lineHeight = 19;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.color = Theme.ui.text;
            label.string = `【传奇遗物】\n${info.name}\n${info.desc}\n（免费二选一）`;
        }
        // 竖版卡面：金褐底 + 史诗金框（传奇藏宝箱专用）→ 卡框贴图加载成功后盖过矢量层
        const tf = card.getComponent(UITransform) ?? card.addComponent(UITransform);
        tf.setContentSize(CARD_W, CARD_H);
        const g = card.getComponent(Graphics) ?? card.addComponent(Graphics);
        g.clear();
        g.fillColor = Theme.ui.treasureBg; // 藏宝箱金褐底色
        g.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 16);
        g.fill();
        cardFrame(g, CARD_W, CARD_H, 2);
        attachEpicGlow(card, CARD_W, CARD_H);
        // 遗物矢量图标（框窗上方居中）
        mountIcon(card, info.icon, 36, Theme.ui.gold, 0, CARD_TEXT_Y + CARD_TEXT_H / 2 + 14);
        this.attachCardFrameImage(card, 2);
    }

    /** Fisher–Yates 原地洗牌（遗物数组专用，卡池抽取已改走 drawWeightedCards 加权抽取） */
    private shuffleType(arr: RelicType[]): void {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
    }

    /** 点击卡牌：宝箱模式 → 直接加遗物并推进；常规选牌 → 应用强化 → 按关卡分流转场（商店 / 下一关） */
    private selectReward(index: number): void {
        if (this._selecting) {
            return; // 防抖：连点/双回调只结算一次
        }
        // ☆ 宝箱模式：直接收录选定遗物
        if (this._chestMode) {
            this.selectRelic(index);
            return;
        }
        const reward = this._currentRewards[index];
        if (!this.node?.isValid) {
            return;
        }
        if (reward === undefined) {
            // 降级模式（数据准备异常导致卡面空白）：无奖励直接推进，保证流程永不死锁
            this._selecting = true;
            console.warn('[Reward] 奖励数据缺失（降级模式）：跳过奖励直接推进');
            try {
                PegComponent.resetAllPegs();
                this.advanceToNextLevel();
            } finally {
                // ★ finally 保证弹窗必关（2026-09-04）：推进链任何一环抛异常时，若弹窗滞留屏幕，
                //   看门狗会因 anyModalOpen()=true 直接 return，形成永久死锁；先关弹窗，
                //   看门狗 3 秒后重发 SHOW_REWARDS 自动重开（showRewards 会复位 _selecting）。
                this.playHideAnimation(index);
            }
            return;
        }
        this._selecting = true;
        try {
            // 附录 A card_pick：选择回调（usedRefresh 为刷新卡牌功能占位字段——功能未上线恒 false，
            // 字段先行定死符合附录 A「只增不改」红线，后续上线刷新功能时直接改值）
            Analytics.track('card_pick', {
                pickedId: reward.id,
                offers: this._currentRewards.map((c) => c.id),
                usedRefresh: false,
            });
            // ★ 奖励应用异常隔离（2026-09-04）：applyReward 曾无兜底，某张卡效果抛错会中断
            //   selectReward → _selecting 恒 true + REWARD_SELECTED 不发 → 第 3 波后永久卡死。
            //   单卡失败只跳过该奖励，选卡流程照常推进。
            try {
                this.applyReward(reward);
            } catch (e) {
                console.error('[Reward] 奖励应用异常（已隔离，流程照常推进）', e);
            }
            // 新回合钉板复活：清空上一场全部钉子受击计数（含力竭灰色）
            PegComponent.resetAllPegs();
            this._currentRewards = [];
            // ☆ 关卡分流转场：
            //   - 第 3 / 6 / 9 关：选完卡牌无缝转入流浪商人商店（ShopDialog 点「继续」才推进下一关）；
            //   - 其余关卡（1/2/4/7/8）：不经过商店，选完直接推进下一关。
            const level = LevelManager.currentLevel;
            const levelCleared = LevelManager.currentWave >= WAVES_PER_LEVEL;
            if (levelCleared && (level === 3 || level === 6 || level === 9)) {
                // 第 3 / 6 / 9 关最后一波：选完卡牌无缝转入流浪商人商店（ShopDialog 点「继续」才推进下一关）
                EventBus.emit(GameEvents.SHOW_SHOP); // 埋点桥（OpsBridge.shop_view）等副作用监听照常收听
                this.openShopDirect();               // ★ 直连兜底：监听缺失/悬空时商店也必须打开（2026-09-04 1-3 回归）
            } else {
                // 中途波次 → 直接进入下一波；非商店关最后一波（如 1/2/4/7/8）→ 直接进入下一关
                this.advanceToNextLevel();
            }
        } finally {
            this.playHideAnimation(index);
        }
    }

    /**
     * 🏪 商店直连兜底（2026-09-04 1-3 第三波回归根因修复）：SHOW_SHOP 的监听方 ShopDialog
     * 与本弹窗同属「会被失活 / 热重载换实例」的弹窗组件——监听缺失或悬空时 emit 静默 no-op，
     * 商店不开 → REWARD_SELECTED 永不发出 → 3/6/9 关选完卡永久卡死（此前商店无任何兜底，
     * 与 WaveManager 对 RewardDialog 的兜底同根因同方案）。
     * emit 后按商店节点真实 active 复查：未开则直接抓组件调 openShop（组件方法不依赖
     * 节点激活态与监听注册），事件链正常打开商店时本方法按节点 active 直接短路。
     */
    private openShopDirect(): void {
        const node = find('Canvas/UILayer/ShopDialog');
        if (node?.isValid && node.active) {
            return; // 商店已被事件链正常打开
        }
        const shop = node?.getComponent(ShopDialog) ?? null;
        if (shop) {
            console.warn('[Reward] SHOW_SHOP 事件链未打开商店（监听缺失/悬空），直接调用 ShopDialog.openShop 兜底');
            try {
                shop.openShop();
            } catch (e) {
                console.error('[Reward] 商店兜底开门异常', e);
            }
        } else {
            console.error('[Reward] Canvas/UILayer/ShopDialog 节点缺失，无法兜底打开商店（请检查场景层级）');
        }
    }

    /** 【传奇藏宝箱】选择：免费收录遗物并直接推进下一关/下一章 */
    private selectRelic(index: number): void {
        if (this._selecting || !this.node?.isValid) {
            return;
        }
        const type = this._chestRelics[index];
        if (type === undefined) {
            return;
        }
        this._selecting = true;
        try {
            RelicManager.addRelic(type); // 免费收录所选遗物
            console.log(`[Reward] 传奇藏宝箱：获得遗物【${RELIC_INFO[type]?.name ?? type}】`);
            this._chestRelics = [];
            // 新回合钉板复活
            PegComponent.resetAllPegs();
            this.advanceToNextLevel();
        } finally {
            // ★ finally 保证弹窗必关（与 selectReward 同款死锁防护）
            this.playHideAnimation(index);
        }
    }

    /** 常规关卡选完 / 宝箱选完后：取消冻结发射 → 广播 REWARD_SELECTED 让 WaveManager 推进下一关 */
    private advanceToNextLevel(): void {
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, false); // 弹窗关闭：恢复发射
        EventBus.emit(GameEvents.REWARD_SELECTED);         // WaveManager 据此 nextLevel() / startWave(1)
    }

    /** 执行对应卡牌强化效果（依据 DataModels.CARD_DATABASE 的 actionType 分发） */
    private applyReward(reward: RewardCard): void {
        switch (reward.actionType) {
            case 'AddOrb': {
                const orbType = reward.orbType;
                const added = DeckManager.instance?.addOrbToDeck(orbType as OrbType) ?? false;
                if (!added) {
                    this._selecting = false;
                    return;
                }
                // 过载雷球：雷球散射数 +2（3→5 连发）；LauncherController.fireLightningBurst 消费 splitCount
                let suffix = '';
                if (reward.id === 'lightning_rage') {
                    OrbBalance.applyUpgrade('lightning_projectile', 2);
                    suffix = '（雷球升级 5 连发）';
                }
                console.log(`[Reward] [${reward.title}] 弹珠类型 ${orbType} 已永久加入卡组${suffix}`);
                break;
            }
            case 'BuffHeavy': {
                EnemyController.heavyOverloadMult += reward.value ?? 0;
                console.log(`[Reward] [${reward.title}] 重炮伤害倍率 +${((reward.value ?? 0) * 100).toFixed(0)}%（当前 ×${EnemyController.heavyOverloadMult.toFixed(1)}）`);
                break;
            }
            case 'IceShield': {
                CastleController.instance?.addShield(reward.value ?? 30);
                console.log(`[Reward] [${reward.title}] 获得 ${reward.value ?? 30} 点要塞护盾`);
                break;
            }
            case 'IceVulnerable': {
                EnemyController.iceVulnerableMult += reward.value ?? 0;
                console.log(`[Reward] [${reward.title}] 冰封敌人受伤 +${((reward.value ?? 0) * 100).toFixed(0)}%`);
                break;
            }
            case 'Heal': {
                CastleController.instance?.heal(reward.value ?? 30);
                console.log(`[Reward] [${reward.title}] 恢复 ${reward.value ?? 30} 点生命`);
                break;
            }
            case 'MaxHp': {
                CastleController.instance?.increaseMaxHp(reward.value ?? 25);
                console.log(`[Reward] [${reward.title}] 生命上限 +${reward.value ?? 25}`);
                break;
            }
            case 'UpgradePeg': {
                const upgraded = PegComponent.upgradeRandomNormalPegs(reward.value ?? 3);
                console.log(`[Reward] [${reward.title}] 已将 ${upgraded} 颗普通钉升级为乘倍钉`);
                break;
            }
            case 'GainGold': {
                // 金币入账：走全局金币系统 GAIN_GOLD 事件（与黄金矿工 / 金币槽同一条管线）
                GoldManager.instance?.addGold(reward.value ?? 60);
                console.log(`[Reward] [${reward.title}] 获得 ${reward.value ?? 60} 金币`);
                break;
            }
            case 'LavaSplash':
                OrbBalance.applyUpgrade('lava_splash');
                break;
            case 'LightningCombo':
                OrbBalance.applyUpgrade('lightning_combo');
                break;
            // 🃏 机制应答卡（P2-1 下半场）：静态倍率挂 EnemyController，takeDamage 消费，重开由 resetStaticData 清零
            case 'AntiShield': {
                EnemyController.shieldbreakerStrips += reward.value ?? 1;
                console.log(`[Reward] [${reward.title}] 命中额外剥盾层 +${EnemyController.shieldbreakerStrips}`);
                break;
            }
            case 'AntiSummon': {
                EnemyController.purgeSummonMult += reward.value ?? 0.5;
                console.log(`[Reward] [${reward.title}] 对召唤物伤害倍率 → ×${EnemyController.purgeSummonMult.toFixed(1)}`);
                break;
            }
            case 'AntiElite': {
                EnemyController.bountyEliteMult += reward.value ?? 0.4;
                console.log(`[Reward] [${reward.title}] 对精英/Boss 伤害倍率 → ×${EnemyController.bountyEliteMult.toFixed(1)}`);
                break;
            }
            default:
                console.warn(`[Reward] 未知卡牌动作类型: ${(reward as RewardCard).actionType}`);
        }
    }

    /** 弹窗浮现动效：整体 0.8 → 1.06 → 1 弹性放大，三张卡牌依次浮入（每张也带小弹跳） */
    private playPopAnimation(): void {
        const node = this.node;
        if (!node?.isValid) {
            return;
        }
        Tween.stopAllByTarget(node);
        // 三张卡可能未在场景接线（cardA/B/C 为可空 @property），stopAllByTarget 不接受 null
        const cards = [this.cardA, this.cardB, this.cardC];
        for (const card of cards) {
            if (card?.isValid) {
                Tween.stopAllByTarget(card);
            }
        }
        node.setScale(0.8, 0.8, 1);
        tween(node)
            .to(0.09, { scale: new Vec3(1.06, 1.06, 1) })
            .to(0.06, { scale: new Vec3(1, 1, 1) })
            .start();

        // 三张卡牌依次浮入（延迟递增）
        cards.forEach((card, i) => {
            if (!card?.isValid) {
                return;
            }
            card.setScale(0.85, 0.85, 1);
            tween(card)
                .delay(0.05 * (i + 1))
                .to(0.09, { scale: new Vec3(1.08, 1.08, 1) })
                .to(0.06, { scale: new Vec3(1, 1, 1) })
                .start();
        });
    }

    /** 弹性收起：所选卡放大 → 整体缩小消失（完成后隐藏节点） */
    private playHideAnimation(index: number): void {
        const node = this.node;
        if (!node?.isValid) {
            return;
        }
        const cards = [this.cardA, this.cardB, this.cardC];
        const picked = cards[index];
        if (picked?.isValid) {
            tween(picked)
                .to(0.06, { scale: new Vec3(1.15, 1.15, 1) })
                .start();
        }
        tween(node)
            .to(0.08, { scale: new Vec3(0.7, 0.7, 1) })
            .call(() => {
                if (node?.isValid) {
                    node.active = false;
                }
            })
            .start();
    }
}