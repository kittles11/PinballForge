import {
    _decorator, Component, Node, Label, UITransform, Graphics, Color, Vec3, tween, Tween,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { CastleController } from '../Battle/CastleController';
import { EnemyController } from '../Battle/EnemyController';
import { PegComponent } from '../Pinball/PegComponent';
import { DeckManager } from '../Core/DeckManager';
import { OrbController } from '../Pinball/OrbController';
import { OrbBalance } from '../Core/OrbBalance';
import { CardData, CARD_DATABASE, drawWeightedCards, OrbType, RelicType } from '../Core/DataModels';
import { LevelManager, WAVES_PER_LEVEL } from '../Core/LevelManager';
import { RelicManager, RELIC_INFO, ALL_RELIC_TYPES } from '../Core/RelicManager';
import { GoldManager } from '../Core/GoldManager';
import { Analytics } from '../Core/Analytics';

const { ccclass, property } = _decorator;

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
    /** 当前是否为【传奇藏宝箱】模式（第 5 / 10 关）：true 时展示 2 张未拥有遗物免费二选一 */
    private _chestMode = false;
    /** 宝箱模式当前展示的 2 个未拥有遗物（与 cardA/cardB 一一对应；cardC 隐藏） */
    private _chestRelics: RelicType[] = [];

    start() {
        // 默认隐藏弹窗：仅在 SHOW_REWARDS 事件时展示
        this.node.active = false;
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
    public showRewards(): void {
        if (!this.node?.isValid) {
            return;
        }
        this._selecting = false;
        // ★ 双保险：弹窗展示瞬间再回收一次场上残余弹珠（WaveManager 已在派发前回收过），
        //    确保任何来源（商店 / 直接触发）打开弹窗时屏幕都绝对平稳、无残球撞钉发声。
        OrbController.recycleAllOrbs();
        // 本关最后一波（currentWave >= maxWaves）才判定精英/Boss 宝箱；中途波次照常 3 选 1
        const levelCleared = LevelManager.currentWave >= WAVES_PER_LEVEL;
        // ☆ 第 5 / 10 关为精英关 / Boss关，通关后开启【传奇藏宝箱】：从未拥有遗物里随机 2 件免费二选一
        if (levelCleared && (LevelManager.currentLevel === 5 || LevelManager.currentLevel === 10)) {
            this.showRelicChest();
            return;
        }
        // 常规关卡 / 中途波次：战后卡牌三选一
        this._chestMode = false;
        // ★ 卡库按稀有度加权抽三（100/40/15）：史诗球卡低频、普通救急卡高频；
        //   无放回不重复；牌库满时池已滤掉 AddOrb（史诗层为空自动退化）
        const canAddOrb = DeckManager.instance?.canAddOrb() ?? true;
        const pool = REWARD_CARD_POOL.filter((card) => canAddOrb || card.actionType !== 'AddOrb');
        this._currentRewards = drawWeightedCards(pool, REWARD_CHOICE_COUNT);
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
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true); // 弹窗打开：冻结发射
        this.node.active = true;
        this.playPopAnimation();
    }

    /**
     * 【传奇藏宝箱】模式：从未拥有的遗物中随机抽 2 件免费二选一（第 5 / 10 关精英/Boss 战后专属）。
     * 选完后直接 RelicManager.addRelic(picked) 并推进下一关/下一章。
     */
    private showRelicChest(): void {
        this._chestMode = true;
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

    /** 绑定单张卡牌的点击事件（点击下标即奖励下标，闭包捕获保证一一对应） */
    private bindCard(card: Node | null, index: number): void {
        if (!card?.isValid) {
            console.warn(`[Reward] 卡牌节点 card${['A', 'B', 'C'][index] ?? index} 未配置，点击该卡无效`);
            return;
        }
        // 确保卡牌节点具备接收 UI 触摸的 UITransform（缺失时补一个默认尺寸）
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
        const label = card.getComponentInChildren(Label);
        if (label) {
            // 代码强制排版属性，彻底解决截断问题：充足显示空间 + 自动换行 + 空间不足自缩字号 = 100% 完整展示
            const transform = label.getComponent(UITransform) || label.addComponent(UITransform);
            transform.setContentSize(480, 110);

            label.overflow = Label.Overflow.SHRINK; // 空间不足时自动微缩字号，完整显示全部文字
            label.enableWrapText = true;           // 强制开启自动换行
            label.fontSize = 17;                   // 合适的字号
            label.lineHeight = 23;                 // 合适的行高
            label.horizontalAlign = Label.HorizontalAlign.CENTER; // 水平居中
            label.verticalAlign = Label.VerticalAlign.CENTER;     // 垂直居中

            // 第 1 行为带流派标签和稀有度的醒目标题，第 2 行为完整说明
            label.string = `【 ${reward.archetype} 】 ${reward.title} [${reward.rarity}]\n${reward.desc}`;
        }
        // 强化卡牌节点自身：充足的 UITransform + 深暗色背景（幂等，每次重绘即可）
        const tf = card.getComponent(UITransform) ?? card.addComponent(UITransform);
        tf.setContentSize(520, 130);
        const g = card.getComponent(Graphics) ?? card.addComponent(Graphics);
        g.clear();
        g.fillColor = new Color(30, 34, 48, 255); // #1E2230 深暗底色
        g.roundRect(-260, -65, 520, 130, 14);
        g.fill();
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
            const transform = label.getComponent(UITransform) || label.addComponent(UITransform);
            transform.setContentSize(480, 110);
            label.overflow = Label.Overflow.SHRINK;
            label.enableWrapText = true;
            label.fontSize = 17;
            label.lineHeight = 23;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.string = `【 💎 传奇遗物 】 ${info.icon} ${info.name}\n${info.desc}\n（🆓 免费二选一）`;
        }
        const tf = card.getComponent(UITransform) ?? card.addComponent(UITransform);
        tf.setContentSize(520, 130);
        const g = card.getComponent(Graphics) ?? card.addComponent(Graphics);
        g.clear();
        g.fillColor = new Color(40, 30, 12, 255); // 藏宝箱金褐底色
        g.roundRect(-260, -65, 520, 130, 14);
        g.fill();
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
        if (!this.node?.isValid || reward === undefined) {
            return;
        }
        this._selecting = true;
        // 附录 A card_pick：选择回调（usedRefresh 为刷新卡牌功能占位字段——功能未上线恒 false，
        // 字段先行定死符合附录 A「只增不改」红线，后续上线刷新功能时直接改值）
        Analytics.track('card_pick', {
            pickedId: reward.id,
            offers: this._currentRewards.map((c) => c.id),
            usedRefresh: false,
        });
        this.applyReward(reward);
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
            EventBus.emit(GameEvents.SHOW_SHOP);
        } else {
            // 中途波次 → 直接进入下一波；非商店关最后一波（如 1/2/4/7/8）→ 直接进入下一关
            this.advanceToNextLevel();
        }
        this.playHideAnimation(index);
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
        RelicManager.addRelic(type); // 免费收录所选遗物
        console.log(`[Reward] 传奇藏宝箱：获得遗物【${RELIC_INFO[type]?.name ?? type}】`);
        this._chestRelics = [];
        // 新回合钉板复活
        PegComponent.resetAllPegs();
        this.advanceToNextLevel();
        this.playHideAnimation(index);
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