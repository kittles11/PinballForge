import {
    _decorator, Component, Graphics, Label, Node, Sprite, Color, tween, UIOpacity, UITransform,
    Vec3, find, Tween,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { AudioManager } from '../Core/AudioManager';
import { RelicType } from '../Core/DataModels';
import { RelicManager } from '../Core/RelicManager';
import { MetaManager } from '../Core/MetaManager';
import { OrbBalance } from '../Core/OrbBalance';
import { cloneColor, shadeColor, Theme } from '../Core/ArtTheme';
import { FxManager } from '../Core/FxManager';
import { loadTex } from '../Core/TexCache';

const { ccclass, property } = _decorator;

/** ResultDialog 最小结构（按类名字符串取组件：避免 CastleController→ResultDialog→ShopDialog→CastleController 循环引用） */
interface ResultDialogLike {
    showResult(isWin: boolean): void;
}

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
    /** 复活快照：被摧毁瞬间的城堡颜色 / 缩放（RUN_REVIVED 原地恢复外观用） */
    private _castleOriginColor: Color | null = null;
    private _castleOriginScale: Vec3 | null = null;

    // ★ 难度方案B 防御阀门：单局治疗/护盾获取总量上限（相对当前生命上限的倍率）。
    //   续航卡（维修/护盾）可跨波反复获取，原「叠加不设上限」配合攻城伤害恒定，防线形同虚设；
    //   封顶后防具卡仍是价值选择，但不再能无限滚雪球。场景重载即新局，计数随实例自然归零。
    /** 单局治疗获取总量上限 = 生命上限 × 此倍率 */
    private static readonly RUN_HEAL_CAP_RATIO = 1.5;
    /** 单局护盾获取总量上限 = 生命上限 × 此倍率 */
    private static readonly RUN_SHIELD_CAP_RATIO = 1.5;
    /** 本局已获取治疗总量 */
    private _runHealGained = 0;
    /** 本局已获取护盾总量 */
    private _runShieldGained = 0;

    /** Label 初始颜色缓存（受击变红动画恢复基准，替代硬编码色值） */
    private _labelOriginColor: Color = cloneColor(Theme.white);
    /** Label 初始缩放缓存（弹跳动画恢复基准） */
    private _labelOriginScale: Vec3 = new Vec3(1, 1, 1);
    /** 炉火窗光晕透明度组件（ensureCastleArt 创建，update 按血量比例脉动） */
    private _glowOpacity: UIOpacity | null = null;
    /** 炉火脉动时钟（秒） */
    private _glowClock = 0;

    protected onLoad(): void {
        // 单例尽早建立（onLoad 早于各系统 start，保证 RewardDialog 战后选择城堡维修时已可访问）
        CastleController.instance = this;
        // ⚒ meta 永久升级「城堡加固」：血量上限加成（先于 currentHp 初始化，确保首局即生效）
        this.maxHp += MetaManager.getCastleBonus();
        // ⚑ 锻造契约（方案C）：寒霜契约减益——生命上限 ×castleHpMult（软启动 ×0.9；无契约 ×1）。
        //   在 meta 加成之后套乘：永久成长不吞契约代价，两段各算各的。
        this.maxHp = Math.round(this.maxHp * OrbBalance.castleHpMult);
        this.currentHp = this.maxHp;
        // ⚒ meta 永久升级「战备护盾」：开局要塞护盾（先于 updateDisplay，首帧即显示）
        this.shield += MetaManager.getStartShieldBonus();
        // 矢量要塞精绘（替代场景遗留的单色方块 Sprite）
        this.ensureCastleArt();
        if (!this.hpLabel) {
            this.hpLabel = find('Canvas/UILayer/CastleHpLabel')?.getComponent(Label) || this.node.getComponentInChildren(Label)!;
        }
        // 顶部 HUD 两行式布局（修复文字重叠）：城堡钉在第一行左侧（y=606），与第二行的能量上下错开
        if (this.hpLabel?.isValid) {
            this.hpLabel.node.setPosition(-250, 606, 0);
            this.hpLabel.fontSize = 24;
            this.hpLabel.lineHeight = 28;
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
        EventBus.on(GameEvents.RUN_REVIVED, this.revive, this);
    }

    protected onDestroy(): void {
        if (CastleController.instance === this) {
            CastleController.instance = null;
        }
        EventBus.off(GameEvents.ATTACK_CASTLE, this.onCastleAttacked, this);
        EventBus.off(GameEvents.RUN_REVIVED, this.revive, this);
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

        // ★ 屏幕边缘红晕脉冲：实际掉血时才触发（护盾完全吸收则不惊扰）
        if (leaked > 0) {
            FxManager.screenPulse();
        }

        if (this.hpLabel) {
            // 文字变红并剧烈弹跳
            this.hpLabel.color = Theme.ui.red;
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
        // 📺 复活快照：被摧毁瞬间的外观（颜色 / 缩放），RUN_REVIVED 原地恢复用
        const sp0 = node.getComponent(Sprite);
        this._castleOriginColor = sp0?.isValid ? sp0.color.clone() : null;
        this._castleOriginScale = baseScale.clone();
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
        // ★ 兜底开门（2026-09-05，与 WaveManager.openRewardDialogFallback 同款策略）：
        //   ResultDialog 节点若在场景中被失活（组件 onLoad 永不执行 → GAME_OVER 监听注册不上），
        //   emit 是静默空转——玩家会卡在「城堡已毁、无结算弹窗、无法重开」的死局。
        //   emit 后直接按类名抓组件调用 showResult（组件方法不依赖节点激活态，内部自行
        //   active=true 并广播 UI_MODAL_CHANGED 冻结发射输入）。
        const resultNode = find('Canvas/UILayer/ResultDialog');
        if (resultNode?.isValid && resultNode.active) {
            return; // 结算弹窗确已打开（事件链正常）
        }
        const dialog = resultNode?.getComponent('ResultDialog') as ResultDialogLike | null;
        if (dialog) {
            console.warn('[Castle] GAME_OVER 事件链未打开结算弹窗（监听缺失），直接调用 ResultDialog.showResult 兜底');
            dialog.showResult(false);
        } else {
            console.error('[Castle] Canvas/UILayer/ResultDialog 节点缺失，无法兜底打开结算弹窗（请检查场景层级）');
        }
    }

    /**
     * 📺 广告复活（RUN_REVIVED，ResultDialog 发起）：原地满血复活，不重载场景、
     * 不动牌组 / 遗物 / 金币 / DDA 进度。残余敌人与刷怪恢复由 WaveManager 清屏处理，
     * 这里只恢复城堡本体：停掉爆炸动画（node 缩放 + Sprite 淡出两条 tween）、
     * 还原外观快照（颜色 / 缩放）、回满血量（护盾不返还，阀门计数照常累计）。
     */
    private revive(): void {
        const node = this.node;
        if (!node?.isValid) {
            return;
        }
        Tween.stopAllByTarget(node);
        const sp = node.getComponent(Sprite);
        if (sp?.isValid) {
            Tween.stopAllByTarget(sp);
            sp.color = this._castleOriginColor ?? Color.WHITE;
        }
        node.setScale(this._castleOriginScale ?? new Vec3(1, 1, 1));
        this._isOver = false;
        this.currentHp = this.maxHp;
        this.updateDisplay();
        console.log('[Castle] 📺 广告复活：城堡满血恢复（爆炸淡出已撤销，护盾不返还）');
    }

    /** 城堡 Sprite 透明度渐变到 0（爆炸后的淡出效果） */
    private fadeOutSprite(sp: Sprite): void {
        Tween.stopAllByTarget(sp);
        tween(sp)
            .to(0.45, { color: Theme.fx.fadeWhite })
            .start();
    }

    private updateDisplay() {
        if (this.hpLabel) {
            this.hpLabel.string = this.shield > 0
                ? `城堡: ${this.currentHp}/${this.maxHp} 🛡${this.shield}`
                : `城堡: ${this.currentHp}/${this.maxHp}`;
        }
    }

    protected update(dt: number): void {
        // 炉火窗呼吸：基础亮度随血量比例衰减（城堡被打残 → 炉火渐熄的叙事反馈），叠加正弦颤动
        if (!this._glowOpacity?.isValid) {
            return;
        }
        this._glowClock = (this._glowClock + dt) % 60;
        const ratio = this.maxHp > 0 ? Math.min(1, this.currentHp / this.maxHp) : 0;
        const base = 70 + 185 * ratio;
        this._glowOpacity.opacity = Math.round(base * (0.86 + 0.14 * Math.sin(this._glowClock * 2.6)));
    }

    /**
     * 城堡外观入口：优先生成贴图（resources/textures/turret_forge_castle），
     * 加载失败退矢量锻铁要塞（buildVectorCastleArt）。旧单色方块 Sprite 一律退役。
     */
    private ensureCastleArt(): void {
        const node = this.node;
        if (!node?.isValid || node.getChildByName('CastleArt')) {
            return;
        }
        node.getComponent(Sprite)?.destroy(); // 旧色块方案退役（保留组件会让爆炸走无关的褪色分支）
        loadTex('turret_forge_castle', (sf) => {
            if (!node?.isValid) {
                return;
            }
            if (!sf) {
                this.buildVectorCastleArt();
                return;
            }
            // 贴图路径：等比缩放到版位（节点原 64×64，城堡取 96 宽与漏斗/敌人比例协调）
            const sp = node.addComponent(Sprite);
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;
            sp.spriteFrame = sf;
            const xt = node.getComponent(UITransform) ?? node.addComponent(UITransform);
            const w = 96;
            xt.setContentSize(w, Math.round(w * (sf.height / sf.width)));
        });
    }

    /**
     * 矢量锻铁要塞（贴图加载失败的兜底造型，GAME_PLAN 4.2 场景件）：
     * 双塔+主楼雉堞、暗铜饰带、铆钉、拱门基座，炉火窗光随血量脉动（update 驱动）。幂等。
     */
    private buildVectorCastleArt(): void {
        const node = this.node;
        if (!node?.isValid || node.getChildByName('CastleArt')) {
            return;
        }

        const art = new Node('CastleArt');
        art.layer = node.layer;
        art.addComponent(UITransform).setContentSize(96, 96);
        const g = art.addComponent(Graphics);
        const body = Theme.machine.body;
        const bronze = shadeColor(Theme.ui.gold, -0.45);
        const copper = shadeColor(Theme.ui.gold, -0.25);
        const dark = shadeColor(body, -0.55);

        // ① 基座：地面压暗托盘
        g.fillColor = shadeColor(body, -0.5, 200);
        g.roundRect(-33, -45, 66, 9, 4);
        g.fill();

        // ② 双塔 + 主楼主体（锻铁深灰）
        g.fillColor = body;
        g.rect(-31, -38, 14, 80); // 左塔
        g.rect(17, -38, 14, 80); // 右塔
        g.rect(-15, -38, 30, 72); // 主楼
        g.fill();

        // ③ 雉堞（塔顶/楼顶各三齿，暗铜色帽）
        g.fillColor = bronze;
        for (const tx of [-30, -25, -20, 16, 21, 26, -11, -2, 7]) {
            const topY = tx <= -17 || tx >= 16 ? 42 : 34;
            g.rect(tx, topY, 4.5, 5.5);
        }
        g.fill();

        // ④ 暗铜饰带（横贯三结构，锻造金属语言）
        g.fillColor = copper;
        g.rect(-31, 6, 62, 4);
        g.fill();

        // ⑤ 拱门（压暗内凹）
        g.fillColor = dark;
        g.rect(-8, -38, 16, 16);
        g.circle(0, -22, 8);
        g.fill();

        // ⑥ 铆钉（金色小圆点，塔楼骨架暗示）
        g.fillColor = Theme.ui.gold;
        for (const [rx, ry] of [[-27, -30], [27, -30], [-27, -4], [27, -4], [-24, 18], [24, 18]]) {
            g.circle(rx, ry, 1.7);
        }
        g.fill();
        node.addChild(art);

        // ⑦ 炉火窗：独立光晕层（update 按血量脉动；城堡的「活着」状态灯）
        const glow = new Node('CastleGlow');
        glow.layer = art.layer;
        glow.addComponent(UITransform).setContentSize(96, 96);
        const gg = glow.addComponent(Graphics);
        gg.fillColor = cloneColor(Theme.fx.ember);
        gg.circle(-24, 30, 8.5);
        gg.circle(24, 30, 8.5);
        gg.circle(0, 24, 8);
        gg.fill();
        const ember = cloneColor(Theme.fx.ember);
        ember.a = 235;
        gg.fillColor = ember;
        for (const [wx, wy, wr] of [[-24, 30, 4.5], [24, 30, 4.5], [0, 24, 4]] as Array<[number, number, number]>) {
            gg.roundRect(wx - wr * 0.62, wy - wr, wr * 1.24, wr * 2, wr * 0.6);
        }
        gg.fill();
        art.addChild(glow);
        const op = glow.addComponent(UIOpacity);
        op.opacity = 200;
        this._glowOpacity = op;
    }

    /** 增加护盾值（战后冰霜护甲卡 / 通关王者之冕结算）：受单局护盾阀门约束（难度方案B），超出上限部分无效 */
    public addShield(amount: number): void {
        if (amount <= 0 || !this.node?.isValid) {
            return;
        }
        const room = Math.max(0, this.maxHp * CastleController.RUN_SHIELD_CAP_RATIO - this._runShieldGained);
        const effective = Math.min(amount, room);
        if (effective <= 0) {
            console.log(`[Castle] 单局护盾阀门已满（上限 ${Math.round(this.maxHp * CastleController.RUN_SHIELD_CAP_RATIO)}），本次 +${amount} 无效`);
            return;
        }
        this._runShieldGained += effective;
        this.shield += effective;
        console.log(`[Castle] 护盾 +${effective}，当前护盾: ${this.shield}`);
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

    /**
     * 维修/治疗城堡（战后卡牌奖励、商店维修）：恢复 amount 点生命值，不超出最大上限；城堡已毁灭则无效。
     * 受单局治疗阀门约束（难度方案B）；bypassRunCap 供吸血球等自带单发封顶的来源豁免（其上限由 leechHitHealCap 承担）。
     */
    public heal(amount: number, bypassRunCap = false): void {
        if (amount <= 0 || !this.node?.isValid || this.currentHp <= 0) {
            return;
        }
        let effective = amount;
        if (!bypassRunCap) {
            const room = Math.max(0, this.maxHp * CastleController.RUN_HEAL_CAP_RATIO - this._runHealGained);
            effective = Math.min(amount, room);
            if (effective <= 0) {
                console.log(`[Castle] 单局治疗阀门已满（上限 ${Math.round(this.maxHp * CastleController.RUN_HEAL_CAP_RATIO)}），本次 +${amount} 无效`);
                return;
            }
            this._runHealGained += effective;
        }
        this.currentHp = Math.min(this.maxHp, this.currentHp + effective);
        console.log(`[Castle] 城堡维修 +${effective}，当前生命: ${this.currentHp}`);
        this.updateDisplay();
    }
}