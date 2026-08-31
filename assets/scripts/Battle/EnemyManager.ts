import { _decorator, Component } from 'cc';
import { EnemyController } from './EnemyController';
import { EventBus, GameEvents } from '../Core/EventBus';

const { ccclass } = _decorator;

/**
 * 敌人管理器：挂载在 BattleLayer/EnemyContainer 节点上。
 * 维护实时存活敌人列表（由 EnemyController 经事件总线登记/注销），并查询最靠前（离我方要塞最近）的目标。
 */
@ccclass('EnemyManager')
export class EnemyManager extends Component {
    /** 单例引用：供 TurretController / 其它系统直接访问实时敌人列表 */
    static instance: EnemyManager | null = null;

    /** 实时活怪列表：EnemyController 启动时自动登记，死亡/销毁时自动注销 */
    public aliveEnemies: EnemyController[] = [];

    protected onLoad(): void {
        EnemyManager.instance = this;
        // 敌人登记 / 注销经事件总线驱动（EnemyController 不再反向导入本类，解除循环引用）
        EventBus.on(GameEvents.ENEMY_SPAWNED, this.registerEnemy, this);
        EventBus.on(GameEvents.ENEMY_REMOVED, this.unregisterEnemy, this);
    }

    protected onDestroy(): void {
        EventBus.targetOff(this); // 注销事件监听（登记 / 注销两个入口一并移除）
        if (EnemyManager.instance === this) {
            EnemyManager.instance = null;
        }
        this.aliveEnemies.length = 0; // 场景重载时清空引用，避免残留悬垂引用
    }

    /** 登记敌人（去重） */
    public registerEnemy(enemy: EnemyController): void {
        if (enemy?.node?.isValid && this.aliveEnemies.indexOf(enemy) < 0) {
            this.aliveEnemies.push(enemy);
        }
    }

    /** 注销敌人 */
    public unregisterEnemy(enemy: EnemyController): void {
        if (!this.aliveEnemies || !enemy) {
            return; // 防御判空：场景重载销毁过程中可能以已失效引用被调用
        }
        const idx = this.aliveEnemies.indexOf(enemy);
        if (idx >= 0) {
            this.aliveEnemies.splice(idx, 1);
        }
    }

    /**
     * 返回 X 坐标最靠左（离我方要塞最近）的存活敌人；无目标返回 null。
     * 列表为空时自动从子节点重新获取（登记遗漏兜底），并过滤已销毁/已死亡对象。
     */
    public getFrontEnemy(): EnemyController | null {
        // 懒清理：每次查询前剔除已死/已销毁残留，防止旧引用堆积影响选敌
        this.prune();
        if (this.aliveEnemies.length === 0) {
            this.aliveEnemies = this.node.getComponentsInChildren(EnemyController)
                .filter((e) => e?.node?.isValid && !e.isDead);
        }
        let front: EnemyController | null = null;
        for (const e of this.aliveEnemies) {
            if (!e?.node?.isValid || e.isDead) {
                continue; // 已销毁/已死亡但未注销的残留，跳过
            }
            if (!front || e.node.position.x < front.node.position.x) {
                front = e;
            }
        }
        return front;
    }

    /** 懒清理：移除已死/已销毁的残留引用（保持列表只含有效敌人） */
    private prune(): void {
        if (this.aliveEnemies.length === 0) {
            return;
        }
        this.aliveEnemies = this.aliveEnemies.filter((e) => e?.node?.isValid && !e.isDead);
    }
}
