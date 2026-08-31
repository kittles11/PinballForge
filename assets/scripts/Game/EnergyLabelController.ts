import { _decorator, Component, Label, Vec3, tween, Tween, find } from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';

const { ccclass } = _decorator;

/** 获得能量时 Label 的 Punch 放大倍率 */
const ENERGY_PUNCH_SCALE = 1.15;

/**
 * 顶部能量 Label 控制器：监听 UPDATE_ENERGY 事件并实时刷新能量文本。
 * 用法：
 *  - 直接拖到场景 Canvas/UILayer/EnergyLabel 节点上（推荐，自动取自身 Label）；
 *  - 或挂到任意启动节点上，会自动按固定路径兜底查找 EnergyLabel。
 */
@ccclass('EnergyLabelController')
export class EnergyLabelController extends Component {
    private _label: Label | null = null;
    /** Label 初始缩放：Punch 弹跳动画的基准（跟随编辑器配置，不写死 1） */
    private _baseScale: Vec3 = new Vec3(1, 1, 1);

    protected onLoad(): void {
        // 优先取挂在同一节点上的 Label；否则按固定路径兜底查找
        this._label = this.getComponent(Label);
        if (!this._label) {
            this._label = find('Canvas/UILayer/EnergyLabel')?.getComponent(Label) ?? null;
        }
        if (!this._label) {
            console.warn('[EnergyLabelController] 未找到 Label，能量显示不会更新！');
        } else {
            this._baseScale.set(this._label.node.scale);
        }
        EventBus.on(GameEvents.UPDATE_ENERGY, this.onUpdateEnergy, this);
    }

    protected start(): void {
        // 主动初始化一次，避免开局停留在编辑器默认文案
        this.onUpdateEnergy(0);
    }

    protected onDestroy(): void {
        // 一键注销本组件的全部事件监听
        EventBus.targetOff(this);
        // 清理可能残留的 Punch 弹跳动画
        if (this._label?.isValid) {
            Tween.stopAllByTarget(this._label.node);
        }
    }

    /** 弹珠撞钉时由事件总线实时广播最新累计能量 */
    private onUpdateEnergy(energy: number): void {
        const label = this._label;
        if (!label?.isValid) {
            return;
        }
        label.string = `能量: ${Math.round(energy)}`;
        if (energy > 0) {
            // 获得能量：轻微弹跳反馈（Punch：放大 1.15 倍回弹）
            const node = label.node;
            Tween.stopAllByTarget(node);
            const big = this._baseScale.clone().multiplyScalar(ENERGY_PUNCH_SCALE);
            tween(node)
                .to(0.08, { scale: big })
                .to(0.12, { scale: this._baseScale.clone() })
                .start();
        }
    }
}