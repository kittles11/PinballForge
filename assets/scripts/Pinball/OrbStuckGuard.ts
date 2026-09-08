/**
 * OrbStuckGuard（Task 006 拆分自 OrbController）：弹珠「卡球三重保底」的独立看护——
 *  ① 低速顶开：速度低于 STUCK_SPEED_THRESHOLD 持续 STUCK_TIMEOUT 秒 → 斜上脉冲顶开；
 *  ② 递进力度：顶开力度随失败次数递增（1x→2x→3x），重质熔岩球（密度 ×2）也顶得开；
 *  ③ 强制结算：连顶 STUCK_MAX_BUMPS 次仍卡 → 判定彻底死锁直接入槽结算；另有
 *     ORB_MAX_ALIVE 秒最大存活保底，防无限弹跳软死锁。
 *
 * 与 OrbController 解耦：强制结算经 onSettle 回调（OrbController 挂载时注入
 * triggerFunnelAndDestroy 包装），本文件不 import OrbController —— Pinball 目录内
 * 互相 import 曾形成循环引用（见 OrbController 文件头 FunnelSlotLike 同款动机）。
 * 入槽 / 销毁流程开始后由 OrbController 调 suspend() 停止检测（原 update 内
 * _funnelEntered 守卫的等价物，杜绝 1 帧销毁延迟窗口内继续施加脉冲）。
 */
import { _decorator, Component, RigidBody2D, Vec2 } from 'cc';

const { ccclass } = _decorator;

/** 卡球判定速度阈值（px/s）：低于该值视为静止 / 卡在钉子上 */
const STUCK_SPEED_THRESHOLD = 15;
/** 卡球计时阈值（秒）：达到后施加斜上脉冲顶开 */
const STUCK_TIMEOUT = 1.8;
/** 顶开脉冲：x 随机 ±200 幅度（400 跨距），y 固定 300 斜上（力度随顶开失败次数递增） */
const STUCK_IMPULSE_X = 400;
const STUCK_IMPULSE_Y = 300;
/** 连顶该次数仍卡死 → 判定彻底死锁，直接入槽结算销毁（比 ORB_MAX_ALIVE 保底更早腾出发射槽位） */
const STUCK_MAX_BUMPS = 3;
/** 弹珠最大存活时长（秒）：超过后强制入槽结算销毁，防无限弹跳软死锁 */
const ORB_MAX_ALIVE = 12;

@ccclass('OrbStuckGuard')
export class OrbStuckGuard extends Component {
    /** 强制结算回调：OrbController 挂载时注入（triggerFunnelAndDestroy 包装）；未注入时顶开仍生效 */
    public onSettle: (() => void) | null = null;

    /** 卡球计时器（秒）：速度低于阈值时累计；达到 STUCK_TIMEOUT 后施加斜上脉冲顶开 */
    private _stuckTimer = 0;
    /** 顶开失败累计：力度随次数递增（1x→2x→3x，重质熔岩球也顶得开）；达 STUCK_MAX_BUMPS 仍卡 → 强制结算 */
    private _stuckBumps = 0;
    /** 存活计时器（秒）：场上超 ORB_MAX_ALIVE 秒强制结算销毁，防无限弹跳软死锁 */
    private _aliveTimer = 0;
    /** 已入槽 / 进入销毁流程：停止全部检测（OrbController.triggerFunnelAndDestroy 调 suspend） */
    private _suspended = false;

    /** 停止看护（入槽结算 / 销毁流程开始后调用，幂等） */
    public suspend(): void {
        this._suspended = true;
    }

    protected update(dt: number): void {
        if (this._suspended || !this.node?.isValid) {
            return;
        }
        const rb = this.getComponent(RigidBody2D);
        // 防卡死：速度极慢（静止 / 卡在钉子上）累计卡球计时，超时施加斜上脉冲顶开。
        // 递进式顶开：力度随失败次数升级（1x→2x→3x），重质熔岩球（密度 ×2）也能被顶开；
        // 连顶 STUCK_MAX_BUMPS 次仍卡 → 判定彻底死锁，直接入槽结算销毁，尽早腾出发射槽位。
        const v = rb?.linearVelocity;
        const speed = v ? v.length() : 0;
        if (speed < STUCK_SPEED_THRESHOLD) {
            this._stuckTimer += dt;
            if (this._stuckTimer >= STUCK_TIMEOUT) {
                this._stuckTimer = 0;
                if (this._stuckBumps >= STUCK_MAX_BUMPS) {
                    console.log(`[OrbStuckGuard] ${this.node.name} 连顶 ${this._stuckBumps} 次仍卡死，强制入槽结算腾位`);
                    this.onSettle?.();
                    return;
                }
                this._stuckBumps++;
                const boost = this._stuckBumps; // 第 1 次 1x（原有力度），失败后 2x、3x 递增
                if (rb) {
                    rb.applyLinearImpulseToCenter(
                        new Vec2((Math.random() - 0.5) * STUCK_IMPULSE_X * boost, STUCK_IMPULSE_Y * boost),
                        true,
                    );
                    console.log(`[OrbStuckGuard] ${this.node.name} 检测到卡死，第 ${this._stuckBumps} 次斜上顶开（力度 ×${boost}）`);
                }
            }
        } else {
            this._stuckTimer = 0; // 恢复运动即清零，避免累计误判
            this._stuckBumps = 0; // 真正恢复运动后递进力度也归位
        }
        // 最大存活保底：场上超 ORB_MAX_ALIVE 秒强制入槽结算销毁，防无限弹跳软死锁
        this._aliveTimer += dt;
        if (this._aliveTimer >= ORB_MAX_ALIVE) {
            console.log(`[OrbStuckGuard] ${this.node.name} 超时 ${ORB_MAX_ALIVE}s 未入槽，强制结算销毁（防无限弹跳）`);
            this.onSettle?.();
        }
    }
}
