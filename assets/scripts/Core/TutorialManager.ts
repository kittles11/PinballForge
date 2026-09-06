import { _decorator, Component, Label, Node, UIOpacity, UITransform, Tween, tween, find } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { Theme } from './ArtTheme';
import type { GameEventMap } from './EventBus';

const { ccclass } = _decorator;

/** 教程完成标记：三步全部触发后写入，之后（含后续局）不再出现 */
const TUTORIAL_DONE_KEY = 'pinballforge_tutorial_done';

/** 第一步瞄准提示延迟（秒）：等首波出怪与场景稳定后再亮出 */
const AIM_HINT_DELAY = 1.5;

/** 短提示停留时长（秒）：第二步 / 第三步展示一段时间后自动淡出 */
const BRIEF_HINT_DURATION = 2.4;

/** 提示条 y 坐标（UILayer 本地坐标）：漏斗区上方、钉板下方 */
const BANNER_Y = -330;

/**
 * 新手三步引导（单例 TutorialManager.instance，RelicManager.ensureMounted 同款自举模式）：
 *  - ① 瞄准：首波 WAVE_START 1.5s 后 → 常驻提示「按住拖拽瞄准，松手发射」，首次开火时淡出；
 *  - ② 开火：首次 FIRE_TURRET → 短提示「漏斗聚能开火！数字越大伤害越高」；
 *  - ③ 守城：首次 ATTACK_CASTLE → 短提示「怪物冲撞城堡会扣血」；
 * 三步全部触发后写 localStorage 完成标记，之后不再打扰。纯代码 Label + UIOpacity 淡入淡出，零 Inspector 配置。
 */
@ccclass('TutorialManager')
export class TutorialManager extends Component {
    /** 单例引用：ensureMounted 挂载后即可用（当前无外部调用方，保留以便后续扩展触发式提示） */
    static instance: TutorialManager | null = null;
    /** 已挂载标记（ensureMounted 幂等守卫） */
    private static _mounted = false;

    private _aimShown = false;
    private _fireShown = false;
    private _attackShown = false;
    /** 当前提示条节点（单槽位：新提示替换旧提示） */
    private _banner: Node | null = null;

    /** 静态自举入口：教程已完成 / 已挂载 / 找不到宿主时静默跳过（挂到 Canvas/UILayer，兜底 Canvas） */
    public static ensureMounted(): void {
        if (TutorialManager._mounted || TutorialManager.instance?.isValid) {
            return;
        }
        try {
            if (localStorage.getItem(TUTORIAL_DONE_KEY) === '1') {
                return;
            }
        } catch (e) { /* 无 localStorage：视为未完成，照常引导 */ }
        const host = find('Canvas/UILayer') ?? find('Canvas');
        if (!host) {
            return;
        }
        TutorialManager._mounted = true;
        host.addComponent(TutorialManager); // 宿主已激活 → onLoad 同步执行并开始监听事件
    }

    protected onLoad(): void {
        TutorialManager.instance = this;
        EventBus.on(GameEvents.WAVE_START, this.onWaveStart, this);
        EventBus.on(GameEvents.FIRE_TURRET, this.onFireTurret, this);
        EventBus.on(GameEvents.ATTACK_CASTLE, this.onAttackCastle, this);
        console.log('[Tutorial] 新手三步引导就绪：瞄准 → 开火 → 守城');
    }

    protected onDestroy(): void {
        if (TutorialManager.instance === this) {
            TutorialManager.instance = null;
        }
        TutorialManager._mounted = false;
        EventBus.targetOff(this);
        if (this._banner?.isValid) {
            this._banner.destroy();
        }
        this._banner = null;
    }

    /** ① 瞄准提示：首波开始 1.5s 后常驻显示，直到首次开火被替换 */
    private onWaveStart(_d: GameEventMap[GameEvents.WAVE_START]): void {
        if (this._aimShown) {
            return;
        }
        this._aimShown = true;
        this.scheduleOnce(() => {
            this.showBanner('按住屏幕拖拽瞄准，松手发射弹珠！', true);
        }, AIM_HINT_DELAY);
    }

    /** ② 开火提示：首次炮塔开火（常驻瞄准条一并被本条替换） */
    private onFireTurret(_d: GameEventMap[GameEvents.FIRE_TURRET]): void {
        if (this._fireShown) {
            return;
        }
        this._fireShown = true;
        this.showBanner('漏斗聚能开火！数字越大伤害越高', false);
        this.tryMarkDone();
    }

    /** ③ 守城提示：怪物首次撞击城堡 */
    private onAttackCastle(_d: GameEventMap[GameEvents.ATTACK_CASTLE]): void {
        if (this._attackShown) {
            return;
        }
        this._attackShown = true;
        this.showBanner('小心！怪物冲撞城堡会扣城防！', false);
        this.tryMarkDone();
    }

    /** 三步齐了 → 写完成标记（仅写一次；后续局 ensureMounted 直接跳过） */
    private tryMarkDone(): void {
        if (!this._aimShown || !this._fireShown || !this._attackShown) {
            return;
        }
        try {
            localStorage.setItem(TUTORIAL_DONE_KEY, '1');
            console.log('[Tutorial] 三步引导完成，写入标记，后续不再显示');
        } catch (e) {
            console.warn('[Tutorial] 完成标记写入失败（下次仍会显示引导）', e);
        }
    }

    /**
     * 显示提示条：单槽位复用（新提示替换旧提示）。
     * persistent=true 常驻（第一步瞄准）；false 展示 BRIEF_HINT_DURATION 秒后自动淡出。
     */
    private showBanner(text: string, persistent: boolean): void {
        if (this._banner?.isValid) {
            Tween.stopAllByTarget(this._banner);
            const oldOpacity = this._banner.getComponent(UIOpacity);
            if (oldOpacity) {
                Tween.stopAllByTarget(oldOpacity);
            }
            this._banner.destroy();
            this._banner = null;
        }
        const host = this.node;
        if (!host?.isValid) {
            return;
        }
        const node = new Node('TutorialBanner');
        node.layer = host.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
        node.addComponent(UITransform);
        node.addComponent(UIOpacity);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = 26;
        label.lineHeight = 32;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.color = Theme.white;
        node.setPosition(0, BANNER_Y, 0);
        host.addChild(node);
        this._banner = node;
        // 淡入
        const opacity = node.getComponent(UIOpacity);
        if (opacity) {
            opacity.opacity = 0;
            tween(opacity).to(0.25, { opacity: 255 }).start();
        }
        // 非常驻提示到时自动淡出（scheduleOnce 随组件销毁自动清理，node 失效由 hideBanner 守卫）
        if (!persistent) {
            this.scheduleOnce(() => this.hideBanner(node), BRIEF_HINT_DURATION);
        }
    }

    /** 淡出并销毁指定提示条（若已不是当前条 / 已失效则跳过） */
    private hideBanner(node: Node): void {
        if (this._banner !== node || !node?.isValid) {
            return;
        }
        this._banner = null;
        const opacity = node.getComponent(UIOpacity);
        if (opacity) {
            tween(opacity)
                .to(0.3, { opacity: 0 })
                .call(() => node.destroy())
                .start();
        } else {
            node.destroy();
        }
    }
}