import { EventTarget } from 'cc';
import type { Vec2Like, WaveDef, OrbType, RelicType, FunnelType, EnemyType } from './DataModels';
import type { EnemyController } from '../Battle/EnemyController';

/** 全局事件名 */
export enum GameEvents {
    /** 珠子撞中钉子 */
    ORB_HIT_PEG = 'ORB_HIT_PEG',
    /** 珠子滚入漏斗（回收 / 重发） */
    ORB_ENTER_FUNNEL = 'ORB_ENTER_FUNNEL',
    /** 弹珠累计能量实时更新（顶部 Label 刷新） */
    UPDATE_ENERGY = 'UPDATE_ENERGY',
    /** 炮塔开火 */
    FIRE_TURRET = 'FIRE_TURRET',
    /** 怪物攻击城堡（载荷含伤害值） */
    ATTACK_CASTLE = 'ATTACK_CASTLE',
    /** 金币增加 */
    GAIN_GOLD = 'GAIN_GOLD',
    /** 一波开始（载荷为该波真实生成配置 WaveDef） */
    WAVE_START = 'WAVE_START',
    /** 敌人被击杀（通知波次管理器结算） */
    ENEMY_KILLED = 'ENEMY_KILLED',
    /** 🦠 史莱姆死亡分裂请求：EnemyController 发起，WaveManager 生成小怪并把本波总数 +count */
    ENEMY_SPLIT = 'ENEMY_SPLIT',
    /** 游戏结束 */
    GAME_OVER = 'GAME_OVER',
    /** 全部波次通关 */
    GAME_VICTORY = 'GAME_VICTORY',
    /** 展示战后卡牌奖励弹窗 */
    SHOW_REWARDS = 'SHOW_REWARDS',
    /** 展示流浪商人商店（选完战后卡牌奖励后自动进入，供金币消费） */
    SHOW_SHOP = 'SHOW_SHOP',
    /** 卡牌奖励已选择（通知波次管理器继续下一波） */
    REWARD_SELECTED = 'REWARD_SELECTED',
    /** 模态弹窗状态切换（true 打开 / false 关闭）：打开期间 LauncherController 冻结发射弹珠 */
    UI_MODAL_CHANGED = 'UI_MODAL_CHANGED',
    /** 遗物集合变化（新增 / 重置）：载荷为当前全部遗物，顶部遗物栏实时刷新 */
    RELIC_CHANGED = 'RELIC_CHANGED',
    /** 新增了一枚遗物（商店购买成功）：载荷为该遗物类型 */
    RELIC_ACQUIRED = 'RELIC_ACQUIRED',
    /** 打开 🎒 牌库与遗物背包弹窗（DeckButtonController 发起，DeckViewDialog 监听展示） */
    SHOW_DECK_VIEW = 'SHOW_DECK_VIEW',
    /** 打开 📋 每日任务面板（DailyTaskBadge 徽章发起，DailyTaskDialog 监听展示） */
    SHOW_DAILY_TASKS = 'SHOW_DAILY_TASKS',
    /** 敌人入场登记（EnemyController start 广播）：EnemyManager 监听登记，解除与 EnemyController 互相导入的循环引用 */
    ENEMY_SPAWNED = 'ENEMY_SPAWNED',
    /** 敌人销毁注销（EnemyController onDestroy 广播）：EnemyManager 监听即时移除列表引用 */
    ENEMY_REMOVED = 'ENEMY_REMOVED',
}

/** 事件 → 载荷 的映射。新增事件时只需在这里登记一次。 */
export interface GameEventMap {
    [GameEvents.ORB_HIT_PEG]: { pegId: string; orbId: string; points: number; hitCount: number };
    [GameEvents.ORB_ENTER_FUNNEL]: { orbId: string; funnelId: string };
    [GameEvents.UPDATE_ENERGY]: number;
    /** 炮塔开火（funnelType：入槽漏斗类型，Boss「破阵坚盾」剥盾判定用；可选字段向后兼容） */
    [GameEvents.FIRE_TURRET]: { damage: number; orbType: OrbType; funnelType?: FunnelType };
    [GameEvents.ATTACK_CASTLE]: { damage: number };
    [GameEvents.GAIN_GOLD]: { amount: number; total?: number };
    [GameEvents.WAVE_START]: { config: WaveDef };
    [GameEvents.ENEMY_KILLED]: EnemyController;
    /** 分裂/召唤请求：史莱姆死亡分裂（默认）；summon=true 时为 Boss「君王诏令」亲卫召唤（Normal 模板 + 死亡掉金币） */
    [GameEvents.ENEMY_SPLIT]: { x: number; y: number; count: number; hp: number; speed: number; summon?: boolean; goldDrop?: number; spawnType?: EnemyType };
    [GameEvents.GAME_OVER]: void;
    [GameEvents.GAME_VICTORY]: void;
    [GameEvents.SHOW_REWARDS]: void;
    [GameEvents.SHOW_SHOP]: void;
    [GameEvents.REWARD_SELECTED]: void;
    [GameEvents.UI_MODAL_CHANGED]: boolean;
    [GameEvents.RELIC_CHANGED]: RelicType[];
    [GameEvents.RELIC_ACQUIRED]: RelicType;
    [GameEvents.SHOW_DECK_VIEW]: void;
    [GameEvents.SHOW_DAILY_TASKS]: void;
    [GameEvents.ENEMY_SPAWNED]: EnemyController;
    [GameEvents.ENEMY_REMOVED]: EnemyController;
}

/** 监听器签名：无参事件（payload void）为 `() => void`，有参事件强制校验载荷类型 */
type Listener<P> = P extends void ? () => void : (payload: P) => void;

/** 对 cc.EventTarget 的类型安全薄封装 */
class GameEventBus {
    private readonly _target = new EventTarget();

    on<K extends GameEvents>(type: K, cb: Listener<GameEventMap[K]>, thisArg?: unknown): void {
        this._target.on(type as string, cb as (...args: any[]) => void, thisArg);
    }

    once<K extends GameEvents>(type: K, cb: Listener<GameEventMap[K]>, thisArg?: unknown): void {
        this._target.once(type as string, cb as (...args: any[]) => void, thisArg);
    }

    off<K extends GameEvents>(type: K, cb?: Listener<GameEventMap[K]>, thisArg?: unknown): void {
        this._target.off(type as string, cb as (...args: any[]) => void, thisArg);
    }

    /**
     * 派发事件：无参事件（如 GAME_OVER / SHOW_REWARDS）无需传参；
     * 有参事件（如 FIRE_TURRET / ATTACK_CASTLE）强制校验载荷类型，缺参/错类型报编译错误。
     */
    emit<K extends GameEvents>(type: K, ...args: GameEventMap[K] extends void ? [] : [payload: GameEventMap[K]]): void {
        this._target.emit(type as string, ...args);
    }

    /** 移除指定 target 注册的全部监听（组件 onDestroy 时调用） */
    targetOff(target: unknown): void {
        this._target.targetOff(target);
    }
}

/** 全局单例事件总线 */
export const EventBus = new GameEventBus();