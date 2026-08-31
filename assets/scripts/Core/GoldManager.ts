import { _decorator, Component } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { MetaManager } from './MetaManager';

const { ccclass } = _decorator;

/**
 * 金币管理器（单例 GoldManager.instance）：对局内金币数据与全局事件接线。
 * 挂载在 Canvas/UILayer 或 GameManager 等常驻节点上。
 * 职责：
 *  - 维护 currentGold（初始 0），提供 addGold / getGold 读写接口；
 *  - 监听 GAIN_GOLD 事件自动累加金币并打印日志；
 *  - resetGold() 供 ResultDialog 再来一局时清零，新一局从 0 开始。
 */
@ccclass('GoldManager')
export class GoldManager extends Component {
    /** 单例引用：供 UI / 结算等系统直接调用 */
    static instance: GoldManager | null = null;

    /** 当前金币总数（初始 0） */
    currentGold = 0;

    protected onLoad(): void {
        GoldManager.instance = this;
        // ⚒ meta 永久升级「开局资金」：新局起始金币（普通开局与此处、重开 resetGold 共用同一加成值）
        this.currentGold = MetaManager.getGoldBonus();
    }

    protected onDestroy(): void {
        EventBus.targetOff(this);
        if (GoldManager.instance === this) {
            GoldManager.instance = null;
        }
    }

    /** 增加金币 */
    public addGold(amount: number): void {
        if (!Number.isFinite(amount) || amount <= 0) {
            return;
        }
        this.currentGold += amount;
        console.log(`[Gold] 金币 +${amount}，当前 ${this.currentGold}`);
        // ★ 立即广播，载荷携带 total 最新总数：UI 用 total 实时刷新，规避读取 currentGold 的时序差
        EventBus.emit(GameEvents.GAIN_GOLD, { amount, total: this.currentGold });
    }

    /**
     * 消费金币（商店购买）：扣减并广播 GAIN_GOLD（携带 total，顶部金币 Label / 商店 Label 实时刷新）。
     * 金币不足或参数非法（<=0）时不扣减，返回 false。
     */
    public spendGold(amount: number): boolean {
        if (amount <= 0 || this.currentGold < amount) {
            return false;
        }
        this.currentGold -= amount;
        console.log(`[Gold] 金币 -${amount}，当前 ${this.currentGold}`);
        // 与 addGold 同通道广播（携带 total，onGainGold 因 total 已定义不会二次累加）
        EventBus.emit(GameEvents.GAIN_GOLD, { amount: -amount, total: this.currentGold });
        return true;
    }

    /** 获取当前金币 */
    public getGold(): number {
        return this.currentGold;
    }

    /** 新开局重置金币：回到「开局资金」起始值（0 + meta 开局资金加成；ResultDialog 再来一局时调用） */
    public resetGold(): void {
        this.currentGold = MetaManager.getGoldBonus();
        console.log(`[Gold] 金币已重置为开局资金 ${this.currentGold}`);
    }
}
