/**
 * 机制应答卡 + Meta 解锁树自检（方向 2 + 方向 3）——
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-meta-cards.ts
 *
 * 覆盖：
 *   ① 应答卡数据：破盾者/清剿令/猎首契约 三张（id/actionType/value）
 *   ② EnemyController 静态倍率 + resetStaticData 全覆盖 + takeDamage 三处挂钩
 *   ③ RewardDialog applyReward 三个新 case + 洞察地板接线
 *   ④ Meta 解锁树：META_PREREQS 门控、isUnlocked、buy 拒绝未解锁、getUpgradeList 五条带 prereq
 *   ⑤ 碎片加成进 grantRunReward；enforceRarityFloor 纯函数真跑（达标/替换/优雅退化）
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
const { CARD_DATABASE, enforceRarityFloor } = await import('./assets/scripts/Core/DataModels.ts');
const { MetaManager, META_PREREQS } = await import('./assets/scripts/Core/MetaManager.ts');

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

// ── ① 应答卡数据 ──
const byId = (id: string) => CARD_DATABASE.find((c: any) => c.id === id);
check('三张应答卡在库（破盾者/清剿令/猎首契约）',
    !!byId('univ_shieldbreaker') && !!byId('univ_purge') && !!byId('univ_bounty'));
check('应答卡 actionType/value 正确（剥盾1层 / 召唤×0.5 / 精英×0.4）',
    byId('univ_shieldbreaker').actionType === 'AntiShield' && byId('univ_shieldbreaker').value === 1
    && byId('univ_purge').actionType === 'AntiSummon' && byId('univ_purge').value === 0.5
    && byId('univ_bounty').actionType === 'AntiElite' && byId('univ_bounty').value === 0.4);
check('卡库总数 16（原 13 + 应答 3）', CARD_DATABASE.length === 16);

// ── ② EnemyController 静态倍率 + 挂钩 ──
const enemy = strip(read('Battle', 'EnemyController.ts'));
check('三个静态倍率默认值（strips=0 / purge=1 / bounty=1）',
    /static shieldbreakerStrips = 0;/.test(enemy)
    && /static purgeSummonMult = 1;/.test(enemy)
    && /static bountyEliteMult = 1;/.test(enemy));
check('resetStaticData 覆盖全部五个倍率（重开零残留）',
    /resetStaticData\(\): void \{[\s\S]*?heavyOverloadMult = 1;[\s\S]*?iceVulnerableMult = 1;[\s\S]*?shieldbreakerStrips = 0;[\s\S]*?purgeSummonMult = 1;[\s\S]*?bountyEliteMult = 1;/.test(enemy));
check('破盾者挂钩：铁甲格挡额外剥离 + Boss 坚盾 peeled 累加（同一加成通吃）',
    /this\.shieldCharges -= 1 \+ EnemyController\.shieldbreakerStrips;/.test(enemy)
    && /peeled \+= EnemyController\.shieldbreakerStrips;/.test(enemy));
check('清剿令挂钩：isMini 且倍率≠1 才乘（无卡零开销）',
    /this\.isMini && EnemyController\.purgeSummonMult !== 1\)[\s\S]{0,60}dmg \*= EnemyController\.purgeSummonMult/.test(enemy));
check('猎首契约挂钩：Boss 或带词缀精英 且倍率≠1 才乘',
    /\(this\.enemyType === EnemyType\.Boss \|\| this\.affix !== null\) && EnemyController\.bountyEliteMult !== 1\)/.test(enemy));

// ── ③ RewardDialog 三 case + 洞察接线 ──
const reward = strip(read('UI', 'RewardDialog.ts'));
check('applyReward 三个应答卡 case 累加对应静态倍率',
    /case 'AntiShield'[\s\S]*?shieldbreakerStrips \+= reward\.value/.test(reward)
    && /case 'AntiSummon'[\s\S]*?purgeSummonMult \+= reward\.value/.test(reward)
    && /case 'AntiElite'[\s\S]*?bountyEliteMult \+= reward\.value/.test(reward));
check('洞察地板接线：Lv1+ 稀有地板、Lv3+ 追加史诗地板（enforceRarityFloor）',
    /const insight = MetaManager\.getInsightLv\(\);/.test(reward)
    && /insight >= 1[\s\S]{0,80}enforceRarityFloor\(this\._currentRewards, pool, '稀有'\)/.test(reward)
    && /insight >= 3[\s\S]{0,80}enforceRarityFloor\(this\._currentRewards, pool, '史诗'\)/.test(reward));

// ── ④ Meta 解锁树（行为真跑） ──
check('META_PREREQS：三根轨 null / shard 需 gold Lv3 / insight 需 damage Lv3',
    META_PREREQS.castle === null && META_PREREQS.damage === null && META_PREREQS.gold === null
    && META_PREREQS.shard.id === 'gold' && META_PREREQS.shard.lv === 3
    && META_PREREQS.insight.id === 'damage' && META_PREREQS.insight.lv === 3);
MetaManager.levels = { castle: 0, damage: 0, gold: 0, shard: 0, insight: 0 };
MetaManager.shards = 9999;
check('子轨初始锁定：gold/damage Lv0 时 shard/insight 未解锁',
    !MetaManager.isUnlocked('shard') && !MetaManager.isUnlocked('insight'));
check('未解锁拒绝购买（碎片充足也买不了 shard）', !MetaManager.buy('shard') && MetaManager.getLv('shard') === 0);
MetaManager.levels.gold = 3;
check('父轨达标即解锁：gold Lv3 → shard 解锁并可购买',
    MetaManager.isUnlocked('shard') && MetaManager.buy('shard') && MetaManager.getLv('shard') === 1);
check('canAfford 对未解锁子轨恒 false（insight 父轨未达标）',
    MetaManager.canAfford('insight') === false);
check('getUpgradeList 返回五条且带 prereq 字段（根轨 null / 子轨非 null）',
    (() => {
        const list = MetaManager.getUpgradeList();
        return list.length === 5
            && list.find((u: any) => u.id === 'castle').prereq === null
            && list.find((u: any) => u.id === 'shard').prereq !== null
            && typeof list.find((u: any) => u.id === 'insight').describe === 'function';
    })());

// ── ⑤ 碎片加成 + enforceRarityFloor 纯函数 ──
MetaManager.levels = { castle: 0, damage: 0, gold: 3, shard: 2, insight: 0 };
check('碎片收藏 Lv2 → getShardBonus=30%', MetaManager.getShardBonus() === 30);
const before = MetaManager.getShards();
const gained = MetaManager.grantRunReward(1, 1, false);
check('grantRunReward 吃碎片加成：1-1 死亡 base15 ×1.30 → 20', gained === 20);
check('加成后确实入账', MetaManager.getShards() === before + 20);

const mk = (id: string, rarity: string) => ({ id, rarity });
const pool = [mk('a', '普通'), mk('b', '普通'), mk('c', '稀有'), mk('d', '史诗'), mk('e', '普通')];
check('地板：已含达标卡则原样返回（不替换）',
    (() => {
        const drawn = [mk('c', '稀有'), mk('a', '普通'), mk('e', '普通')];
        const out = enforceRarityFloor(drawn, pool, '稀有', () => 0);
        return out.map((x: any) => x.id).join(',') === 'c,a,e';
    })());
check('地板：无达标卡则替换最弱一张（三普通 → 补入稀有，替换末位最弱）',
    (() => {
        const drawn = [mk('a', '普通'), mk('b', '普通'), mk('e', '普通')];
        const out = enforceRarityFloor(drawn, pool, '稀有', () => 0);
        return out.some((x: any) => x.id === 'c') && out.length === 3 && !out.some((x: any) => x.id === 'a');
    })());
check('地板：史诗达标替换后仍保持三张且含史诗',
    (() => {
        const drawn = [mk('a', '普通'), mk('b', '普通'), mk('e', '普通')];
        const out = enforceRarityFloor(drawn, pool, '史诗', () => 0);
        return out.some((x: any) => x.id === 'd') && out.length === 3;
    })());
check('地板：池内无达标卡优雅退化（原样返回，不崩）',
    (() => {
        const drawn = [mk('a', '普通'), mk('b', '普通')];
        const noEpic = [mk('a', '普通'), mk('b', '普通'), mk('e', '普通')];
        const out = enforceRarityFloor(drawn, noEpic, '史诗', () => 0);
        return out.map((x: any) => x.id).join(',') === 'a,b';
    })());
check('地板不改入参数组（纯函数）',
    (() => {
        const drawn = [mk('a', '普通'), mk('b', '普通'), mk('e', '普通')];
        const snapshot = drawn.map((x: any) => x.id).join(',');
        enforceRarityFloor(drawn, pool, '史诗', () => 0);
        return drawn.map((x: any) => x.id).join(',') === snapshot;
    })());

console.log(failed === 0 ? '\n✅ 应答卡 + Meta 解锁树自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
