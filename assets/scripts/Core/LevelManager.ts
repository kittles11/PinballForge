import type { WaveDef } from './DataModels';
import { DynamicDifficulty } from './DynamicDifficulty';

/** 本地存档键名：章节 / 关卡进度用全局 localStorage 持久化 */
const SAVE_KEY = 'pinballforge_progress';
/** 每章关卡数 */
const LEVELS_PER_CHAPTER = 10;
/** 每关波数（唯一真源，WaveManager 等消费方从此引用，避免改一处漏一处造成波次表错位） */
export const WAVES_PER_LEVEL = 3;
/** 章节上限（50 章） */
const MAX_CHAPTER = 50;
/** 章节大 Boss 体型放大倍率 */
const BOSS_SCALE = 2.2;
/** 普通怪基础 HP（1-1 = 140）：线性项每章 +90、每关 +12（再乘 Boss×4.5 / 精英×2.5） */
const BASE_HP = 140;
/** 章节复合成长系数（难度方案A）：玩家倍率构筑随进程指数走强，血量以同型复合曲线对齐，中后期不再脱节。
 *  2026-09-07 校准 1.045 → 1.030（tools/balance-double-halve.ts ×3 构筑口径）：原系数下第 12 章起
 *  「×3 构筑」档位已无解（回复>伤害），第 10 章 Boss 漏伤比 9.1；1.030 把 10-10 压回 0.71
 *  （0.6~0.9 目标带），成长死亡点推后到约第 20 章——25 章后为无尽挑战区（DDA 承接，设计意图）。 */
const HP_CHAPTER_GROWTH = 1.030;
/** 精英怪（每关第 3 波）血量倍率：第 5 关精英关也沿用 2.5（约 350+ HP） */
const ELITE_HP_MULT = 2.5;
/** 章节大 Boss 血量倍率：相对普通怪整体 ×4.5（约 750 HP），不再与精英倍率叠加 */
const BOSS_HP_MULT = 4.5;

/** 波次兵力表（下标 = waveIndex - 1）：第 1 波 3 只 / 第 2 波 4 只 / 第 3 波 1 只精英 */
const WAVE_COUNTS = [3, 4, 1];
/** 波次兵力成长跨度（难度方案B 压力轴，下标同 WAVE_COUNTS）：每过 N 章该波 +1 只，到 CAPS 封顶（Boss 波恒 1 只） */
const WAVE_COUNT_GROW_SPANS = [10, 8, 12];
/** 波次兵力封顶（下标同 WAVE_COUNTS）：约第 31/33/25 章到位 6/8/3，后期防线不再与第 1 章同压 */
const WAVE_COUNT_CAPS = [6, 8, 3];
/** 攻城基础伤害（1-1 = 10）：难度方案B 随章节成长，恢复「漏怪有代价」的防线压力 */
const BASE_ATTACK_DAMAGE = 10;
/** 攻城伤害每章增量（难度方案B）：第 50 章 ≈133/头槌，修城 50 金回 40 不再是无限续航 */
const ATTACK_DAMAGE_GROWTH = 2.5;
/** 伤害保底·教学期（第 1~3 章含）：维持 50，保住新手 1~2 球清波的上手正反馈 */
const DAMAGE_FLOOR_TUTORIAL = 50;
/** 伤害保底·常规（第 4 章起）：降为 25，裸球撞 1 钉不再稳赚半条怪血 */
const DAMAGE_FLOOR_STANDARD = 25;
/** 伤害保底教学期覆盖章节数（含） */
const DAMAGE_FLOOR_FREE_CHAPTERS = 3;
/** 相邻出怪间隔（秒），精英怪同帧生成 */
const WAVE_SPAWN_INTERVALS = [0.8, 0.6, 0];

/**
 * 关卡章节管理器（模块级单例，与 RelicManager 同构）：50 章 × 10 关 × 3 波的长线闯关流转。
 * - currentChapter 1~50、currentLevel 1~10，每关固定 3 波；
 * - getWaveConfig(waveIndex) 按章节 / 关卡 / 波次算法自适应生成敌人数值；
 * - nextLevel() 关 +1，超过 10 则章节 +1 并重置关卡，自动写本地存档；
 * - getProgressText() 返回「第 X-Y 关 (Z/3波)」进度文本。
 */
