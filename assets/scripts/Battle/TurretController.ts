import {
    _decorator, Component, Node, Vec3, Color, Graphics, UITransform, Layers,
    MotionStreak, Sprite, gfx, tween, Tween, find,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { EnemyManager } from './EnemyManager';
import { EnemyController } from './EnemyController';
import { OrbType, FunnelType } from '../Core/DataModels';
import { orbTrailColor, Theme } from '../Core/ArtTheme';
import { MetaManager } from '../Core/MetaManager';
import { OrbBalance } from '../Core/OrbBalance';
import { CastleController } from './CastleController';
import { FloatingTextManager } from '../Core/FloatingTextManager';
import { RuntimeTex } from '../Core/RuntimeTex';
import { FxManager } from '../Core/FxManager';

const { ccclass, property } = _decorator;

/** 后坐力位移（px） */
const RECOIL_OFFSET = 20;
/** 子弹飞行时长（秒）：固定极速弹道 */
const BULLET_FLIGHT_TIME = 0.12;
/** 无敌人兜底时打向屏幕右侧的 X 坐标（BattleLayer 本地坐标） */
const FALLBACK_TARGET_X = 360;
/** 无敌人管理器兜底时直接按固定路径查找的敌人 */
const FALLBACK_ENEMY_PATH = 'Canvas/BattleLayer/EnemyContainer/Enemy';

/**
 * 炮塔控制器：挂载在 BattleLayer/Turret 节点上。
 * 监听 FIRE_TURRET 事件：按【珠子类型】发射特效子弹（白/电光/火红/冰蓝），命中最靠前的敌人。
 * 漏斗只做数值修饰（倍率已由 OrbController 在发射端乘入载荷 damage），不改变弹体外观与受击特效。
 */
@ccclass('TurretController')
export class TurretController extends Component {
    /** 敌人管理器（需在 Inspector 拖入 BattleLayer/EnemyContainer 上的 EnemyManager） */
    @property(EnemyManager)
    enemyManager: EnemyManager | null = null;

    /** 复用临时对象，避免飞行期间分配 */
    private readonly _tmpStart = new Vec3();
    private readonly _tmpEnd = new Vec3();
    private readonly _tmpWorld = new Vec3();

    /** 炮塔固定原点缓存：后坐力动画的恢复基准（onLoad 记录一次，避免连续开火中断时漂移） */
    private readonly _originPos = new Vec3();

    protected onLoad(): void {
        // 缓存固定原点：后坐力往返都以它为基准，杜绝「动画中途被打断 → 起点漂移」的累积误差
        this._originPos.set(this.node.position);
        this.drawTurret();
    }

    /**
     * 纯代码绘制炮塔外观：场景旧贴图（57520716-…，改版前的灰绿底色方块）已从工程删除，
     * 残留 Sprite 引用会渲染成「资源缺失」占位图案；本工程美术全走 Graphics 矢量绘制
     * （零图片资产），炮台改为代码绘制，与 DailyTaskBadge.buildUI 同款范式。
     */
    private drawTurret(): void {
        // ★ 2026-09-06：Graphics 迁入专用 TurretArt 子节点（与钉子 PegArt / 弹珠 OrbBody 同构）。
        //   场景 Turret 节点残留旧贴图 Sprite（57520716… 已删，_spriteFrame 序列化为 null），
        //   绘制层与该 Sprite 同节点并存属 renderable 互斥风险面（3.8.8 引擎 addComponent 冲突检测
        //   在 EDITOR 分支被注释、运行时静默放行且行为未定义），子节点化后从根上隔离，不再触碰场景文件。
        let art = this.node.getChildByName('TurretArt');
        if (!art?.isValid) {
            art = new Node('TurretArt');
            art.layer = this.node.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
            art.addComponent(UITransform);
            art.setParent(this.node);
        }
        const g = art.getComponent(Graphics) ?? art.addComponent(Graphics);
        g.clear();
        // 炮管（朝上，先画，根部由底座覆盖）
        g.fillColor = Theme.machine.body;
        g.roundRect(-7, -4, 14, 34, 6);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = Theme.machine.edge;
        g.roundRect(-7, -4, 14, 34, 6);
        g.stroke();
        // 圆形底座：深灰板体 + 青蓝描边（与导流板 / 蹦床同族机关配色）
        g.fillColor = Theme.machine.body;
        g.circle(0, 0, 24);
        g.fill();
        g.lineWidth = 3;
        g.strokeColor = Theme.machine.edge;
        g.circle(0, 0, 24);
        g.stroke();
        // 中枢亮点
        g.fillColor = Theme.machine.edge;
        g.circle(0, 0, 7);
        g.fill();
    }

    protected start(): void {
        EventBus.on(GameEvents.FIRE_TURRET, this.onFire, this);

        // 未手动拖入 EnemyManager 时，自动在父节点（BattleLayer）的子孙中搜寻，免除手动配置失误
        if (!this.enemyManager) {
            this.enemyManager = this.node.parent?.getComponentInChildren(EnemyManager) ?? null;
        }
    }

    protected onDestroy(): void {
        EventBus.off(GameEvents.FIRE_TURRET, this.onFire, this);
    }

    /** 开火事件回调：后坐力动画 + 珠子类型特效子弹极速飞向最靠前的敌人 */
    private onFire(data: { damage: number; orbType: OrbType; funnelType?: FunnelType }): void {
        this.playRecoil();
        // ★ 枪口焰：开火瞬间一小团暖白闪
        FxManager.muzzle(this.node.worldPosition);
        this.launchBullet(this.resolveTarget(), data);
    }

    /** 优先取管理器选定的最靠前敌人；管理器缺失时用固定路径 find 兜底 */
    private resolveTarget(): EnemyController | null {
        const fromManager = this.enemyManager?.getFrontEnemy();
        if (fromManager?.node?.isValid) {
            return fromManager;
        }
        const fallback = find(FALLBACK_ENEMY_PATH);
        return fallback?.getComponent(EnemyController) ?? null;
    }

    /** 生成对应颜色的子弹并以固定 0.12s 极速飞向目标终点；无敌人时打向屏幕右侧边框 */
    private launchBullet(target: EnemyController | null, data: { damage: number; orbType: OrbType; funnelType?: FunnelType }): void {
        const host = this.node.parent; // BattleLayer：子弹与敌人同坐标系
        if (!host?.isValid || !this.node.isValid) {
            return;
        }

        // 起点 = 炮塔位置（BattleLayer 本地坐标）
        this._tmpStart.set(this.node.position);

        if (target?.node?.isValid) {
            // 终点 = 目标世界坐标 → BattleLayer 本地坐标（容器有偏移/缩放时依然准确命中）
            target.node.getWorldPosition(this._tmpWorld);
            host.inverseTransformPoint(this._tmpEnd, this._tmpWorld);
        } else {
            // 无敌人兜底：打向屏幕最右侧边框
            this._tmpEnd.set(FALLBACK_TARGET_X, this.node.position.y, 0);
        }

        const bullet = this.createBulletNode(data.orbType);
        bullet.setPosition(this._tmpStart);
        host.addChild(bullet);

        const node = bullet;
        tween(node)
            .to(BULLET_FLIGHT_TIME, { position: this._tmpEnd.clone() })
            .call(() => {
                // 到达终点：销毁子弹
                if (node.isValid) {
                    node.destroy();
                }
                // ★ 命中发射瞬间锁定的目标，飞行中不再重查敌人列表——
                //   修复「隔空打怪」：旧逻辑到达时重新 resolveTarget，可能命中与瞄准不同的另一只敌人
                if (target?.node?.isValid && !target.isDead) {
                    // funnelType 透传：Boss「破阵坚盾」按入槽漏斗做剥盾判定（普通怪无感）
                    // ⚒ meta「攻城炮台」：炮塔子弹伤害按等级加成（siegeBonus = Lv × 20%）
                    const dmg = Math.round(data.damage * (1 + MetaManager.getSiegeBonus()));
                    target.takeDamage(dmg, data.orbType, false, data.funnelType ?? null);
                    // 🌳 吸血球：命中后按倍率治疗城堡（续航，不改伤害分配；命中才回血，语义正确）。
                    //   难度方案B：单发回血封顶 leechHitHealCap，且豁免城堡单局治疗阀门（上限由封顶承担）
                    if (data.orbType === OrbType.Leech) {
                        const heal = Math.min(Math.round(dmg * OrbBalance.leechHealRatio), OrbBalance.leechHitHealCap);
                        if (heal > 0) {
                            CastleController.instance?.heal(heal, true);
                            // 回血飘字：翠绿「+N ❤」从命中敌人处升起（吸血反馈可视化）
                            FloatingTextManager.instance?.showText(
                                `+${heal} ❤`, target.node.worldPosition, Theme.orb.leech, false,
                            );
                        }
                    }
                    // ★ 命中火花：跟随珠子类型色
                    FxManager.spark(target.node.worldPosition, orbTrailColor(data.orbType), 3);
                }
            })
            .start();
    }

    /**
     * 创建炮弹：UI_2D 层级保证 2D 相机绝对可见；外观严格跟随【珠子类型】：
     * 普通：#FFFFFF 银白光球 r10；雷球：#00FFFF 电光球 r12；
     * 熔岩：#FF4400 火红大弹 r16；霜冻：#E0F7FA 淡冰蓝光球 r12。
     */
    private createBulletNode(orbType: OrbType): Node {
        const n = new Node('Bullet');
        n.layer = Layers.Enum.UI_2D; // 保证 2D 相机一定渲染该子弹
        n.getComponent(UITransform) ?? n.addComponent(UITransform);
        const g = n.addComponent(Graphics);

        let color: Color;
        let radius: number;
        if (orbType === OrbType.Lightning) {
            color = Theme.orb.lightning; // #00FFFF 雷球电光
            radius = 12;
        } else if (orbType === OrbType.Frost) {
            color = Theme.orb.frost; // #E0F7FA 霜冻淡冰蓝
            radius = 12;
        } else if (orbType === OrbType.Lava) {
            color = Theme.orb.lava; // #FF4400 熔岩火红大弹
            radius = 16;
        } else if (orbType === OrbType.Plasma) {
            color = Theme.orb.plasma; // 等离紫弹
            radius = 13;
        } else if (orbType === OrbType.Magma) {
            color = Theme.orb.magma; // 熔核洋红大弹
            radius = 17;
        } else if (orbType === OrbType.Leech) {
            color = Theme.orb.leech; // 吸血翠绿弹
            radius = 12;
        } else {
            color = Theme.orb.normal; // #FFFFFF 普通银白
            radius = 10;
        }

        g.fillColor = color;
        g.circle(0, 0, radius);
        g.fill();

        // ★ 柔光弹体：glow 纹理叠层（加法混合），硬边实心圆 → 辉光弹
        const glowSF = RuntimeTex.glow();
        if (glowSF) {
            const glow = new Node('BulletGlow');
            glow.layer = n.layer;
            const xt = glow.addComponent(UITransform);
            xt.setContentSize(radius * 3.2, radius * 3.2);
            const sp = glow.addComponent(Sprite);
            sp.spriteFrame = glowSF;
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            sp.color = color;
            // ★ 加法混合（2026-09-05）：走 Sprite 混合因子（引擎原生路径）；自建 customMaterial
            //   的 blendState 覆盖会整体替换 BlendTarget，实测渲染成不透明方块。
            sp.srcBlendFactor = gfx.BlendFactor.SRC_ALPHA;
            sp.dstBlendFactor = gfx.BlendFactor.ONE;
            n.addChild(glow);
        }

        // ★ 弹道拖尾：短淡出 MotionStreak（0.12s 飞行中拉出光迹，替代原瞬移实心圆点）
        //   挂到子节点：MotionStreak 与 Graphics 同为 renderable 组件，同节点互斥
        //   （"Can't add renderable component" 即因此产生），子节点随父节点移动，拖尾跟随正确。
        const streakTex = RuntimeTex.streakTexture();
        if (streakTex) {
            const trail = new Node('BulletTrail');
            trail.layer = n.layer;
            trail.addComponent(UITransform);
            const streak = trail.addComponent(MotionStreak);
            streak.texture = streakTex;
            streak.fadeTime = 0.1;
            streak.minSeg = 3;
            streak.stroke = radius * 1.2;
            streak.fastMode = false;
            streak.color = color;
            n.addChild(trail);
        }
        return n;
    }

    /** 后坐力：瞬间向左平移 RECOIL_OFFSET px，再 0.1s 回到固定原点（不随当前坐标漂移） */
    private playRecoil(): void {
        if (!this.node?.isValid) {
            return;
        }
        const node = this.node;
        Tween.stopAllByTarget(node);
        tween(node)
            .to(0.05, { position: new Vec3(this._originPos.x - RECOIL_OFFSET, this._originPos.y, this._originPos.z) })
            .to(0.1, { position: this._originPos.clone() })
            .start();
    }
}
