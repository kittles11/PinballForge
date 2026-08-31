import {
    _decorator, Component, Node, Vec3, Color, Graphics, UITransform, Layers,
    tween, Tween, find,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { EnemyManager } from './EnemyManager';
import { EnemyController } from './EnemyController';
import { OrbType } from '../Core/DataModels';

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
    private onFire(data: { damage: number; orbType: OrbType }): void {
        this.playRecoil();
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
    private launchBullet(target: EnemyController | null, data: { damage: number; orbType: OrbType }): void {
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
                    target.takeDamage(data.damage, data.orbType);
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
            color = new Color(0x00, 0xff, 0xff, 0xff); // #00FFFF 雷球电光
            radius = 12;
        } else if (orbType === OrbType.Frost) {
            color = new Color(0xE0, 0xF7, 0xFA, 0xff); // #E0F7FA 霜冻淡冰蓝
            radius = 12;
        } else if (orbType === OrbType.Lava) {
            color = new Color(0xff, 0x44, 0x00, 0xff); // #FF4400 熔岩火红大弹
            radius = 16;
        } else {
            color = new Color(0xff, 0xff, 0xff, 0xff); // #FFFFFF 普通银白
            radius = 10;
        }

        g.fillColor = color;
        g.circle(0, 0, radius);
        g.fill();
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
