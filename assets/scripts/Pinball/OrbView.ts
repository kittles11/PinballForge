/**
 * OrbView（Task 006 拆分自 OrbController）：弹珠的「渲染契约」载体——
 * 本体矢量圆盘 / 球种配色与命名 / 视觉缩放 / 辉光叠层 / MotionStreak 拖尾 / 受击闪色。
 *
 * ★ 渲染契约（2026-09-05 选项B根修，与 PegComponent 同构；拆分时原样保留，勿破坏）：
 *  - 球体本体的可见性由子节点 OrbBody 的 Graphics 矢量实心圆盘无条件保证，
 *    不挂、不依赖主节点 Sprite / 任何贴图（零贴图、零运行时纹理上传）；
 *  - 必须挂子节点——Graphics 与 MotionStreak 同为 renderable 组件，同节点互斥
 *    （历史坑：直接 addComponent 到已挂 Sprite 的主节点会被引擎拒绝注册并刷屏）；
 *  - 辉光加法混合走 Sprite.srcBlendFactor/dstBlendFactor 引擎原生路径
 *    （自建 customMaterial 的 blendState 覆盖曾把辉光渲染成不透明方块——弹珠变方块回归根因）。
 *
 * OrbController 保留物理 / 结算 / 卡组守恒，经 applyTypeVisual / flashTint / setHeatTint 驱动本组件；
 * 本组件零物理依赖（绝不触碰 RigidBody2D / Collider2D），随宿主节点同生共死。
 */
import {
    _decorator, Component, Color, Graphics, Node, Sprite, gfx, MotionStreak, builtinResMgr,
    SpriteFrame, Texture2D, UITransform, Vec3,
} from 'cc';
import { orbTrailColor, Theme } from '../Core/ArtTheme';
import { RuntimeTex } from '../Core/RuntimeTex';
import { OrbType } from '../Core/DataModels';
import { OrbBalance } from '../Core/OrbBalance';

const { ccclass } = _decorator;

/** 拖尾流光（MotionStreak）：持续时长（秒） */
const STREAK_FADE_TIME = 0.2;
/** 拖尾流光：最小采样间距（px），越小轨迹越顺滑 */
const STREAK_MIN_SEG = 2;
/** 拖尾流光：粗细（px） */
const STREAK_STROKE = 14;

@ccclass('OrbView')
export class OrbView extends Component {
    /**
     * 本体绘制层（子节点 OrbBody 的 Graphics；见文件头渲染契约）。
     * 必须挂子节点：Graphics 与 MotionStreak 同为 renderable，同节点互斥（见 setupMotionStreak）。
     */
    private _bodyArt: Graphics | null = null;
    /** 本体当前填充色（球种主题色 / 受击闪色）；克隆持有，避免改写 Theme 共享实例 */
    private _tint: Color = Theme.orb.normal.clone();
    /** 本体绘制半径（UITransform 半宽，兜底 12） */
    private _bodyRadius = 12;

    /**
     * 纯代码动态赋型的渲染半程（幂等）：配色 / 命名 / 视觉缩放 + 本体圆盘 + 辉光 + 拖尾。
     * 物理半程（gravityScale / density 写入与延迟密度重建）仍在 OrbController.initOrbType。
     * 发射路径在节点入树前调用（此刻本组件尚未 onLoad），故不依赖任何生命周期时序。
     */
    public applyTypeVisual(type: OrbType): void {
        if (!this.node?.isValid) {
            return;
        }
        // 本体绘制半径：取 UITransform 半宽（球体 24×24 → 12），兜底 12
        const ui = this.node.getComponent(UITransform);
        this._bodyRadius = ui && ui.contentSize.width > 0 ? ui.contentSize.width / 2 : 12;
        if (type === OrbType.Lightning) {
            this._tint.set(Theme.orb.lightning); // 金黄电光色
            this.node.name = 'LightningOrb';
        } else if (type === OrbType.Lava) {
            this._tint.set(Theme.orb.lava); // 熔岩正红色
            this.node.setScale(new Vec3(OrbBalance.lava.scale, OrbBalance.lava.scale, 1));
        } else if (type === OrbType.Frost) {
            this._tint.set(Theme.orb.frost); // 冰蓝 #4FC3F7
            this.node.name = 'FrostOrb';
        } else if (type === OrbType.Plasma) {
            this._tint.set(Theme.orb.plasma); // 等离紫
            this.node.setScale(new Vec3(OrbBalance.plasma.scale, OrbBalance.plasma.scale, 1));
            this.node.name = 'PlasmaOrb';
        } else if (type === OrbType.Magma) {
            this._tint.set(Theme.orb.magma); // 洋红
            this.node.setScale(new Vec3(OrbBalance.magma.scale, OrbBalance.magma.scale, 1));
            this.node.name = 'MagmaOrb';
        } else if (type === OrbType.Leech) {
            this._tint.set(Theme.orb.leech); // 翠绿
            this.node.name = 'LeechOrb';
        } else if (type === OrbType.Normal) {
            // ★ 美术修复：普通球本体统一为主题纯白（与「纯白」拖尾/瞄准线语义一致）
            this._tint.set(Theme.orb.normal);
        }

        // ★ 本体实心圆盘 + 高光（可见性的唯一保证，幂等）
        this.redrawBody();

        // ★ 弹珠辉光叠层（柔光体积感，幂等）
        this.setupOrbGlow(type);

        // ★ 动态拖尾流光：按球种挂 MotionStreak（幂等），发射下落全程跟随对应属性的光迹
        this.setupMotionStreak(type);
    }

