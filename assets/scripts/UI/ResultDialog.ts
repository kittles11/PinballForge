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
import { MetaManager } from '../Core/MetaManager';
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
    /** 升级行 Label（与 MetaManager.getUpgradeList() 顺序一致） */
    private _rowLabels: Label[] = [];
    /** 三列窄行紧凑模式：省略「效果」文案，仅显示 名称 Lv 价格 */
    private _forgeCompact = false;

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

    /** 幂等创建锻造区：碎片余额行 + 升级行（1/2/3 列自适应，整行可点购买） */
    private ensureForgeSection(): void {
        if (this._forgeRoot?.isValid) {
            return;
        }
        const root = new Node('ForgeSection');
        root.addComponent(UITransform).setContentSize(520, 150);
        // 摆位（面板居中锚点）：落在 descLabel(y=40) 与 RestartButton(y=-140) 之间的 180px 带内。
        // 列数随升级条数自适应：≤4 单列 / ≤10 双列 / >10 三列（每列 ceil(n/cols) 行，行距收放保证不压按钮）。
        root.setPosition(0, -44, 0);
        this.node.addChild(root);
        this._forgeRoot = root;

        // 顶部：碎片余额（整行居中）
        this._shardsLabel = this.makeForgeRow(root, 0, 42, 17, FORGE_COLOR_SHARDS, 520);
        // 升级行：按 getUpgradeList 树分支序分列（前段左 / 中段中 / 后段右），整行可点购买
        const list = MetaManager.getUpgradeList();
        const n = list.length;
        const cols = n <= 4 ? 1 : n <= 10 ? 2 : 3;
        const perCol = Math.ceil(n / cols);
        const colX = cols === 1 ? [0] : cols === 2 ? [-128, 128] : [-170, 0, 170];
        const rowW = cols === 3 ? 166 : 248;
        const fs = cols === 3 ? 12 : 13;
        const spacing = perCol <= 4 ? 30 : 25;
        // 三列窄行放不下「效果」文案 → 紧凑模式仅显示 名称 Lv 价格（效果由名称+等级隐含）
        this._forgeCompact = cols >= 3;
        this._rowLabels = list.map((u, i) => {
            const col = Math.floor(i / perCol);
            const row = i % perCol;
            const x = colX[col];
            const y = 14 - row * spacing;
            const label = this.makeForgeRow(root, x, y, fs, Color.WHITE.clone(), rowW);
            label.node.on(Node.EventType.TOUCH_END, () => this.onForgeRowClick(u.id), this);
            return label;
        });
    }

    /** 锻造区一行：可触摸行节点（Label overflow=SHRINK 固定宽自适应）+ 居中 Label */
    private makeForgeRow(parent: Node, x: number, y: number, fontSize: number, color: Color, width: number): Label {
        const rowNode = new Node('ForgeRow');
        rowNode.addComponent(UITransform).setContentSize(width, 28);
        rowNode.setPosition(x, y, 0);
        const label = rowNode.addComponent(Label);
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 6;
        label.color = color;
        label.overflow = Label.Overflow.SHRINK;
        label.enableWrapText = false;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        parent.addChild(rowNode);
        return label;
    }

    /** 刷新锻造区文案与配色：可买金色 / 钱不够灰色 / 满级暗灰 / 🔒 未解锁灰色带前置说明（双列紧凑文案） */
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
            const effect = this._forgeCompact ? '' : (u.describe ? u.describe(lv) : `+${lv * u.perLv}`);
            if (!MetaManager.isUnlocked(u.id)) {
                // 🌳 解锁树：子轨未达标 → 🔒 + 前置需求文案（规则对玩家可见，不靠猜）
                const pre = u.prereq!;
                const preName = list.find((x) => x.id === pre.id)?.name ?? pre.id;
                label.string = `🔒${u.name} 需${preName}${pre.lv}级`;
                label.color = FORGE_COLOR_LOCKED;
                return;
            }
            const price = MetaManager.getPrice(u.id);
            if (price < 0) {
                label.string = `${u.name} Lv${lv}${effect ? ' ' + effect : ''} MAX`;
                label.color = FORGE_COLOR_MAXED;
            } else {
                label.string = `${u.name} Lv${lv}${effect ? ' ' + effect : ''} ⚒${price}`;
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
