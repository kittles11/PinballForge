import {
    _decorator, Component, Enum, Collider2D, Contact2DType, IPhysics2DContact,
    Sprite, Color, Vec3, tween, Tween, Node, Label, UITransform, UIOpacity, Graphics,
} from 'cc';
import { OrbController } from './OrbController';
import { FunnelType } from '../Core/DataModels';
import { EASE_PUNCH, Theme } from '../Core/ArtTheme';
import { FxManager } from '../Core/FxManager';
import { recessedSlot } from '../Core/UiKit';

const { ccclass, property } = _decorator;

/** 槽口可容纳宽度（凹陷槽与光晕的基准尺寸；漏斗场景布置宽约 88px，取整留边） */
const SLOT_MOUTH_W = 76;
const SLOT_MOUTH_H = 30;
/** 呼吸光晕基准透明度 / 振幅 / 周期（秒）：低调呼吸，不与受击震屏抢注意力 */
const HALO_BASE = 150;
const HALO_AMPLITUDE = 70;
const HALO_PERIOD = 2.2;

export { FunnelType };

// 注册枚举元数据，供 Cocos 类系统序列化 / 编辑器下拉识别
Enum(FunnelType);

/**
 * 漏斗槽：回收进入的弹珠，按槽位类型结算后广播开火事件。
 * 依赖：节点需挂 Collider2D（sensor）接收弹珠接触。
 *
 * ★ 中性化改造（2026-09-07）：漏斗不再有红/蓝/金主题色——场景烘焙色 Sprite 一律置白，
 *   光柱删除，光晕/凹陷槽/吞球反馈/汇聚特效统一中性白；类型识别改由漏斗正下方
 *   「EMOJ + 文案」标注承担（💥 聚能 ×2 / ❄️ 精炼 ×1.5 / 💰 金币 +20）。
 */
@ccclass('FunnelSlot')
export class FunnelSlot extends Component {
    /** 槽位类型 */
    @property({ type: Enum(FunnelType) })
    funnelType: FunnelType = FunnelType.HeavyCannon;

    /** 监听中的碰撞体，onDestroy 时用于注销 */
    private _collider: Collider2D | null = null;
    /** 呼吸光晕透明度组件（ensureHaloPulse 创建，update 驱动脉动） */
    private _haloOpacity: UIOpacity | null = null;
    /** 光晕脉动时钟（秒，周期内取模） */
    private _haloClock = 0;

    protected start(): void {
        this._collider = this.getComponent(Collider2D);
        if (this._collider) {
            this._collider.on(Contact2DType.BEGIN_CONTACT, this.onBeginContact, this);
        }
        this.neutralizeSprite();
        this.ensureTypeLabel();
        this.ensureRecess();
        this.ensureHaloPulse();
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
        // ★ 吞球演出：四周火花向槽口汇聚 + 竖直光柱闪（中性白，漏斗无主题色）
        FxManager.converge(this.node.worldPosition, Theme.white);
    }

    /**
     * 常驻类型标注（漏斗正下方 42px 小字，白色）：💥 聚能 ×2 / ❄️ 精炼 ×1.5 / 💰 金币 +20。
     * 漏斗本体已中性化，类型识别完全由该 EMOJ 标注承担；幂等，场景已布置同名子节点则跳过。
     */
    private ensureTypeLabel(): void {
        const node = this.node;
        if (!node?.isValid || node.getChildByName('TypeLabel')) {
            return;
        }
        const text = this.funnelType === FunnelType.HeavyCannon ? '💥 聚能 ×2'
            : this.funnelType === FunnelType.IceFreeze ? '❄️ 精炼 ×1.5'
                : '💰 金币 +20';
        const labelNode = new Node('TypeLabel');
        labelNode.layer = node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
        labelNode.addComponent(UITransform);
        const label = labelNode.addComponent(Label);
        label.string = text;
        label.fontSize = 18;
        label.lineHeight = 22;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.color = Theme.white;
        labelNode.addComponent(UIOpacity).opacity = 235;
        labelNode.setPosition(0, -42, 0);
        node.addChild(labelNode);
    }

    /**
     * 漏斗去色：场景烘焙的槽位主题色（红/蓝/金）Sprite 一律覆白（幂等，覆盖旧值即可）。
     * 呼吸光晕与凹陷槽已走中性白，本步保证场景里任何旧配色布置都不再透出。
     */
    private neutralizeSprite(): void {
        const sp = this.getComponent(Sprite);
        if (sp?.isValid) {
            sp.color = Theme.white;
        }
    }

    /** 吞球反馈：Y 轴轻微下沉压缩回弹（Punch）+ Sprite 短暂闪烁白光（中性反馈） */
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

        // Sprite 闪烁白光
        const sp = this.getComponent(Sprite);
        if (sp?.isValid) {
            Tween.stopAllByTarget(sp);
            const origin = sp.color.clone();
            sp.color = Theme.white;
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

    /** 槽位绘制色：中性白（漏斗已去主题色，全部装饰统一走此色） */
    private static neutralColor(): Color {
        return Theme.white;
    }

    /**
     * 凹陷槽口（可供性，GAME_PLAN 4.3）：亮环 + 暗陷 + 底部反光，用「往里凹」的光照语言
     * 暗示「可投入」；与吞球压缩动画（playSwallowFeedback）形成看与按的闭环。幂等。
     */
    private ensureRecess(): void {
        const node = this.node;
        if (!node?.isValid || node.getChildByName('Recess')) {
            return;
        }
        const recess = new Node('Recess');
        recess.layer = node.layer;
        recess.addComponent(UITransform).setContentSize(SLOT_MOUTH_W + 8, SLOT_MOUTH_H + 8);
        const g = recess.addComponent(Graphics);
        recessedSlot(g, 0, 0, SLOT_MOUTH_W, SLOT_MOUTH_H, FunnelSlot.neutralColor(), Theme.ui.panelOpaque, 12);
        node.addChild(recess);
    }

    /** 槽口呼吸光晕：UIOpacity 正弦脉动（update 驱动，无 tween 泄漏），中性白光晕（幂等） */
    private ensureHaloPulse(): void {
        const node = this.node;
        if (!node?.isValid || node.getChildByName('Halo')) {
            return;
        }
        const c = FunnelSlot.neutralColor();
        const halo = new Node('Halo');
        halo.layer = node.layer;
        halo.addComponent(UITransform);
        const g = halo.addComponent(Graphics);
        // 三层同心圆软光晕（大而淡 → 小而亮），中心与槽口重合
        const layers: Array<[number, number]> = [[58, 26], [40, 44], [24, 66]];
        for (const [r, alpha] of layers) {
            const col = c.clone();
            col.a = alpha;
            g.fillColor = col;
            g.circle(0, 0, r);
            g.fill();
        }
        const op = halo.addComponent(UIOpacity);
        op.opacity = HALO_BASE;
        node.addChild(halo);
        // 光晕垫在槽口视觉之下（凹陷槽口仍清晰可读）
        halo.setSiblingIndex(0);
        this._haloOpacity = op;
    }

    protected update(dt: number): void {
        if (!this._haloOpacity?.isValid) {
            return;
        }
        this._haloClock = (this._haloClock + dt) % HALO_PERIOD;
        const phase = Math.sin((this._haloClock / HALO_PERIOD) * Math.PI * 2);
        this._haloOpacity.opacity = HALO_BASE + Math.round(phase * HALO_AMPLITUDE);
    }
}
