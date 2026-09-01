import {
    _decorator, Component, Label, Node, Vec2, EventTouch,
} from 'cc';
import { DeckButtonController, TAP_SLOP } from '../UI/DeckButtonController';
import { EventBus, GameEvents } from './EventBus';
import { TutorialManager } from './TutorialManager';
import { OrbBalance } from './OrbBalance';
import { MetaManager } from './MetaManager';
import { OpsBridge } from './OpsBridge';
import { DailyTaskDialog } from '../UI/DailyTaskDialog';
import { EnergyLabelController } from '../Game/EnergyLabelController';
import { MusicManager } from './MusicManager';

const { ccclass, property } = _decorator;

/** 弹珠类型编号（与 OrbController.OrbType 对齐）：0 普通 / 1 裂变雷球 / 2 重力熔岩球 / 3 霜冻冰球 */
const ORB_TYPE_NORMAL = 0;
const ORB_TYPE_LIGHTNING = 1;
const ORB_TYPE_LAVA = 2;
const ORB_TYPE_FROST = 3;

/** 类型编号 → 显示名（用于 DeckLabel 与日志）：0 普通 / 1 雷球 / 2 熔岩 / 3 冰霜 / 4 等离子 */
const ORB_TYPE_NAMES: string[] = ['普通弹珠', '闪电弹珠', '熔岩弹珠', '冰霜弹珠', '等离子球'];

/** 初始卡组构成（纯类型编号，无需任何 Prefab 绑定）：3 普通 + 1 雷球 + 1 熔岩 + 1 冰，固定 6 颗 */
const INITIAL_DECK_TYPES: number[] = [
    ORB_TYPE_NORMAL, ORB_TYPE_NORMAL, ORB_TYPE_NORMAL,
    ORB_TYPE_LIGHTNING, ORB_TYPE_LAVA, ORB_TYPE_FROST,
];

/** 牌库容量基础软上限：masterDeck 最多 8 颗（Meta「弹珠槽扩容」在此之上叠加），超限需先花金币删卡腾位 */
const MAX_DECK_SIZE = 8;

/**
 * 弹珠牌库（单例 DeckManager.instance）：纯代码动态组卡。
 * 挂载在 Canvas/UILayer 或 GameManager 上。
 * 职责：
 *  - 只维护弹珠类型与牌库状态；球种特性完全由类型编号驱动，
 *    LauncherController 发射时经 drawNextOrbType → OrbController.initOrbType 动态赋予；
 *  - 抽牌堆为 number[]（0 普通 / 1 雷球 / 2 熔岩），抽空时弃牌重洗、再无则重建初始卡组 → 弹药永不枯竭；
 *  - deckLabel 实时显示「当前装填 | 剩余」。
 */
@ccclass('DeckManager')
export class DeckManager extends Component {
    /** 单例引用：供发射器 / 弹珠回收等系统直接调用 */
    static instance: DeckManager | null = null;

    /** 牌库信息 Label：显示当前装填与余量（可选） */
    @property(Label)
    deckLabel: Label | null = null;

    /** 底部牌库文字按下位置（UI 坐标）：区分「轻点呼出背包」与「从文字处起始的瞄准拖拽」 */
    private readonly _labelPressPos = new Vec2();

    /** 抽牌堆：下一次 drawNextOrbType 从中取顶（元素为类型编号） */
    private drawPile: number[] = [];
    /** 弃牌堆：弹珠入槽后回收的类型编号；抽牌堆抽空时整体洗回 */
    private discardPile: number[] = [];
    /** 卡组总池：初始卡组 + 战后奖励新增卡牌的全集；抽牌堆与弃牌堆皆空时从这里重新洗入（不回落初始卡组）。
     *  public：供 DeckViewDialog 背包面板统计各球种数量（masterDeck 即「玩家当前拥有的全部弹珠」）。 */
    public masterDeck: number[] = [];

