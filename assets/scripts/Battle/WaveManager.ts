import {
    _decorator, Component, Node, Prefab, instantiate, Label, find,
    Color, Graphics, UITransform, Vec3,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { anyModalOpen } from '../Core/ModalGate';
import { EnemyController } from './EnemyController';
import {
    WaveDef, RelicType, EnemyType, ENEMY_TYPE_STATS, ENEMY_BODY_RADIUS, rollEnemyType,
    rollEliteAffixes,
} from '../Core/DataModels';
import { LevelManager, WAVES_PER_LEVEL } from '../Core/LevelManager';
import { RelicManager, CROWN_GOLD_AMOUNT, CROWN_SHIELD_AMOUNT } from '../Core/RelicManager';
import { OrbController } from '../Pinball/OrbController';
import { RewardDialog } from '../UI/RewardDialog';
import { GoldManager } from '../Core/GoldManager';
import { CastleController } from './CastleController';
import { Theme } from '../Core/ArtTheme';
import { FxManager } from '../Core/FxManager';
import { CameraShake } from '../Core/CameraShake';
import { FloatingTextManager } from '../Core/FloatingTextManager';
import { HitStop } from '../Core/HitStop';

const { ccclass, property } = _decorator;

/** 出怪 X：屏幕右边缘 */
const SPAWN_X = 320;
/** 出怪 Y 基准 */
const SPAWN_Y = 480;
/** 同波相邻敌人的 Y 错开量，避免完全重叠 */
const SPAWN_Y_STEP = 40;
/** 🦠 史莱姆分裂小怪：血量 = 母体最大生命 × 此比例 */
const MINI_SLIME_HP_RATIO = 0.35;
/** 🦠 分裂小怪体型缩放（母体为 1） */
const MINI_SLIME_SCALE = 0.55;
/** 🦠 分裂小怪在母体左右两侧的错开距离（px） */
const MINI_SLIME_OFFSET_X = 30;
// 攻城基础伤害已随章节成长（难度方案B），唯一真源在 LevelManager.getBaseAttackDamage()，此处不再私有常量避免两处漂移。
/** 每波开始补贴金币（发射已免费，此补贴为纯商店收入打底：约每波 1/9 张商店卡片的购买力） */
const WAVE_SHOT_SUBSIDY = 9;
/** 🐕 结算看门狗延迟（秒）：SHOW_REWARDS 派发后弹窗仍未激活时的重发检查间隔 */
const REWARD_WATCHDOG_DELAY = 3;

/**
 * 波次管理器：挂载在 BattleLayer/EnemyContainer 节点上。
 * - 接管敌人生成：按波次表在屏幕右缘按间隔出怪，并按章节/波次「混合出怪」——
 *   🔴 普通怪 / 🛡️ 铁甲怪 / ⚡ 突袭怪 / 🦠 史莱姆按权重池随机组合（Slime 第 2 章解锁，
 *   第 1 章第 1 波纯普通怪教学）；👹 Boss 波（章节第 10 关第 3 波）固定出章节大 Boss；
 *   类型数值唯一真源见 DataModels.ENEMY_TYPE_STATS；
 * - 监听 ENEMY_KILLED 结算 + ENEMY_SPLIT 扩容本波总数（史莱姆死亡分裂 2 只小怪）；
 *   本波全灭后：非末波直接推进（难度调整：三选一收敛为每关一次），最后一波完成则弹出战后奖励 / 广播 GAME_VICTORY。
 */
// 每关固定波数唯一真源为 LevelManager 导出的 WAVES_PER_LEVEL，此处不再私有重复，避免两处常量漂移造成波次表错位；maxWaves 默认值即从该真源取得。
@ccclass('WaveManager')
export class WaveManager extends Component {
    /** 敌人 Prefab（含 EnemyController；缺失时用场景预置敌人克隆兜底） */
    @property(Prefab)
    enemyPrefab: Prefab | null = null;

    /** 波次显示文本（在 Inspector 拖入 UILayer 下的波次 Label） */
    @property(Label)
    waveLabel: Label | null = null;

    /** 单关总波数（固定 3 波，由 LevelManager 同款常量保证一致） */
    @property
    maxWaves = WAVES_PER_LEVEL;

    /** 当前波次 */
    currentWave = 1;
    /** 本波总敌人数（🦠 史莱姆死亡分裂会动态扩容，防止波次提前结算） */
    waveTotalEnemies = 0;
    /** 本波已击杀数 */
    waveKilledEnemies = 0;

    /** 场景预置敌人模板（enemyPrefab 未配置时的运行时克隆兜底） */
    private _template: Node | null = null;

    /** GAME_OVER 后为 true：停止一切刷怪（含已排定的 scheduleOnce），杜绝结束后继续出怪 */
    private _gameOver = false;
    /** 当前波次已进入结算：拦截重复 ENEMY_KILLED / 重复 SHOW_REWARDS */
    private _waveSettled = false;
    /** 防止重复的胜利/奖励事件再次推进波次 */
    private _runSettled = false;

    protected onLoad(): void {
        EventBus.on(GameEvents.ENEMY_KILLED, this.onEnemyKilled, this);
        EventBus.on(GameEvents.ENEMY_SPLIT, this.onEnemySplit, this);
        EventBus.on(GameEvents.REWARD_SELECTED, this.onRewardSelected, this);
        EventBus.on(GameEvents.GAME_OVER, this.onGameOver, this);
        EventBus.on(GameEvents.RUN_REVIVED, this.onRunRevived, this);
        EventBus.on(GameEvents.RUN_CONTINUED, this.onRunContinued, this);
    }

    protected start(): void {
        LevelManager.loadFromSave();
        // 先克隆一份场景预置敌人作为模板，再清场：波次系统接管生成后，避免旧敌人重复/漏计
        const existing = this.node.children.find((c) => c.getComponent(EnemyController) != null);
        this._template = existing && existing.isValid ? instantiate(existing) : null;
        for (const child of [...this.node.children]) {
            if (child.getComponent(EnemyController)) {
                child.destroy();
            }
        }
        this.startWave(1);
        // 顶部 HUD 两行式布局（修复文字重叠）：第一行 y=606 城堡/金币/徽章，第二行 y=562 能量/波次
        if (this.waveLabel?.isValid) {
            this.waveLabel.node.setPosition(0, 562, 0);
            this.waveLabel.fontSize = 22;
            this.waveLabel.lineHeight = 26;
        }
    }
    protected onDestroy(): void {
        EventBus.off(GameEvents.ENEMY_KILLED, this.onEnemyKilled, this);
        EventBus.off(GameEvents.ENEMY_SPLIT, this.onEnemySplit, this);
        EventBus.off(GameEvents.REWARD_SELECTED, this.onRewardSelected, this);
        EventBus.off(GameEvents.GAME_OVER, this.onGameOver, this);
        // 生命周期清理：注销全部定时器（含未触发的出怪 scheduleOnce），防止销毁后回调悬空
        this.unscheduleAllCallbacks();
    }

    /** GAME_OVER：停止刷怪并清空已排定的出怪定时器 */
    private onGameOver(): void {
        this._gameOver = true;
        this._runSettled = true;
        this.unscheduleAllCallbacks();
    }

    /** 清空场上全部敌人节点（复活 / 续战前清场；走 onDestroy 注销，不算击杀不掉落） */
    private clearEnemies(): void {
        for (const child of [...this.node.children]) {
            if (child.isValid && child.getComponent(EnemyController)) {
                child.destroy();
            }
        }
    }

    /**
     * 📺 广告复活（RUN_REVIVED，ResultDialog 发起）：撤销本次失败，原地继续本局。
     * 残余敌人整体清掉（GAME_OVER 监听里被冻结的活体一并销毁，新怪自带干净状态），
     * 然后重开当前波（杀敌计数随 startWave 归零重刷）；城堡复活由 CastleController 处理。
     */
    private onRunRevived(): void {
        if (!this.node?.isValid || !this._gameOver) {
            return; // 未处于终局态：与本次复活无关（防御）
        }
        this._gameOver = false;
        this._runSettled = false;
        this._waveSettled = false;
        this.clearEnemies();
        this.startWave(this.currentWave);
        console.log(`[Wave] 📺 广告复活：清场后重开第 ${this.currentWave} 波`);
    }

    /**
     * 🌌 无尽续战（RUN_CONTINUED，ResultDialog 发起）：终局胜利后不重载场景继续爬层。
     * LevelManager.enterEndless() 已把进度切到无尽，这里清场并从第 1 波重新起跑；
     * 牌组 / 遗物 / 金币 / DDA 全部原地延续，故本方法不做任何构筑重置。
     */
    private onRunContinued(): void {
        if (!this.node?.isValid) {
            return;
        }
        this._gameOver = false;
        this._runSettled = false;
        this._waveSettled = false;
        this.clearEnemies();
        this.currentWave = 1;
        this.startWave(1);
        console.log('[Wave] 🌌 无尽模式续战：清场后从第 1 波重新起跑（构筑延续）');
    }

    /** 开启指定波次：刷新文本并按 LevelManager 自适应的波次配置按间隔出怪 */
    public startWave(waveIndex: number): void {
        if (this._gameOver || this._runSettled || waveIndex < 1 || waveIndex > this.maxWaves) {
            return;
        }
        // startWave 可能被重复事件或调试入口调用；先取消旧波次的出怪回调，避免串波。
        this.unscheduleAllCallbacks();
        this._waveSettled = false;
        this.currentWave = waveIndex;
        LevelManager.currentWave = waveIndex; // 供进度文本展示当前波次
        this.waveKilledEnemies = 0;
        // ★ 使用 LevelManager 自适应的波次配置（血量 / 移速 / Boss 随章节·关卡成长）
        const def = LevelManager.getWaveConfig(waveIndex);
        this.waveTotalEnemies = def.count;
        // 🎯 发射经济：每波开始补贴 9 金（≈3 发），发射消耗金币后这就是保底弹药
        GoldManager.instance?.addGold(WAVE_SHOT_SUBSIDY);
        if (this.waveLabel?.isValid) {
            this.waveLabel.string = `波次: ${waveIndex}/${this.maxWaves} · ${LevelManager.getProgressText()}`;
        }
        console.log(`[Wave] ${LevelManager.getProgressText()} 第 ${waveIndex} 波开始：生成 ${def.count} 只敌人`);
        // 广播波次开始：TutorialManager 首步引导与 OpsBridge 埋点（附录 A wave_start/run_start）的统一信源。
        // 此前本事件只有监听没有 emit（接线缺口，TutorialManager 瞄准提示因此永不触发），此处补齐。
        EventBus.emit(GameEvents.WAVE_START, { config: def });
        this.spawnBatch(def, 0);
    }

    /** 按间隔递归生成一整个波次 */
    private spawnBatch(def: WaveDef, index: number): void {
        if (this._gameOver || index >= def.count) {
            return;
        }
        this.spawnOne(def, index);
        if (def.spawnInterval > 0 && index + 1 < def.count) {
            this.scheduleOnce(() => {
                if (this.node?.isValid && !this._gameOver) {
                    this.spawnBatch(def, index + 1);
                }
            }, def.spawnInterval);
        }
    }

    /** 生成单只敌人：波次混合出怪决定类型，按 ENEMY_TYPE_STATS 套用血量/移速/体型/攻城伤害与外观 */
    private spawnOne(def: WaveDef, index: number): void {
        const enemy = this.createEnemyNode();
        if (!enemy?.isValid) {
            return;
        }
        const ec = enemy.getComponent(EnemyController);
        if (!ec) {
            enemy.destroy();
            return;
        }
        // 👹 Boss 波（章节第 10 关第 3 波）固定出 Boss；其余按波次权重池混合随机（def.enemyType 可钉死类型）
        const type = def.isBoss
            ? EnemyType.Boss
            : (def.enemyType ?? rollEnemyType(this.currentWave, LevelManager.currentChapter));
        const stats = ENEMY_TYPE_STATS[type];
        // 类型外观 + 护盾层数须在节点激活（onLoad）前设置，使 _baseColor/_baseScale 以类型外观为基准
        ec.setupType(type);
        ec.maxHp = Math.max(1, Math.round(def.hp * stats.hpMult));
        ec.currentHp = ec.maxHp; // 显式同步当前血量（onLoad 已按 maxHp 同步，此处双保险）
        ec.moveSpeed = stats.speedOverride > 0 ? stats.speedOverride : def.speed;
        ec.attackDamage = Math.max(1, Math.round(LevelManager.getBaseAttackDamage() * stats.attackDamageMult));
        enemy.setScale(stats.scale, stats.scale, 1);
        // 🎖️ 精英波（每关第 3 波非 Boss）：按章节掷一组去重词缀（难度方案B：第 10 章起 2 条 / 第 25 章起 3 条），
        // 把"大一号血包"变成机制怪；applyAffix 在节点激活前调用，onLoad 护盾弧可读到叠加层数
        if (def.isElite && !def.isBoss) {
            for (const affix of rollEliteAffixes(LevelManager.currentChapter)) {
                ec.applyAffix(affix, LevelManager.currentChapter);
            }
        }
        // 错开 Y 高度，避免同屏多怪完全重叠
        enemy.setPosition(SPAWN_X, SPAWN_Y - index * SPAWN_Y_STEP, 0);
        enemy.setParent(this.node);
        // ★ Boss 出场演出（注意力分层顶端：运动 + 意外）：红光爆闪 + 冲击环 + 震屏 + 顿帧 + 宣告跳字；
        //   普通/精英怪只保留既有出生反馈，不做全场级演出，保证「该看哪」的强度差
        if (type === EnemyType.Boss) {
            const pos = enemy.worldPosition;
            FxManager.blast(pos, Theme.enemy.bodyFallback, 150);
            FxManager.flash(pos, Theme.fx.redPulse, 220, 0.14);
            CameraShake.shake(11, 0.3);
            HitStop.stop(90);
            FloatingTextManager.instance?.showText(
                'Boss 来袭！', new Vec3(pos.x, pos.y - 60, pos.z), Theme.ui.red, true,
            );
        }
        console.log(`[Wave] 生成 ${stats.icon} ${type}：HP ${ec.maxHp} / 移速 ${ec.moveSpeed} / 攻城 ${ec.attackDamage}`);
    }

    /** 🦠 史莱姆分裂 / 👑 Boss 君王诏令：母体死亡处或 Boss 身前同步生成小怪，并把本波总数 +count（先扩容再计杀，防止波次提前结算） */
    private onEnemySplit(payload: { x: number; y: number; count: number; hp: number; speed: number; summon?: boolean; goldDrop?: number; spawnType?: EnemyType }): void {
        if (this._gameOver) {
            return;
        }
        this.waveTotalEnemies += payload.count;
        for (let i = 0; i < payload.count; i++) {
            if (payload.summon) {
                this.spawnBossGuard(payload, i);
            } else {
                this.spawnMiniSlime(payload, i);
            }
        }
        console.log(payload.summon
            ? `[Wave] 👑 君王诏令 +${payload.count}，本波总数增至 ${this.waveTotalEnemies}`
            : `[Wave] 🦠 史莱姆分裂 +${payload.count}，本波总数增至 ${this.waveTotalEnemies}`);
    }

    /**
     * 👑 Boss 亲卫（君王诏令）：Normal 模板 + 显式血量（payload.hp 已由 EnemyController 按
     * 章节曲线 summonHpRatioForChapter 算好，此处不再乘小怪比例），上下错开生成，死亡掉金币。
     */
    private spawnBossGuard(payload: { x: number; y: number; hp: number; speed: number; goldDrop?: number; spawnType?: EnemyType }, index: number): void {
        const enemy = this.createEnemyNode();
        if (!enemy?.isValid) {
            return;
        }
        const ec = enemy.getComponent(EnemyController);
        if (!ec) {
            enemy.destroy();
            return;
        }
        ec.setupType(payload.spawnType ?? EnemyType.Normal, true); // isMini：亲卫不参与分裂/护盾等母体逻辑
        ec.maxHp = Math.max(1, Math.round(payload.hp));
        ec.currentHp = ec.maxHp;
        ec.moveSpeed = payload.speed;
        ec.attackDamage = Math.max(1, Math.round(LevelManager.getBaseAttackDamage() * ENEMY_TYPE_STATS[EnemyType.Normal].attackDamageMult));
        ec.goldOnDeath = payload.goldDrop ?? 0;
        enemy.setScale(1, 1, 1);
        // 召唤点上下错开，避免完全重叠
        enemy.setPosition(payload.x, payload.y + (index === 0 ? 24 : -24), 0);
        enemy.setParent(this.node);
        console.log(`[Wave] 👑 生成亲卫：HP ${ec.maxHp} / 移速 ${ec.moveSpeed} / 掉金 ${ec.goldOnDeath}`);
    }

    /** 生成分裂小怪：继承母体移速，血量按比例缩减，体型缩小且不再分裂（isMini） */
    private spawnMiniSlime(payload: { x: number; y: number; hp: number; speed: number }, index: number): void {
        const enemy = this.createEnemyNode();
        if (!enemy?.isValid) {
            return;
        }
        const ec = enemy.getComponent(EnemyController);
        if (!ec) {
            enemy.destroy();
            return;
        }
        ec.setupType(EnemyType.Slime, true); // isMini：小怪不再分裂，防无限套娃
        ec.maxHp = Math.max(1, Math.round(payload.hp * MINI_SLIME_HP_RATIO));
        ec.currentHp = ec.maxHp;
        ec.moveSpeed = payload.speed;
        ec.attackDamage = Math.max(1, Math.round(LevelManager.getBaseAttackDamage() * ENEMY_TYPE_STATS[EnemyType.Slime].attackDamageMult));
        enemy.setScale(MINI_SLIME_SCALE, MINI_SLIME_SCALE, 1);
        // 在母体左右两侧错开生成，避免完全重叠
        enemy.setPosition(
            payload.x + (index % 2 === 0 ? -MINI_SLIME_OFFSET_X : MINI_SLIME_OFFSET_X),
            payload.y + 10, 0,
        );
        enemy.setParent(this.node);
        console.log(`[Wave] 生成 🦠 史莱姆小怪：HP ${ec.maxHp} / 移速 ${ec.moveSpeed}`);
    }

    /** 敌人节点来源：Prefab > 场景模板克隆 > 运行时手搓红点怪（保证流程测试可跑通） */
    private createEnemyNode(): Node | null {
        if (this.enemyPrefab?.isValid) {
            return instantiate(this.enemyPrefab);
        }
        if (this._template?.isValid) {
            return instantiate(this._template);
        }
        const node = new Node('WaveEnemy');
        node.layer = this.node.layer;
        node.addComponent(UITransform).setContentSize(48, 48);
        const g = node.addComponent(Graphics);
        g.fillColor = Theme.enemy.bodyFallback; // 兜底红怪体色（与 DataModels.Normal 一致）
        g.circle(0, 0, ENEMY_BODY_RADIUS);
        g.fill();
        node.addComponent(EnemyController);
        return node;
    }

    /** ENEMY_KILLED 结算：本波全灭后弹出卡牌奖励 + 商店（选择后推进波次/关卡） */
    private onEnemyKilled(_enemy: EnemyController): void {
        if (this._gameOver || this._waveSettled) {
            return;
        }
        this.waveKilledEnemies++;
        if (this.waveTotalEnemies <= 0 || this.waveKilledEnemies < this.waveTotalEnemies) {
            return;
        }
        this._waveSettled = true;
        this.unscheduleAllCallbacks();
        const isLevelCleared = this.currentWave >= this.maxWaves;
        console.log(`[Wave] 第 ${this.currentWave}/${this.maxWaves} 波全灭结算：killed=${this.waveKilledEnemies}/${this.waveTotalEnemies}，关卡清空=${isLevelCleared}`);
        // ★ 波次全灭瞬间：立刻安全回收场上所有残余弹珠，防止它们在弹窗背后继续撞钉发声、
        //    持续占物理线程。必须在派发任何弹窗事件（奖励/商店/宝箱/胜利）之前执行。
        //    结算链加固（2026-09-04）：回收异常只记日志不阻断——曾出现弹窗链某环抛异常
        //    导致 SHOW_REWARDS 永不发出、_waveSettled 挡死重入、游戏永久卡在波次间。
        try {
            OrbController.recycleAllOrbs();
        } catch (e) {
            console.error('[Wave] 残余弹珠回收异常（已隔离，不阻断结算）', e);
        }
        // ★ 终章末关最后一波击杀 → 全游戏通关
        if (isLevelCleared && LevelManager.isFinalBattle()) {
            this._runSettled = true;
            console.log('[Game] 已完成终章最后一战，游戏通关！');
            EventBus.emit(GameEvents.GAME_VICTORY);
            return;
        }
        // 难度调整（三选一收敛为每关一次）：仅本关最后一波弹出卡牌奖励；
        // 第 1/2 波直接广播 REWARD_SELECTED —— WaveManager 推进下一波、PegBoardManager 重排钉板，不发奖励。
        if (!isLevelCleared) {
            console.log(`[Wave] 本波已清空（第 ${this.currentWave}/${this.maxWaves} 波），无奖励自动推进下一波`);
            EventBus.emit(GameEvents.REWARD_SELECTED);
            return;
        }
        // 本关清空：弹出战后卡牌奖励（第 5/10 关为遗物宝箱；3/6/9 关选完无缝转入商店）
        console.log('[Wave] 本关已清空，弹出战后卡牌奖励（每关一次）！');
        try {
            EventBus.emit(GameEvents.SHOW_REWARDS);
        } catch (e) {
            console.error('[Wave] SHOW_REWARDS 派发异常（RewardDialog 内部出错，见上方堆栈）', e);
        }
        // 兜底开门：emit 后若仍无任何模态弹窗激活（监听丢失 / 弹窗节点在场景中被失活），
        // 直接抓 RewardDialog 组件调用 showRewards（组件方法不依赖节点激活态，见方法注释）
        this.openRewardDialogFallback();
        // 🐕 看门狗（2026-09-04 回归兜底）：弹窗节点被 closeAllModals 失活后 start 永不执行、
        //   SHOW_REWARDS 监听可能丢失，且 EventTarget 无监听时 emit 静默 no-op——派发后若迟迟
        //   没有模态弹窗激活，自动重发直至弹窗打开或玩家推进，绝不让关卡推进链静默卡死。
        this.scheduleOnce(this.checkRewardWatchdog, REWARD_WATCHDOG_DELAY);
    }

    /** 🐕 结算看门狗：SHOW_REWARDS 派发后弹窗仍未激活 → 重发（自愈循环：弹窗打开或玩家推进后自动停止） */
    private checkRewardWatchdog(): void {
        if (this._gameOver || this._runSettled || !this._waveSettled) {
            return; // 已终局 / 已选卡推进：无需兜底
        }
        if (anyModalOpen()) {
            return; // 奖励 / 商店 / 结算弹窗已正常打开：交给玩家操作
        }
        console.warn('[Wave] 看门狗：SHOW_REWARDS 派发后弹窗未激活，自动重发（监听丢失兜底）');
        // 先续期再重发：即使重发因监听方内部异常中断，自愈循环本身也不停转
        this.scheduleOnce(this.checkRewardWatchdog, REWARD_WATCHDOG_DELAY);
        EventBus.emit(GameEvents.SHOW_REWARDS);
        this.openRewardDialogFallback();
    }

    /**
     * 🚪 兜底开门（2026-09-04 根因修复）：奖励弹窗节点在场景中被摆成 active=false 时，
     * 组件 onLoad 永不执行（Cocos 只在节点首次激活时调用）、SHOW_REWARDS 监听注册不上，
     * emit 永远空转——看门狗重发多少次都无济于事（三轮实测回归的共同根因）。
     * emit 后若 RewardDialog 节点仍未激活，直接抓 RewardDialog 组件调 showRewards：
     * 组件方法不依赖节点激活态即可调用，其内部会自行 active=true → 触发 onLoad/onEnable
     * 补注册监听 + 绑定卡牌。事件链正常打开弹窗时按弹窗节点真实 active 直接短路
     * （2026-09-04 1-3 回归收紧：监听悬空时 emit 静默 no-op，anyModalOpen 只能证明
     * 「有弹窗开着」，证明不了「奖励弹窗已开」——目标节点自身状态才是唯一真源）。
     */
    private openRewardDialogFallback(): void {
        if (this._gameOver || this._runSettled || !this._waveSettled) {
            return; // 已终局 / 已推进：无需兜底
        }
        const node = find('Canvas/UILayer/RewardDialog');
        if (node?.isValid && node.active) {
            return; // 奖励弹窗确已打开（事件链正常）
        }
        const dialog = node?.getComponent(RewardDialog) ?? null;
        if (dialog) {
            console.warn('[Wave] SHOW_REWARDS 事件链未打开弹窗（监听缺失），直接调用 RewardDialog.showRewards 兜底');
            try {
                dialog.showRewards();
            } catch (e) {
                console.error('[Wave] 兜底开门异常（看门狗将继续重试）', e);
            }
        } else {
            console.error('[Wave] Canvas/UILayer/RewardDialog 节点缺失，无法兜底打开奖励弹窗（请检查场景层级）');
        }
    }

    /** 卡牌奖励 + 商店均已确认（ShopDialog「继续」广播）：推进到下一波，或下一关的起始波 */
    private onRewardSelected(): void {
        // ★ 节点有效性守卫（2026-09-04）：脚本热重载/场景重建后旧 WaveManager 实例若仍挂在
        //   事件总线上，绝不能在已销毁组件上推进关卡（startWave 会触碰已销毁节点）——静默让位。
        if (!this.node?.isValid || this._gameOver || this._runSettled || !this._waveSettled) {
            return;
        }
        this._waveSettled = false;
        if (this.currentWave >= this.maxWaves) {
            // 本关最后一波完成：进入下一关（章节可能 +1），从第 1 波重新开始
            LevelManager.nextLevel();
            // ★ 王者之冕：通关一关结算时额外 +30 金币（RelicInfo 描述「通关关卡结算时额外获得」）
            if (RelicManager.hasRelic(RelicType.CrownOfKings)) {
                GoldManager.instance?.addGold(CROWN_GOLD_AMOUNT);
                CastleController.instance?.addShield(CROWN_SHIELD_AMOUNT);
            }
            this.startWave(1);
        } else {
            this.startWave(this.currentWave + 1);
        }
    }
}