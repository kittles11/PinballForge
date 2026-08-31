import { _decorator, Component, Label, Vec3, tween, Tween, find } from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { GoldManager } from '../Core/GoldManager';

const { ccclass } = _decorator;

/** 获得金币时 Label 的 Punch 放大倍率 */
const GOLD_PUNCH_SCALE = 1.2;

/**
 * 顶部金币 Label 控制器：监听 GAIN_GOLD 事件实时刷新金币文本并播放弹性缩放反馈。
 * 用法：
 *  - 直接拖到场景 Canvas/UILayer/GoldLabel 节点上（推荐，自动取自身 Label）；
 *  - 或挂到任意启动节点上，会自动按固定路径兜底查找 GoldLabel。
 */
@ccclass('GoldLabelController')
export class GoldLabelController extends Component {
    private _label: Label | null = null;
    /** Label 初始缩放：Punch 弹跳动画的基准（跟随编辑器配置，不写死 1） */
    private _baseScale: Vec3 = new Vec3(1, 1, 1);

    protected onLoad(): void {
        // 优先取挂在同一节点上的 Label；否则按固定路径兜底查找
        this._label = this.getComponent(Label);
        if (!this._label) {
            this._label = find('Canvas/UILayer/GoldLabel')?.getComponent(Label) ?? null;
        }
        if (!this._label) {
            console.warn('[GoldLabelController] 未找到 Label，金币显示不会更新！');
        } else {
            this._baseScale.set(this._label.node.scale);
            // 顶部 HUD 布局：金币水平靠右，与居左的城堡血量、居中的波次错开避免重叠
            this._label.node.setPosition(210, 590, 0);
        }
        EventBus.on(GameEvents.GAIN_GOLD, this.onGainGold, this);
    }

    protected start(): void {
        // 主动初始化一次：显示实际开局金币（含 meta「开局资金」加成），避免开局停留在编辑器默认文案
        const label = this._label;
        if (label?.isValid) {
            label.string = `💰 ${GoldManager.instance?.currentGold ?? 0}`;
        }
    }

    protected onDestroy(): void {
        // 一键注销本组件的全部事件监听
        EventBus.targetOff(this);
        // 清理可能残留的 Punch 弹跳动画
        if (this._label?.isValid) {
            Tween.stopAllByTarget(this._label.node);
        }
    }

    /** 获得金币：刷新文本 + Punch 弹性缩放动效（放大 1.2 倍回弹） */
    private onGainGold(data: { amount: number; total?: number }): void {
        const label = this._label;
        if (!label?.isValid) {
            return;
        }
        // ★ 优先用事件携带的最新总数 total，规避读取管理器 currentGold 累加时的时序差（延迟 1 拍）
        const latestGold = data.total ?? GoldManager.instance?.currentGold ?? 0;
        label.string = `💰 ${latestGold}`;
        const node = label.node;
        Tween.stopAllByTarget(node);
        const big = this._baseScale.clone().multiplyScalar(GOLD_PUNCH_SCALE);
        tween(node)
            .to(0.08, { scale: big })
            .to(0.12, { scale: this._baseScale.clone() })
            .start();
    }
}