    protected onLoad(): void {
        DeckManager.instance = this;
        // 🎓 新手三步引导自举：必须在 onLoad 挂事件监听（Cocos 保证所有 onLoad 先于所有 start 执行），
        // 否则会错过 WaveManager.start() 在场景启动阶段广播的第一波 WAVE_START。
        TutorialManager.ensureMounted();
        // 📊 运营埋点桥自举（附录 A 统一挂钩层 + 每日任务进度上报；监听 EventBus，业务系统零侵入）
        OpsBridge.ensureMounted();
        // 📋 每日任务面板 + 徽章自举（面板监听 SHOW_DAILY_TASKS 打开；模块级 bootstrap 兜底场景重载重挂）
        DailyTaskDialog.ensureMounted();
        // ⚡ 顶部能量 Label 控制器自举（场景 EnergyLabel 节点从未挂本组件 → UPDATE_ENERGY 零监听）
        EnergyLabelController.ensureMounted();
        // 🎵 程序化 BGM 自举（纯 Web Audio 合成零素材；每场景启动清终局标记并起播，弹窗 duck、Boss 加层）
        MusicManager.ensureStarted();
        // ⚒ meta 永久升级「弹珠打磨」：开局套用伤害加成（OrbBalance.reset() 末尾同样套用，重开一局也覆盖）
        OrbBalance.applyMetaBonus();
    }

    protected start(): void {
        // 卡组纯类型化：随时可重建，不依赖任何 Prefab 配置
        this.drawPile.length = 0;
        this.discardPile.length = 0;
        this.masterDeck = [...INITIAL_DECK_TYPES];
        this.drawPile = [...this.masterDeck];
        this.shuffle(this.drawPile);
        this.updateDeckLabel();
        // 🎒 牌库查看 UI 自举：顶部背包徽章（场景已布置同名节点则幂等复用，否则纯代码创建）。
        // 牌库/遗物弹窗改由 DeckViewDialog 模块级自举挂载（本类不再反向 import 它，解除循环引用）。
        DeckButtonController.ensureMounted();
        // 🎒 双通道呼出：底部牌库文字轻点同样打开背包面板（与右上角 🎒 徽章体验一致）
        this.bindDeckLabelTap();
        console.log(`[DeckManager] 初始卡组就绪：${this.masterDeck.map(t => ORB_TYPE_NAMES[t]).join('、')}（弹药永不枯竭）`);
    }

    protected onDestroy(): void {
        // 注销底部牌库文字上的触摸监听（保持节点销毁前干净）
        const labelNode = this.deckLabel?.node;
        if (labelNode?.isValid) {
            labelNode.off(Node.EventType.TOUCH_START, this.onDeckLabelTouchStart, this);
            labelNode.off(Node.EventType.TOUCH_END, this.onDeckLabelTouchEnd, this);
        }
        if (DeckManager.instance === this) {
            DeckManager.instance = null;
        }
    }

    // ---------- 底部牌库文字轻点呼出背包（双通道之一） ----------

    /** DeckLabel 轻点监听绑定：轻点「装填: ... | 待发: X | 弃牌: Y」文字同样打开背包面板 */
    private bindDeckLabelTap(): void {
        const node = this.deckLabel?.node;
        if (!node?.isValid) {
            return;
        }
        node.on(Node.EventType.TOUCH_START, this.onDeckLabelTouchStart, this);
        node.on(Node.EventType.TOUCH_END, this.onDeckLabelTouchEnd, this);
    }

    /** 记录按下位置（区分轻点与从文字处起始的瞄准拖拽） */
    private onDeckLabelTouchStart(event: EventTouch): void {
        const pos = event.getUILocation();
        this._labelPressPos.set(pos.x, pos.y);
    }

    /** 抬起时位移仍在轻点范围内 → 广播 SHOW_DECK_VIEW 打开背包面板 */
    private onDeckLabelTouchEnd(event: EventTouch): void {
        const pos = event.getUILocation();
        if (Vec2.distance(this._labelPressPos, pos) > TAP_SLOP) {
            return; // 位移过大：是瞄准拖拽而非点击
        }
        EventBus.emit(GameEvents.SHOW_DECK_VIEW);
    }

    /** 战后三选一奖励新增卡牌：永久加入总池并投进弃牌堆，进入循环（下次重洗即可抽到）。
     *  受牌库软上限约束：满 8 颗时拒绝添加并返回 false（需先删卡腾位）。 */
    public addOrbToDeck(type: number): boolean {
        if (!this.canAddOrb()) {
            console.warn(`[DeckManager] 牌库已满（${this.masterDeck.length}/${this.maxDeckSize}），无法添加「${ORB_TYPE_NAMES[type] ?? '未知'}」，请先删卡腾位`);
            return false;
        }
        this.masterDeck.push(type);
        this.discardPile.push(type);
        this.updateDeckLabel();
        return true;
    }

    /** 牌库是否还能新增卡牌（软上限 → masterDeck.length < 有效容量） */
    public canAddOrb(): boolean {
        return this.masterDeck.length < this.maxDeckSize;
    }

    /** 当前牌库总卡数（masterDeck 长度） */
    public getDeckSize(): number {
        return this.masterDeck.length;
    }

