import {
    _decorator, Component, Node, find, director, Director,
} from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { RelicType, RELIC_DATABASE, ALL_RELIC_TYPES } from './DataModels';
import { RelicBarController } from '../UI/RelicBarController';

const { ccclass } = _decorator;

/** 高能烈药：爆炸钉爆炸半径强制下限（px） */
export const HIGH_EXPLOSIVE_RADIUS = 180;
/** 荆棘要塞：怪物撞城的一击反弹伤害 */
export const THORN_REFLECT_DAMAGE = 35;
/** 王者之冕：通关关卡结算时额外获得的要塞护盾值 */
export const CROWN_SHIELD_AMOUNT = 15;
/** 王者之冕：通关关卡结算时额外获得的金币数 */
export const CROWN_GOLD_AMOUNT = 30;
/** 潮汐镀金：每波开始时镀金为乘倍钉的普通钉数量 */
export const TIDAL_GILD_COUNT = 2;

// 复用 DataModels 中的数据表：顶部遗物栏 / 商店按钮共用（单价统一 130 金币）
export interface RelicInfo {
    name: string;
    icon: string;
    desc: string;
    price: number;
}

/** 全部遗物的展示信息（无 cc 依赖的纯展示数据，来源为 RELIC_DATABASE） */
export const RELIC_INFO: Record<RelicType, RelicInfo> = RELIC_DATABASE;

/** 全部遗物（商店展示顺序） */
export { ALL_RELIC_TYPES };

/**
 * 遗物持有上限（数据侧唯一真源）：遗物种类天然唯一（同种不可重复），
 * 上限即全表数量——藏宝箱只从未拥有遗物中抽取，抽尽即空池（RewardDialog 已做
 * 空池回退常规三选一，杜绝无可点卡软锁）。规则对玩家可见：遗物栏占位与背包均展示 x/5。
 */
export const MAX_RELICS = ALL_RELIC_TYPES.length;

/** 遗物栏锚点 Y 坐标（px）：钉在 HUD 两行（606/562）下方、怪物走廊（480）之上，不遮挡能量/波次行 */
const RELIC_BAR_Y = 514;

/**
 * 肉鸽被动遗物全局逻辑组件（全局静态单例 + 场景可反序列化）。
 *
 * 设计说明（修复 Missing class 的关键）：
 *  - 场景 MainScene 的 RelicBar 节点上挂有多个 RelicManager 组件实例（脚本 uuid
 *    反序列化引用），因此 RelicManager 必须是一个 @ccclass 注册的 Component，
 *    否则场景加载时报 Missing class；
 *  - 遗物数据必须在所有实例间全局唯一，故 ownedRelics 与全部方法声明为 static，
 *    即使节点上反序列化出多个实例也不会数据错乱；
 *  - 现有代码全部以静态式调用（RelicManager.addRelic / hasRelic / getRelics /
 *    resetRelics / effectiveBombRadius），static 签名与之完全兼容；
 *  - 自举：监听场景启动事件，把 RelicBarController 组件幂等挂到
 *    Canvas/UILayer/RelicBar 节点（单向依赖：本文件 → 视图；初始数据经 RELIC_CHANGED 事件回推）。
 *
 * 职责：
 *  - 维护已获得遗物集合（每种唯一，重开前常驻）；
 *  - 提供 getRelics / hasRelic / resetRelics 供宿主系统查询与结算；
 *  - 被动效果触发：由各自宿主系统查询 hasRelic 生效（黄金矿工在 OrbController、
 *    高能烈药在 PegComponent、荆棘要塞在 EnemyController、潮汐镀金在 PegBoardManager /
 *    王者之冕在结算流程）。
 */
@ccclass('RelicManager')
export class RelicManager extends Component {
    /** 最近挂载的单例实例（静态数据唯一，多实例共享；主要为兼容旧式 .instance 访问） */
    public static instance: RelicManager | null = null;

    /** 已获得的遗物集合（每种唯一，全局常驻被动，重开前生效；static 保证多实例共享） */
    public static ownedRelics: Set<RelicType> = new Set();

    /** 场景启动自举是否已注册（只注册一次，避免多个实例重复监听） */
    private static _bootstrapped = false;

    /** 本实例是否为节点上的主实例（非主实例不持有任何全局状态，销毁时不得清理主实例的注册） */
    private _isPrimary = false;

