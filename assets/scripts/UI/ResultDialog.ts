import {
    _decorator, Component, Node, Label, UITransform, director, Vec3, tween, Tween, Color,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { EnemyController } from '../Battle/EnemyController';
import { GoldManager } from '../Core/GoldManager';
import { RelicManager } from '../Core/RelicManager';
import { LevelManager } from '../Core/LevelManager';
import { ShopDialog } from './ShopDialog';
import { OrbBalance } from '../Core/OrbBalance';
import { MetaManager, META_MAX_LV } from '../Core/MetaManager';
import type { MetaUpgradeId } from '../Core/MetaManager';
import { Theme } from '../Core/ArtTheme';

const { ccclass, property } = _decorator;

/** 锻造区配色：碎片余额行 / 可买行（金）/ 钱不够（灰）/ 已满级（暗灰） */
const FORGE_COLOR_SHARDS = Theme.ui.gold;
const FORGE_COLOR_BUYABLE = Theme.ui.gold;
const FORGE_COLOR_LOCKED = Theme.ui.gray;
const FORGE_COLOR_MAXED = Theme.ui.disabledGray;

/**
 * 胜负结算弹窗：挂载在 Canvas/UILayer/ResultDialog 节点上。
 * - 监听 GAME_OVER / GAME_VICTORY：城堡沦陷或通关全部波次时显示对应结算文案；
 * - 点击 restartBtn：重载 MainScene，一键无缝再来一局。
 */
@ccclass('ResultDialog')
export class ResultDialog extends Component {
    /** 结算标题文本 */
    @property(Label)
    titleLabel: Label | null = null;

    /** 结算描述文本 */
    @property(Label)
    descLabel: Label | null = null;

    /** 再来一局按钮节点 */
    @property(Node)
    restartBtn: Node | null = null;

    /** 场景重载防抖：防连点重复 loadScene 引发双重销毁竞态 */
    private _restarting = false;

    // ---------- ⚒ 死亡补偿锻造区（P1-1：结算发碎片 + 永久升级原地购买） ----------

    /** 结算发碎片防重标志（GAME_OVER / GAME_VICTORY 理论只广播一次，防其他触发源重复入账） */
    private _rewardGranted = false;
    /** 本局获得的碎片量（锻造区展示用） */
    private _gainedShards = 0;
    /** 锻造区根节点（幂等创建；descLabel 与 RestartButton 之间） */
    private _forgeRoot: Node | null = null;
    /** 碎片余额行 Label */
    private _shardsLabel: Label | null = null;
    /** 三条升级行 Label（与 MetaManager.getUpgradeList() 顺序一致） */
    private _rowLabels: Label[] = [];

    protected onLoad(): void {
        EventBus.on(GameEvents.GAME_OVER, this.onGameOver, this);
        EventBus.on(GameEvents.GAME_VICTORY, this.onGameVictory, this);
        // 确保按钮节点能接收 UI 触摸（缺失 UITransform 时补一个默认尺寸）
        if (this.restartBtn?.isValid) {
            this.restartBtn.getComponent(UITransform) ?? this.restartBtn.addComponent(UITransform);
            this.restartBtn.on(Node.EventType.TOUCH_END, this.onRestartClick, this);
        }
    }

    protected start(): void {
        // 默认隐藏：仅在 GAME_OVER / GAME_VICTORY 事件时展示
        this.node.active = false;
    }

    protected onDestroy(): void {
        EventBus.off(GameEvents.GAME_OVER, this.onGameOver, this);
        EventBus.off(GameEvents.GAME_VICTORY, this.onGameVictory, this);
        if (this.restartBtn?.isValid) {
            this.restartBtn.off(Node.EventType.TOUCH_END, this.onRestartClick, this);
        }
        // 锻造区节点随本节点销毁（子节点连带销毁、监听自动解除），这里仅清引用防悬挂
        this._forgeRoot = null;
        this._shardsLabel = null;
        this._rowLabels = [];
    }

    /** 城堡沦陷：显示失败结算 */
    private onGameOver(): void {
        this.showResult(false);
    }

    /** 通关全部波次：显示胜利结算 */
    private onGameVictory(): void {
        this.showResult(true);
    }

    /** 展示结算弹窗；label 未配置时静默跳过，避免未捕获异常 */
    public showResult(isWin: boolean): void {
        if (!this.node?.isValid) {
            return;
        }
        console.log('[Result] 结算弹窗打开：冻结发射');
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true);
        this.node.active = true;
        if (this.titleLabel?.isValid) {
            this.titleLabel.string = isWin ? '🎉 战斗胜利！' : '💀 城堡沦陷';
        }
        if (this.descLabel?.isValid) {
            this.descLabel.string = isWin
                ? '恭喜守护住了城堡，通关全部波次！'
                : '要塞被怪物摧毁，请强化弹珠后再试！';
        }
        // ⚒ 死亡补偿：按结算时的章节/关卡进度发放 meta 碎片（一次结算只发一次），并挂出锻造区供原地购买
        if (!this._rewardGranted) {
            this._rewardGranted = true;
            this._gainedShards = MetaManager.grantRunReward(
                LevelManager.currentChapter, LevelManager.currentLevel, isWin,
            );
        }
        this.ensureForgeSection();
        this.refreshForge();
        this.playPopAnimation();
    }

    // ---------- ⚒ 锻造区（纯代码构建，零 Inspector 配置；TutorialManager 同款模式） ----------

    /** 幂等创建锻造区：碎片余额行 + 三条升级行（整行可点购买） */
    private ensureForgeSection(): void {
        if (this._forgeRoot?.isValid) {
            return;
        }
        const root = new Node('ForgeSection');
        root.addComponent(UITransform).setContentSize(500, 190);
        // 摆位（面板 560×560 居中锚点）：descLabel(y=40) 与 RestartButton(y=-140) 之间。
        // 解锁树扩到 6 行（碎片余额 + 5 升级行）：根上移至 -36、行距 34→27、字号 17→15 压缩排布。
        root.setPosition(0, -36, 0);
        this.node.addChild(root);
        this._forgeRoot = root;

        // 第一行：碎片余额（本局获得 + 持有总量）
        this._shardsLabel = this.makeForgeRow(root, 0, 44, 19, FORGE_COLOR_SHARDS);
        // 之后五行：永久升级（与 MetaManager.getUpgradeList() 固定顺序一致），整行可点击购买
        this._rowLabels = MetaManager.getUpgradeList().map((u, i) => {
            const label = this.makeForgeRow(root, 0, 16 - i * 27, 15, Color.WHITE.clone());
            label.node.on(Node.EventType.TOUCH_END, () => this.onForgeRowClick(u.id), this);
            return label;
        });
    }

    /** 锻造区一行：可触摸行节点（Label overflow=NONE 自适应文本宽，居中）+ 居中 Label */
    private makeForgeRow(parent: Node, x: number, y: number, fontSize: number, color: Color): Label {
        const rowNode = new Node('ForgeRow');
        rowNode.addComponent(UITransform).setContentSize(500, 30);
        rowNode.setPosition(x, y, 0);
        const label = rowNode.addComponent(Label);
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 10;
        label.color = color;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        parent.addChild(rowNode);
        return label;
    }

    /** 刷新锻造区文案与配色：可买金色 / 钱不够灰色 / 满级暗灰 / 🔒 未解锁灰色带前置说明 */
    private refreshForge(): void {
        if (this._shardsLabel?.isValid) {
            this._shardsLabel.string = `⚒ 精铸碎片 ${MetaManager.getShards()}（本局 +${this._gainedShards}）`;
        }
        const list = MetaManager.getUpgradeList();
        list.forEach((u, i) => {
            const label = this._rowLabels[i];
            if (!label?.isValid) {
                return;
            }
            const lv = MetaManager.getLv(u.id);
            const effect = u.describe ? u.describe(lv) : `${u.unit}+${lv * u.perLv}`;
            if (!MetaManager.isUnlocked(u.id)) {
                // 🌳 解锁树：子轨未达标 → 🔒 + 前置需求文案（规则对玩家可见，不靠猜）
                const pre = u.prereq!;
                const preName = list.find((x) => x.id === pre.id)?.name ?? pre.id;
                label.string = `🔒 ${u.name}（需 ${preName} Lv${pre.lv} 解锁）`;
                label.color = FORGE_COLOR_LOCKED;
                return;
            }
            const price = MetaManager.getPrice(u.id);
            if (price < 0) {
                label.string = `${u.name} Lv${lv}/${META_MAX_LV}（${effect}）· 已满级`;
                label.color = FORGE_COLOR_MAXED;
            } else {
                label.string = `${u.name} Lv${lv}/${META_MAX_LV}（${effect}）· ⚒${price} 点击升级`;
                label.color = MetaManager.canAfford(u.id) ? FORGE_COLOR_BUYABLE : FORGE_COLOR_LOCKED;
            }
        });
    }

    /** 点击升级行：买得起则扣费升级并刷新，否则忽略（颜色已示意不可买） */
    private onForgeRowClick(id: MetaUpgradeId): void {
        if (!MetaManager.buy(id)) {
            return;
        }
        console.log(`[Result] 锻造升级 ${id} → Lv${MetaManager.getLv(id)}`);
        this.refreshForge();
    }

    /** 弹窗浮现动效：0.85 → 1.06 → 1 弹性放大 */
    private playPopAnimation(): void {
        const node = this.node;
        if (!node?.isValid) {
            return;
        }
        Tween.stopAllByTarget(node);
        node.setScale(0.85, 0.85, 1);
        tween(node)
            .to(0.09, { scale: new Vec3(1.06, 1.06, 1) })
            .to(0.06, { scale: new Vec3(1, 1, 1) })
            .start();
    }

    /** 点击再来一局：先重置静态老虎机状态，再重载当前场景，无缝开新局 */
    private onRestartClick(): void {
        if (this._restarting) {
            return; // 防连点：loadScene 为异步切换，重复调用会造成场景双重销毁
        }
        this._restarting = true;
        // ★ 重开前重置易残留的静态状态（重炮过载倍率等），防止上一局强化带进新局
        EnemyController.resetStaticData();
        OrbBalance.reset();
        // ★ 重开前重置金币，新一局从 0 开始
        GoldManager.instance?.resetGold();
        // ★ 重开前重置被动遗物，新一局从零收集（RelicBar 顶部栏随之清空）
        RelicManager.resetRelics();
        // ★ 重开前重置进度为 1-1 并清除本地存档，新局从头闯关
        LevelManager.resetProgress();
        // ★ 重开前重置商店静态删卡次数，删卡阶梯价从 75 重新起步
        ShopDialog.removeCardCount = 0;
        // 动态场景名：以当前场景为准，避免硬编码 'MainScene' 与实际场景名不一致时报错
        const sceneName = director.getScene()?.name || 'MainScene';
        console.log(`[Result] 点击再来一局，重新加载 ${sceneName}`);
        director.loadScene(sceneName);
    }
}
