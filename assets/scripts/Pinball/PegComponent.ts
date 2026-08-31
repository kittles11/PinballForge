import {
    _decorator, Component, Enum, Color, Sprite, Collider2D, Vec3, tween, Tween, find,
} from 'cc';
import { PegType } from '../Core/DataModels';
import { CameraShake } from '../Core/CameraShake';
import { RelicManager } from '../Core/RelicManager';

const { ccclass, property } = _decorator;

export { PegType };

// 注册枚举元数据，供 Cocos 类系统序列化 / 编辑器下拉识别
Enum(PegType);

/** 炸药钉爆炸半径下限（px）：默认 120；铺满屏幕后由 PegBoardManager 按实际间距注入更大的值 */
export const BOMB_RADIUS = 120;

/** 各类型钉子的初始主题色（编辑器未配颜色时兜底使用；Bomb 炽红 / Refresh 翠绿） */
const PEG_TYPE_COLORS: Record<PegType, Color> = {
    [PegType.Normal]: new Color(255, 255, 255, 255),      // 白 / 木色
    [PegType.Multiplier]: new Color(255, 215, 0, 255),    // 金黄
    [PegType.Bomb]: new Color(255, 40, 40, 255),          // 炸药红 #FF2828
    [PegType.Refresh]: new Color(50, 230, 100, 255),      // 刷新翠绿 #32E664
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

    /** 受击激活时的高亮颜色（普通钉浅绿，乘倍钉金黄） */
    @property(Color)
    hitColor: Color = new Color(144, 238, 144, 255);

    /** 受击达到上限变暗的颜色（灰色） */
    @property(Color)
    disabledColor: Color = new Color(153, 153, 153, 255);

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
    /** 初始 Sprite 颜色（默认白色），resetPeg 时恢复 */
    private _defaultColor: Color = new Color(255, 255, 255, 255);
    /** 初始缩放，作为弹性动画的基准 */
    private _baseScale: Vec3 = new Vec3(1, 1, 1);

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
        if (!skipAnim) {
            // 打断上一次未完成的动画，避免叠加
            Tween.stopAllByTarget(node);
            const big = this._baseScale.clone().multiplyScalar(1.3);
            tween(node)
                .to(0.08, { scale: big })
                .to(0.1, { scale: this._baseScale.clone() })
                .start();
        }

        // 炸药钉：一次性命中，引爆周围 BOMB_RADIUS 内钉子后自身力竭
        if (this.pegType === PegType.Bomb) {
            this.triggerBombExplosion(visited);    // 鍐呴儴缁?_isExploding 瀹堝崼闃茶繖
            this.exhaust();                 // 立即力竭变灰，防止被二次引爆
            return;                         // 不走受击高亮，避免炸后闪成与自身炽红无关的浅绿
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
        const lavaColor = new Color(255, 51, 0, 255); // 鲜亮红橙 #FF3300
        if (this._sprite?.isValid) {
            this._sprite.color = lavaColor;
        }
        tween(node)
            .to(0.06, { scale: big })
            .to(0.18, { scale: this._baseScale.clone() })
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
        for (const other of allPegs) {
            if (other === this || !other?.node?.isValid || other.isExhausted) continue;
            const dist = Vec3.distance(myPos, other.node.worldPosition);
            if (dist <= radius) {
                other.onHit(false, visited); // 杩炲甫寮曠偢骞剁粨绠楀彈鍑?
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
        const gold = new Color(255, 215, 0, 255);
        this.hitColor.set(gold);
        this._defaultColor.set(gold);
        if (this._sprite?.isValid) {
            this._sprite.color = gold;
        }
        // 力竭中的钉子强化后立即恢复可受击（重置为金黄并启用碰撞器）
        if (this._isExhausted) {
            this.resetPeg();
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