    /** 受击闪色：本体 tint 短暂切到 flashColor 后还原（雷球电光 0.05s / 熔岩爆燃 0.08s） */
    public flashTint(flashColor: Color, duration: number): void {
        const origin = this._tint.clone();
        this._tint.set(flashColor);
        this.redrawBody();
        this.scheduleOnce(() => {
            if (this.node?.isValid) {
                this._tint.set(origin);
                this.redrawBody();
            }
        }, duration);
    }

    /**
     * 连击热流（方案B③）：本体基础色随连击热度渐变（球种拖尾色 → 炽橙）。
     * 与 flashTint 协同：闪色还原到调用瞬间的热度色；新球发射经 applyTypeVisual 重置回球种本色。
     */
    public setHeatTint(base: Color): void {
        if (!this.node?.isValid) {
            return;
        }
        this._tint.set(base);
        this.redrawBody();
    }

    /**
     * 取（幂等创建）OrbBody 绘制层子节点。
     * ★ 必须挂子节点：Graphics 与 MotionStreak 同为 renderable 组件，同节点互斥
     *   （见 setupMotionStreak 的历史坑）；子节点随父节点移动，位置天然跟随。
     */
    private ensureBodyArt(): Graphics | null {
        if (this._bodyArt?.isValid) {
            return this._bodyArt;
        }
        if (!this.node?.isValid) {
            return null;
        }
        let child = this.node.getChildByName('OrbBody');
        if (!child?.isValid) {
            child = new Node('OrbBody');
            child.layer = this.node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
            child.addComponent(UITransform);
            this.node.addChild(child);
        }
        this._bodyArt = child.getComponent(Graphics) ?? child.addComponent(Graphics);
        return this._bodyArt;
    }

    /**
     * 重绘球体本体（状态变化时整体重绘，零逐帧开销）：
     * ⓪ 实心圆盘：球体可见性的**唯一保证**，纯矢量填充，不依赖任何贴图 / 运行时纹理上传；
     * ① 左上高光小圆点：给实心圆盘一点球体立体感（同样零贴图）。
     */
    private redrawBody(): void {
        const g = this.ensureBodyArt();
        if (!g?.isValid) {
            return;
        }
        const r = Math.max(1, this._bodyRadius);
        g.clear();
        g.fillColor = this._tint;
        g.circle(0, 0, r);
        g.fill();
        g.fillColor = Theme.orb.normal;
        g.circle(-r * 0.3, r * 0.3, r * 0.28);
        g.fill();
    }

