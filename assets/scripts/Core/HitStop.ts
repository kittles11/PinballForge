/**
 * 全局顿帧（HitStop）：命中重演瞬间短暂冻结 2D 物理步进，制造「打击停顿」手感。
 *
 * 原理：Cocos 无全局 timeScale，直接暂停 director 会连 UI/特效一起僵死；
 * 这里只关 PhysicsSystem2D.enable——弹珠/敌人瞬间定格，而震屏、闪光、跳字继续演出，
 * 恰好是动作游戏 hit-stop 的标准表现（画面停住、反馈还在放）。
 *
 * 护栏：
 *  - 模态弹窗打开期间拒绝触发（与 CameraShake/FxManager 同款免疫锁）；
 *  - 重叠触发取剩余时间更长的一方（与 CameraShake 强度合并策略同思路），绝不叠加延长；
 *  - 时长钳制 20~110ms：顿帧是调味不是主菜，超过 0.1s 的「卡顿感」是负体验；
 *  - 恢复走 scheduleOnce（挂自举节点），场景销毁/热重载也不会留下永久冻结。
 *
 * 自举范式与 FxManager 一致：静态门面 HitStop.stop(...)，首次访问惰性自建宿主节点。
 */
import { _decorator, Component, Director, director, find, Node, PhysicsSystem2D, UITransform } from 'cc';
import { EventBus, GameEvents } from './EventBus';

const { ccclass } = _decorator;

/** 顿帧时长下限（ms）：再短感知不到，白付调度成本 */
const DURATION_MIN_MS = 20;
/** 顿帧时长上限（ms）：手感红线，超过即「卡顿」 */
const DURATION_MAX_MS = 110;
/** 重炮开火顿帧（ms）：与 CameraShake 的开火震屏同源触发，形成「轰」的打击组合拳 */
const TURRET_FIRE_STOP_MS = 40;

@ccclass('HitStop')
export class HitStop extends Component {
    private static _instance: HitStop | null = null;
    /** 模态弹窗免疫锁 */
    private _modalOpen = false;
    /** 当前冻结剩余（ms）：0 = 未冻结 */
    private _remainMs = 0;
    /** 冻结前的物理系统开关状态（恢复用） */
    private _wasEnabled = true;

    public static get instance(): HitStop | null {
        if (this._instance?.isValid) {
            return this._instance;
        }
        const host = find('Canvas/UILayer') ?? find('Canvas');
        if (!host) {
            return null;
        }
        // 热重载防御：优先复用已存在的宿主节点（编辑器脚本热更会让 _instance 失效，
        // 无复用则每次热更都新建一个宿主节点并被编辑器序列化回场景——曾堆出 11 个）
        let node = host.getChildByName('HitStopHost');
        if (!node?.isValid) {
            node = new Node('HitStopHost');
            node.layer = host.layer;
            node.addComponent(UITransform);
            host.addChild(node);
        }
        const comps = node.getComponents(HitStop);
        for (let i = 1; i < comps.length; i++) {
            comps[i].destroy();
        }
        this._instance = comps[0] ?? node.addComponent(HitStop);
        return this._instance;
    }

    /** setter 必须与 getter 成对（onLoad 回写 this；FxManager 同款范式）——只读 getter 会让 addComponent 派发的 onLoad 直接抛 TypeError */
    public static set instance(value: HitStop | null) {
        this._instance = value;
    }

    protected onLoad(): void {
        HitStop.instance = this;
        EventBus.on(GameEvents.FIRE_TURRET, this.onFireTurret, this);
        EventBus.on(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
    }

    protected onDestroy(): void {
        if (HitStop._instance === this) {
            HitStop._instance = null;
        }
        EventBus.off(GameEvents.FIRE_TURRET, this.onFireTurret, this);
        EventBus.off(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
        this.restorePhysics();
        this._remainMs = 0;
    }

    /** 重炮开火：短促顿帧强化「炮弹出膛」重量感（伤害再大也是 40ms，重演交给震屏/闪光分层） */
    private onFireTurret(_d: unknown): void {
        HitStop.stop(TURRET_FIRE_STOP_MS);
    }

    private onUiModalChanged(open: boolean): void {
        this._modalOpen = open === true;
        // 弹窗打开瞬间立即恢复物理（防止顿帧横跨弹窗边界，冻结了商店背后的结算演出）
        if (open) {
            this.restorePhysics();
            this._remainMs = 0;
        }
    }

    /** 幂等自举入口（模块级自举与静态访问共用）：返回实例，场景未就绪时为 null */
    public static ensureMounted(): HitStop | null {
        return HitStop.instance;
    }

    /**
     * 触发一次顿帧（静态门面）。
     * @param ms 冻结时长，内部钳制 [20, 110]ms；弹窗期 / 组件未就绪时静默跳过
     */
    public static stop(ms: number = 40): void {
        const inst = HitStop.instance;
        if (!inst?.isValid || inst._modalOpen) {
            return;
        }
        const want = Math.max(DURATION_MIN_MS, Math.min(DURATION_MAX_MS, ms));
        // 重叠触发：取剩余更长的一方（顿帧中的补刀不刷新冻结，避免连击拖成幻灯片）
        if (inst._remainMs > 0) {
            inst._remainMs = Math.max(inst._remainMs, want);
            return;
        }
        const sys = HitStop.physicsSystem();
        if (!sys) {
            return;
        }
        inst._wasEnabled = sys.enable;
        if (!inst._wasEnabled) {
            return; // 物理已被别处关闭（如结算收尾），不去抢开关
        }
        sys.enable = false;
        inst._remainMs = want;
        inst.scheduleOnce(() => inst.tick(), want / 1000);
    }

    /** 冻结到期恢复（scheduleOnce 回调） */
    private tick(): void {
        this._remainMs = 0;
        this.restorePhysics();
    }

    /** 恢复物理步进（幂等） */
    private restorePhysics(): void {
        const sys = HitStop.physicsSystem();
        if (sys && this._wasEnabled) {
            sys.enable = true;
        }
    }

    /** 物理系统取用兜底：个别平台/裁剪配置下可能为空，全部调用点走此入口 */
    private static physicsSystem(): PhysicsSystem2D | null {
        try {
            return PhysicsSystem2D.instance ?? null;
        } catch {
            return null;
        }
    }
}

// ---------- 模块级自举（与 BackdropFx 同款范式：场景启动后挂载，保证 FIRE_TURRET 监听就位） ----------
director.on(Director.EVENT_AFTER_SCENE_LAUNCH, HitStop.ensureMounted, HitStop);
HitStop.ensureMounted();
