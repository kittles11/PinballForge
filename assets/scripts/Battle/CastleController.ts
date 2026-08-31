import { _decorator, Component, Label, Sprite, Color, tween, Vec3, find, Tween } from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { AudioManager } from '../Core/AudioManager';
import { RelicType } from '../Core/DataModels';
import { RelicManager } from '../Core/RelicManager';
import { MetaManager } from '../Core/MetaManager';

const { ccclass, property } = _decorator;

/**
 * 城堡控制器：挂载在 BattleLayer/Turret 或 BattleLayer/Castle 节点上。
 * 监听全局事件 ATTACK_CASTLE（怪物攻击城堡），扣血并刷新文本，播放文字变色 + 弹跳动效；
 * 生命归零时广播 GAME_OVER。与敌人系统完全解耦。
 */
@ccclass('CastleController')
export class CastleController extends Component {
    /** 单例引用：供战后卡牌奖励（城堡维修）等系统直接调用 */
    static instance: CastleController | null = null;

    @property
    public maxHp: number = 100;

    @property(Label)
    public hpLabel: Label | null = null;

    public currentHp: number = 100;

    /** 护盾值（冰霜护甲 / 王者之冕）：先于生命吸收伤害，归零后伤害透传至生命 */
    public shield: number = 0;

    /** 城堡是否已毁灭（守卫：生命归零后禁止重复触发爆炸动画 / 重复广播 GAME_OVER） */
    private _isOver = false;

    /** Label 初始颜色缓存（受击变红动画恢复基准，替代硬编码色值） */
    private _labelOriginColor: Color = Color.WHITE.clone();
    /** Label 初始缩放缓存（弹跳动画恢复基准） */
    private _labelOriginScale: Vec3 = new Vec3(1, 1, 1);

    protected onLoad(): void {
        // 单例尽早建立（onLoad 早于各系统 start，保证 RewardDialog 战后选择城堡维修时已可访问）
        CastleController.instance = this;
        // ⚒ meta 永久升级「城堡加固」：血量上限加成（先于 currentHp 初始化，确保首局即生效）
        this.maxHp += MetaManager.getCastleBonus();
        this.currentHp = this.maxHp;
        if (!this.hpLabel) {
            this.hpLabel = find('Canvas/UILayer/CastleHpLabel')?.getComponent(Label) || this.node.getComponentInChildren(Label)!;
        }
        // 顶部 HUD 布局：城堡血量水平靠左（Canvas 宽 720 坐标系），与居中的波次、靠右的金币错开避免重叠
        if (this.hpLabel?.isValid) {
            this.hpLabel.node.setPosition(-210, 590, 0);
        }
        // 缓存原色与原缩放（作为动画恢复基准，避免硬编码颜色值漂移）
        if (this.hpLabel?.isValid) {
            this._labelOriginColor.set(this.hpLabel.color);
            this._labelOriginScale.set(this.hpLabel.node.scale);
        }
        this.updateDisplay();
    }

    protected start(): void {
        EventBus.on(GameEvents.ATTACK_CASTLE, this.onCastleAttacked, this);
    }

    protected onDestroy(): void {
        if (CastleController.instance === this) {
            CastleController.instance = null;
        }
        EventBus.off(GameEvents.ATTACK_CASTLE, this.onCastleAttacked, this);
        // 生命周期清理：停掉 Label 上残留的弹跳 tween，避免节点销毁后动画继续驱动
        if (this.hpLabel?.node?.isValid) {
            Tween.stopAllByTarget(this.hpLabel.node);
        }
    }

    public onCastleAttacked(data: any) {
        if (this._isOver || !this.node?.isValid) {
            return; // 游戏已结束：不再响应任何攻击
        }
        const damage = (data && data.damage) ? data.damage : 10;
        // ★ 护盾吸收：先扣护盾，护盾不足时才把剩余伤害透传至生命
        let leaked = damage;
        if (this.shield > 0) {
            const absorbed = Math.min(this.shield, damage);
            this.shield = Math.max(0, this.shield - absorbed);
            leaked = damage - absorbed;
            console.log(`[Castle] 护盾吸收 ${absorbed} 点伤害，剩余护盾: ${this.shield}`);
            this.updateDisplay();
        }
        this.currentHp = Math.max(0, this.currentHp - leaked);
        console.log(`[Castle] 城堡受到攻击，扣除 ${leaked} 点血，剩余: ${this.currentHp}`);

        this.updateDisplay();

        if (this.hpLabel) {
            // 文字变红并剧烈弹跳
            this.hpLabel.color = new Color(255, 50, 50, 255);
            // 打断上一次残留弹跳，避免连续攻击时动画叠加抖动、颜色提前复原
            Tween.stopAllByTarget(this.hpLabel.node);
            tween(this.hpLabel.node)
                .to(0.06, { scale: new Vec3(1.4, 1.4, 1) })
                .to(0.1, { scale: this._labelOriginScale.clone() })
                .call(() => {
                    if (this.hpLabel?.isValid) {
                        this.hpLabel.color = this._labelOriginColor.clone();
                    }
                })
                .start();
        }

        if (this.currentHp <= 0) {
            this.onCastleDestroyed();
        }
    }