    /**
     * 按球种动态挂载/更新 MotionStreak 拖尾（幂等：重复赋型不会重复添加组件）。
     * ★ 必须挂子节点 OrbTrail：MotionStreak 与 Sprite 同为 renderable 组件，同节点互斥——
     *   此前直接 addComponent 到主节点（已挂 Sprite），引擎每次激活都拒绝注册并刷屏
     *   「Can't add renderable component to this node because it already have one.」，
     *   且拖尾注册被拒后从未真正渲染。与 TurretController.createBulletNode 的
     *   BulletTrail 同款子节点方案；子节点随父节点移动，拖尾跟随正确。
     * 纯代码零资源依赖：拖尾纹理优先 RuntimeTex 程序化截面（横向柔边 + 两端收口），
     * 生成失败时回退内置纯白贴图（ui-sprite-frame）；fastMode 保持 false → 顶点色随
     * fadeTime 渐隐，拖尾尾端自然消散。
     */
    private setupMotionStreak(type: number): void {
        if (!this.node?.isValid) {
            return;
        }
        let trail = this.node.getChildByName('OrbTrail');
        if (!trail?.isValid) {
            trail = new Node('OrbTrail');
            trail.layer = this.node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
            trail.addComponent(UITransform);
            this.node.addChild(trail);
        }
        const streak = trail.getComponent(MotionStreak) ?? trail.addComponent(MotionStreak);
        if (!streak) {
            return;
        }
        // ★ 柔边拖尾：优先用 RuntimeTex 程序化截面纹理（横向柔边 + 两端收口），
        //   生成失败时回退内置纯白贴图（ui-sprite-frame）
        const softTex = RuntimeTex.streakTexture();
        if (softTex) {
            streak.texture = softTex;
        } else {
            const splash = builtinResMgr.get<SpriteFrame>('ui-sprite-frame');
            streak.texture = (splash?.texture as Texture2D | null) ?? null;
        }
        streak.fadeTime = STREAK_FADE_TIME;
        streak.minSeg = STREAK_MIN_SEG;
        streak.stroke = STREAK_STROKE;
        streak.fastMode = false;
        streak.color = orbTrailColor(type);
    }

    /**
     * 弹珠辉光叠层（幂等）：主体之上叠一团加法混合 glow（径向体积光）+ 左上高光点，
     * 把内置白圆硬边球升级为「辉光玻璃珠」。子节点无物理组件，不影响碰撞与染色链路。
     */
    private setupOrbGlow(type: number): void {
        if (!this.node?.isValid) {
            return;
        }
        const glowSF = RuntimeTex.glow();
        if (!glowSF) {
            return; // 纹理不可用时静默跳过：硬边球体也可接受
        }
        const tint = orbTrailColor(type);
        // ① 主体辉光（径向柔光，熔岩球更大更烫）
        let glow = this.node.getChildByName('OrbGlow');
        if (!glow?.isValid) {
            glow = new Node('OrbGlow');
            glow.layer = this.node.layer;
            glow.addComponent(UITransform);
            const sp = glow.addComponent(Sprite);
            sp.spriteFrame = glowSF;
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            // ★ 加法混合（2026-09-05）：直接设 Sprite 混合因子（引擎原生路径，_updateBlendFunc
            //   会在材质实例上正确叠加）。自建 customMaterial 的 blendState 覆盖会整体替换
            //   BlendTarget，实测把辉光渲染成不透明方块（弹珠变方块的回归根因）。
            sp.srcBlendFactor = gfx.BlendFactor.SRC_ALPHA;
            sp.dstBlendFactor = gfx.BlendFactor.ONE;
            glow.setParent(this.node);
        }
        const glowSp = glow.getComponent(Sprite);
        if (glowSp?.isValid) {
            glowSp.color = tint;
        }
        const glowSize = type === OrbType.Lava ? 62 : type === OrbType.Magma ? 66 : type === OrbType.Plasma ? 56 : 52;
        glow.getComponent(UITransform)?.setContentSize(glowSize, glowSize);
        // ② 左上高光点（镜面反射小亮斑）
        let dot = this.node.getChildByName('OrbHighlight');
        if (!dot?.isValid) {
            dot = new Node('OrbHighlight');
            dot.layer = this.node.layer;
            dot.addComponent(UITransform);
            const dsp = dot.addComponent(Sprite);
            dsp.spriteFrame = glowSF;
            dsp.sizeMode = Sprite.SizeMode.CUSTOM;
            dsp.trim = false;
            // 加法混合：同 OrbGlow，走 Sprite 混合因子（引擎原生路径）
            dsp.srcBlendFactor = gfx.BlendFactor.SRC_ALPHA;
            dsp.dstBlendFactor = gfx.BlendFactor.ONE;
            dot.getComponent(UITransform)?.setContentSize(14, 14);
            dot.setPosition(-6, 6, 0);
            dot.setParent(this.node);
        }
    }
}
