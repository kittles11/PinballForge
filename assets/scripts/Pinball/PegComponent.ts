import {
    _decorator, Component, Enum, Color, Graphics, Node, Sprite, Collider2D, UITransform,
    Vec3, tween, Tween, find,
} from 'cc';
import { PegType } from '../Core/DataModels';
import { CameraShake } from '../Core/CameraShake';
import { RelicManager } from '../Core/RelicManager';
import { cloneColor, EASE_POP, EASE_PUNCH, SQUASH_SCALE_X, SQUASH_SCALE_Y, Theme } from '../Core/ArtTheme';
import { FxManager } from '../Core/FxManager';

const { ccclass, property } = _decorator;

export { PegType };

// 注册枚举元数据，供 Cocos 类系统序列化 / 编辑器下拉识别
Enum(PegType);

/** 炸药钉爆炸半径下限（px）：默认 120；铺满屏幕后由 PegBoardManager 按实际间距注入更大的值 */
export const BOMB_RADIUS = 120;

/** 各类型钉子的初始主题色（编辑器未配颜色时兜底使用）：色值统一取自 ArtTheme 语义色板 */
const PEG_TYPE_COLORS: Record<PegType, Color> = {
    [PegType.Normal]: Theme.peg.normal,
    [PegType.Multiplier]: Theme.peg.multiplier,
    [PegType.Bomb]: Theme.peg.bomb,
    [PegType.Refresh]: Theme.peg.refresh,
};

/**
 * 钉子组件：管理受击次数、力竭状态与回合重置。
 * 依赖：节点需挂 Sprite（变色）与 Collider2D（力竭时禁用）。
 */
@ccclass('PegComponent')
export class PegComponent extends Component {
    /** 钉子类型 */
    @property({ type: Enum(PegType) })
    pegType: PegType = PegType.Normal;

    /** 爆炸半径（px）：默认 BOMB_RADIUS=120；PegBoardManager 铺满屏幕时按实际横向间距注入更大值，保证覆盖一整圈相邻钉 */
    explosionRadius = BOMB_RADIUS;

    /** 每回合最大可受击次数 */
    @property
    maxHitsPerRound = 3;

    /** 受击激活时的高亮颜色（普通钉浅绿，乘倍钉金黄）；克隆持有，可被 upgradeToMultiplier 安全改写 */
    @property(Color)
    hitColor: Color = cloneColor(Theme.peg.hit);

    /** 受击达到上限变暗的颜色（灰色） */
    @property(Color)
    disabledColor: Color = cloneColor(Theme.peg.exhaust);

    /** 当前被撞击次数 */
    get currentHitCount(): number {
        return this._currentHitCount;
    }
    private _currentHitCount = 0;

    /** 是否已力竭（本回合耗尽） */
    get isExhausted(): boolean {
        return this._isExhausted;
    }
    private _isExhausted = false;

    /** 能量倍率：乘倍钉 ×2，其余 ×1 */
    get multiplier(): number {
        return this.pegType === PegType.Multiplier ? 2 : 1;
    }

    /** 爆炸守卫：炸药钉爆炸期间置 true，防止连锁爆炸在同一同步递归栈内重复引爆同一颗钉（栈溢出死循环） */
    private _isExploding = false;

    private _sprite: Sprite | null = null;
    private _collider: Collider2D | null = null;
    /** 初始 Sprite 颜色（类型主题色），resetPeg 时恢复 */
    private _defaultColor: Color = cloneColor(Theme.peg.normal);
    /** 初始缩放，作为弹性动画的基准 */
    private _baseScale: Vec3 = new Vec3(1, 1, 1);
    /** 钉子绘制半径（UITransform 半宽，兜底 16） */
    private _radius = 16;
    /** 类型纹样 + 受击计量环的绘制层（子节点 PegArt，状态变化时整体重绘） */
    private _art: Graphics | null = null;

    protected onLoad(): void {
        this._sprite = this.getComponent(Sprite);
        this._collider = this.getComponent(Collider2D);
        // 按类型赋予初始主题色；若枚举未配置才回退到 Sprite 编辑器原始颜色
        const typeColor = PEG_TYPE_COLORS[this.pegType];
        if (typeColor) {
            this._defaultColor.set(typeColor);
        } else if (this._sprite) {
            this._defaultColor.set(this._sprite.color);
        }
        if (this._sprite) {
            this._sprite.color = this._defaultColor;
        }
        this._baseScale.set(this.node.scale);
        // 钉子半径（计量环 / 类型纹样的绘制基准）：取 UITransform 半宽，兜底 16
        const size = this.node.getComponent(UITransform)?.contentSize;
        this._radius = size && size.width > 0 ? size.width / 2 : 16;
        this.redrawArt();
    }

