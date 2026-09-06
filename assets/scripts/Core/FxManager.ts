/**
 * 全局命中特效池（静态门面 FxManager.spark(...)，零 Inspector 惰性自建）：
 * - 节点池复用 + RuntimeTex 运行时柔光纹理 + 单实例加法混合材质（同材质同纹理可合批，
 *   特效层预期新增 draw call ≤2）；
 * - 性能护栏：池上限 96 / 同屏活跃 ≤64（超出静默丢弃，保帧率 > 保特效）；
 * - 模态弹窗打开瞬间清空全部特效并锁定派生（与 CameraShake 弹窗免疫锁同款策略）；
 * - 运行时纹理 / 材质异常时自动退 Graphics 同心圆软光斑（useGraphicsFallback 开关）。
 * 自举范式与 FloatingTextManager.instance 一致；静态门面调用范式与 CameraShake.shake 一致。
 */
import {
    _decorator, Component, Graphics, Node, Sprite, Tween, tween, UIOpacity, UITransform,
    Vec3, Color, gfx, find,
} from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { RuntimeTex } from './RuntimeTex';
import { Theme, cloneColor } from './ArtTheme';

const { ccclass } = _decorator;

/** 对象池上限：池内空闲节点最多 96，超出直接销毁（与 FloatingTextManager 同款封顶策略） */
const POOL_CAP = 96;
/** 同屏活跃特效上限：超出后新特效静默丢弃 */
const ACTIVE_CAP = 64;

@ccclass('FxManager')
export class FxManager extends Component {
    private static _instance: FxManager | null = null;

    /** 单例引用：首次访问时若不存在则自动创建并挂载到 Canvas/UILayer 下 */
    public static get instance(): FxManager | null {
        if (this._instance?.isValid) {
            return this._instance;
        }
        return this.bootstrap();
    }

    public static set instance(value: FxManager | null) {
        this._instance = value;
    }

    /** 手动强制回退开关：个别原生平台纹理异常时置 true（与 RuntimeTex.useGraphicsFallback 联动） */
    static useGraphicsFallback = false;

    /** 空闲特效节点池（复用） */
    private _pool: Node[] = [];
    /** 当前活跃特效数（含闪光/火花/烟团；环形冲击圈为低频特例不计入） */
    private _active = 0;
    /** 自身 UITransform：世界坐标 → 本地坐标转换用 */
    private _uiTransform: UITransform | null = null;
    /** 模态弹窗免疫锁：弹窗打开期间特效派生全锁 + 现存特效全清 */
    private _modalOpen = false;
    /** 能力探测：glow 纹理 + 加法混合材质是否可用（决定 Sprite 路径 or Graphics 回退路径） */
    private _glowOK = false;

    /** 惰性自建：优先挂 Canvas/UILayer，兜底 Canvas；场景无 Canvas 时返回 null（调用方 ?. 静默跳过） */
    private static bootstrap(): FxManager | null {
        const host = find('Canvas/UILayer') ?? find('Canvas');
        if (!host) {
            return null;
        }
        const layer = new Node('FxLayer');
        layer.layer = host.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
        layer.addComponent(UITransform);
        host.addChild(layer);
        this._instance = layer.addComponent(FxManager);
        console.log('[Fx] 惰性自建命中特效层：Canvas/UILayer/FxLayer');
        return this._instance;
    }

