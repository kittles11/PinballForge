/**
 * 发射器（2026-09-08 反向深渊改版）：玩家手指拖拽瞄准、松手发射，从屏幕底部向上打出弹珠。
 *
 * 设计要点（用户拍板）：
 *  - 发射角度 100% 贴合拖拽瞄准线：发射向量 = (触点 - 发射座) 归一化，全程零 Math.random、
 *    零扇区外插——松手瞬间所见即所得（随机角改版 [-165°,-15°] 滚角随布局反转一并退役）；
 *  - 布局反转：弹射座从顶部 (0, 510) 迁往屏底（onLoad 兜底：y ≥ 0 即仍留在上半屏时
 *    强制 (0, -560)，漏斗吞球区 -380 之下，拖拽向上不被漏斗横杆遮挡）；
 *  - 纯拖拽发射：全局 input TOUCH_END 释放发射，不再依赖任何 Button click 回调
 *    （「发 射」按钮整套链路随随机角改版一并退役）；太短（< MIN_AIM_LENGTH，含屏底
 *    牌库文字轻点呼出背包）或朝下的触摸不发射；
 *  - 弹窗互斥（UI_MODAL_CHANGED / GAME_OVER + 现实同步）与连发冷却（launchCooldown）沿用；
 *  - DOM 级 R 键逃生门保留（输入系统整体坏死时强制重载场景的唯一自救手段）。
 */
import {
    _decorator, Component, Node, Prefab, Vec2, Vec3,
    input, Input, EventTouch, instantiate, director, RigidBody2D,
} from 'cc';
import { DeckManager } from '../Core/DeckManager';
import { EventBus, GameEvents } from '../Core/EventBus';
import { anyModalOpen } from '../Core/ModalGate';
import { OrbController } from '../Pinball/OrbController';
import { OrbBalance } from '../Core/OrbBalance';
import { OrbType } from '../Core/DataModels';

const { ccclass, property } = _decorator;

/** 手指距发射点小于该值（px）视为无效瞄准（轻点误触，不发射） */
const MIN_AIM_LENGTH = 15;
/** 发射座兜底落位（UILayer 局部坐标，锁定 720×1280 画布）：屏底漏斗吞球区之下 */
const LAUNCHER_BOTTOM_Y = -560;

/**
 * 发射器：拖拽瞄准发射。orbPrefab / launcherNode / launchSpeed / launchCooldown
 * 沿用场景既有接线；按钮自举 / 按压手感 / 随机滚角随发射改版一并退役。
 */
@ccclass('LauncherController')
export class LauncherController extends Component {
    @property({ type: Prefab })
    orbPrefab: Prefab | null = null;

    @property({ type: Node })
    launcherNode: Node | null = null;

    @property
    launchSpeed = 1500;

    /** 发射冷却（秒）：拖拽松手连发节流（原按钮连点节流平移到释放手势） */
    @property
    launchCooldown = 0.25;

    /** 模态互斥镜像（UI_MODAL_CHANGED / GAME_OVER 同步 + 现实纠偏） */
    private _modalOpen = false;
    /** 上次发射时刻（秒）：冷却节流基准 */
    private _lastLaunchTime = 0;
    /** 复用暂存：弹珠出生点（世界坐标） */
    private readonly _tmpWorld = new Vec3();

