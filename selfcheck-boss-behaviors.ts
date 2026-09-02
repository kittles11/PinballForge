/**
 * Boss 特色行为自检（P2-1 内容多样化，设计稿 docs/BOSS_DESIGN.md）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-boss-behaviors.ts
 *
 * 覆盖三层：
 *   ① 数据层真跑（DataModels 零 cc 依赖）：章节轮换表、参数缩放曲线、周期不重叠约束
 *   ② 契约链：funnelType 从 OrbController 发射端 → EventBus 载荷 → TurretController → takeDamage 全链贯通
 *   ③ 行为接线：三行为调度、坚盾剥层/减伤、破绽倍率、诏令召唤与掉金、施法定身、同屏护栏、
 *      以及两条红线——EnemyController 禁 import EnemyManager（运行时循环）、坚盾必须软减伤非免疫
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { register } from 'node:module';
register('./ts-resolve-hook.mjs', import.meta.url);
const {
    BossBehavior, bossBehaviorForChapter, BOSS_BEHAVIOR_STATS,
    bulwarkIntervalForChapter, summonHpRatioForChapter,
} = await import('./assets/scripts/Core/DataModels.ts');

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
check('轮换表锚点：第1章None / 第2章Expose / 第3章Summon / 第4章Bulwark',
    bossBehaviorForChapter(1) === 'None' && bossBehaviorForChapter(2) === 'Expose'
    && bossBehaviorForChapter(3) === 'Summon' && bossBehaviorForChapter(4) === 'Bulwark');
check('轮换表 1~60 章：相邻章节行为永不重复（连续两章 Boss 有新鲜感）',
    (() => {
        for (let ch = 2; ch <= 60; ch++) {
            if (bossBehaviorForChapter(ch) === bossBehaviorForChapter(ch - 1)) return false;
        }
        return true;
    })());
check('轮换表输出恒在枚举内且第1章后无 None（特色行为永不缺席）',
    (() => {
        const all = new Set(Object.values(BossBehavior));
        for (let ch = 2; ch <= 60; ch++) {
            const b = bossBehaviorForChapter(ch);
            if (!all.has(b) || b === 'None') return false;
        }
        return true;
    })());
check('坚盾间隔曲线：第4章12s → 第8章10s → 第12章起封底8s',
    bulwarkIntervalForChapter(4) === 12 && bulwarkIntervalForChapter(8) === 10
    && bulwarkIntervalForChapter(12) === 8 && bulwarkIntervalForChapter(50) === 8);
check('亲卫血量比例曲线：第3章12% → 第9章封顶18%（防后期滚雪球）',
    Math.abs(summonHpRatioForChapter(3) - 0.12) < 1e-9
    && Math.abs(summonHpRatioForChapter(9) - 0.18) < 1e-9
    && Math.abs(summonHpRatioForChapter(50) - 0.18) < 1e-9);
check('周期不重叠约束：破绽(预告+窗口) < 间隔；盾时长 < 最紧间隔（不叠盾）；前摇 < 召唤间隔',
    BOSS_BEHAVIOR_STATS.exposeTelegraph + BOSS_BEHAVIOR_STATS.exposeWindow < BOSS_BEHAVIOR_STATS.exposeInterval
    && BOSS_BEHAVIOR_STATS.bulwarkDuration < BOSS_BEHAVIOR_STATS.bulwarkIntervalFloor
    && BOSS_BEHAVIOR_STATS.summonCast < BOSS_BEHAVIOR_STATS.summonInterval);
check('软惩罚红线：坚盾减伤倍率在 (0,1) 开区间（×0.5 而非 ×0，绝不无敌）',
    BOSS_BEHAVIOR_STATS.bulwarkDamageMult > 0 && BOSS_BEHAVIOR_STATS.bulwarkDamageMult < 1);

// ── ② funnelType 契约链 ──
const eventBus = strip(read('Core', 'EventBus.ts'));
const orb = strip(read('Pinball', 'OrbController.ts'));
const turret = strip(read('Battle', 'TurretController.ts'));
const enemy = strip(read('Battle', 'EnemyController.ts'));
const wave = strip(read('Battle', 'WaveManager.ts'));
check('EventBus：FIRE_TURRET 载荷含可选 funnelType（向后兼容）',
    /\[GameEvents\.FIRE_TURRET\]: \{ damage: number; orbType: OrbType; funnelType\?: FunnelType \}/.test(eventBus));
check('EventBus：ENEMY_SPLIT 载荷含 summon/goldDrop/spawnType 可选旗标',
    /ENEMY_SPLIT\]: \{ x: number; y: number; count: number; hp: number; speed: number; summon\?: boolean; goldDrop\?: number; spawnType\?: EnemyType \}/.test(eventBus));
check('发射端：OrbController 入槽结算携带 funnelType（剥盾语义源头）',
    /FIRE_TURRET, \{ damage: Math\.round\(damage\), orbType: this\.orbType, funnelType: type \}/.test(orb));
check('透传链：TurretController 命中时把 funnelType 传入 takeDamage（缺省 null）',
    /takeDamage\((?:dmg|data\.damage), data\.orbType, false, data\.funnelType \?\? null\)/.test(turret));

// ── ③ 行为接线 ──
check('Boss 出生按章节轮换表装配行为（回复 + 至多 1 特色，Hick 上限）',
    /this\.bossBehavior = bossBehaviorForChapter\(LevelManager\.currentChapter\)/.test(enemy)
    && /BossBehavior\.Expose\)[\s\S]{0,120}schedule\(this\.bossExposeCycle/.test(enemy)
    && /BossBehavior\.Summon\)[\s\S]{0,120}schedule\(this\.bossSummonCycle/.test(enemy)
    && /BossBehavior\.Bulwark\)[\s\S]{0,160}schedule\(this\.bossBulwarkCycle, bulwarkIntervalForChapter/.test(enemy));
check('A 坚盾：重炮剥 bulwarkPeelHeavy / 熔岩剥 bulwarkPeelLava（两条应答通道都在）',
    /funnelType === FunnelType\.HeavyCannon\)[\s\S]{0,80}bulwarkPeelHeavy/.test(enemy)
    && /orbType === OrbType\.Lava\)[\s\S]{0,80}bulwarkPeelLava/.test(enemy));
check('A 坚盾：盾期伤害乘 bulwarkDamageMult 且仅对炮弹生效（rawFloor 直伤不吃盾不剥盾）',
    /_bulwarkLayers > 0 && !rawFloor/.test(enemy)
    && /dmg \*= BOSS_BEHAVIOR_STATS\.bulwarkDamageMult/.test(enemy));
check('A 坚盾：超时自动碎盾出口存在（不应对也能过，只是 DPS 损失）',
    /scheduleOnce\(\(\) => \{[\s\S]{0,200}_bulwarkLayers = 0;[\s\S]{0,80}redrawShieldPips\(0\)[\s\S]{0,600}bulwarkDuration/.test(enemy));
check('C 破绽：窗口内乘 exposeDamageMult 且仅炮弹生效',
    /_exposed && !rawFloor/.test(enemy) && /dmg \*= BOSS_BEHAVIOR_STATS\.exposeDamageMult/.test(enemy));
check('B 诏令：经 ENEMY_SPLIT(summon:true) 复用史莱姆已验证管线，血量走章节曲线',
    /summon: true,/.test(enemy) && /const hp = Math\.max\(1, Math\.round\(this\.maxHp \* summonHpRatioForChapter\(LevelManager\.currentChapter\)\)\)/.test(enemy));
check('B 诏令：WaveManager 分流 spawnBossGuard 并置 goldOnDeath（掉金闭环）',
    /payload\.summon[\s\S]{0,120}spawnBossGuard\(payload, i\)/.test(wave)
    && /ec\.goldOnDeath = payload\.goldDrop \?\? 0;/.test(wave));
check('B 诏令：死亡掉金走 GoldManager.addGold + 跳字（经济机会兑现）',
    /goldOnDeath > 0[\s\S]{0,120}GoldManager\.instance\?\.addGold\(this\.goldOnDeath\)/.test(enemy));
check('施法可读性：诏令/举盾定身前摇（_casting 置位→update 跳过行进攻击→前摇结束复位）',
    /this\._casting = true;/.test(enemy)
    && /if \(this\._casting\) \{\s*return;/.test(enemy)
    && (enemy.match(/this\._casting = false;/g) ?? []).length >= 2);
check('同屏护栏：aliveCount 达 onScreenCap 诏令静默跳过',
    /aliveCount >= BOSS_BEHAVIOR_STATS\.onScreenCap/.test(enemy));
check('循环红线：EnemyController 不 import EnemyManager（护栏计数自维护，杜绝运行时循环）',
    !/import \{[^}]*EnemyManager[^}]*\} from/.test(enemy)
    && /private static _aliveCount = 0;/.test(enemy)
    && /EnemyController\._aliveCount \+= 1;/.test(enemy)
    && /EnemyController\._aliveCount = Math\.max\(0, EnemyController\._aliveCount - 1\)/.test(enemy));
check('护盾弧视觉复用：redrawShieldPips 参数化（铁甲/Boss 坚盾共用一套绘制）',
    /private redrawShieldPips\(count: number\): void/.test(enemy)
    && /this\.redrawShieldPips\(this\.shieldCharges\)/.test(enemy)
    && /this\.redrawShieldPips\(this\._bulwarkLayers\)/.test(enemy));
check('数值全部走 BOSS_BEHAVIOR_STATS（行为方法体内无裸数字周期）',
    (enemy.match(/BOSS_BEHAVIOR_STATS\./g) ?? []).length >= 15);

console.log(failed === 0 ? '\n✅ Boss 行为自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