    protected onDestroy(): void {
        if (this.node?.isValid) {
            Tween.stopAllByTarget(this.node);
        }
    }

    /**
     * 被弹珠撞击：
     * - 受击计数 +1；
     * - 播放弹性缩放动画（0.08s 放大到 1.3 倍，0.1s 回弹）；
     * - Sprite 变高亮色；
     * - 达到 maxHitsPerRound 后进入力竭（变灰 + 禁用 Collider2D）。
     */
    public onHit(skipAnim: boolean = false, visited: Set<PegComponent> | null = null): void {
        // 严格非空检查：节点已销毁 / 已力竭则不处理
        if (!this.node?.isValid || this._isExhausted) {
            return;
        }
        // 炸弹钉已在爆炸递归栈内 → 立即返回，终止连锁爆炸死循环（防栈溢出）
        if (this._isExploding) {
            return;
        }
        if (visited?.has(this)) {
            return;
        }
        visited?.add(this);
        this._currentHitCount += 1;

        // 撞钉发声统一由 OrbController 碰撞点走 AudioManager 全局直播池（零 Inspector 配置），
        // 此处不再自行发声，避免与 OrbController 双响。
        const node = this.node;

        // 副球（雷球分裂的左右弹，skipAnim=true）不播放弹性缩放动画：只累加能量/计数，
        // 靠主球统一反馈动画，削减高频碰撞下的 Tween 实例开销。
        // 类型纹样 / 计量环随受击即时重绘（副球 skipAnim 也计数，同样重绘）
        this.redrawArt();

        if (!skipAnim) {
            // 打断上一次未完成的动画，避免叠加；squash & stretch：X 撑 Y 压 + backOut 过冲回弹
            Tween.stopAllByTarget(node);
            const big = new Vec3(
                this._baseScale.x * SQUASH_SCALE_X,
                this._baseScale.y * SQUASH_SCALE_Y,
                this._baseScale.z,
            );
            tween(node)
                .to(0.08, { scale: big }, { easing: EASE_PUNCH })
                .to(0.12, { scale: this._baseScale.clone() }, { easing: EASE_POP })
                .start();
        }

        // 炸药钉：一次性命中，引爆周围 BOMB_RADIUS 内钉子后自身力竭
        if (this.pegType === PegType.Bomb) {
            this.triggerBombExplosion(visited); // 内部 _isExploding 守卫防连锁重复引爆
            this.exhaust();                     // 立即力竭变灰，防止被二次引爆
            return;                             // 不走受击高亮，避免炸后闪成与自身炽红无关的浅绿
        }

        // 刷新钉：复活全场除自身外的其它钉子；自身照常累计受击，打满 maxHitsPerRound 才力竭
        if (this.pegType === PegType.Refresh) {
            PegComponent.resetAllPegs(this);
        }

        // 受击高亮：Sprite 缺失 / 失效时静默跳过，不崩溃
        if (this._sprite?.isValid) {
            this._sprite.color = this.hitColor;
        }

        if (this._currentHitCount >= this.maxHitsPerRound) {
            this.exhaust();
        }
    }

    /**
     * 熔岩球撞击特效：大范围熔岩震动——瞬间放大到 1.6 倍并染成鲜亮红橙 #FF3300，随即回弹复原。
     * 比普通 onHit 的 1.3 倍受击动画更剧烈，配合 +60 能量爆燃钉子的爽感。
     * 注意：不与 onHit 的力竭守卫绑定——即使这次撞击刚好让钉子力竭，也要完整播完爆燃效果
     * （结束时若已力竭则复原为灰色 disabledColor）。
     */
    public lavaHit(): void {
        if (!this.node?.isValid) {
            return;
        }
        const node = this.node;
        // 打断上一次未完成的缩放动画，避免叠加
        Tween.stopAllByTarget(node);

        const big = this._baseScale.clone().multiplyScalar(1.6);
        if (this._sprite?.isValid) {
            this._sprite.color = Theme.peg.lavaSplash; // 鲜亮红橙 #FF3300
        }
        tween(node)
            .to(0.06, { scale: big }, { easing: EASE_PUNCH })
            .to(0.18, { scale: this._baseScale.clone() }, { easing: EASE_POP })
            .call(() => {
                // 复原颜色：已力竭 → 保持灰色；未力竭 → 保持受击高亮色 hitColor
                // （修复旧逻辑：lavaHit 动画结束后一律复原为初始白，导致受击高亮被错误清除）
                if (this._sprite?.isValid) {
                    this._sprite.color = this._isExhausted
                        ? this.disabledColor.clone()
                        : this.hitColor.clone();
                }
            })
            .start();
    }