class LevelManagerClass {
    /** 当前章节（1 ~ 50；无尽模式下 > 50 继续外推） */
    currentChapter = 1;
    /** 当前关卡（1 ~ 10） */
    currentLevel = 1;
    /** 当前波次游标：由 WaveManager 每波开始时同步（供 getProgressText 展示） */
    currentWave = 1;
    /** 🌌 无尽模式（50 章通关后解锁）：章节不再钳制 50，数值公式继续外推 */
    endless = false;

    /** 从本地存档恢复进度（新开局调用；无存档则保持 1-1） */
    loadFromSave(): void {
        try {
            const raw = localStorage.getItem(SAVE_KEY);
            if (!raw) {
                return;
            }
            const data = JSON.parse(raw) as { chapter?: number; level?: number; endless?: boolean };
            const chapter = typeof data?.chapter === 'number' ? data.chapter : 1;
            const level = typeof data?.level === 'number' ? data.level : 1;
            this.currentChapter = Math.max(1, Math.floor(chapter));
            this.currentLevel = Math.min(LEVELS_PER_CHAPTER, Math.max(1, Math.floor(level)));
            this.endless = data?.endless === true;
            if (!this.endless) {
                // 常规进度钳制在 50 章内（无尽档不钳制，公式自行外推）
                this.currentChapter = Math.min(MAX_CHAPTER, this.currentChapter);
            }
        } catch (e) {
            console.warn('[LevelManager] 读取存档失败，从 1-1 开始', e);
        }
    }

    /**
     * 请求指定波次（1~3）的出怪配置：血量 / 移速按当前章节与关卡算法自适应，
     * 第 3 波精英怪血量 ×2.5；当前章节第 10 关的第 3 波为章节大 Boss（×4.5 血、2.2 倍体型）。
     */
    getWaveConfig(waveIndex: number): WaveDef {
        const w = Math.max(1, Math.min(WAVES_PER_LEVEL, Math.floor(waveIndex)));
        const isLast = (w === WAVES_PER_LEVEL);
        // 章节大 Boss：当前章节第 10 关的第 3 波精英升级为 Boss
        const isBoss = isLast && this.currentLevel === LEVELS_PER_CHAPTER;
        // 普通怪基础血量：线性基线 × 章节复合成长（难度方案A 曲线校准）。
        // 线性项 = 140 + 90×(章节-1) + 12×(关卡-1)，保住前期锚点手感；复合项 ×1.045^(章节-1) 对齐玩家倍率构筑的指数走强。
        // 锚点：1-1=140、5-10 精英=1813、10-10 Boss=7074、50-10 Boss=181179（旧纯线性 1520/4761/20961，中后期缺口 ×1.2~×8.6）。
        // 最早版 1.15^49≈895 倍指数爆炸不可取：复合系数取 1.045，50 章累计 ×8.6 而非 ×895，终局仍在攻略范围。
        const linearHp = BASE_HP + (this.currentChapter - 1) * 90 + (this.currentLevel - 1) * 12;
        const baseHp = Math.round(linearHp * Math.pow(HP_CHAPTER_GROWTH, this.currentChapter - 1));
        // 血量倍率：Boss ×4.5、第 3 波精英 ×2.5、普通 ×1（Boss 不叠精英倍率，整体即 ×4.5）
        // ×动态难度隐藏修正（连续失败缓冲，玩家不可感知；GAME_PLAN 3.3 红线：不显示提示）
        const mult = (isBoss ? BOSS_HP_MULT : (isLast ? ELITE_HP_MULT : 1)) * DynamicDifficulty.getHpMult();
        const hp = Math.round(baseHp * mult);
        // 移速随章节与关卡上涨（难度方案B 压力轴）：斜率 1.2→1.8/章、封顶 110→150，后期节奏线不再冻结
        const speed = Math.min(150, 35 + this.currentChapter * 1.8 + this.currentLevel * 0.6);
        // 波次兵力随章节成长（难度方案B 压力轴）：每过 GROW_SPAN 章 +1 只、到 CAPS 封顶；Boss 波恒 1 只
        const wi = w - 1;
        const count = isBoss
            ? 1
            : Math.min(
                WAVE_COUNT_CAPS[wi],
                WAVE_COUNTS[wi] + Math.floor((this.currentChapter - 1) / WAVE_COUNT_GROW_SPANS[wi]),
            );

        return {
            count,
            hp,
            speed,
            // 出怪间隔 ×动态难度修正（连续失败缓冲：间隔拉长 = 单波同屏压力下降）
            spawnInterval: WAVE_SPAWN_INTERVALS[w - 1] * DynamicDifficulty.getSpawnIntervalMult(),
            isBoss,
            // 精英波：每关第 3 波（第 10 关升级为 Boss，不叠加词缀）
            isElite: isLast && !isBoss,
            scale: isBoss ? BOSS_SCALE : 1,
        };
    }

