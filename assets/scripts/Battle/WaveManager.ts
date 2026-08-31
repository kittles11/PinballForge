import {
    _decorator, Component, Node, Prefab, instantiate, Label,
    Color, Graphics, UITransform,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { EnemyController } from './EnemyController';
import {
    WaveDef, RelicType, EnemyType, ENEMY_TYPE_STATS, ENEMY_BODY_RADIUS, rollEnemyType,
} from '../Core/DataModels';
import { LevelManager, WAVES_PER_LEVEL } from '../Core/LevelManager';
import { RelicManager, CROWN_GOLD_AMOUNT, CROWN_SHIELD_AMOUNT } from '../Core/RelicManager';
import { OrbController } from '../Pinball/OrbController';
import { GoldManager } from '../Core/GoldManager';
import { CastleController } from './CastleController';

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
/** 攻城基础伤害（各类敌人 = 基础 × ENEMY_TYPE_STATS.attackDamageMult） */
const WAVE_BASE_ATTACK_DAMAGE = 10;

/**
 * 波次管理器：挂载在 BattleLayer/EnemyContainer 节点上。
 * - 接管敌人生成：按波次表在屏幕右缘按间隔出怪，并按章节/波次「混合出怪」——
 *   🔴 普通怪 / 🛡️ 铁甲怪 / ⚡ 突袭怪 / 🦠 史莱姆按权重池随机组合（Slime 第 2 章解锁，
 *   第 1 章第 1 波纯普通怪教学）；👹 Boss 波（章节第 10 关第 3 波）固定出章节大 Boss；
 *   类型数值唯一真源见 DataModels.ENEMY_TYPE_STATS；
 * - 监听 ENEMY_KILLED 结算 + ENEMY_SPLIT 扩容本波总数（史莱姆死亡分裂 2 只小怪）；
 *   本波全灭后弹出战后卡牌奖励，选择后进入下一波；最后一波完成则广播 GAME_VICTORY。
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
        // 顶部 HUD 布局：波次 / 进度文本水平居中，与居左的城堡血量、靠右的金币错开避免重叠
        if (this.waveLabel?.isValid) {
            this.waveLabel.node.setPosition(0, 590, 0);
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
        if (this.waveLabel?.isValid) {
            this.waveLabel.string = `波次: ${waveIndex}/${this.maxWaves} · ${LevelManager.getProgressText()}`;
        }
        console.log(`[Wave] ${LevelManager.getProgressText()} 第 ${waveIndex} 波开始：生成 ${def.count} 只敌人`);
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
        ec.attackDamage = Math.max(1, Math.round(WAVE_BASE_ATTACK_DAMAGE * stats.attackDamageMult));
        enemy.setScale(stats.scale, stats.scale, 1);
        // 错开 Y 高度，避免同屏多怪完全重叠
        enemy.setPosition(SPAWN_X, SPAWN_Y - index * SPAWN_Y_STEP, 0);
        enemy.setParent(this.node);
        console.log(`[Wave] 生成 ${stats.icon} ${type}：HP ${ec.maxHp} / 移速 ${ec.moveSpeed} / 攻城 ${ec.attackDamage}`);
    }

    /** 🦠 史莱姆分裂：母体死亡处同步生成小怪，并把本波总数 +count（先扩容再计杀，防止波次提前结算） */
    private onEnemySplit(payload: { x: number; y: number; count: number; hp: number; speed: number }): void {
        if (this._gameOver) {
            return;
        }
        this.waveTotalEnemies += payload.count;
        for (let i = 0; i < payload.count; i++) {
            this.spawnMiniSlime(payload, i);
        }
        console.log(`[Wave] 🦠 史莱姆分裂 +${payload.count}，本波总数增至 ${this.waveTotalEnemies}`);
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
        ec.attackDamage = Math.max(1, Math.round(WAVE_BASE_ATTACK_DAMAGE * ENEMY_TYPE_STATS[EnemyType.Slime].attackDamageMult));
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
        g.fillColor = new Color(255, 80, 80, 255);
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
        // ★ 波次全灭瞬间：立刻安全回收场上所有残余弹珠，防止它们在弹窗背后继续撞钉发声、
        //    持续占物理线程。必须在派发任何弹窗事件（奖励/商店/宝箱/胜利）之前执行。
        OrbController.recycleAllOrbs();
        // ★ 终章末关最后一波击杀 → 全游戏通关
        if (isLevelCleared && LevelManager.isFinalBattle()) {
            this._runSettled = true;
            console.log('[Game] 已完成终章最后一战，游戏通关！');
            EventBus.emit(GameEvents.GAME_VICTORY);
            return;
        }
        // 其余情形统一进入战后卡牌奖励 + 商店；REWARD_SELECTED 时再决定推进下一波 / 下一关
        console.log(`[Wave] ${isLevelCleared ? '本关' : '本波'}已清空，弹出战后卡牌奖励！`);
        EventBus.emit(GameEvents.SHOW_REWARDS);
    }

    /** 卡牌奖励 + 商店均已确认（ShopDialog「继续」广播）：推进到下一波，或下一关的起始波 */
    private onRewardSelected(): void {
        if (this._gameOver || this._runSettled || !this._waveSettled) {
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