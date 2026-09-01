import {
    _decorator, Component, Node, Sprite, Color, Vec3, Graphics, UITransform,
    tween, Tween, Label,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import {
    EnemyType, ENEMY_TYPE_STATS, ENEMY_BODY_RADIUS, OrbType, RelicType,
    FunnelType, BossBehavior, BOSS_BEHAVIOR_STATS,
    bossBehaviorForChapter, bulwarkIntervalForChapter, summonHpRatioForChapter,
    EnemyAffix, AFFIX_STATS,
} from '../Core/DataModels';
import { RelicManager, THORN_REFLECT_DAMAGE } from '../Core/RelicManager';
import { LevelManager } from '../Core/LevelManager';
import { GoldManager } from '../Core/GoldManager';
import { FloatingTextManager } from '../Core/FloatingTextManager';
import { cloneColor, rgb, Theme } from '../Core/ArtTheme';
import { FxManager } from '../Core/FxManager';

const { ccclass, property } = _decorator;

/** 霜冻弹单体冻结时长（秒） */
const FREEZE_DURATION = 3;
/** 急冻时身体变冰蓝（#00FFFF 冰封色） */
const FREEZE_COLOR = Theme.enemy.freeze;
/** 熔岩弹受击时身体闪的大红光颜色 */
const HEAVY_HIT_COLOR = Theme.enemy.heavyHit;
/** 雷球弹受击时身体闪的电光青白色 */
const LIGHTNING_HIT_COLOR = Theme.enemy.lightningHit;
/** 受击白闪时长（秒） */
const HIT_FLASH_DURATION = 0.08;
/** 死亡爆开：先撑大到该倍率 */
const DIE_EXPLODE_SCALE = 1.7;
/** 死亡缩小淡出时长（秒） */
const DIE_ANIM_DURATION = 0.3;
/** 头槌冲撞：到达防线后向左扑撞的距离（px） */
const ATTACK_LUNGE_X = 25;

/** 🛡️ 铁甲怪护盾格挡：身体闪的银蓝光 */
const SHIELD_BLOCK_COLOR = Theme.enemy.shieldBlock;
/** 🛡️ 护盾格挡跳字颜色（冰蓝） */
const SHIELD_TEXT_COLOR = Theme.enemy.shieldText;
/** 环绕护盾弧颜色（冰蓝） */
const SHIELD_PIP_COLOR = Theme.enemy.shieldPip;
/** 👹 Boss 专属技能「狂暴回复」：每 BOSS_REGEN_INTERVAL 秒回复最大生命的 BOSS_REGEN_RATIO */
const BOSS_REGEN_INTERVAL = 6;
const BOSS_REGEN_RATIO = 0.05;
/** Boss 回血跳字颜色（毒绿） */
const BOSS_REGEN_TEXT_COLOR = Theme.enemy.bossRegen;

/** 受击伤害跳字：敌人头顶垂直偏移（px，血条上方） */
const HIT_TEXT_OFFSET_Y = 60;
/** 受击跳字颜色：普通伤害红字 / 熔岩暴击亮红大字 / 雷球电光青字 */
const HIT_TEXT_COLOR = Theme.enemy.hurtText;
const HEAVY_HIT_TEXT_COLOR = Theme.enemy.hurtTextHeavy;
const LIGHTNING_TEXT_COLOR = Theme.enemy.lightningText;

/** 头顶血条宽度（px） */
const HP_BAR_WIDTH = 46;
/** 头顶血条底框厚度（px） */
const HP_BAR_BACK_HEIGHT = 8;
/** 头顶血条绿色进度条厚度（px） */
const HP_BAR_FILL_HEIGHT = 5;
/** 血条在敌人头顶的垂直偏移（px） */
const HP_BAR_OFFSET_Y = 42;

/**
 * 敌人控制器：挂载在敌人节点上。
 * - update 中向左行进，到达防线后每 1s 顶撞城堡（frozen / 死亡时不行动）；
 * - 受击按【珠子类型】结算特效：霜冻冰蓝定身 3s / 雷球电光闪 / 熔岩红光暴击 / 普通白闪；
 *   血量归零时缩小淡出销毁并从管理器注销；
 * - 特色类型行为（WaveManager 出怪时 setupType 指定，数值唯一真源见 DataModels.ENEMY_TYPE_STATS）：
 *   🛡️ 铁甲怪 2 层护盾免疫前 2 次伤害 / 🦠 史莱姆死亡分裂 2 只小怪 / 👹 Boss 定期狂暴回血。
 */
@ccclass('EnemyController')
export class EnemyController extends Component {
    /** 最大生命值 */
    @property
    maxHp = 100;

    /** 向左行进速度（px/s） */
    @property
    moveSpeed = 30;

    /** 炮塔防线 X 坐标：到达后停在炮塔右侧防线，不再向左穿透 */
    @property
    defenseLineX = -180;

    /** 当前生命值 */
    currentHp = 100;

    /** 是否被急冻定身 */
    isFrozen = false;

    /** 敌人类型（WaveManager 出怪时指定，决定护盾 / 分裂 / Boss 技能行为） */
    public enemyType: EnemyType = EnemyType.Normal;
    /** 是否史莱姆分裂出的小怪（小怪不再分裂，防无限套娃） */
    public isMini = false;
    /** 剩余护盾层数（>0 时免疫单次伤害，每挡一次 -1） */
    private shieldCharges = 0;
    /** 头顶护盾层数指示点根节点 */
    private _shieldPipsRoot: Node | null = null;

    // ---------- 👹 Boss 特色行为（P2-1，设计稿 docs/BOSS_DESIGN.md；非 Boss 全部为默认值零开销） ----------

    /** 本 Boss 的特色行为（start 时按章节轮换表分配） */
    public bossBehavior: BossBehavior = BossBehavior.None;
    /** A 坚盾：当前举盾层数（0=无盾；盾期炮伤 ×0.5 软减伤，重炮剥 1 层 / 熔岩剥 2 层，超时自动碎，绝不无敌） */
    private _bulwarkLayers = 0;
    /** C 破绽：当前处于受击 ×2 窗口 */
    private _exposed = false;
    /** 施法前摇：诏令/举盾预告期间定身停攻（可读信号 + 玩家 DPS 补偿），update 跳过行进 */
    private _casting = false;
    /** 死亡掉金币（Boss 诏令亲卫由 WaveManager 置位；0=不掉） */
    public goldOnDeath = 0;

    /** 🎖️ 精英词缀（WaveManager 出精英波时掷取并 applyAffix；Boss 与普通怪恒为 null） */
    public affix: EnemyAffix | null = null;

    /**
     * 同屏存活敌人计数（含 0.36s 死亡动画中的尸体，偏保守）：君王诏令的同屏护栏用。
     * 不 import EnemyManager 查数——EnemyManager→EnemyController 已有引用，反向 import 会构成
     * 运行时循环（selfcheck-code-standards 规则 4），故本类自维护：onLoad +1 / onDestroy -1，
     * 场景重载全销毁自然归零。
     */
    private static _aliveCount = 0;
    public static get aliveCount(): number {
        return EnemyController._aliveCount;
    }

    /** 游戏是否已结束（GAME_OVER 后全员锁定：彻底停步停攻、原地庆祝，绝不向左穿出屏幕） */
    isGameOver = false;

    /** 是否已开始原地庆祝跳动（防重复启动 tween） */
    private _celebrating = false;

    /** 是否已死亡（防重复销毁 / 重复扣血） */
    get isDead(): boolean {
        return this._dead;
    }
    private _dead = false;

    /** 到达防线后每 attackInterval 秒攻击城堡一次 */
    @property
    attackInterval = 1.0;
    /** 每次攻击对城堡造成的伤害 */
    @property
    attackDamage = 10;
    /** 重炮过载（战后卡牌奖励）：聚能漏斗（红）伤害倍率额外加成，1 = 无加成，1.5 = +50%；由 OrbController 入槽结算时乘入 */
    static heavyOverloadMult = 1;
    /** 极寒易伤（战后极寒易伤卡）：被冰封的敌人受到的伤害倍率加成，1 = 无加成，1.5 = +50% */
    static iceVulnerableMult = 1;
    /** 🃏 破盾者（应答卡）：每次命中额外剥离的护盾层数（铁甲格挡与 Boss 坚盾通吃），0 = 未持有 */
    static shieldbreakerStrips = 0;
    /** 🃏 清剿令（应答卡）：对召唤物/分裂小怪（isMini）的伤害倍率，1 = 无加成 */
    static purgeSummonMult = 1;
    /** 🃏 猎首契约（应答卡）：对精英（带词缀）与 Boss 的伤害倍率，1 = 无加成 */
    static bountyEliteMult = 1;

    /** 重开前重置全部静态状态（ResultDialog 重载场景前调用，防上次对局的强化残留） */
    static resetStaticData(): void {
        EnemyController.heavyOverloadMult = 1;
        EnemyController.iceVulnerableMult = 1;
        EnemyController.shieldbreakerStrips = 0;
        EnemyController.purgeSummonMult = 1;
        EnemyController.bountyEliteMult = 1;
    }

    /** 攻城攻击计时器（到防线后开始累计） */
    private attackTimer = 0;
    /** 头槌冲撞动画播放中（期间让位 tween 驱动位置，不参与防线锁定，避免动画被每帧覆盖） */
    private _lungeAnimating = false;

    /** 是否已进入销毁流程（onDestroy 去重，防重复注销） */
    private isDestroyed = false;

    /** 身体初始颜色（急冻解除 / 白闪恢复时还原用） */
    private _baseColor: Color = cloneColor(Theme.white);
    /** 身体初始缩放（死亡爆开动画基准） */
    private _baseScale: Vec3 = new Vec3(1, 1, 1);

    /** 头顶血条根节点（背景底框） */
    private _hpBarRoot: Node | null = null;
    /** 头顶血条绿色进度条节点（由 scaleX 控制长度） */
    private _hpBarFill: Node | null = null;

    /**
     * 按类型初始化外观与护盾层数（WaveManager 在节点激活前调用，保证 onLoad 以类型颜色/体型为基准）。
     * @param type   敌人类型
     * @param isMini 史莱姆分裂小怪：不携带护盾且不再分裂
     */
    public setupType(type: EnemyType, isMini = false): void {
        this.enemyType = type;
        this.isMini = isMini;
        const stats = ENEMY_TYPE_STATS[type];
        this.shieldCharges = isMini ? 0 : stats.shieldLayers;
        const c = stats.color;
        // 优先染 Sprite（Prefab / 场景模板路径）；无 Sprite 时重绘 Graphics 兜底圆（运行时手搓怪路径）
        const sp = this.getComponent(Sprite) ?? this.getComponentInChildren(Sprite);
        if (sp?.isValid) {
            sp.color = rgb(c.r, c.g, c.b);
        } else {
            const g = this.getComponent(Graphics);
            if (g?.isValid) {
                g.clear();
                g.fillColor = rgb(c.r, c.g, c.b);
                g.circle(0, 0, ENEMY_BODY_RADIUS);
                g.fill();
            }
        }
    }

    /**
     * 🎖️ 施加精英词缀（WaveManager 在节点激活前调用，与 setupType 同时序）。
     * 铁壁与铁甲怪天生护盾可叠加（2+2=4 层合法，onLoad 的 createShieldPips 读到叠加后层数）；
     * 疾风在 WaveManager 已设定的 moveSpeed 上再乘；血怒/随从为标记行为，start/die 分别消费。
     */
    public applyAffix(affix: EnemyAffix): void {
        this.affix = affix;
        const s = AFFIX_STATS[affix];
        if (s.shieldCharges) {
            this.shieldCharges += s.shieldCharges;
        }
        if (s.speedMult) {
            this.moveSpeed = Math.round(this.moveSpeed * s.speedMult);
        }
    }

    protected onLoad(): void {
        this.currentHp = this.maxHp;
        EnemyController._aliveCount += 1;
        const sp = this.getComponent(Sprite);
        if (sp?.isValid) {
            this._baseColor.set(sp.color);
        }
        this._baseScale.set(this.node.scale);
    }

    protected start(): void {
        // 自动登记：经事件总线通知 EnemyManager（本类不再反向导入 EnemyManager，解除循环引用）。
        // 管理器未就绪时由其 getFrontEnemy 的子节点扫描兜底重新发现，登记不会遗漏。
        EventBus.emit(GameEvents.ENEMY_SPAWNED, this);
        // 代码生成头顶血条（绿色进度条 + 背景底框），无需手动拖拽组件
        this.createHpBar();
        this.updateHpBar();
        // 🛡️ 铁甲怪：血条上方绘制护盾层数指示点
        this.createShieldPips();
        // ★ 美术叠层：落地投影 + 轮廓描边 + 类型剪影（幂等，纯代码零资源）
        this.ensureEnemyArt();
        // 👹 章节大 Boss：启动周期狂暴回复（冰封不影响回复 → 需爆发伤害压制，不能磨死它）
        if (this.enemyType === EnemyType.Boss && !this.isMini) {
            this.schedule(this.bossRegen, BOSS_REGEN_INTERVAL);
            // ★ P2-1 特色行为：按章节轮换表分配（回复 + 1 特色，Hick 上限），参数曲线见 DataModels
            this.bossBehavior = bossBehaviorForChapter(LevelManager.currentChapter);
            if (this.bossBehavior === BossBehavior.Expose) {
                this.schedule(this.bossExposeCycle, BOSS_BEHAVIOR_STATS.exposeInterval);
            } else if (this.bossBehavior === BossBehavior.Summon) {
                this.schedule(this.bossSummonCycle, BOSS_BEHAVIOR_STATS.summonInterval);
            } else if (this.bossBehavior === BossBehavior.Bulwark) {
                this.schedule(this.bossBulwarkCycle, bulwarkIntervalForChapter(LevelManager.currentChapter));
            }
            if (this.bossBehavior !== BossBehavior.None) {
                console.log(`[Enemy] 👹 Boss 特色行为就位：${this.bossBehavior}（第 ${LevelManager.currentChapter} 章轮换表）`);
            }
        }

        // 🎖️ 精英词缀：常驻徽章 + 出生跳字宣告；血怒挂半强度回复定时器
        if (this.affix !== null) {
            this.ensureAffixBadge();
            const s = AFFIX_STATS[this.affix];
            FloatingTextManager.instance?.showText(
                `🎖️ ${s.icon} ${s.name}！`,
                new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y + 20, 0),
                Theme.ui.gold, true,
            );
            if (this.affix === EnemyAffix.Vital && s.regenInterval) {
                this.schedule(this.vitalRegen, s.regenInterval);
            }
        }

        // 游戏结束：全员立即停步停攻、原地庆祝（严格全局锁定）
        EventBus.on(GameEvents.GAME_OVER, this.onGameOver, this);
    }

    protected onDestroy(): void {
        if (this.isDestroyed) {
            return;
        }
        this.isDestroyed = true;
        EnemyController._aliveCount = Math.max(0, EnemyController._aliveCount - 1);
        EventBus.off(GameEvents.GAME_OVER, this.onGameOver, this);
        // 安全注销：广播事件由 EnemyManager 即时移除引用（unregisterEnemy 内部按 indexOf 去重，幂等）。
        // 场景重载时若管理器先销毁（已停止监听并清空列表），本事件静默失效，无副作用。
        EventBus.emit(GameEvents.ENEMY_REMOVED, this);
    }

    protected update(dt: number): void {
        if (this._dead || !this.node?.isValid) {
            return;
        }
        // 游戏结束：彻底停止移动 / 攻击 / 头槌冲撞，原地庆祝，绝不向左穿出屏幕
        if (this.isGameOver) {
            this.celebrate();
            return;
        }
        // 急冻定身：不移动也不攻击
        if (this.isFrozen) {
            return;
        }
        // 👹 施法前摇：诏令 / 举盾预告期间定身停攻（读招窗口，位置交由场景静止表达）
        if (this._casting) {
            return;
        }
        // 头槌冲撞动画播放中：位置交由 tween 驱动，跳过防线锁定
        if (this._lungeAnimating) {
            return;
        }
        const y = this.node.position.y;
        const nx = this.node.position.x - this.moveSpeed * dt;
        if (nx > this.defenseLineX) {
            // 未到达防线：正常向左行进
            this.node.setPosition(nx, y, 0);
            return;
        }
        // 到达防线（X <= defenseLineX）：强制固定在防线坐标，不再向左穿透
        this.node.setPosition(this.defenseLineX, y, 0);

        // 累计攻击计时：每满 attackInterval 秒头槌冲撞一次并广播 ATTACK_CASTLE
        this.attackTimer += dt;
        if (this.attackTimer >= this.attackInterval) {
            this.attackTimer = 0;
            this.lungeAttack();
        }
    }

    /** GAME_OVER 全局锁定：置标记并立即启动原地庆祝（幂等：仅存活敌人执行） */
    private onGameOver(): void {
        if (this._dead || !this.node?.isValid) {
            return;
        }
        this.isGameOver = true;
        this.celebrate();
    }

    /**
     * 原地庆祝跳动：打断一切行进 / 头槌 / 冰封 tween，只做上下弹跳。
     * x 坐标锁定在当前位置不再变化 → 绝不向左穿出屏幕。
     */
    private celebrate(): void {
        if (!this.node?.isValid || this._dead || this._celebrating) {
            return;
        }
        this._celebrating = true;
        // 立即打断一切位置驱动 tween（含正在播放的头槌冲撞），位置交由跳动接管
        Tween.stopAllByTarget(this.node);
        const base = this.node.position.clone();
        const jumpY = 14;
        tween(this.node)
            .repeatForever(
                tween()
                    .to(0.14, { position: new Vec3(base.x, base.y + jumpY, 0) })
                    .to(0.14, { position: new Vec3(base.x, base.y, 0) })
            )
            .start();
    }

    /** 头槌冲撞：0.08s 猛烈向左扑撞 25px，0.12s 弹回防线；同时广播城堡扣血事件 */
    private lungeAttack(): void {
        this._lungeAnimating = true;
        const curX = this.defenseLineX;
        const curY = this.node.position.y;
        tween(this.node)
            .to(0.08, { position: new Vec3(curX - ATTACK_LUNGE_X, curY, 0) })
            .to(0.12, { position: new Vec3(curX, curY, 0) })
            .call(() => {
                this._lungeAnimating = false;
            })
            .start();
        // 经全局事件总线广播攻击，城堡监听后自行扣血——彻底解耦
        EventBus.emit(GameEvents.ATTACK_CASTLE, { damage: this.attackDamage });

        // 荆棘城墙被动：怪物撞城时反弹固定伤害（跳过 50 保底如实扣 35；若致死则走 takeDamage 正常死亡结算）
        if (RelicManager.hasRelic(RelicType.ThornCastle)) {
            this.takeDamage(THORN_REFLECT_DAMAGE, OrbType.Normal, true);
        }
    }

    /** 受击入口：伤害已由发射端乘好漏斗倍率，此处按【珠子类型】结算受击特效；血量归零则死亡。
     *  @param orbType 珠子类型（决定受击特效：霜冻冻结 / 雷电光闪 / 熔岩红光暴击 / 普通白闪）
     *  @param rawFloor true 时跳过「最低 50」保底（供荆棘反射这类固定小伤害使用，如实扣除）；默认 false 维持 50 保底。
     *  @param funnelType 入槽漏斗类型（TurretController 透传）：Boss「破阵坚盾」剥盾判定用；荆棘等直伤传 null。 */
    public takeDamage(amount: number, orbType: OrbType, rawFloor = false, funnelType: FunnelType | null = null): void {
        if (this._dead || !this.node?.isValid) {
            return;
        }

        // 🛡️ 铁甲怪护盾：有剩余层数时免疫本次伤害（各珠子类型炮弹与跳过保底的固定伤害一并挡下），
        //   每挡一次消耗 1 层。注意：霜冻冰球的全场冰封走 freeze() 不经伤害结算，不受护盾阻挡。
        //   🌳 等离子球签名机制：无视铁甲格挡（直接透传全额伤害，不消耗盾层——护盾仍挡其它球）。
        if (this.shieldCharges > 0 && orbType !== OrbType.Plasma) {
            // 🃏 破盾者：每次命中额外剥离 shieldbreakerStrips 层（对铁甲格挡层生效）
            this.shieldCharges -= 1 + EnemyController.shieldbreakerStrips;
            this.redrawShieldPips(Math.max(0, this.shieldCharges));
            this.flashHit(SHIELD_BLOCK_COLOR);
            FloatingTextManager.instance?.showText(
                '🛡️ 格挡',
                new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0),
                SHIELD_TEXT_COLOR,
            );
            console.log(`[Enemy] 🛡️ 护盾格挡一次伤害，剩余层数: ${this.shieldCharges}`);
            return;
        }

        // 保底伤害：每次受击至少扣除 50 点，确保 1~2 颗弹珠即可打爆红怪（荆棘反射等固定伤害可跳过）
        // 漏斗倍率（聚能 ×2 / 精炼 ×1.5）已在 OrbController 入槽结算时乘入，此处不再感知漏斗。
        const baseDmg = rawFloor ? Math.max(amount, 0) : Math.max(amount, 50);
        let dmg = baseDmg;
        // 👹 A 破阵坚盾：盾期炮弹伤害 ×0.5（软减伤非免疫）；重炮（红槽）弹剥 1 层、熔岩弹剥 2 层——
        //   漏斗选择与熔岩构筑在这里获得真实应答。荆棘等直伤（rawFloor）不吃盾也不剥盾。
        //   🌳 等离子球无视坚盾减伤（不吃 ×0.5，也不剥层）。
        if (this._bulwarkLayers > 0 && !rawFloor && orbType !== OrbType.Plasma) {
            let peeled = 0;
            if (funnelType === FunnelType.HeavyCannon) {
                peeled += BOSS_BEHAVIOR_STATS.bulwarkPeelHeavy;
            }
            if (orbType === OrbType.Lava) {
                peeled += BOSS_BEHAVIOR_STATS.bulwarkPeelLava;
            }
            // 🃏 破盾者：对 Boss 坚盾同样生效（与铁甲格挡层共用一个剥离加成）
            peeled += EnemyController.shieldbreakerStrips;
            dmg *= BOSS_BEHAVIOR_STATS.bulwarkDamageMult;
            const pos = new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0);
            if (peeled > 0) {
                this._bulwarkLayers = Math.max(0, this._bulwarkLayers - peeled);
                if (this._bulwarkLayers === 0) {
                    FloatingTextManager.instance?.showText('🛡️ 盾碎了！', pos, Theme.ui.gold, true);
                } else {
                    FloatingTextManager.instance?.showText(`🛡️ 剥盾 -${peeled}`, pos, SHIELD_TEXT_COLOR);
                }
                this.redrawShieldPips(this._bulwarkLayers);
            } else {
                FloatingTextManager.instance?.showText('🛡️ ×0.5', pos, SHIELD_TEXT_COLOR);
            }
        }
        // 👹 C 破绽时刻：窗口内受到伤害 ×2（攒手时机检查，纯正反馈；窗口外零惩罚）
        if (this._exposed && !rawFloor) {
            dmg *= BOSS_BEHAVIOR_STATS.exposeDamageMult;
            FloatingTextManager.instance?.showText(
                '💢 破绽！',
                new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y + 26, 0),
                HEAVY_HIT_TEXT_COLOR, true,
            );
        }
        // ★ 极寒易伤被动：被冰封的敌人所受伤害额外 × 冰封易伤倍率（极寒易伤卡，默认 1）
        if (this.isFrozen) {
            dmg *= EnemyController.iceVulnerableMult;
        }
        // 🃏 清剿令：召唤物/分裂小怪（isMini）受到的伤害 ×purgeSummonMult
        if (this.isMini && EnemyController.purgeSummonMult !== 1) {
            dmg *= EnemyController.purgeSummonMult;
        }
        // 🃏 猎首契约：精英（带词缀）与章节 Boss 受到的伤害 ×bountyEliteMult
        if ((this.enemyType === EnemyType.Boss || this.affix !== null) && EnemyController.bountyEliteMult !== 1) {
            dmg *= EnemyController.bountyEliteMult;
        }
        this.currentHp = Math.max(0, this.currentHp - dmg);
        console.log(`[Enemy] 受到伤害: ${dmg}, 剩余血量: ${this.currentHp}`);
        this.updateHpBar();
        // ★ 受击血雾：迸溅量随弹种加重（熔岩重弹更浓）
        FxManager.spark(
            this.node.worldPosition,
            Theme.fx.blood,
            orbType === OrbType.Lava ? 6 : 3,
            150,
            0.26,
        );
        // ★ 受击伤害跳字：头顶飘出扣血数字（熔岩重弹暴击大字）
        this.showDamageText(dmg, orbType);

        switch (orbType) {
            case OrbType.Frost:
                // 霜冻弹：身体变冰蓝 + 定身 3s（重复受击时重置计时；全场 4s 冰封由霜冻球入槽技能另发）
                this.isFrozen = true;
                this.applyFreezeColor();
                this.unschedule(this.unfreeze);
                this.scheduleOnce(this.unfreeze, FREEZE_DURATION);
                break;
            case OrbType.Lightning:
                // 雷球：身体闪电光青白光
                this.flashHit(LIGHTNING_HIT_COLOR);
                break;
            case OrbType.Lava:
                // 熔岩重弹：身体闪大红光（💥 暴击跳字）
                this.flashHit(HEAVY_HIT_COLOR);
                break;
            case OrbType.Plasma:
                // 🌳 等离子球：身体闪等离紫光（无视护盾的透传命中反馈）
                this.flashHit(Theme.orb.plasma);
                break;
            default:
                // 普通 / 金币弹：标准白闪（金币已改为入槽即发，见 OrbController.triggerFunnelAndDestroy，此处不再发放防重复）
                this.flashHit(Color.WHITE);
                break;
        }

        if (this.currentHp <= 0) {
            this.die();
        }
    }

    /**
     * ★ 受击伤害跳字：敌人头顶飘出 -dmg 红字；熔岩重弹额外 💥 大字暴击样式、雷球 ⚡ 电光字。
     * 经全局浮动跳字池（对象池复用），敌人死亡销毁不影响跳字生命周期。
     */
    private showDamageText(dmg: number, orbType: OrbType): void {
        if (!this.node?.isValid) {
            return;
        }
        const pos = new Vec3(
            this.node.worldPosition.x,
            this.node.worldPosition.y + HIT_TEXT_OFFSET_Y,
            0,
        );
        if (orbType === OrbType.Lava) {
            FloatingTextManager.instance?.showText(
                `-${Math.round(dmg)} 💥`, pos, HEAVY_HIT_TEXT_COLOR, true,
            );
        } else if (orbType === OrbType.Lightning) {
            FloatingTextManager.instance?.showText(`-${Math.round(dmg)} ⚡`, pos, LIGHTNING_TEXT_COLOR);
        } else {
            FloatingTextManager.instance?.showText(`-${Math.round(dmg)}`, pos, HIT_TEXT_COLOR);
        }
    }

    /** Lightning 连击免费攻击：不经过漏斗与炮弹，按普通弹白闪结算、无特殊特效。 */
    public takeFreeDamage(amount: number): void {
        this.takeDamage(amount, OrbType.Normal, true);
    }

    /** 👹 Boss 专属技能「狂暴回复」：每 6s 回复 5% 最大生命（不超上限）；冰封期间照常回复 */
    private bossRegen(): void {
        if (this._dead || !this.node?.isValid || this.currentHp <= 0 || this.currentHp >= this.maxHp) {
            return;
        }
        const heal = Math.min(this.maxHp - this.currentHp, Math.round(this.maxHp * BOSS_REGEN_RATIO));
        this.currentHp += heal;
        this.updateHpBar();
        FloatingTextManager.instance?.showText(
            `+${heal} 🩸`,
            new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0),
            BOSS_REGEN_TEXT_COLOR,
        );
        console.log(`[Enemy] 👹 Boss 狂暴回复 +${heal}，当前血量 ${this.currentHp}/${this.maxHp}`);
    }

    /**
     * 👹 B 君王诏令：1s 定身鼓身预告 → 经 ENEMY_SPLIT（summon 旗标）召唤亲卫，
     *   WaveManager 走 Normal 模板生成（HP = Boss 最大生命 × 章节曲线，死亡掉金币）。
     *   亲卫出生在 Boss 身前（左侧更近防线）→ 炮塔最前索敌自动被抢——系统涌现，零新索敌代码。
     *   同屏敌人达软上限静默跳过本周期（护栏：防史莱姆分裂与召唤叠加失控）。
     */
    private bossSummonCycle(): void {
        if (this._dead || !this.node?.isValid) {
            return;
        }
        if (EnemyController.aliveCount >= BOSS_BEHAVIOR_STATS.onScreenCap) {
            console.log('[Enemy] 👹 同屏敌人达上限，君王诏令跳过');
            return;
        }
        this._casting = true;
        const puff = this._baseScale.clone().multiplyScalar(1.15);
        tween(this.node)
            .to(BOSS_BEHAVIOR_STATS.summonCast / 2, { scale: puff })
            .to(BOSS_BEHAVIOR_STATS.summonCast / 2, { scale: this._baseScale.clone() })
            .start();
        FloatingTextManager.instance?.showText(
            '👑 诏令！',
            new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0),
            Theme.ui.gold, true,
        );
        this.scheduleOnce(() => {
            this._casting = false;
            if (this._dead || !this.node?.isValid) {
                return;
            }
            const hp = Math.max(1, Math.round(this.maxHp * summonHpRatioForChapter(LevelManager.currentChapter)));
            EventBus.emit(GameEvents.ENEMY_SPLIT, {
                x: this.node.position.x - 40,
                y: this.node.position.y,
                count: BOSS_BEHAVIOR_STATS.summonCount,
                hp,
                speed: this.moveSpeed * BOSS_BEHAVIOR_STATS.summonSpeedMult,
                summon: true,
                goldDrop: BOSS_BEHAVIOR_STATS.summonGoldDrop,
                spawnType: EnemyType.Normal,
            });
            console.log(`[Enemy] 👑 君王诏令：召唤 ${BOSS_BEHAVIOR_STATS.summonCount} 只亲卫 HP ${hp}`);
        }, BOSS_BEHAVIOR_STATS.summonCast);
    }

    /**
     * 👹 A 破阵坚盾：0.8s 定身缩身预告 → 举盾 3 层（复用铁甲怪护盾弧视觉）。
     *   盾期炮伤 ×0.5 软减伤（非免疫，绝不无敌）；重炮（红槽）弹剥 1 层、熔岩弹剥 2 层（takeDamage 内结算）；
     *   10s 超时自动碎——不应对的玩家等周期也能过，只是 DPS 与金币机会成本。
     */
    private bossBulwarkCycle(): void {
        if (this._dead || !this.node?.isValid || this._bulwarkLayers > 0) {
            return; // 上一盾未碎不叠加（定时器与盾时长已对齐，此为保险）
        }
        this._casting = true;
        const crouch = this._baseScale.clone().multiplyScalar(0.9);
        tween(this.node)
            .to(BOSS_BEHAVIOR_STATS.bulwarkCast / 2, { scale: crouch })
            .to(BOSS_BEHAVIOR_STATS.bulwarkCast / 2, { scale: this._baseScale.clone() })
            .start();
        FloatingTextManager.instance?.showText(
            '🛡️ 坚盾！',
            new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0),
            SHIELD_TEXT_COLOR, true,
        );
        this.scheduleOnce(() => {
            this._casting = false;
            if (this._dead || !this.node?.isValid) {
                return;
            }
            this._bulwarkLayers = BOSS_BEHAVIOR_STATS.bulwarkLayers;
            this.ensureShieldPipsRoot();
            this.redrawShieldPips(this._bulwarkLayers);
            this.scheduleOnce(() => {
                if (this._bulwarkLayers > 0) {
                    this._bulwarkLayers = 0;
                    this.redrawShieldPips(0);
                    if (this.node?.isValid && !this._dead) {
                        FloatingTextManager.instance?.showText(
                            '🛡️ 盾已碎裂',
                            new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0),
                            Theme.ui.whiteGhost,
                        );
                    }
                }
            }, BOSS_BEHAVIOR_STATS.bulwarkDuration);
        }, BOSS_BEHAVIOR_STATS.bulwarkCast);
    }

    /**
     * 👹 C 破绽时刻：1s 双闪预告 → 3s 窗口（受击 ×2 + 身体放大红光提示）。
     *   纯正反馈检查：窗口外零惩罚，攒球等窗口的玩家白赚倍率——第 2 章的时机教学位。
     */
    private bossExposeCycle(): void {
        if (this._dead || !this.node?.isValid) {
            return;
        }
        this.flashHit(Color.WHITE);
        this.scheduleOnce(() => {
            if (this._dead || !this.node?.isValid) {
                return;
            }
            this.flashHit(HEAVY_HIT_COLOR);
        }, BOSS_BEHAVIOR_STATS.exposeTelegraph / 2);
        this.scheduleOnce(() => {
            if (this._dead || !this.node?.isValid) {
                return;
            }
            this._exposed = true;
            this.node.setScale(this._baseScale.clone().multiplyScalar(1.12));
            FloatingTextManager.instance?.showText(
                '💢 破绽！×2',
                new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0),
                HEAVY_HIT_TEXT_COLOR, true,
            );
            this.scheduleOnce(() => {
                this._exposed = false;
                if (this.node?.isValid && !this._dead) {
                    this.node.setScale(this._baseScale.clone());
                }
            }, BOSS_BEHAVIOR_STATS.exposeWindow);
        }, BOSS_BEHAVIOR_STATS.exposeTelegraph);
    }

    /** 🎖️ 血怒回复：每 5s 回 2% 最大生命（Boss 狂暴回复的半强度同款模型，冰封不挡回复） */
    private vitalRegen(): void {
        if (this._dead || !this.node?.isValid || this.currentHp <= 0 || this.currentHp >= this.maxHp) {
            return;
        }
        const ratio = AFFIX_STATS[EnemyAffix.Vital].regenRatio;
        const heal = Math.min(this.maxHp - this.currentHp, Math.round(this.maxHp * ratio));
        this.currentHp += heal;
        this.updateHpBar();
        FloatingTextManager.instance?.showText(
            `+${heal} 🩸`,
            new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0),
            BOSS_REGEN_TEXT_COLOR,
        );
    }

    /** 🎖️ 词缀徽章：血条上方常驻小图标（持续可读信号；节点随敌人销毁自然回收） */
    private ensureAffixBadge(): void {
        if (!this.affix || !this.node?.isValid || this.node.getChildByName('AffixBadge')) {
            return;
        }
        const n = new Node('AffixBadge');
        n.layer = this.node.layer;
        n.addComponent(UITransform).setContentSize(40, 24);
        const label = n.addComponent(Label);
        label.string = AFFIX_STATS[this.affix].icon;
        label.fontSize = 20;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        n.setPosition(0, HP_BAR_OFFSET_Y + 24, 0);
        this.node.addChild(n);
    }

    /** 解除急冻定身：恢复移动并还原身体颜色 */
    private unfreeze(): void {
        this.isFrozen = false;
        const sp = this.getComponent(Sprite);
        if (sp?.isValid) {
            sp.color = this._baseColor;
        }
    }

    /**
     * 主动冰封（霜冻冰球落入急冻槽时对全场敌人调用）：指定时长定身 + 冰蓝染色。
     * 重复冰封时重置计时（避免叠加），时长由调用方决定（默认 3s）。
     */
    public freeze(duration = FREEZE_DURATION): void {
        if (this._dead || !this.node?.isValid) {
            return;
        }
        this.isFrozen = true;
        this.applyFreezeColor();
        this.unschedule(this.unfreeze);
        this.scheduleOnce(this.unfreeze, duration);
    }

    /** 急冻冰封：身体变深蓝（Sprite 缺失时静默跳过） */
    private applyFreezeColor(): void {
        const sp = this.getComponent(Sprite);
        if (sp?.isValid) {
            sp.color = FREEZE_COLOR;
        }
    }

    /** 受击闪色：短暂染成指定颜色后恢复原色（Sprite 缺失时静默跳过） */
    private flashHit(flashColor: Color): void {
        const sp = this.getComponent(Sprite);
        if (!sp?.isValid) {
            return;
        }
        const origin = sp.color.clone();
        sp.color = flashColor;
        this.scheduleOnce(() => {
            if (sp?.isValid) {
                // ★ 急冻色恢复修复：定身期间闪色结束后必须回到冰蓝色而不是原色，
                //   否则 froze 时的白闪/红光回调会把冰蓝冲掉，造成「解冻后颜色错乱」
                sp.color = this.isFrozen ? FREEZE_COLOR : origin;
            }
        }, HIT_FLASH_DURATION);
    }

    /** 代码生成头顶血条：背景底框 + 绿色进度条（无需手动拖拽） */
    private createHpBar(): void {
        if (!this.node?.isValid || this._hpBarRoot?.isValid) {
            return;
        }
        const root = new Node(`HpBar_${this.node.name}`);
        root.layer = this.node.layer;
        root.getComponent(UITransform) ?? root.addComponent(UITransform);

        // 背景底框（半透明黑）：以自身原点为中心绘制，保证随 scaleX 收缩时永不跑偏
        const bg = new Node('hpBg');
        bg.layer = this.node.layer;
        bg.getComponent(UITransform) ?? bg.addComponent(UITransform);
        const bgG = bg.addComponent(Graphics);
        bgG.fillColor = Theme.enemy.hpBarBack;
        bgG.rect(-HP_BAR_WIDTH * 0.5, -HP_BAR_BACK_HEIGHT * 0.5, HP_BAR_WIDTH, HP_BAR_BACK_HEIGHT);
        bgG.fill();

        // 绿色进度条（前景，受击时按比例收缩）；居中绘制 → scaleX 以中心为轴收缩，
        // 血条在敌人头顶始终水平居中，不会因缩水而向左偏
        const fill = new Node('hpFill');
        fill.layer = this.node.layer;
        fill.getComponent(UITransform) ?? fill.addComponent(UITransform);
        const fillG = fill.addComponent(Graphics);
        fillG.fillColor = Theme.enemy.hpBarFill;
        fillG.rect(-HP_BAR_WIDTH * 0.5, -HP_BAR_FILL_HEIGHT * 0.5, HP_BAR_WIDTH, HP_BAR_FILL_HEIGHT);
        fillG.fill();

        root.addChild(bg);
        root.addChild(fill);
        this.node.addChild(root);
        root.setPosition(0, HP_BAR_OFFSET_Y, 0);

        this._hpBarRoot = root;
        this._hpBarFill = fill;
    }

    /** 按血量比例更新绿色进度条宽度（scaleX = currentHp / maxHp） */
    private updateHpBar(): void {
        if (!this._hpBarFill?.isValid) {
            return;
        }
        const ratio = this.maxHp > 0
            ? Math.max(0, Math.min(1, this.currentHp / this.maxHp))
            : 0;
        this._hpBarFill.setScale(ratio, 1, 1);
    }

    /** 🛡️ 铁甲怪专属：血条上方创建护盾层数指示点（纯代码生成，无需手动拖拽） */
    private createShieldPips(): void {
        if (this.shieldCharges <= 0) {
            return;
        }
        this.ensureShieldPipsRoot();
        this.redrawShieldPips(this.shieldCharges);
    }

    /** 惰性创建护盾弧根节点（铁甲怪出生 / Boss 首次举盾共用；幂等） */
    private ensureShieldPipsRoot(): void {
        if (this._shieldPipsRoot?.isValid || !this.node?.isValid) {
            return;
        }
        const root = new Node(`ShieldPips_${this.node.name}`);
        root.layer = this.node.layer;
        root.getComponent(UITransform) ?? root.addComponent(UITransform);
        this.node.addChild(root);
        root.setPosition(0, 0, 0); // 环绕护盾弧以身体中心为圆心
        this._shieldPipsRoot = root;
    }

    /** 按剩余护盾层数重绘环绕护盾弧（身体外圈上半圆均分；层数归零整圈隐藏）。
     *  count 由调用方传入：铁甲怪格挡传 shieldCharges，Boss 坚盾传 _bulwarkLayers，共用一套视觉。 */
    private redrawShieldPips(count: number): void {
        const root = this._shieldPipsRoot;
        if (!root?.isValid) {
            return;
        }
        if (count <= 0) {
            root.active = false;
            return;
        }
        root.active = true;
        const g = root.getComponent(Graphics) ?? root.addComponent(Graphics);
        g.clear();
        g.lineWidth = 4.5;
        g.strokeColor = SHIELD_PIP_COLOR;
        const n = count;
        const radius = ENEMY_BODY_RADIUS + 9;
        const gap = 22 * Math.PI / 180;
        const span = (Math.PI - gap * (n - 1)) / n; // 均分上半圆 180°
        for (let i = 0; i < n; i++) {
            const a0 = i * (span + gap);
            g.arc(0, 0, radius, a0, a0 + span, true);
            g.stroke();
        }
    }

    /**
     * 敌人美术叠层（幂等，纯代码零资源）：
     * ① 落地投影：压扁暗椭圆（子节点 y 压缩实现），伪景深让敌人「立」在场地上；
     * ② 深色轮廓描边 + 类型剪影：铁甲=胸前盾弧 / 突袭=左向尖角 / 史莱姆=顶部气泡 / Boss=冠刺。
     */
    private ensureEnemyArt(): void {
        if (!this.node?.isValid || this.node.getChildByName('EnemyShadow')) {
            return;
        }
        // ① 落地投影
        const shadow = new Node('EnemyShadow');
        shadow.layer = this.node.layer;
        shadow.addComponent(UITransform);
        const sg = shadow.addComponent(Graphics);
        sg.fillColor = Theme.enemy.shadow;
        sg.circle(0, 0, ENEMY_BODY_RADIUS * 0.95);
        sg.fill();
        shadow.setScale(1, 0.32, 1);
        shadow.setPosition(0, -ENEMY_BODY_RADIUS * 1.18, 0);
        this.node.addChild(shadow);

        // ② 轮廓描边 + 类型剪影
        const art = new Node('EnemyArt');
        art.layer = this.node.layer;
        art.addComponent(UITransform);
        const g = art.addComponent(Graphics);
        const R = ENEMY_BODY_RADIUS;
        g.lineWidth = 3;
        g.strokeColor = Theme.enemy.outline;
        g.circle(0, 0, R);
        g.stroke();
        switch (this.enemyType) {
            case EnemyType.Shield: {
                // 盾弧：胸前一道厚弧
                g.strokeColor = Theme.enemy.shieldPip;
                g.lineWidth = 5;
                g.arc(0, 0, R * 0.62, 20 * Math.PI / 180, 160 * Math.PI / 180, true);
                g.stroke();
                break;
            }
            case EnemyType.Speed: {
                // 左向双尖角（突袭方向感）
                g.lineWidth = 3.5;
                g.strokeColor = Theme.enemy.mark;
                g.moveTo(R * 0.55, R * 0.5);
                g.lineTo(-R * 0.25, 0);
                g.lineTo(R * 0.55, -R * 0.5);
                g.stroke();
                break;
            }
            case EnemyType.Slime: {
                // 顶部两颗气泡（黏液质感）
                g.fillColor = Theme.enemy.mark;
                g.circle(-6, R * 0.72, 5);
                g.fill();
                g.circle(6, R * 0.9, 3);
                g.fill();
                break;
            }
            case EnemyType.Boss: {
                // 冠刺：三连尖刺
                g.lineWidth = 3.5;
                g.strokeColor = Theme.enemy.mark;
                g.moveTo(-R * 0.6, R * 0.55);
                g.lineTo(-R * 0.35, R * 1.05);
                g.lineTo(-R * 0.1, R * 0.62);
                g.lineTo(R * 0.15, R * 1.15);
                g.lineTo(R * 0.4, R * 0.6);
                g.lineTo(R * 0.6, R * 0.95);
                g.lineTo(R * 0.7, R * 0.5);
                g.stroke();
                break;
            }
            default:
                break; // 普通怪：仅轮廓
        }
        this.node.addChild(art);
    }

    /** 死亡：注销 + 缩小淡出 + 销毁 */
    private die(): void {
        if (this._dead) {
            return;
        }
        this._dead = true;
        // 死亡即注销（事件广播，幂等；后续 onDestroy 重复广播由 unregisterEnemy 的 indexOf 去重兜底）
        EventBus.emit(GameEvents.ENEMY_REMOVED, this);
        // 🦠 史莱姆分裂：先广播分裂请求（WaveManager 同步生成小怪并把本波总数 +count），再广播击杀，
        //   保证「先扩容、后计杀」，最后一只史莱姆死亡时波次不会提前结算
        if (this.enemyType === EnemyType.Slime && !this.isMini && this.node?.isValid) {
            EventBus.emit(GameEvents.ENEMY_SPLIT, {
                x: this.node.position.x,
                y: this.node.position.y,
                count: ENEMY_TYPE_STATS[EnemyType.Slime].splitCount,
                hp: this.maxHp,
                speed: this.moveSpeed,
            });
        }
        // 🎖️ 随从词缀：精英死亡召唤 2 只亲卫（复用诏令 summon 管线；不掉金币——亲卫本身就是漏防惩罚）
        if (this.affix === EnemyAffix.Retinue && !this.isMini && this.node?.isValid) {
            const s = AFFIX_STATS[EnemyAffix.Retinue];
            EventBus.emit(GameEvents.ENEMY_SPLIT, {
                x: this.node.position.x - 30,
                y: this.node.position.y,
                count: s.summonCount,
                hp: Math.max(1, Math.round(this.maxHp * s.summonHpRatio)),
                speed: this.moveSpeed,
                summon: true,
                goldDrop: 0,
                spawnType: EnemyType.Normal,
            });
        }
        // 停掉 Boss 狂暴回复等全部定时器（死亡后不再回血）
        this.unscheduleAllCallbacks();
        // 通知波次管理器：本敌已被击杀（用于波次结算）
        EventBus.emit(GameEvents.ENEMY_KILLED, this);
        // 💰 亲卫死亡奖励（Boss 君王诏令置位 goldOnDeath）：把压力转成经济机会，鼓励应对而非逃避
        if (this.goldOnDeath > 0 && this.node?.isValid) {
            GoldManager.instance?.addGold(this.goldOnDeath);
            FloatingTextManager.instance?.showText(
                `+${this.goldOnDeath} 💰`,
                new Vec3(this.node.worldPosition.x, this.node.worldPosition.y + HIT_TEXT_OFFSET_Y, 0),
                Theme.ui.gold,
            );
        }
        // ★ 死亡爆浆：体色碎片向下抛洒
        const stats = ENEMY_TYPE_STATS[this.enemyType];
        if (stats) {
            FxManager.gibs(this.node.worldPosition, rgb(stats.color.r, stats.color.g, stats.color.b), 7);
        }
        if (this._hpBarRoot?.isValid) {
            this._hpBarRoot.active = false;
        }

        const node = this.node;
        Tween.stopAllByTarget(node);
        // 死亡：身体爆开（撑大）→ 缩小淡出（Node 无 opacity tween 属性，缩放即视觉淡出）
        const explode = this._baseScale.clone().multiplyScalar(DIE_EXPLODE_SCALE);
        tween(node)
            .to(0.06, { scale: explode })
            .to(DIE_ANIM_DURATION, { scale: new Vec3(0, 0, 0) })
            .call(() => {
                if (node.isValid) {
                    node.destroy();
                }
            })
            .start();
    }
}
