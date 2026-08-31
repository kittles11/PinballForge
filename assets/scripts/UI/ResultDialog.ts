import {
    _decorator, Component, Node, Label, UITransform, director, Vec3, tween, Tween,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { EnemyController } from '../Battle/EnemyController';
import { GoldManager } from '../Core/GoldManager';
import { RelicManager } from '../Core/RelicManager';
import { LevelManager } from '../Core/LevelManager';
import { ShopDialog } from './ShopDialog';
import { OrbBalance } from '../Core/OrbBalance';

const { ccclass, property } = _decorator;

/**
 * 胜负结算弹窗：挂载在 Canvas/UILayer/ResultDialog 节点上。
 * - 监听 GAME_OVER / GAME_VICTORY：城堡沦陷或通关全部波次时显示对应结算文案；
 * - 点击 restartBtn：重载 MainScene，一键无缝再来一局。
 */
@ccclass('ResultDialog')
export class ResultDialog extends Component {
    /** 结算标题文本 */
    @property(Label)
    titleLabel: Label = null!;

    /** 结算描述文本 */
    @property(Label)
    descLabel: Label = null!;

    /** 再来一局按钮节点 */
    @property(Node)
    restartBtn: Node = null!;

    /** 场景重载防抖：防连点重复 loadScene 引发双重销毁竞态 */
    private _restarting = false;

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
        this.playPopAnimation();
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
