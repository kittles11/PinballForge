import type { WaveDef } from './DataModels';

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
/** 普通怪基础 HP（1-1 = 140）：此后每章 +90、每关 +12 线性递增（再乘 Boss×4.5 / 精英×2.5） */
const BASE_HP = 140;
/** 精英怪（每关第 3 波）血量倍率：第 5 关精英关也沿用 2.5（约 350+ HP） */
const ELITE_HP_MULT = 2.5;
/** 章节大 Boss 血量倍率：相对普通怪整体 ×4.5（约 750 HP），不再与精英倍率叠加 */
const BOSS_HP_MULT = 4.5;

/** 波次兵力表（下标 = waveIndex - 1）：第 1 波 3 只 / 第 2 波 4 只 / 第 3 波 1 只精英 */
const WAVE_COUNTS = [3, 4, 1];
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
    /** 当前章节（1 ~ 50） */
    currentChapter = 1;
    /** 当前关卡（1 ~ 10） */
    currentLevel = 1;
    /** 当前波次游标：由 WaveManager 每波开始时同步（供 getProgressText 展示） */
    currentWave = 1;

    /** 从本地存档恢复进度（新开局调用；无存档则保持 1-1） */
    loadFromSave(): void {
        try {
            const raw = localStorage.getItem(SAVE_KEY);
            if (!raw) {
                return;
            }
            const data = JSON.parse(raw) as { chapter?: number; level?: number };
            const chapter = typeof data?.chapter === 'number' ? data.chapter : 1;
            const level = typeof data?.level === 'number' ? data.level : 1;
            this.currentChapter = Math.min(MAX_CHAPTER, Math.max(1, Math.floor(chapter)));
            this.currentLevel = Math.min(LEVELS_PER_CHAPTER, Math.max(1, Math.floor(level)));
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
        // 普通怪基础血量：线性重标定 = 140 + 90×(章节-1) + 12×(关卡-1)。
        // 锚点：1-1=140、5-10 精英=1520、10-10 Boss=4761、50-10 Boss=20961。
        // 旧公式 1.15^49≈895 倍指数爆炸（50-10 Boss 约 16 万血），玩家必然打不动；线性曲线下终局 Boss 约 2.1 万血仍可攻略。
        const baseHp = BASE_HP + (this.currentChapter - 1) * 90 + (this.currentLevel - 1) * 12;
        // 血量倍率：Boss ×4.5、第 3 波精英 ×2.5、普通 ×1（Boss 不叠精英倍率，整体即 ×4.5）
        const mult = isBoss ? BOSS_HP_MULT : (isLast ? ELITE_HP_MULT : 1);
        const hp = Math.round(baseHp * mult);
        // 移速随章节与关卡缓慢上涨，封顶 110
        const speed = Math.min(110, 35 + this.currentChapter * 1.2 + this.currentLevel * 0.6);

        return {
            count: WAVE_COUNTS[w - 1],
            hp,
            speed,
            spawnInterval: WAVE_SPAWN_INTERVALS[w - 1],
            isBoss,
            scale: isBoss ? BOSS_SCALE : 1,
        };
    }

    /** 关卡 +1；超过 10 则章节 +1 并重置关卡（封顶第 50 章，不再越界）；自动保存到本地存档 */
    nextLevel(): void {
        this.currentLevel += 1;
        if (this.currentLevel > LEVELS_PER_CHAPTER) {
            this.currentLevel = 1;
            // 原写法用 0 基的 chapterIdx(0~49) 与 1 基的 MAX_CHAPTER(50) 比较，条件恒假：
            // 50-10 通关后 chapterIdx+2 会把进度推到不存在的第 51 章，血量公式继续外推。
            this.currentChapter = Math.min(MAX_CHAPTER, this.currentChapter + 1);
        }
        console.log(`[LevelManager] 进入 ${this.getProgressText()}`);
        this.save();
    }

    /** 阶段进度文本：如「第 1-1 关 (1/3波)」 */
    getProgressText(): string {
        return `第 ${this.currentChapter}-${this.currentLevel} 关 (${this.currentWave}/${WAVES_PER_LEVEL}波)`;
    }

    /** 是否已完成全部 50 章（当前处于终章末关，用于通关结算） */
    isFinalBattle(): boolean {
        return this.currentChapter >= MAX_CHAPTER && this.currentLevel >= LEVELS_PER_CHAPTER;
    }

    /** 把当前进度写入本地存档 */
    private save(): void {
        try {
            localStorage.setItem(SAVE_KEY, JSON.stringify({ chapter: this.currentChapter, level: this.currentLevel }));
        } catch (e) {
            console.warn('[LevelManager] 存档写入失败', e);
        }
    }

    /** 新开一局：重置进度为 1-1 并清除本地存档 */
    resetProgress(): void {
        this.currentChapter = 1;
        this.currentLevel = 1;
        try {
            localStorage.removeItem(SAVE_KEY);
        } catch (e) {
            console.warn('[LevelManager] 清除存档失败', e);
        }
    }
}

/** 全局单例关卡管理器（纯逻辑，无需场景挂载） */
export const LevelManager = new LevelManagerClass();