/**
 * P0 上手体验包自检（纯 Node，无引擎依赖）—— v2 乐趣放大六项的关键接线校验：
 *   node --experimental-transform-types selfcheck-onboarding-p0.ts
 *
 * 覆盖：① 开火演出 + 结算大字  ② 连击音高爬升  ③ 新手三步引导
 *       ④ 漏斗常驻标注  ⑤ 音频打包修复（resources.load）  ⑥ 数值曲线线性重标定
 * 源码级断言（stripComments 后检查真实代码，杜绝注释干扰）+ 磁盘资源存在性检查 + 曲线锚点纯算术复核。
 */
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

const audio = strip(read('Core', 'AudioManager.ts'));
const level = strip(read('Core', 'LevelManager.ts'));
const funnel = strip(read('Pinball', 'FunnelSlot.ts'));
const orb = strip(read('Pinball', 'OrbController.ts'));
const shake = strip(read('Core', 'CameraShake.ts'));
const deck = strip(read('Core', 'DeckManager.ts'));
const tutorial = strip(read('Core', 'TutorialManager.ts'));

// ── ① 开火演出 + 结算大字 ──
check('入槽结算弹出「基础 ×倍率」第一段跳字',
    /\$\{Math\.round\(base\)\} ×\$\{multStr\}/.test(orb)
    && /Theme\.white/.test(orb));
check('入槽结算弹出「总伤 💥」暴击大字（颜色跟随球种拖尾色）',
    /\$\{Math\.round\(damage\)\} 💥/.test(orb) && /orbTrailColor\(this\.orbType\)/.test(orb));
check('金币槽不重复弹伤害大字（type !== FunnelType.GoldCoin 分支）',
    /if \(type !== FunnelType\.GoldCoin\)\s*\{/.test(orb));
check('炮塔开火震屏按伤害爬升（min(14, 6 + damage/100)）',
    /CameraShake\.shake\(Math\.min\(14,\s*6 \+ \(d\?\.damage \?\? 0\) \/ 100\),\s*0\.15\)/.test(shake));
check('震屏旧死代码判定已移除（d?.type === 0 不存在）',
    !/d\?\.type === 0/.test(shake));

// ── ② 连击音高爬升 ──
check('撞钉发声传入连击计数 playHit(this.hitCount + 1)',
    /AudioManager\.playHit\(this\.hitCount \+ 1\)/.test(orb));
check('playHit 按 combo 拉高 playbackRate（音调爬升保留）',
    /a\.playbackRate = Math\.min\(1 \+ Math\.max\(0, combo - 1\) \* 0\.05, 2\)/.test(audio));
check('合成音降级路径同样按 combo 爬升',
    /Math\.min\(880 \* base, 1760\)/.test(audio));

// ── ③ 新手三步引导 ──
check('TutorialManager 监听三个既有事件（WAVE_START / FIRE_TURRET / ATTACK_CASTLE）',
    /EventBus\.on\(GameEvents\.WAVE_START, this\.onWaveStart, this\)/.test(tutorial)
    && /EventBus\.on\(GameEvents\.FIRE_TURRET, this\.onFireTurret, this\)/.test(tutorial)
    && /EventBus\.on\(GameEvents\.ATTACK_CASTLE, this\.onAttackCastle, this\)/.test(tutorial));
check('三步完成后写 localStorage 完成标记 pinballforge_tutorial_done',
    /'pinballforge_tutorial_done'/.test(tutorial) && /localStorage\.setItem\(TUTORIAL_DONE_KEY, '1'\)/.test(tutorial));
check('ensureMounted 幂等自举（已完成 / 已挂载直接跳过）',
    /public static ensureMounted\(\): void/.test(tutorial)
    && /if \(TutorialManager\._mounted \|\| TutorialManager\.instance\?\.isValid\)/.test(tutorial));
check('DeckManager.onLoad 自举 TutorialManager（onLoad 早于 start，接得住第一波）',
    /protected onLoad\(\): void\s*\{\s*DeckManager\.instance = this;\s*TutorialManager\.ensureMounted\(\);/.test(deck));

// ── ④ 漏斗常驻标注 ──
check('FunnelSlot.start 幂等创建类型标注 ensureTypeLabel',
    /this\.ensureTypeLabel\(\);/.test(funnel)
    && /getChildByName\('TypeLabel'\)/.test(funnel));
check('标注文案：聚能 ×2 / 精炼 ×1.5 / 金币 +20',
    /'聚能 ×2'/.test(funnel) && /'精炼 ×1\.5'/.test(funnel) && /'金币 \+20'/.test(funnel));
check('标注用槽位主题色且位于正下方 42px',
    /FunnelSlot\.themeColor\(this\.funnelType\)/.test(funnel) && /setPosition\(0, -42, 0\)/.test(funnel));

// ── ⑤ 音频打包修复 ──
check("init 经 resources.load('audio/ding', AudioClip) 取打包后地址",
    /resources\.load\('audio\/ding', AudioClip,/.test(audio));
check('旧路径 assets/ding.mp3 保留为兜底（createPool 回退）',
    /createPool\('assets\/ding\.mp3'\)/.test(audio));
check('过期 ponytail 标记已移除（不再硬编码承诺）',
    !/ponytail:/.test(audio));
check('resources 目录已有 ding.mp3 且原始 assets/ding.mp3 保留',
    existsSync(join(ROOT, 'assets', 'resources', 'audio', 'ding.mp3'))
    && existsSync(join(ROOT, 'assets', 'ding.mp3')));

// ── ⑥ 数值曲线：线性基线 × 章节复合成长（难度方案A 曲线校准） ──
check('linearHp 线性基线：140 + 90×(章-1) + 12×(关-1)',
    /const linearHp = BASE_HP \+ \(this\.currentChapter - 1\) \* 90 \+ \(this\.currentLevel - 1\) \* 12;/.test(level));
check('baseHp 复合成长：线性基线 × HP_CHAPTER_GROWTH^(章-1)，系数锁定 1.045（防 1.15 指数爆炸回归）',
    /const baseHp = Math\.round\(linearHp \* Math\.pow\(HP_CHAPTER_GROWTH, this\.currentChapter - 1\)\);/.test(level)
    && /const HP_CHAPTER_GROWTH = 1\.045;/.test(level));
check('Boss×4.5 / 精英×2.5 倍率保持不变',
    /const BOSS_HP_MULT = 4\.5;/.test(level) && /const ELITE_HP_MULT = 2\.5;/.test(level));

// 锚点数值复核（纯算术，防公式被手滑改坏；与实现同序：先四舍五入复合基线，再乘精英/Boss 倍率）
const hp = (ch: number, lv: number) => Math.round((140 + (ch - 1) * 90 + (lv - 1) * 12) * Math.pow(1.045, ch - 1));
check('锚点：1-1 普通怪 = 140', hp(1, 1) === 140);
check('锚点：5-10 精英 = 1813', Math.round(hp(5, 10) * 2.5) === 1813);
check('锚点：10-10 Boss = 7074', Math.round(hp(10, 10) * 4.5) === 7074);
check('锚点：50-10 Boss = 181179', Math.round(hp(50, 10) * 4.5) === 181179);

console.log(failed === 0 ? '\n✅ P0 自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);