    protected onLoad(): void {
        // 场景历史遗留：RelicBar 节点上序列化出数十个重复 RelicManager 实例。
        // 仅节点上的首个实例为主实例；其余立即自我销毁，避免多实例互相抢
        // instance / _bootstrapped 静态标志（任一非主实例 onDestroy 复位标志会让遗物栏自举失效）。
        if (this.node.getComponent(RelicManager) !== this) {
            this.destroy();
            return;
        }
        this._isPrimary = true;
        RelicManager.instance = this;
        if (!RelicManager._bootstrapped) {
            RelicManager._bootstrapped = true;
            // 顶部遗物栏全局自举：每个场景启动后确保 RelicBar 已挂载（新局重载时也会重建）
            director.on(Director.EVENT_AFTER_SCENE_LAUNCH, RelicManager.ensureMounted, this);
        }
    }

    protected onDestroy(): void {
        if (!this._isPrimary) {
            return;
        }
        if (RelicManager.instance === this) {
            RelicManager.instance = null;
        }
        EventBus.targetOff(this);
        if (RelicManager._bootstrapped) {
            RelicManager._bootstrapped = false;
            director.off(Director.EVENT_AFTER_SCENE_LAUNCH, RelicManager.ensureMounted, this);
        }
    }

    /** 获得一枚遗物（同种重复获得返回 false；全表收集满后同样拒绝——上限规则唯一守卫点） */
    public static addRelic(type: RelicType): boolean {
        if (RelicManager.ownedRelics.has(type)) {
            return false;
        }
        if (RelicManager.ownedRelics.size >= MAX_RELICS) {
            console.warn(`[Relic] 遗物已满 ${MAX_RELICS}/${MAX_RELICS}，拒绝再获得：${type}`);
            return false;
        }
        RelicManager.ownedRelics.add(type);
        const info = RELIC_INFO[type];
        console.log(`[Relic] 获得遗物：${info.icon} ${info.name}（${info.desc}）`);
        EventBus.emit(GameEvents.RELIC_ACQUIRED, type);
        EventBus.emit(GameEvents.RELIC_CHANGED, RelicManager.getRelics());
        RelicManager.ensureMounted();
        return true;
    }

    /** 是否已拥有指定遗物 */
    public static hasRelic(type: RelicType): boolean {
        return RelicManager.ownedRelics.has(type);
    }

    /** 当前已拥有的全部遗物（数组快照） */
    public static getRelics(): RelicType[] {
        return [...RelicManager.ownedRelics];
    }

    /** 重开新局时清空全部遗物（ResultDialog 重载场景前调用），遗物仅在单局内生效 */
    public static resetRelics(): void {
        if (RelicManager.ownedRelics.size === 0) {
            return;
        }
        RelicManager.ownedRelics.clear();
        console.log('[Relic] 遗物已全部重置（新局从 0 开始）');
        EventBus.emit(GameEvents.RELIC_CHANGED, []);
    }

    /** 高能烈药被动：返回生效的爆炸钉半径（持有则强制 ≥ 180px，否则原样返回） */
    public static effectiveBombRadius(baseRadius: number): number {
        return RelicManager.hasRelic(RelicType.HighExplosive)
            ? Math.max(baseRadius, HIGH_EXPLOSIVE_RADIUS)
            : baseRadius;
    }

    /** 顶部遗物栏自举：幂等地把 RelicBar 组件挂到 Canvas/UILayer/RelicBar 节点 */
    public static ensureMounted(): void {
        const uiLayer = find('Canvas/UILayer');
        if (!uiLayer || !uiLayer.isValid) {
            return;
        }
        let barNode = uiLayer.getChildByName('RelicBar');
        if (!barNode?.isValid) {
            barNode = new Node('RelicBar');
            barNode.layer = uiLayer.layer;
            uiLayer.addChild(barNode);
            // 仅新建时钉位：场景已存在的 RelicBar 由 RelicBarController.onLoad 自钉，
            // 此处若无条件 setPosition 会在场景启动后覆盖控制器钉出的两行式 HUD 位置（曾把遗物栏顶回 HUD 行造成遮挡）
            barNode.setPosition(0, RELIC_BAR_Y, 0);
        }
        if (!barNode.getComponent(RelicBarController)) {
            barNode.addComponent(RelicBarController);
        }
        // 挂载后广播一次当前遗物集合：遗物栏初始渲染完全由 RELIC_CHANGED 事件驱动，
        // 与 RelicBarController 保持单向依赖（本文件 → 视图），杜绝互相导入的循环引用。
        EventBus.emit(GameEvents.RELIC_CHANGED, RelicManager.getRelics());
    }
}
