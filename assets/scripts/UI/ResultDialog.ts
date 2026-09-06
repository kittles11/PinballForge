import {
    _decorator, Component, Node, Label, UITransform, Sprite, director, Vec3, tween, Tween, Color, Graphics,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { EnemyController } from '../Battle/EnemyController';
import { AdService } from '../Core/AdService';
import { raisedButton } from '../Core/UiKit';
import { GoldManager } from '../Core/GoldManager';
import { RelicManager } from '../Core/RelicManager';
import { LevelManager } from '../Core/LevelManager';
import { ShopDialog } from './ShopDialog';
import { OrbBalance } from '../Core/OrbBalance';
import { MetaManager } from '../Core/MetaManager';
import type { MetaUpgradeId } from '../Core/MetaManager';
import { cloneColor, Theme } from '../Core/ArtTheme';
import { mountIcon } from '../Core/IconLib';
import { closeAllModals } from '../Core/ModalGate';

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
    // ---------- 📺 广告点位 / 🌌 无尽入口状态（第 3/4 步 UI 接线；重载场景自然重置） ----------
    /** 本局是否已用掉「📺 复活」广告（每局一次） */
    private _adReviveUsed = false;
    /** 本局是否已用掉「📺 碎片双倍」广告（每局一次） */
    private _adShardsUsed = false;
    /** 当前结算态：true 胜利 / false 失败（动作按钮可见性判定用） */
    private _shownWin = false;

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
    /** 解锁总览预览模式：行文案显示「效果/解锁内容」而非价格，点击不购买 */
    private _forgePreview = false;
    /** 预览/购买切换按钮 Label */
    private _forgeToggle: Label | null = null;
    /** 展示中标记（同 RewardDialog._showing）：防启动期失活导致的 start 推迟自吞首次展示 */
    private _showing = false;

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
        // 默认隐藏：仅在 GAME_OVER / GAME_VICTORY 事件时展示（展示中不自吞，见 _showing 注释）
        if (!this._showing) {
            this.node.active = false;
        }
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
        this._showing = true; // 先置位再激活：推迟执行的 start() 默认隐藏不得吞掉本次展示
        console.log('[Result] 结算弹窗打开：冻结发射');
        // 结算置顶：战斗中开着的任务/背包弹窗是运行时代码节点，渲染序在本节点（场景节点）
        // 之上——不先关掉，结算界面会被压在其遮罩之下，玩家关掉当前面板后会「又露出一个
        // 关不掉的界面」（2026-09-04 排查）。FxLayer/FloatingTextLayer 同理在下方隐藏。
        closeAllModals();
        const uiLayer = this.node.parent;
        if (uiLayer?.isValid) {
            this.node.setSiblingIndex(uiLayer.children.length - 1);
        }
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, true);
        this.node.active = true;
        // ★ 面板加大（用户反馈：锻造区与再来一局按钮悬空在小面板外，与战斗层飘字叠在一起）：
        // 内容带 = 标题(+160) ~ 再来一局(-140-按钮半高)；旧面板按 default_panel 贴图原始尺寸渲染（约 430×430）。
        // 结算期间隐藏特效层与飘字层（两者渲染序都在弹窗之上：伤害跳字/「精炼+1」会压在结算文字上；
        // 场景重载后两层层均按需惰性重建，无需恢复）。
        for (const layerName of ['FxLayer', 'FloatingTextLayer']) {
            const layer = this.node.parent?.getChildByName(layerName);
            if (layer?.isValid) {
                layer.active = false;
            }
        }
        const panelUi = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        panelUi.setContentSize(640, 880);
        const panelSprite = this.node.getComponent(Sprite);
        if (panelSprite) {
            panelSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            panelSprite.type = Sprite.Type.SIMPLE;
        }
        // 再来一局按钮下移：面板加大后腾出锻造区完整四行空间（原 -140 与第四行升级文字重叠）
        if (this.restartBtn?.isValid) {
            this.restartBtn.setPosition(0, -390, 0);
        }
        // 标题/说明强制几何（修复字体叠加）：场景旧 Label 无显式宽度，SHRINK 下窄宽会把标题折行压到说明文字上
        if (this.titleLabel?.isValid) {
            this.titleLabel.fontSize = 32;
            this.titleLabel.lineHeight = 40;
            this.titleLabel.overflow = Label.Overflow.SHRINK;
            this.titleLabel.node.getComponent(UITransform)?.setContentSize(480, 52);
        }
        if (this.descLabel?.isValid) {
            this.descLabel.fontSize = 20;
            this.descLabel.lineHeight = 26;
            this.descLabel.overflow = Label.Overflow.SHRINK;
            this.descLabel.node.getComponent(UITransform)?.setContentSize(560, 72);
        }
        if (this.titleLabel?.isValid) {
            this.titleLabel.string = isWin ? '战斗胜利！' : '城堡沦陷';
            // 标题左侧挂胜负矢量图标（先清两态旧图标再挂当前态，幂等）
            this.titleLabel.node.children.filter((c) => c.name.startsWith('Icon_')).forEach((c) => c.destroy());
            mountIcon(
                this.titleLabel.node, isWin ? 'star' : 'skull', 34,
                isWin ? Theme.ui.gold : Theme.ui.red, -118, 0,
            );
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
        this._shownWin = isWin;
        this.ensureActionButtons();
        this.refreshActionButtons();
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
        this._shardsLabel = this.makeForgeRow(root, 0, 42, 17, FORGE_COLOR_SHARDS, 400);
        // 头部右侧：解锁总览切换按钮（📖 看效果 / 💰 购买），复用行节点仅换文案，不动布局
        this._forgeToggle = this.makeForgeRow(root, 250, 42, 13, FORGE_COLOR_SHARDS, 90);
        this._forgeToggle.string = '总览';
        this._forgeToggle.node.on(Node.EventType.TOUCH_END, () => this.toggleForgePreview(), this);
        // 升级行：按 getUpgradeList 树分支序分列（前段左 / 中段中 / 后段右），整行可点购买
        const list = MetaManager.getUpgradeList();
        const n = list.length;
        const cols = n <= 4 ? 1 : n <= 10 ? 2 : 3;
        const perCol = Math.ceil(n / cols);
        const colX = cols === 1 ? [0] : cols === 2 ? [-128, 128] : [-170, 0, 170];
        const rowW = cols === 3 ? 166 : 248;
        const fs = cols === 3 ? 12 : 13;
        const spacing = perCol <= 4 ? 34 : 28;
        // 三列窄行放不下「效果」文案 → 紧凑模式仅显示 名称 Lv 价格（效果由名称+等级隐含）
        this._forgeCompact = cols >= 3;
        this._rowLabels = list.map((u, i) => {
            const col = Math.floor(i / perCol);
            const row = i % perCol;
            const x = colX[col];
            const y = 14 - row * spacing;
            const label = this.makeForgeRow(root, x, y, fs, cloneColor(Theme.white), rowW);
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

    /** 刷新锻造区文案与配色：购买模式（名称 Lv 价格）/ 预览模式（名称·效果，🔒 显示前置） */
    private refreshForge(): void {
        if (this._shardsLabel?.isValid) {
            this._shardsLabel.string = `精铸碎片 ◆${MetaManager.getShards()}（本局 +${this._gainedShards}）`;
        }
        const list = MetaManager.getUpgradeList();
        list.forEach((u, i) => {
            const label = this._rowLabels[i];
            if (!label?.isValid) {
                return;
            }
            const lv = MetaManager.getLv(u.id);
            if (!MetaManager.isUnlocked(u.id)) {
                // 🌳 解锁树：子轨未达标 → 🔒 + 前置需求文案（规则对玩家可见，不靠猜）
                const pre = u.prereq!;
                const preName = list.find((x) => x.id === pre.id)?.name ?? pre.id;
                label.string = this._forgePreview
                    ? `🔒${u.name}·需${preName}${pre.lv}`
                    : `🔒${u.name} 需${preName}${pre.lv}级`;
                label.color = FORGE_COLOR_LOCKED;
                return;
            }
            const price = MetaManager.getPrice(u.id);
            if (this._forgePreview) {
                // 预览模式：显示「效果/已解锁内容」（describe 或 +数值），不显示价格
                const effect = u.describe ? u.describe(lv) : `+${lv * u.perLv}`;
                label.string = price < 0 ? `${u.name}·${effect} MAX` : `${u.name}·${effect}`;
                label.color = price < 0 ? FORGE_COLOR_MAXED : FORGE_COLOR_BUYABLE;
                return;
            }
            const effect = this._forgeCompact ? '' : (u.describe ? u.describe(lv) : `+${lv * u.perLv}`);
            if (price < 0) {
                label.string = `${u.name} Lv${lv}${effect ? ' ' + effect : ''} MAX`;
                label.color = FORGE_COLOR_MAXED;
            } else {
                label.string = `${u.name} Lv${lv}${effect ? ' ' + effect : ''} ◆${price}`;
                label.color = MetaManager.canAfford(u.id) ? FORGE_COLOR_BUYABLE : FORGE_COLOR_LOCKED;
            }
        });
    }

    /** 切换「解锁总览预览 ↔ 购买」模式：仅换行文案与按钮标签，不动布局与触摸绑定 */
    private toggleForgePreview(): void {
        this._forgePreview = !this._forgePreview;
        if (this._forgeToggle?.isValid) {
            this._forgeToggle.string = this._forgePreview ? '购买' : '总览';
        }
        this.refreshForge();
    }

    /** 点击升级行：预览模式不响应；购买模式下买得起则扣费升级并刷新，否则忽略（颜色已示意不可买） */
    private onForgeRowClick(id: MetaUpgradeId): void {
        if (this._forgePreview) {
            return;
        }
        if (!MetaManager.buy(id)) {
            return;
        }
        console.log(`[Result] 锻造升级 ${id} → Lv${MetaManager.getLv(id)}`);
        this.refreshForge();
    }

    // ---------- 📺 广告点位 + 🌌 无尽入口（第 3/4 步 UI 接线）----------
    // 按钮纯代码构建（锻造区同款手法，无 Inspector 依赖）：失败态显示 复活/碎片双倍 两枚，
    // 终局胜利态显示「进入无尽」一枚（LevelManager.isFinalBattle() 判定，与结算文案同源）。

    /** 三枚动作按钮幂等创建（节点复用，每次结算只刷新文案与可见性） */
    private ensureActionButtons(): void {
        this.makeActionButton('AdReviveBtn', -150, '📺 看广告 复活', () => this.onReviveClick());
        this.makeActionButton('AdDoubleBtn', 150, '', () => this.onShardsDoubleClick());
        this.makeActionButton('EndlessBtn', 0, '🌌 进入无尽模式', () => this.onEndlessClick());
    }

    /** 结算动作按钮统一样式：凸起金底 + 居中文案（y=-330，锻造区与再来一局之间） */
    private makeActionButton(name: string, x: number, text: string, onClick: () => void): void {
        let node = this.node.getChildByName(name);
        if (!node || !node.isValid) {
            node = new Node(name);
            node.layer = this.node.layer;
            this.node.addChild(node);
            node.setPosition(x, -330, 0);
            node.addComponent(UITransform).setContentSize(236, 56);
            const g = node.addComponent(Graphics);
            raisedButton(g, 236, 56, Theme.ui.goldDim, 12);
            const labelNode = new Node('Label');
            labelNode.layer = node.layer;
            node.addChild(labelNode);
            labelNode.addComponent(UITransform).setContentSize(236, 56);
            const label = labelNode.addComponent(Label);
            label.fontSize = 18;
            label.lineHeight = 24;
            label.color = Theme.white.clone();
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            node.on(Node.EventType.TOUCH_END, onClick, this);
        }
        if (text) {
            const lbl = node.getChildByName('Label')?.getComponent(Label);
            if (lbl?.isValid) {
                lbl.string = text;
            }
        }
    }

    /** 按当前结算态刷新动作按钮可见性（复活/双倍：失败态；进入无尽：终局胜利态） */
    private refreshActionButtons(): void {
        const reviveBtn = this.node.getChildByName('AdReviveBtn');
        if (reviveBtn?.isValid) {
            reviveBtn.active = !this._shownWin && !this._adReviveUsed;
        }
        const doubleBtn = this.node.getChildByName('AdDoubleBtn');
        if (doubleBtn?.isValid) {
            doubleBtn.active = !this._shownWin && !this._adShardsUsed && this._gainedShards > 0;
        }
        const endlessBtn = this.node.getChildByName('EndlessBtn');
        if (endlessBtn?.isValid) {
            endlessBtn.active = this._shownWin && LevelManager.isFinalBattle() && !LevelManager.endless;
        }
    }

    /** 📺 复活点位：看完整广告 → 广播 RUN_REVIVED（城堡满血原地复活 + 波次清场续播；每局一次） */
    private onReviveClick(): void {
        if (this._adReviveUsed) {
            return;
        }
        AdService.showRewarded('revive', () => {
            this._adReviveUsed = true;
            console.log('[Result] 广告复活：撤销本次失败，本局战斗原地继续');
            this.dismissAndContinue(GameEvents.RUN_REVIVED);
        });
    }

    /** 📺 碎片双倍点位：看完整广告 → 本局结算碎片再入账一次（每局一次） */
    private onShardsDoubleClick(): void {
        if (this._adShardsUsed || this._gainedShards <= 0) {
            return;
        }
        AdService.showRewarded('shards_double', () => {
            this._adShardsUsed = true;
            const bonus = this._gainedShards;
            MetaManager.addShards(bonus);
            this._gainedShards += bonus;
            console.log(`[Result] 广告双倍碎片：+◆${bonus}（本局结算共 +◆${this._gainedShards}）`);
            this.refreshForge();
            this.refreshActionButtons();
        });
    }

    /** 🌌 终局胜利进入无尽：LevelManager 切到无尽进度并广播 RUN_CONTINUED（本局构筑原地延续） */
    private onEndlessClick(): void {
        if (LevelManager.endless) {
            return;
        }
        LevelManager.enterEndless();
        console.log('[Result] 进入无尽模式：本局牌组/遗物/金币延续，波次重新起跑');
        this.dismissAndContinue(GameEvents.RUN_CONTINUED);
    }

    /**
     * 关闭结算面板并广播续战事件（复活 / 无尽续战共用）：不重载场景，本局继续。
     * 结算时被隐藏的特效层 / 飘字层在这里恢复（续战路径没有场景重载兜底，必须手动还原）。
     */
    private dismissAndContinue(evt: GameEvents): void {
        this._showing = false;
        this._rewardGranted = false; // 续战后的下一次结算需重新发碎片
        this._gainedShards = 0;
        this.node.active = false;
        EventBus.emit(GameEvents.UI_MODAL_CHANGED, false); // 恢复发射输入（LauncherController 事件 + 看门狗双保险）
        for (const layerName of ['FxLayer', 'FloatingTextLayer']) {
            const layer = this.node.parent?.getChildByName(layerName);
            if (layer?.isValid) {
                layer.active = true;
            }
        }
        EventBus.emit(evt);
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
        ShopDialog.repairCount = 0;
        // 动态场景名：以当前场景为准，避免硬编码 'MainScene' 与实际场景名不一致时报错
        const sceneName = director.getScene()?.name || 'MainScene';
        console.log(`[Result] 点击再来一局，重新加载 ${sceneName}`);
        director.loadScene(sceneName);
    }
}
