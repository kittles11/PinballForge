import {
    _decorator, Component, Enum, Collider2D, Contact2DType, IPhysics2DContact,
    Sprite, Color, Vec3, tween, Tween, Node, Label, UITransform, UIOpacity, Graphics,
} from 'cc';
import { OrbController } from './OrbController';
import { FunnelType } from '../Core/DataModels';
import { cloneColor, EASE_PUNCH, funnelColor } from '../Core/ArtTheme';
import { FxManager } from '../Core/FxManager';

const { ccclass, property } = _decorator;

export { FunnelType };

// 注册枚举元数据，供 Cocos 类系统序列化 / 编辑器下拉识别
Enum(FunnelType);

/**
 * 漏斗槽：回收进入的弹珠，按槽位类型结算后广播开火事件。
 * 依赖：节点需挂 Collider2D（sensor）接收弹珠接触。
 */
@ccclass('FunnelSlot')
export class FunnelSlot extends Component {
    /** 槽位类型 */
    @property({ type: Enum(FunnelType) })
    funnelType: FunnelType = FunnelType.HeavyCannon;

    /** 监听中的碰撞体，onDestroy 时用于注销 */
    private _collider: Collider2D | null = null;

    protected start(): void {
        this._collider = this.getComponent(Collider2D);
        if (this._collider) {
            this._collider.on(Contact2DType.BEGIN_CONTACT, this.onBeginContact, this);
        }
        this.ensureTypeLabel();
        this.ensureNeonPillar();
    }

    protected onDestroy(): void {
        if (this._collider?.isValid) {
            this._collider.off(Contact2DType.BEGIN_CONTACT, this.onBeginContact, this);
        }
        this._collider = null;
    }

    private onBeginContact(
        _selfCollider: Collider2D | null,
        otherCollider: Collider2D | null,
        _contact: IPhysics2DContact | null,
    ): void {
        // 防御：碰撞对象 / 节点失效时直接忽略
        if (!otherCollider?.node?.isValid) {
            return;
        }
        // 只处理带 OrbController 的弹珠
        const orb = otherCollider.node.getComponent(OrbController);
        if (!orb) {
            return;
        }
        this.processOrb(orb);
    }

    /**
     * 结算弹珠：统一交由弹珠触发开火与销毁，避免双发；槽位自身播放吞球反馈。
     * 金币在入槽时即发（OrbController.triggerFunnelAndDestroy 内 GoldCoin 分支 +20）；
     * 金币弹命中敌人只造成伤害、不再发金币，避免入槽与受击两处重复发放。
     */
    private processOrb(orb: OrbController): void {
        orb.triggerFunnelAndDestroy(this);
        this.playSwallowFeedback();
        // ★ 吞球演出：四周火花向槽口汇聚 + 竖直光柱闪（主题色）
        FxManager.converge(this.node.worldPosition, FunnelSlot.themeColor(this.funnelType));
    }

    /**
     * 常驻类型标注（漏斗正下方 42px 小字，主题色）：聚能×2 / 精炼×1.5 / 金币+20。
     * 让「三选一漏斗」的价值一目了然（瞄准即下注），玩家不用心算倍率；幂等，场景已布置同名子节点则跳过。
     */
    private ensureTypeLabel(): void {
        const node = this.node;
        if (!node?.isValid || node.getChildByName('TypeLabel')) {
            return;
        }
        const text = this.funnelType === FunnelType.HeavyCannon ? '聚能 ×2'
            : this.funnelType === FunnelType.IceFreeze ? '精炼 ×1.5'
                : '金币 +20';
        const labelNode = new Node('TypeLabel');
        labelNode.layer = node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
        labelNode.addComponent(UITransform);
        const label = labelNode.addComponent(Label);
        label.string = text;
        label.fontSize = 18;
        label.lineHeight = 22;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.color = FunnelSlot.themeColor(this.funnelType);
        labelNode.addComponent(UIOpacity).opacity = 235;
        labelNode.setPosition(0, -42, 0);
        node.addChild(labelNode);
    }

    /** 吞球反馈：Y 轴轻微下沉压缩回弹（Punch）+ Sprite 短暂闪烁对应槽位主题色（红/蓝/金） */
    private playSwallowFeedback(): void {
        const node = this.node;
        if (!node?.isValid) {
            return;
        }
        // Y 轴压缩回弹（backOut 过冲）
        Tween.stopAllByTarget(node);
        const base = node.scale.clone();
        const compressed = new Vec3(base.x * 1.15, base.y * 0.6, base.z);
        tween(node)
            .to(0.06, { scale: compressed }, { easing: EASE_PUNCH })
            .to(0.12, { scale: base })
            .start();

        // Sprite 闪烁主题色
        const sp = this.getComponent(Sprite);
        if (sp?.isValid) {
            Tween.stopAllByTarget(sp);
            const origin = sp.color.clone();
            sp.color = FunnelSlot.themeColor(this.funnelType);
            tween(sp)
                .delay(0.08)
                .call(() => {
                    if (sp.isValid) {
                        sp.color = origin;
                    }
                })
                .start();
        }
    }

    /** 槽位主题色：聚能=红 / 精炼=蓝 / 金币=金（统一取自 ArtTheme） */
    private static themeColor(type: FunnelType): Color {
        return funnelColor(type);
    }

    /** 霓虹光柱：槽口向上的三层梯形渐隐光柱（主题色），让「三选一漏斗」在场上可读（幂等） */
    private ensureNeonPillar(): void {
        const node = this.node;
        if (!node?.isValid || node.getChildByName('NeonPillar')) {
            return;
        }
        const c = FunnelSlot.themeColor(this.funnelType);
        const pillar = new Node('NeonPillar');
        pillar.layer = node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
        pillar.addComponent(UITransform);
        const g = pillar.addComponent(Graphics);
        // 三层梯形：外层宽而淡 → 内层窄而亮（alpha 依次抬升模拟渐隐）
        const layers: Array<[number, number]> = [[92, 55], [66, 90], [38, 150]];
        for (const [halfTop, alpha] of layers) {
            const col = cloneColor(c);
            col.a = alpha;
            g.fillColor = col;
            g.moveTo(-44, -30);
            g.lineTo(-halfTop, 160);
            g.lineTo(halfTop, 160);
            g.lineTo(44, -30);
            g.close();
            g.fill();
        }
        node.addChild(pillar);
    }
}