    /** 炸药钉爆炸：镜头震动 + 引爆周围 BOMB_RADIUS 内的所有钉子（_isExploding 守卫防连锁死循环） */
    private triggerBombExplosion(visited: Set<PegComponent> | null = null): void {
        // 防重入守卫：本次爆炸尚未结束（同一同步递归栈内）不允许再次引爆
        if (this._isExploding) {
            return;
        }
        this._isExploding = true;

        // 爆炸瞬间触发镜头震动
        CameraShake.shake(10, 0.18);

        // 获取全场所有钉子（钉板各钉挂在同一父节点下）
        const allPegs = this.node.parent?.getComponentsInChildren(PegComponent) ?? [];
        const myPos = this.node.worldPosition;
        // 高能烈药被动：持有该遗物时爆炸半径强制扩大到 HIGH_EXPLOSIVE_RADIUS（否则维持原半径）
        const radius = RelicManager.effectiveBombRadius(this.explosionRadius);
        // ★ 命中特效：白闪 + 冲击环 + 火星迸溅 + 烟团（旧实现爆炸零视觉，只震屏）
        FxManager.blast(myPos, Theme.peg.bomb, radius);
        for (const other of allPegs) {
            if (other === this || !other?.node?.isValid || other.isExhausted) continue;
            const dist = Vec3.distance(myPos, other.node.worldPosition);
            if (dist <= radius) {
                other.onHit(false, visited); // 连带引爆并结算受击
            }
        }

        this._isExploding = false;
    }

    /** 进入力竭状态：变灰 + 禁用碰撞体 */
    private exhaust(): void {
        this._isExhausted = true;
        if (this._sprite?.isValid) {
            this._sprite.color = this.disabledColor;
        }
        if (this._collider?.isValid) {
            this._collider.enabled = false;
        }
        this.redrawArt(); // 计量环全段熄灭
    }

    /**
     * 新波次开启时一键复活全场已力竭的钉子（清零计数、恢复碰撞器、恢复初始颜色与缩放）。
     * 供 RewardDialog 选择卡牌后调用。
     */
    static resetAllPegs(except?: PegComponent): void {
        const pegs = find('Canvas')?.getComponentsInChildren(PegComponent) ?? [];
        for (const peg of pegs) {
            if (peg === except || !peg?.node?.isValid) {
                continue;
            }
            peg.resetPeg();
        }
    }

    /** 新回合重置：清零计数、恢复碰撞器、恢复初始颜色与缩放 */
    public resetPeg(): void {
        this._currentHitCount = 0;
        this._isExhausted = false;

        if (this._collider) {
            this._collider.enabled = true;
        }
        if (this._sprite) {
            this._sprite.color = this._defaultColor;
        }

        Tween.stopAllByTarget(this.node);
        this.node.setScale(this._baseScale);
        this.redrawArt();
    }

    /**
     * 动态设置钉子类型：更新 pegType，并同步刷新 _defaultColor 与当前 Sprite 颜色。
     * 供 PegBoardManager 生成钉板时按随机分配的结果统一指定类型（Normal / Bomb / Refresh / Multiplier）。
     * 若钉子正处于力竭状态，改类型后立即恢复可受击，保证新类型能正常参与本局。
     */
    public setPegType(type: PegType): void {
        this.pegType = type;

        // 同步初始基准色：有类型映射色用映射色，否则回退当前 Sprite 颜色
        const typeColor = PEG_TYPE_COLORS[type];
        if (typeColor) {
            this._defaultColor.set(typeColor);
        } else if (this._sprite) {
            this._defaultColor.set(this._sprite.color);
        }
        if (this._sprite?.isValid) {
            this._sprite.color = this._defaultColor;
        }
        this.redrawArt();

        // 力竭中的钉子改类型后立即重置，避免新类型仍处于禁用碰撞的灰化状态
        if (this._isExhausted) {
            this.resetPeg();
        }
    }

    /**
     * 强化为乘倍钉（战后卡牌奖励）：
     * 类型改为乘倍钉，并把受击高亮色与回合重置基准色一并设为金黄，
     * 保证强化后的金色外观在受击 / 回合重置后依然保持。
     */
    public upgradeToMultiplier(): void {
        if (!this.node?.isValid) {
            return;
        }
        this.pegType = PegType.Multiplier;
        const gold = cloneColor(Theme.peg.multiplier);
        this.hitColor.set(gold);
        this._defaultColor.set(gold);
        if (this._sprite?.isValid) {
            this._sprite.color = gold;
        }
        this.redrawArt();
        // 力竭中的钉子强化后立即恢复可受击（重置为金黄并启用碰撞器）
        if (this._isExhausted) {
            this.resetPeg();
        }
    }

