import { _decorator, Component, Vec3 } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import type { GameEventMap } from './EventBus';

const { ccclass } = _decorator;

/** 震屏基准强度（px）：shake() 不传参时使用 */
const SHAKE_DEFAULT_INTENSITY = 8;
/** 震屏基准时长（秒） */
const SHAKE_DEFAULT_DURATION = 0.12;

/**
 * 震屏控制器：挂载在 Canvas/Camera 节点上，静态单例 CameraShake.instance。
 * - onLoad 时记录相机原始本地坐标（Canvas 2D 相机通常为 (0, 0, 1000)）；
 * - duration 内每帧产生 ±intensity 随机偏移，幅度随进度线性衰减，
 *   抖动越来越轻，结束时精确复位到原始坐标（平滑复位）；
 * - 自动监听 FIRE_TURRET（重炮）与 ATTACK_CASTLE 触发震动。
 */
@ccclass('CameraShake')
export class CameraShake extends Component {
    /** 单例引用：供外部任意时刻直接调用 */
    static instance: CameraShake | null = null;

    /** 相机原始本地坐标：复位基准（如 (0, 0, 1000)） */
    private readonly _origin = new Vec3();

    private _shaking = false;
    private _elapsed = 0;
    private _duration = SHAKE_DEFAULT_DURATION;
    private _intensity = SHAKE_DEFAULT_INTENSITY;
    /** 模态弹窗免疫锁：弹窗（战后卡牌 / 商店 / 结算）打开期间绝对禁止任何震屏 */
    private _isModalOpen = false;

    protected onLoad(): void {
        CameraShake.instance = this;
        // 以挂载时刻的本地坐标作为原始坐标（Canvas 2D 相机默认 (0, 0, 1000)）
        this._origin.set(this.node.position);
    }

    protected start(): void {
        // 重炮（type 0）开火：猛烈震屏
        EventBus.on(GameEvents.FIRE_TURRET, this.onFireTurret, this);
        // 城堡受击：轻震
        EventBus.on(GameEvents.ATTACK_CASTLE, this.onAttackCastle, this);
        // 城堡爆炸（游戏失败）：大震屏
        EventBus.on(GameEvents.GAME_OVER, this.onGameOver, this);
        // 模态弹窗开关：打开瞬间强制停止震动并复位相机，弹窗期间免疫任何后续震动
        EventBus.on(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
    }

    protected onDisable(): void {
        // 停用即强制复位，防止节点以抖动偏移的状态被缓存/复用
        if (this.node?.isValid) {
            this.node.setPosition(this._origin);
        }
        this._shaking = false;
    }

    protected onDestroy(): void {
        if (CameraShake.instance === this) {
            CameraShake.instance = null;
        }
        EventBus.off(GameEvents.FIRE_TURRET, this.onFireTurret, this);
        EventBus.off(GameEvents.ATTACK_CASTLE, this.onAttackCastle, this);
        EventBus.off(GameEvents.GAME_OVER, this.onGameOver, this);
        EventBus.off(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
        // 销毁前强制复位到原始坐标，杜绝残留抖动偏移
        if (this.node?.isValid) {
            this.node.setPosition(this._origin);
        }
    }

    /** 对外静态入口：任意代码随时可调用；组件未挂载 / 已销毁时静默跳过 */
    public static shake(intensity: number = SHAKE_DEFAULT_INTENSITY, duration: number = SHAKE_DEFAULT_DURATION): void {
        const inst = CameraShake.instance;
        if (!inst?.isValid) {
            return;
        }
        // ★ 模态弹窗免疫锁：弹窗打开期间（商店 / 战后卡牌 / 结算）绝对禁止任何震屏，
        //    杜绝弹窗背后残珠撞钉 / 炮火等继续抖动画面的低劣体验。
        if (inst._isModalOpen) {
            return;
        }
        // 震动打断优化：若当前正处于抖动中，按剩余衰减强度评估——新震动的强度弱于当前剩余
        // 强度时，以剩余强度为准（Math.max），避免强震动被后续弱震动覆盖而突然变轻。
        if (inst._shaking) {
            const t = Math.min(1, inst._elapsed / inst._duration);
            const remainAmp = inst._intensity * (1 - t);
            intensity = Math.max(remainAmp, intensity);
        }
        inst._intensity = Math.max(0, intensity);
        inst._duration = Math.max(0.001, duration);
        inst._elapsed = 0;
        inst._shaking = true;
    }

    /** 炮塔开火：强度随伤害爬升（6~14 / 0.15s），数字越大演出越重。
     *  修复：旧实现判定 d?.type === 0，但 FIRE_TURRET 载荷为 {damage, orbType} 根本没有 type 字段，震屏从未生效过。 */
    private onFireTurret(d: GameEventMap[GameEvents.FIRE_TURRET]): void {
        CameraShake.shake(Math.min(14, 6 + (d?.damage ?? 0) / 100), 0.15);
    }

    /** 城堡受击：强度 6 / 0.1s */
    private onAttackCastle(_d: GameEventMap[GameEvents.ATTACK_CASTLE]): void {
        CameraShake.shake(6, 0.1);
    }

    /** 城堡爆炸（GAME_OVER）：大震屏 16px / 0.45s */
    private onGameOver(): void {
        CameraShake.shake(16, 0.45);
    }

    /** 模态弹窗开关：打开瞬间立即停震并强制复位相机，弹窗期间锁死所有震屏请求；关闭后解锁 */
    private onUiModalChanged(open: boolean): void {
        if (open) {
            this._isModalOpen = true;
            this._shaking = false;
            // 打开瞬间强行把相机拉回原点，杜绝弹窗带着残留抖动偏移弹出
            if (this.node?.isValid) {
                this.node.setPosition(this._origin);
            }
        } else {
            this._isModalOpen = false;
        }
    }

    protected update(dt: number): void {
        if (!this._shaking) {
            return;
        }
        this._elapsed += dt;
        const t = Math.min(1, this._elapsed / this._duration);
        if (t >= 1) {
            // 结束后精确复位到原始坐标，顺带清掉任何残留偏移
            this._shaking = false;
            this.node.setPosition(this._origin);
            return;
        }
        // 幅度 = intensity * (1 - t) 随进度衰减 → 抖动渐变轻，结束自然平滑复位
        const amp = this._intensity * (1 - t);
        const ox = (Math.random() * 2 - 1) * amp;
        const oy = (Math.random() * 2 - 1) * amp;
        this.node.setPosition(this._origin.x + ox, this._origin.y + oy, this._origin.z);
    }
}