    /**
     * 城堡被毁：播放剧烈爆炸音 → 城堡剧烈抖动 + 放大爆炸淡出动画 → 广播 GAME_OVER。
     * ResultDialog 监听 GAME_OVER 会立即弹出结算弹窗。
     */
    private onCastleDestroyed(): void {
        if (this._isOver) {
            return;
        }
        this._isOver = true;
        console.warn('[Castle] 城堡生命归零，游戏失败！');

        // 1. 剧烈爆炸音（Web Audio 纯代码合成，零外部资产）
        AudioManager.playCastleExplode();

        const node = this.node;
        Tween.stopAllByTarget(node);
        const basePos = node.position.clone();
        const baseScale = node.scale.clone();
        const bigScale = baseScale.clone().multiplyScalar(1.7);

        // 2. 剧烈抖动：左右上下快速连续位移 → 3. 放大爆炸：撑大到 1.7 倍 → 4. 淡出
        tween(node)
            .to(0.05, { position: new Vec3(basePos.x - 14, basePos.y + 12, 0) })
            .to(0.05, { position: new Vec3(basePos.x + 14, basePos.y - 10, 0) })
            .to(0.05, { position: new Vec3(basePos.x - 10, basePos.y - 12, 0) })
            .to(0.05, { position: new Vec3(basePos.x + 10, basePos.y + 10, 0) })
            .to(0.05, { position: new Vec3(basePos.x, basePos.y, 0) })
            .to(0.12, { scale: bigScale })
            .call(() => {
                const sp = node.getComponent(Sprite);
                if (sp?.isValid) {
                    this.fadeOutSprite(sp);
                } else {
                    // 无 Sprite 时的兜底淡出：缩放收没
                    Tween.stopAllByTarget(node);
                    tween(node).to(0.45, { scale: new Vec3(0.001, 0.001, 0.001) }).start();
                }
            })
            .start();

        // 5. 广播游戏结束：ResultDialog 监听 GAME_OVER 立即弹出结算弹窗
        EventBus.emit(GameEvents.GAME_OVER);
    }

    /** 城堡 Sprite 透明度渐变到 0（爆炸后的淡出效果） */
    private fadeOutSprite(sp: Sprite): void {
        Tween.stopAllByTarget(sp);
        tween(sp)
            .to(0.45, { color: new Color(255, 255, 255, 0) })
            .start();
    }

    private updateDisplay() {
        if (this.hpLabel) {
            this.hpLabel.string = this.shield > 0
                ? `城堡: ${this.currentHp}/${this.maxHp} 🛡${this.shield}`
                : `城堡: ${this.currentHp}/${this.maxHp}`;
        }
    }

    /** 增加护盾值（战后冰霜护甲卡 / 通关王者之冕结算），叠加不设上限 */
    public addShield(amount: number): void {
        if (amount <= 0 || !this.node?.isValid) {
            return;
        }
        this.shield += amount;
        console.log(`[Castle] 护盾 +${amount}，当前护盾: ${this.shield}`);
        this.updateDisplay();
    }

    /** 提升生命上限（战后城墙加固卡），补差距额上限值 */
    public increaseMaxHp(amount: number): void {
        if (amount <= 0 || !this.node?.isValid) {
            return;
        }
        this.maxHp += amount;
        this.currentHp = Math.min(this.maxHp, this.currentHp + amount);
        console.log(`[Castle] 生命上限 +${amount}，当前: ${this.currentHp}/${this.maxHp}`);
        this.updateDisplay();
    }

    /** 维修城堡（战后卡牌奖励）：恢复 amount 点生命值，不超出最大上限；城堡已毁灭则无效 */
    public heal(amount: number): void {
        if (amount <= 0 || !this.node?.isValid || this.currentHp <= 0) {
            return;
        }
        this.currentHp = Math.min(this.maxHp, this.currentHp + amount);
        console.log(`[Castle] 城堡维修 +${amount}，当前生命: ${this.currentHp}`);
        this.updateDisplay();
    }
}