    /** 攻城基础伤害（难度方案B）：10 + 2.5×(章节-1)，随章节成长恢复漏怪惩罚；各类敌人再乘 ENEMY_TYPE_STATS.attackDamageMult */
    getBaseAttackDamage(): number {
        return BASE_ATTACK_DAMAGE + (this.currentChapter - 1) * ATTACK_DAMAGE_GROWTH;
    }

    /** 单次命中伤害保底（难度方案A）：第 1~3 章教学期 50，第 4 章起 25；荆棘等直伤 rawFloor 路径不受影响 */
    getDamageFloor(): number {
        return this.currentChapter <= DAMAGE_FLOOR_FREE_CHAPTERS ? DAMAGE_FLOOR_TUTORIAL : DAMAGE_FLOOR_STANDARD;
    }

    /** 关卡 +1；超过 10 则章节 +1 并重置关卡；自动保存到本地存档。
     *  常规模式封顶第 50 章（不再越界）；🌌 无尽模式章节继续 +1 外推（51、52……公式自适应）。 */
    nextLevel(): void {
        this.currentLevel += 1;
        if (this.currentLevel > LEVELS_PER_CHAPTER) {
            this.currentLevel = 1;
            // 原写法用 0 基的 chapterIdx(0~49) 与 1 基的 MAX_CHAPTER(50) 比较，条件恒假：
            // 50-10 通关后 chapterIdx+2 会把进度推到不存在的第 51 章，血量公式继续外推。
            this.currentChapter = this.endless
                ? this.currentChapter + 1
                : Math.min(MAX_CHAPTER, this.currentChapter + 1);
        }
        console.log(`[LevelManager] 进入 ${this.getProgressText()}`);
        this.save();
    }

    /** 🌌 进入无尽模式：章节推进到 51 层 1 关（同局续战，卡组/遗物/金币由场景自然保留），并写存档 */
    enterEndless(): void {
        this.endless = true;
        this.currentChapter = MAX_CHAPTER + 1;
        this.currentLevel = 1;
        console.log('[LevelManager] 🌌 进入无尽模式：第 51 层');
        this.save();
    }

    /** 阶段进度文本：如「第 1-1 关 (1/3波)」；无尽模式显示「无尽 N 层 (1/3波)」 */
    getProgressText(): string {
        const prefix = this.endless
            ? `无尽 ${this.currentChapter - MAX_CHAPTER} 层`
            : `第 ${this.currentChapter}-${this.currentLevel} 关`;
        return `${prefix} (${this.currentWave}/${WAVES_PER_LEVEL}波)`;
    }

    /** 是否已完成全部 50 章（当前处于终章末关，用于通关结算）；无尽模式中恒 false（流程无缝续战） */
    isFinalBattle(): boolean {
        return !this.endless && this.currentChapter >= MAX_CHAPTER && this.currentLevel >= LEVELS_PER_CHAPTER;
    }

    /** 把当前进度写入本地存档 */
    private save(): void {
        try {
            localStorage.setItem(SAVE_KEY, JSON.stringify({
                chapter: this.currentChapter,
                level: this.currentLevel,
                endless: this.endless,
            }));
        } catch (e) {
            console.warn('[LevelManager] 存档写入失败', e);
        }
    }

    /** 新开一局：重置进度为 1-1 并清除本地存档 */
    resetProgress(): void {
        this.currentChapter = 1;
        this.currentLevel = 1;
        this.endless = false;
        try {
            localStorage.removeItem(SAVE_KEY);
        } catch (e) {
            console.warn('[LevelManager] 清除存档失败', e);
        }
    }
}

/** 全局单例关卡管理器（纯逻辑，无需场景挂载） */
export const LevelManager = new LevelManagerClass();