/**
 * 精英词缀自检（P2-1 下半场：普通敌人内容多样化）——
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-elite-affixes.ts
 *
 * 背景：每关第 3 波精英此前只是 ×2.5 血的"大一号"，审计点名的公式膨胀重灾区。
 * 词缀系统全部复用既有机制（铁壁=铁甲格挡弧 / 疾风=moveSpeed / 血怒=回复定时器 /
 * 随从=诏令 ENEMY_SPLIT 管线），本自检三层覆盖：
 *   ① 数据层真跑：解锁池、掷骰边界（注入 rand 确定性）、字段完整
 *   ② 波次配置真跑：isElite/isBoss 互斥矩阵（Boss 波永不叠词缀）
 *   ③ 接线断言：applyAffix 数值应用、血怒/随从消费点、徽章可读性、宣告跳字
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { register } from 'node:module';
register('./ts-resolve-hook.mjs', import.meta.url);
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};
const {
    EnemyAffix, AFFIX_STATS, AFFIX_UNLOCK_CHAPTER, affixPoolForChapter, rollEliteAffix,
} = await import('./assets/scripts/Core/DataModels.ts');
const { LevelManager } = await import('./assets/scripts/Core/LevelManager.ts');

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*/g, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// ── ① 数据层真跑 ──
check('解锁曲线：第1章仅铁壁 / 第2章+疾风 / 第3章+血怒 / 第4章起全 4 条',
    affixPoolForChapter(1).length === 1 && affixPoolForChapter(2).length === 2
    && affixPoolForChapter(3).length === 3 && affixPoolForChapter(4).length === 4
    && affixPoolForChapter(50).length === 4);
check('掷骰边界（注入 rand）：0→池首、0.999→池尾、恒不越界',
    rollEliteAffix(4, () => 0) === EnemyAffix.Bulwark
    && rollEliteAffix(4, () => 0.999999) === EnemyAffix.Retinue
    && rollEliteAffix(1, () => 0.5) === EnemyAffix.Bulwark);
check('掷骰只落在已解锁池内（第 2 章永不掷出血怒/随从）',
    (() => {
        for (let i = 0; i < 100; i++) {
            const a = rollEliteAffix(2, () => i / 100);
            if (a !== 'Bulwark' && a !== 'Haste') return false;
        }
        return true;
    })());
check('词缀表字段完整（icon/name + 各自数值项）',
    (Object.values(EnemyAffix) as string[]).every((a) => {
        const s = AFFIX_STATS[a];
        return !!s && s.icon.length > 0 && s.name.length > 0;
    })
    && AFFIX_STATS[EnemyAffix.Bulwark].shieldCharges === 2
    && AFFIX_STATS[EnemyAffix.Haste].speedMult === 1.35
    && AFFIX_STATS[EnemyAffix.Vital].regenRatio === 0.02
    && AFFIX_STATS[EnemyAffix.Retinue].summonCount === 2);
check('血怒强度 < Boss 狂暴回复（0.4%/s vs 0.83%/s，精英不抢 Boss 生态位）',
    AFFIX_STATS[EnemyAffix.Vital].regenRatio / AFFIX_STATS[EnemyAffix.Vital].regenInterval < 0.05 / 6);

// ── ② 波次配置真跑：isElite / isBoss 互斥矩阵 ──
LevelManager.currentChapter = 3;
LevelManager.currentLevel = 5;
const w1 = LevelManager.getWaveConfig(1);
const w3 = LevelManager.getWaveConfig(3);
LevelManager.currentLevel = 10;
const bossW3 = LevelManager.getWaveConfig(3);
check('普通关第 3 波 = 精英（isElite 且非 Boss）；第 1 波两者皆非',
    w3.isElite === true && w3.isBoss === false && w1.isElite === false && w1.isBoss === false);
check('第 10 关第 3 波 = Boss（isBoss 且 isElite=false：Boss 永不叠精英词缀）',
    bossW3.isBoss === true && bossW3.isElite === false);

// ── ③ 接线断言 ──
const wave = strip(read('Battle', 'WaveManager.ts'));
const enemy = strip(read('Battle', 'EnemyController.ts'));
check('出怪侧：精英波掷词缀并 applyAffix（激活前时序，onLoad 护盾弧读到叠加层数）',
    /if \(def\.isElite && !def\.isBoss\) \{\s*const affix = rollEliteAffix\(LevelManager\.currentChapter\);\s*if \(affix\) \{\s*ec\.applyAffix\(affix\);/.test(wave)
    && wave.indexOf('ec.applyAffix(affix)') < wave.indexOf('enemy.setParent(this.node)'));
check('铁壁：shieldCharges 叠加式（与铁甲天生 2 层可叠至 4，走既有格挡与弧视觉）',
    /this\.shieldCharges \+= s\.shieldCharges;/.test(enemy));
check('疾风：moveSpeed 乘算并取整',
    /this\.moveSpeed = Math\.round\(this\.moveSpeed \* s\.speedMult\);/.test(enemy));
check('血怒：start 挂定时器消费 regenInterval → vitalRegen 半强度回复',
    /affix === EnemyAffix\.Vital && s\.regenInterval[\s\S]{0,80}schedule\(this\.vitalRegen, s\.regenInterval\)/.test(enemy)
    && /private vitalRegen\(\): void/.test(enemy));
check('随从：die 走 summon 管线（先扩容后计杀时序与史莱姆/Boss 一致），goldDrop=0',
    /affix === EnemyAffix\.Retinue && !this\.isMini[\s\S]{0,400}summon: true,[\s\S]{0,40}goldDrop: 0/.test(enemy));
check('可读性：徽章常驻（AffixBadge 挂血条上方）+ 出生跳字宣告「🎖️ 图标 名！」',
    /new Node\('AffixBadge'\)/.test(enemy)
    && /n\.setPosition\(0, HP_BAR_OFFSET_Y \+ 24, 0\)/.test(enemy)
    && /🎖️ \$\{s\.icon\} \$\{s\.name\}！/.test(enemy));
check('applyAffix 幂等防御：重复施加直接覆盖标记（不叠加 moveSpeed 两次）',
    /public applyAffix\(affix: EnemyAffix\): void \{\s*this\.affix = affix;/.test(enemy));

console.log(failed === 0 ? '\n✅ 精英词缀自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
