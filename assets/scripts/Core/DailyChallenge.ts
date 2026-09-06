/**
 * 每日挑战（模块级单例，与 SignInManager 同构；纯逻辑零 cc 依赖）。
 *
 * GAME_PLAN 3.1 每日挑战关（固定目标 + 首胜奖励）设计取舍：
 * - 完整的"固定 seed 重建关卡"需要把 WaveManager / 钉板 / 抽卡全部 RNG 注入，改动面大；
 *   本实现取**目标关**方案：按日期哈希从 1-1 ~ 50-10 确定性选定「今日挑战关」，
 *   玩家当天在该关首胜即领取额外碎片——保留"每天有专属目标"的回归动机，改动面 = 0（关卡生成零侵入）。
 * - 确定性：同一天所有玩家/所有会话看到同一目标关（日期字符串 FNV-1a 哈希，无随机数）。
 *
 * 存档：localStorage('pinballforge_challenge')，与其它存档完全独立。
 */
import { MetaManager } from './MetaManager';
import { Analytics } from './Analytics';

/** 挑战存档键（独立 key） */
const CHALLENGE_SAVE_KEY = 'pinballforge_challenge';

/** 首胜奖励（⚒ 精铸碎片） */
export const DAILY_CHALLENGE_REWARD = 60;

/** 挑战关章节范围（与关卡系统一致：50 章 × 10 关） */
const CHALLENGE_MAX_CHAPTER = 50;
const CHALLENGE_MAX_LEVEL = 10;

/** 本地日期键：YYYY-MM-DD */
function todayKey(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

/** FNV-1a 32 位字符串哈希（确定性，无引擎依赖） */
function fnv1a(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

class DailyChallengeManagerClass {
    /** 读档幂等守卫 */
    private _loaded = false;
    /** 存档记录的日期键（跨日比对用） */
    private _day = '';
    /** 今日挑战是否已领奖 */
    private _claimed = false;

    /** 从存档恢复 + 跨日重置（所有公共入口首行调用；覆盖次日重启与长会话过夜两种场景） */
    ensureLoaded(): void {
        if (!this._loaded) {
            this._loaded = true;
            try {
                const raw = localStorage.getItem(CHALLENGE_SAVE_KEY);
                if (raw) {
                    const data = JSON.parse(raw) as { day?: unknown; claimed?: unknown };
                    this._day = typeof data?.day === 'string' ? data.day : '';
                    this._claimed = data?.claimed === true;
                }
            } catch (e) {
                console.warn('[DailyChallenge] 读取存档失败，按新档处理', e);
            }
        }
        if (this._day !== todayKey()) {
            this._day = todayKey();
            this._claimed = false;
            this.save();
        }
    }

    /** 把挑战数据写入存档 */
    private save(): void {
        try {
            localStorage.setItem(
                CHALLENGE_SAVE_KEY,
                JSON.stringify({ day: this._day, claimed: this._claimed }),
            );
        } catch (e) {
            console.warn('[DailyChallenge] 存档写入失败', e);
        }
    }

    /** 今日挑战目标章节（1~50，同日确定性） */
    getTodayChapter(): number {
        this.ensureLoaded();
        return 1 + (fnv1a(`${this._day}#chapter`) % CHALLENGE_MAX_CHAPTER);
    }

    /** 今日挑战目标关卡（1~10，与章节独立哈希流，同日确定性） */
    getTodayLevel(): number {
        this.ensureLoaded();
        return 1 + (fnv1a(`${this._day}#level`) % CHALLENGE_MAX_LEVEL);
    }

    /** 指定关卡是否为今日挑战目标 */
    isFeatured(chapter: number, level: number): boolean {
        this.ensureLoaded();
        return chapter === this.getTodayChapter() && level === this.getTodayLevel();
    }

    /** 今日挑战是否已领奖 */
    hasClaimed(): boolean {
        this.ensureLoaded();
        return this._claimed;
    }

    /**
     * 通关上报：目标关首胜 → 发奖（碎片经 MetaManager.addShards 入账）。
     * 返回实际入账碎片数（非目标关 / 已领奖返回 0）。
     */
    onRunWin(chapter: number, level: number): number {
        this.ensureLoaded();
        if (this._claimed || !this.isFeatured(chapter, level)) {
            return 0;
        }
        this._claimed = true;
        this.save();
        MetaManager.addShards(DAILY_CHALLENGE_REWARD);
        Analytics.track('daily_challenge_win', {
            chapter,
            level,
            reward: DAILY_CHALLENGE_REWARD,
        });
        console.log(`[DailyChallenge] 🎯 今日挑战达成（第 ${chapter}-${level} 关）+⚒${DAILY_CHALLENGE_REWARD}`);
        return DAILY_CHALLENGE_REWARD;
    }
}

/** 全局单例（纯逻辑，无需场景挂载） */
export const DailyChallenge = new DailyChallengeManagerClass();