    protected onLoad(): void {
        if (!this.launcherNode) {
            this.launcherNode = this.node;
        }
        // 布局反转兜底：反向深渊里弹珠从屏底向上打，发射座绝不能留在上半屏
        //（场景烘焙 (0, 510) 的旧坐标、拖动错的都拉回屏底漏斗之下）
        if (this.launcherNode.position.y >= 0) {
            this.launcherNode.setPosition(0, LAUNCHER_BOTTOM_Y, 0);
        }
        EventBus.on(GameEvents.UI_MODAL_CHANGED, this.onUiModalChanged, this);
        EventBus.on(GameEvents.GAME_OVER, this.onGameOver, this);
        // DOM 级逃生门（绕过引擎输入系统）：按 R 强制重开一局——输入系统整体坏死时唯一的自救手段
        if (typeof window !== 'undefined' && !(window as any).__pfPanicKey) {
            (window as any).__pfPanicKey = true;
            window.addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key === 'r' || e.key === 'R') {
                    console.log('[诊断] 逃生键 R：强制重载场景');
                    director.loadScene(director.getScene()?.name || 'MainScene');
                }
            });
        }
        // 拖拽瞄准发射：全局监听松手（发射无按钮，全屏任意位置拖拽后松手即发射）
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    }

    protected onDestroy(): void {
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        EventBus.targetOff(this);
    }

    private onUiModalChanged(open: boolean): void {
        this.syncModalOpen(open);
    }

    private onGameOver(): void {
        this.syncModalOpen(true);
    }

    /** 模态现实同步：镜像说开但实际弹窗全关 → 自愈复位（历史 missed-false 卡死教训） */
    private syncModalOpen(open: boolean): void {
        this._modalOpen = open === true;
        if (this._modalOpen && !anyModalOpen()) {
            this._modalOpen = false;
        }
    }

    /**
     * 拖拽瞄准发射（唯一发射入口）：TOUCH_END 松手时以「触点 - 发射座」为发射向量。
     * 太短（< MIN_AIM_LENGTH）= 轻点误触（含牌库文字轻点呼出背包）、朝下 = 无效手势，均不发射。
     */
    private onTouchEnd(event: EventTouch): void {
        if (this._modalOpen || !this.launcherNode?.isValid) {
            return;
        }
        // 冷却节流（锚定松手时刻；本手势无论是否发射都占用冷却基准）
        const now = Date.now() / 1000;
        if (now - this._lastLaunchTime < this.launchCooldown) {
            return;
        }
        const ui = event.getUILocation();
        const origin = this.launcherNode.worldPosition;
        // 方向 = 松手触点 - 发射座：所见即所得，零随机、零扇区外插（反向深渊：向上即 dir.y > 0）
        const aimDir = new Vec2(ui.x - origin.x, ui.y - origin.y);
        if (aimDir.length() < MIN_AIM_LENGTH || aimDir.y <= 0) {
            return; // 轻点误触（含屏底牌库文字呼出背包）/ 朝下拖拽：反向深渊只收向上发射
        }
        this._lastLaunchTime = now;
        this.launchOrb(aimDir);
    }

    /**
     * 发射当前弹珠（唯一调用方：onTouchEnd，拖拽松手触发）。
     * 方向 = onTouchEnd 算好的拖拽瞄准向量（触点 - 发射座），本函数零角度加工：
     * 不做任何随机扰动 / 扇区钳制，归一化后 100% 沿玩家瞄准线出膛。
     */
    private launchOrb(aimDir: Vec2): void {
        const prefab = this.orbPrefab;
        if (!prefab?.isValid || !this.launcherNode?.isValid) {
            console.warn('[Launcher] 弹珠 Prefab 或发射点无效！');
            return;
        }
        // 🎯 发射免费（2026-09-03 回滚发射经济）：金币回归纯商店货币（击杀掉落 + 金币槽 +20 + 波次补贴）。
        // DeckManager 为纯类型化卡组（不持有 Prefab），发射统一使用本组件配置的 orbPrefab
        const orbType = DeckManager.instance?.drawNextOrbType() ?? 0;
        console.log(`[Launcher] 🚀 成功发射弹珠: 类型=${orbType}`);

        // 🎲 回合推进（物理肉鸽 P2）：一次发射 = 消耗一次开火权 = 游戏推进一回合——
        // EnemyManager 监听后驱动全体敌人下落一步。雷球散射在 launchOrb 只派发一次
        //（一次开火权 = 一回合，不按散种子弹数重复推进）。
        EventBus.emit(GameEvents.TURN_ADVANCE);

        // 归一化瞄准向量：发射初速 = 单位方向 × launchSpeed（零随机、零角度加工，所见即所得）
        const len = aimDir.length();
        if (len <= 0) {
            return;
        }
        const dir = new Vec2(aimDir.x / len, aimDir.y / len);

        if (orbType === OrbType.Lightning) {
            this.fireLightningBurst(prefab, dir);
            return;
        }
        this.fireOrb(prefab, orbType, dir, false);
    }

    /**
     * 雷球扇形散射：数量与间隔消费 OrbBalance.lightning（splitCount/scatterAngle）。
     * 基础 3 连发（-15°/0/+15°）；「过载雷球」卡经 applyUpgrade('lightning_projectile', 2)
     * 把 splitCount 推到 5 → ±30° 五连发。中心球为主球（入槽回收），其余为副球（不回收，卡组守恒）。
     */
    private fireLightningBurst(prefab: Prefab, dir: Vec2): void {
        const { splitCount, scatterAngle } = OrbBalance.lightning;
        const offsets = OrbBalance.lightningSpread(splitCount, scatterAngle);
        const centerIdx = (offsets.length - 1) / 2;
        offsets.forEach((offset, i) => {
            const cos = Math.cos(offset);
            const sin = Math.sin(offset);
            // 平面旋转（与旧版 left/right 手算公式一致）
            const rotated = new Vec2(
                dir.x * cos - dir.y * sin,
                dir.x * sin + dir.y * cos,
            );
            this.fireOrb(prefab, OrbType.Lightning, rotated, i !== centerIdx);
        });
    }

    private fireOrb(prefab: Prefab, orbType: number, dir: Vec2, isSideKick: boolean): boolean {
        const orb = instantiate(prefab);
        if (!orb.isValid) return false;

        const orbCtrl = orb.getComponent(OrbController);
        if (orbCtrl) {
            orbCtrl.initOrbType(orbType);
            if (isSideKick) {
                orbCtrl.isSplitChild = true;
            }
        }

        orb.setParent(this.node.parent);
        this.launcherNode.getWorldPosition(this._tmpWorld);
        orb.setWorldPosition(this._tmpWorld);

        const rb = orb.getComponent(RigidBody2D);
        if (!rb) {
            console.warn('[Launcher] 弹珠缺少 RigidBody2D！');
            return false;
        }

        // 反向深渊：零重力（OrbBalance 全系 gravityScale=0）→ 初速 = 瞄准方向 × launchSpeed 匀速直线。
        // ★ 只写 linearVelocity（2026-09-08 根修）：旧版赋速后再叠加同值 impulse，实际初速被双倍
        //   放大到 2×launchSpeed——拖拽瞄准时代必须所见即所得，双重叠加已拆除。
        const vx = dir.x * this.launchSpeed;
        const vy = dir.y * this.launchSpeed;
        rb.linearVelocity = new Vec2(vx, vy);
        return true;
    }
}
