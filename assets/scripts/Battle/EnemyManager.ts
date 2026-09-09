import { _decorator, Component } from 'cc';
import { EnemyController } from './EnemyController';
import { EventBus, GameEvents } from '../Core/EventBus';

const { ccclass } = _decorator;

/**
 * 敌人管理器：挂载在 BattleLayer/EnemyContainer 节点上。
 * 维护实时存活敌人列表（由 EnemyController 经事件总线登记/注销），并查询最靠前（离我方要塞最近）的目标。
 * ⚡ 天雷（流派质变）：监听 DAMAGE_ENEMY 对随机一名存活敌人落雷直伤——
 * 发射端（OrbController）只派发事件、不耦合敌人系统（.clinerules 事件总线解耦红线）。
 * 🎲 回合推进（物理肉鸽 P2）：监听 TURN_ADVANCE（LauncherController 每次实际发射派发），
 * 驱动全体存活敌人 advanceDown 回合下落一步（触底攻城判定在敌人侧自持）。
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
        // ⚡ 雷电球「天雷」：随机存活敌人吃直伤（无存活敌人时静默落空——概率资源不补偿，语义=空劈）
        EventBus.on(GameEvents.DAMAGE_ENEMY, this.onDamageEnemy, this);
        // 🎲 回合推进（物理肉鸽 P2）：每次玩家发射驱动全体敌人下落一步
        EventBus.on(GameEvents.TURN_ADVANCE, this.onTurnAdvance, this);
    }

    protected onDestroy(): void {
        EventBus.targetOff(this); // 注销事件监听（登记 / 注销 / 天雷 / 回合推进四个入口一并移除）
        if (EnemyManager.instance === this) {
            EnemyManager.instance = null;
        }
        this.aliveEnemies.length = 0; // 场景重载时清空引用，避免残留悬垂引用
    }

    /** ⚡ 天雷消费：随机选一名存活敌人结算直伤；scheduleOnce(0) 出物理回调锁（与 OrbController.hitEnemy 同惯例） */
    private onDamageEnemy(damage: number): void {
        this.prune();
        const pool = this.aliveEnemies.filter((e) => e?.node?.isValid && !e.isDead);
        const target = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
        if (!target) {
            return; // 强制判空（.clinerules）：无存活敌人时落空
        }
        const enemy = target;
        this.scheduleOnce(() => {
            if (enemy.node?.isValid && !enemy.isDead) {
                enemy.takeDamage(damage);
            }
        }, 0);
    }

    /** 🎲 回合推进（物理肉鸽 P2）：一次发射 = 一回合，全体存活敌人同步下落一步（含触底攻城判定）。
     *  快照后遍历 + 双重守卫（isValid / isDead）：advanceDown 触底致死的敌人不再参与本回合推进。 */
    private onTurnAdvance(): void {
        this.prune();
        const list = this.aliveEnemies.slice();
        for (const enemy of list) {
            if (enemy?.node?.isValid && !enemy.isDead) {
                enemy.advanceDown();
            }
        }
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