    /** 取（幂等创建）PegArt 绘制层：子节点承载类型纹样与受击计量环 */
    private ensureArt(): Graphics | null {
        if (this._art?.isValid) {
            return this._art;
        }
        if (!this.node?.isValid) {
            return null;
        }
        let child = this.node.getChildByName('PegArt');
        if (!child?.isValid) {
            child = new Node('PegArt');
            child.layer = this.node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
            child.addComponent(UITransform);
            child.setParent(this.node);
        }
        this._art = child.getComponent(Graphics) ?? child.addComponent(Graphics);
        return this._art;
    }

    /**
     * 重绘钉子美术层（状态变化时整体重绘，零逐帧开销）：
     * ① 受击计量环：maxHitsPerRound 段弧，随受击逐段熄灭（与音效音高爬升对齐的进度反馈）；
     * ② 类型形状分化：普通=圆（仅计量环）/ 乘倍=六角 / 炸药=引信火花 / 刷新=内环四刻度。
     */
    private redrawArt(): void {
        const g = this.ensureArt();
        if (!g?.isValid) {
            return;
        }
        g.clear();
        const c = PEG_TYPE_COLORS[this.pegType] ?? Theme.peg.normal;
        const r = this._radius;

        // ① 受击计量环：段弧从正上方开始顺时针排布，已受击段熄灭
        const segs = Math.max(1, Math.round(this.maxHitsPerRound));
        const gap = 0.24; // 弧段间隙（弧度）
        const span = (Math.PI * 2) / segs;
        g.lineWidth = 3;
        for (let i = 0; i < segs; i++) {
            const spent = i < this._currentHitCount;
            const a0 = -Math.PI / 2 + i * span + gap / 2;
            g.strokeColor = spent ? Theme.peg.ringOff : c;
            g.arc(0, 0, r + 7, a0, a0 + span - gap, false);
            g.stroke();
        }

        // ② 类型纹样分化
        switch (this.pegType) {
            case PegType.Multiplier: {
                // 六角描边（乘倍钉的「晶体感」）
                g.lineWidth = 2.5;
                g.strokeColor = c;
                const rr = r - 4;
                for (let k = 0; k < 6; k++) {
                    const a = (Math.PI / 3) * k - Math.PI / 2;
                    const x = rr * Math.cos(a);
                    const y = rr * Math.sin(a);
                    if (k === 0) {
                        g.moveTo(x, y);
                    } else {
                        g.lineTo(x, y);
                    }
                }
                g.close();
                g.stroke();
                break;
            }
            case PegType.Bomb: {
                // 引信：顶部短线 + 火花点
                g.lineWidth = 2.5;
                g.strokeColor = c;
                g.moveTo(0, r - 2);
                g.lineTo(0, r + 8);
                g.stroke();
                g.fillColor = Theme.fx.ember;
                g.circle(0, r + 10, 3);
                g.fill();
                break;
            }
            case PegType.Refresh: {
                // 内环四段刻度（表盘感 = 周期刷新）
                g.lineWidth = 2.5;
                g.strokeColor = c;
                for (let k = 0; k < 4; k++) {
                    const a0 = (Math.PI / 2) * k - Math.PI / 2 + 0.2;
                    g.arc(0, 0, r - 5, a0, a0 + (Math.PI / 2) - 0.4, false);
                    g.stroke();
                }
                break;
            }
            default:
                break; // 普通钉：仅计量环，保持素净
        }
    }

    /**
     * 战后卡牌奖励：随机挑选 count 颗普通钉强化为乘倍钉。
     * 场景内普通钉不足 count 时按实际数量强化；返回实际强化数量。
     */
    static upgradeRandomNormalPegs(count: number): number {
        const pegs = find('Canvas')?.getComponentsInChildren(PegComponent) ?? [];
        const normals = pegs.filter((p) => p?.node?.isValid && p.pegType === PegType.Normal);
        // Fisher–Yates 洗牌，保证每次随机取不同普通钉
        for (let i = normals.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = normals[i];
            normals[i] = normals[j];
            normals[j] = tmp;
        }
        const picked = normals.slice(0, Math.max(0, count));
        for (const peg of picked) {
            peg.upgradeToMultiplier();
        }
        return picked.length;
    }

    /** 潮汐镀金：随机挑选 count 颗普通钉镀金为乘倍钉（金光视觉与永久强化一致），返回实际镀金名单 */
    static gildRandomNormalPegs(count: number): PegComponent[] {
        const pegs = find('Canvas')?.getComponentsInChildren(PegComponent) ?? [];
        const normals = pegs.filter((p) => p?.node?.isValid && p.pegType === PegType.Normal);
        // Fisher–Yates 洗牌（与 upgradeRandomNormalPegs 同款），保证随机取不同普通钉
        for (let i = normals.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = normals[i];
            normals[i] = normals[j];
            normals[j] = tmp;
        }
        const picked = normals.slice(0, Math.max(0, count));
        for (const peg of picked) {
            peg.upgradeToMultiplier();
        }
        return picked;
    }
}