    /** 牌库有效容量（基础 8 + Meta「弹珠槽扩容」加成；供商店/背包显示「牌库已满 (X/N)」） */
    public get maxDeckSize(): number {
        return MAX_DECK_SIZE + MetaManager.getOrbCapBonus();
    }

    /**
     * 从卡组移除 1 颗指定类型弹珠（战后商店「删卡」消费）。
     * 同步从抽牌堆 / 弃牌堆移除 1 颗对应球，保持运行时一致（masterDeck 为总池，两堆为运行时牌）。
     * @returns true 删除成功；牌库已无该类型球返回 false。
     */
    public removeOrbFromDeck(type: number): boolean {
        const masterIdx = this.masterDeck.indexOf(type);
        if (masterIdx < 0) {
            return false;
        }
        this.masterDeck.splice(masterIdx, 1);
        // 运行时同步：优先从抽牌堆移除 1 颗，抽牌堆无则从弃牌堆移除
        const drawIdx = this.drawPile.indexOf(type);
        if (drawIdx >= 0) {
            this.drawPile.splice(drawIdx, 1);
        } else {
            const discardIdx = this.discardPile.indexOf(type);
            if (discardIdx >= 0) {
                this.discardPile.splice(discardIdx, 1);
            }
        }
        this.updateDeckLabel();
        console.log(`[DeckManager] 已从卡组移除 1 颗「${ORB_TYPE_NAMES[type] ?? '未知'}」，剩余 ${this.getOrbCount(type)} 颗`);
        return true;
    }

    /** 查询卡组（masterDeck）中指定类型弹珠的数量（商店删卡按钮的可用性判断） */
    public getOrbCount(type: number): number {
        let count = 0;
        for (const t of this.masterDeck) {
            if (t === type) {
                count++;
            }
        }
        return count;
    }

    /**
     * 预览即将发射的弹珠类型（供 LauncherController 瞄准线变色）。
     * 抽牌堆为空时按「弃牌堆 → 总池」顺序预测重洗后的顶牌；极端空场返回 0（普通）。
     */
    public peekNextOrbType(): number {
        if (this.drawPile.length > 0) {
            return this.drawPile[0];
        }
        if (this.discardPile.length > 0) {
            return this.discardPile[0];
        }
        return this.masterDeck.length > 0 ? this.masterDeck[0] : ORB_TYPE_NORMAL;
    }

    /**
     * 抽取下一颗弹珠的类型编号（0 普通 / 1 雷球 / 2 熔岩）。
     * 抽牌堆抽空时自动补给：优先把弃牌堆整体洗回；弃牌堆也为空（刚开局/未回收）则从 masterDeck 重新洗入，
     * 保证战后新增的卡牌不会因「重建初始卡组」而丢失。
     * @returns 永不抛错/越界；极端空场兜底返回 0（普通）。
     */
    public drawNextOrbType(): number {
        if (this.drawPile.length === 0) {
            if (this.discardPile.length > 0) {
                this.drawPile.push(...this.discardPile);
                this.discardPile.length = 0;
                this.shuffle(this.drawPile);
                console.log('[DeckManager] 弃牌堆已重洗入抽牌堆…（弹药永不枯竭）');
            } else {
                // 抽牌堆与弃牌堆皆空：从总池重新洗入，禁止硬编码回退初始卡组（会丢失战后奖励卡牌）
                this.drawPile.push(...this.masterDeck);
                this.shuffle(this.drawPile);
                console.log('[DeckManager] 抽牌堆已空且无弃牌，从总池重新洗入…（含全部战后奖励卡牌）');
            }
        }
        const type = this.drawPile.shift() ?? ORB_TYPE_NORMAL;
        this.updateDeckLabel();
        return type;
    }

    /** 弹珠入槽消耗后回收其类型编号进弃牌堆（裂变子弹珠不入牌库，保持卡组守恒） */
    public discardOrbType(type: number): void {
        this.discardPile.push(type);
        this.updateDeckLabel();
    }

    /** 刷新牌库信息 Label：装填: [球种] | 待发: X | 弃牌: Y */
    private updateDeckLabel(): void {
        if (!this.deckLabel?.isValid) {
            return;
        }
        const loaded = ORB_TYPE_NAMES[this.peekNextOrbType()] ?? '未知';
        this.deckLabel.string = `装填: ${loaded} | 待发: ${this.drawPile.length} | 弃牌: ${this.discardPile.length}`;
    }

    /** Fisher–Yates 原地洗牌 */
    private shuffle(arr: number[]): void {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
    }
}