    protected onLoad(): void {
        FxManager.instance = this;
        this._uiTransform = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        this._glowOK = !FxManager.useGraphicsFallback
            && !RuntimeTex.useGraphicsFallback
            && RuntimeTex.glow() !== null;
        EventBus.on(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
    }

    protected onDestroy(): void {
        if (FxManager._instance === this) {
            FxManager._instance = null;
        }
        EventBus.off(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
        this._pool.length = 0;
    }

    /** 模态弹窗开关：打开瞬间清空全部特效并锁定派生；关闭后解锁 */
    private onUiModalChanged(open: boolean): void {
        this._modalOpen = open;
        if (open) {
            this.clearAll();
        }
    }

    /** 取节点：优先池内复用（重设纹理），池空按能力路径新建；超活跃上限 / 弹窗期返回 null */
    private obtain(smoke: boolean = false): Node | null {
        if (this._modalOpen || this._active >= ACTIVE_CAP) {
            return null;
        }
        let node = this._pool.pop();
        if (node?.isValid) {
            const sp = node.getComponent(Sprite);
            if (sp?.isValid) {
                sp.spriteFrame = smoke
                    ? (RuntimeTex.smoke() ?? RuntimeTex.glow())
                    : RuntimeTex.glow();
            }
            node.active = true;
            return node;
        }
        return this.createFxNode(smoke);
    }

    /** 纯代码创建特效节点：Sprite(glow 纹理 + 加法混合) 或 Graphics 回退 */
    private createFxNode(smoke: boolean = false): Node | null {
        if (!this.node?.isValid) {
            return null;
        }
        const node = new Node('Fx');
        node.layer = this.node.layer;
        node.addComponent(UITransform);
        node.addComponent(UIOpacity);
        if (this._glowOK) {
            const sp = node.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            sp.spriteFrame = smoke ? (RuntimeTex.smoke() ?? RuntimeTex.glow()) : RuntimeTex.glow();
            // ★ 加法混合（2026-09-05）：走 Sprite 混合因子（引擎原生路径）；自建 customMaterial
            //   的 blendState 覆盖会整体替换 BlendTarget，实测渲染成不透明方块。
            sp.srcBlendFactor = gfx.BlendFactor.SRC_ALPHA;
            sp.dstBlendFactor = gfx.BlendFactor.ONE;
        } else {
            node.addComponent(Graphics); // 回退：playNode 时画同心圆软光斑
        }
        this.node.addChild(node);
        return node;
    }

    /** 回收：停全部 tween → 隐藏入池；池超上限直接销毁（已入池节点重复回收幂等跳过） */
    private recycle(node: Node): void {
        this._active = Math.max(0, this._active - 1);
        if (!node?.isValid || !node.active) {
            return;
        }
        Tween.stopAllByTarget(node);
        const op = node.getComponent(UIOpacity);
        if (op?.isValid) {
            Tween.stopAllByTarget(op);
        }
        if (this._pool.length >= POOL_CAP) {
            node.destroy();
            return;
        }
        node.active = false;
        this._pool.push(node);
    }

    /** 通用单节点播放：颜色 / 尺寸 / 起始缩放 → 可选位移 + 缩放 tween + 同步淡出 → 结束回收 */
    private playNode(
        node: Node, color: Color, size: number, startScale: number,
        life: number, endPos: Vec3 | null, endScale: number,
    ): void {
        if (!node?.isValid) {
            return;
        }
        node.setScale(startScale, startScale, 1);
        const sp = node.getComponent(Sprite);
        if (sp?.isValid) {
            sp.color = color;
            if (size > 0) {
                const xt = node.getComponent(UITransform);
                xt?.setContentSize(size, size);
            }
        } else {
            // Graphics 回退：三层同心圆模拟柔光斑（正常混合下的近似辉光）
            const g = node.getComponent(Graphics);
            const r = size > 0 ? size : 120;
            if (g?.isValid) {
                g.clear();
                const col = cloneColor(color);
                col.a = 40;
                g.fillColor = col;
                g.circle(0, 0, r * 0.55);
                g.fill();
                col.a = 95;
                g.fillColor = col;
                g.circle(0, 0, r * 0.34);
                g.fill();
                col.a = 200;
                g.fillColor = col;
                g.circle(0, 0, r * 0.16);
                g.fill();
            }
        }
        const op = node.getComponent(UIOpacity);
        if (!op?.isValid) {
            this.recycle(node);
            return;
        }
        Tween.stopAllByTarget(node);
        Tween.stopAllByTarget(op);
        op.opacity = 255;
        this._active++;
        const tw = tween(node);
        if (endPos) {
            tw.to(life, { position: endPos, scale: new Vec3(endScale, endScale, 1) });
        } else {
            tw.to(life, { scale: new Vec3(endScale, endScale, 1) });
        }
        tw.start();
        tween(op).to(life, { opacity: 0 }).call(() => this.recycle(node)).start();
    }

    // ---------------- 静态特效 API ----------------

    /**
     * 火花迸溅：count 粒柔光点向四周随机方向飞散并淡出。
     * 撞钉 / 命中 / 受击血雾共用；副球限流由调用方控制（isSplitChild 时 count=1）。
     */
    public static spark(worldPos: Vec3, color: Color, count: number = 4, speed: number = 120, life: number = 0.3): void {
        const mgr = FxManager.instance;
        if (!mgr?._uiTransform?.isValid) {
            return;
        }
        for (let i = 0; i < count; i++) {
            const node = mgr.obtain();
            if (!node) {
                return;
            }
            const local = mgr._uiTransform.convertToNodeSpaceAR(worldPos);
            node.setPosition(local.x, local.y, 0);
            const ang = Math.random() * Math.PI * 2;
            const spd = speed * (0.55 + Math.random() * 0.7);
            const end = new Vec3(
                local.x + Math.cos(ang) * spd * life,
                local.y + Math.sin(ang) * spd * life,
                0,
            );
            mgr.playNode(node, color, 26 + Math.random() * 18, 0.45, life, end, 1.5);
        }
    }

    /** 柔光闪：一团快速放大并淡出的光斑（白闪 / 枪口焰 / 命中闪光共用） */
    public static flash(worldPos: Vec3, color: Color = Theme.fx.white, size: number = 64, life: number = 0.1): void {
        const mgr = FxManager.instance;
        if (!mgr?._uiTransform?.isValid) {
            return;
        }
        const node = mgr.obtain();
        if (!node) {
            return;
        }
        const local = mgr._uiTransform.convertToNodeSpaceAR(worldPos);
        node.setPosition(local.x, local.y, 0);
        mgr.playNode(node, color, size, 0.6, life, null, 2.2);
    }

    /** 冲击细环：Graphics 描边圆放大淡出（低频演出：炸药爆炸 / 吞球，不入池即用即毁） */
    public static ring(worldPos: Vec3, color: Color, endScale: number = 2.6, life: number = 0.3): void {
        const mgr = FxManager.instance;
        if (!mgr?._uiTransform?.isValid || mgr._modalOpen || mgr._active >= ACTIVE_CAP) {
            return;
        }
        const host = mgr.node;
        if (!host?.isValid) {
            return;
        }
        const node = new Node('FxRing');
        node.layer = host.layer;
        node.addComponent(UITransform);
        node.addComponent(UIOpacity);
        const g = node.addComponent(Graphics);
        g.lineWidth = 4;
        g.strokeColor = color;
        g.circle(0, 0, 30);
        g.stroke();
        host.addChild(node);
        const local = mgr._uiTransform.convertToNodeSpaceAR(worldPos);
        node.setPosition(local.x, local.y, 0);
        node.setScale(0.4, 0.4, 1);
        const op = node.getComponent(UIOpacity);
        if (!op?.isValid) {
            node.destroy();
            return;
        }
        op.opacity = 210;
        tween(node).to(life, { scale: new Vec3(endScale, endScale, 1) }).start();
        tween(op).to(life, { opacity: 0 }).call(() => {
            Tween.stopAllByTarget(node);
            node.destroy();
        }).start();
    }

    /** 烟团：1~2 团噪声烟向上飘散放大（爆炸余韵） */
    public static smoke(worldPos: Vec3, radius: number = 120): void {
        const mgr = FxManager.instance;
        if (!mgr?._uiTransform?.isValid) {
            return;
        }
        for (let i = 0; i < 2; i++) {
            const node = mgr.obtain(true);
            if (!node) {
                return;
            }
            const local = mgr._uiTransform.convertToNodeSpaceAR(worldPos);
            const end = new Vec3(local.x + (Math.random() - 0.5) * radius * 0.4, local.y + radius * 0.25, 0);
            const col = cloneColor(Theme.fx.smoke);
            col.a = 170;
            mgr.playNode(node, col, radius * (0.7 + i * 0.3), 0.5, 0.5, end, 1.6);
        }
    }

    /** 爆炸演出：白闪 + 冲击环 + 火星迸溅 + 烟团（炸药钉爆炸当前零视觉 → 此处一次补齐） */
    public static blast(worldPos: Vec3, color: Color, radius: number = 120): void {
        FxManager.flash(worldPos, Theme.fx.white, radius * 1.5, 0.09);
        FxManager.ring(worldPos, Theme.fx.shock, Math.max(2, radius / 42), 0.32);
        FxManager.spark(worldPos, color, 9, radius * 1.9, 0.4);
        FxManager.smoke(worldPos, radius);
    }

    /** 枪口焰：炮塔开火瞬间一小团暖白闪 */
    public static muzzle(worldPos: Vec3): void {
        FxManager.flash(worldPos, Theme.fx.muzzle, 46, 0.07);
    }

    /** 死亡碎浆：碎片向下偏置抛洒并缩小消失 */
    public static gibs(worldPos: Vec3, color: Color, count: number = 6): void {
        const mgr = FxManager.instance;
        if (!mgr?._uiTransform?.isValid) {
            return;
        }
        for (let i = 0; i < count; i++) {
            const node = mgr.obtain();
            if (!node) {
                return;
            }
            const local = mgr._uiTransform.convertToNodeSpaceAR(worldPos);
            node.setPosition(local.x, local.y, 0);
            const end = new Vec3(
                local.x + (Math.random() - 0.5) * 240,
                local.y - 40 - Math.random() * 110,
                0,
            );
            mgr.playNode(node, color, 30 + Math.random() * 12, 0.8, 0.42, end, 0.3);
        }
    }

    /** 吞球：四周火花向槽口汇聚 + 一道竖直光柱闪（三槽漏斗吞球反馈） */
    public static converge(worldPos: Vec3, color: Color): void {
        const mgr = FxManager.instance;
        if (!mgr?._uiTransform?.isValid) {
            return;
        }
        const local = mgr._uiTransform.convertToNodeSpaceAR(worldPos);
        // 竖直光柱：拉长的柔光斑瞬间亮起再淡出
        const pillar = mgr.obtain();
        if (pillar) {
            pillar.setPosition(local.x, local.y + 60, 0);
            const xt = pillar.getComponent(UITransform);
            xt?.setContentSize(120, 300);
            mgr.playNode(pillar, color, 0, 1.0, 0.16, null, 1.0);
        }
        // 汇聚火花：起点在半径 90 环上 → 终点槽口
        for (let i = 0; i < 5; i++) {
            const node = mgr.obtain();
            if (!node) {
                return;
            }
            const ang = (i / 5) * Math.PI * 2;
            node.setPosition(local.x + Math.cos(ang) * 90, local.y + Math.sin(ang) * 90, 0);
            mgr.playNode(node, color, 24, 0.5, 0.26, new Vec3(local.x, local.y, 0), 0.3);
        }
    }

    /** 屏幕边缘红晕脉冲：城堡受击时全屏红色柔光两连闪（弹窗期免疫） */
    public static screenPulse(): void {
        const mgr = FxManager.instance;
        if (!mgr?._uiTransform?.isValid || mgr._modalOpen || mgr._active >= ACTIVE_CAP) {
            return;
        }
        const node = mgr.obtain();
        if (!node) {
            return;
        }
        node.setPosition(0, 0, 0);
        const sp = node.getComponent(Sprite);
        if (sp?.isValid) {
            const xt = node.getComponent(UITransform);
            xt?.setContentSize(900, 1640);
            sp.color = Theme.fx.redPulse;
        }
        const op = node.getComponent(UIOpacity);
        if (!op?.isValid) {
            mgr.recycle(node);
            return;
        }
        Tween.stopAllByTarget(op);
        op.opacity = 0;
        mgr._active++;
        tween(op)
            .to(0.09, { opacity: 76 })
            .to(0.2, { opacity: 0 })
            .to(0.09, { opacity: 50 })
            .to(0.24, { opacity: 0 })
            .call(() => mgr.recycle(node))
            .start();
    }

    /** 清空全部活跃特效（弹窗打开时调用）：停 tween → 全部回池 */
    public clearAll(): void {
        const kids = [...this.node.children];
        for (const k of kids) {
            if (k?.isValid && k.active) {
                Tween.stopAllByTarget(k);
                const op = k.getComponent(UIOpacity);
                if (op?.isValid) {
                    Tween.stopAllByTarget(op);
                }
                this.recycle(k);
            }
        }
    }
}
