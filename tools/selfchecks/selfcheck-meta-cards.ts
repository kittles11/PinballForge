/**
 * 机制应答卡 + Meta 解锁树自检（方向 2 + 方向 3）——
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-meta-cards.ts
 *
 * 覆盖：
 *   ① 应答卡数据：破盾者/清剿令/猎首契约 三张（id/actionType/value）
 *   ② EnemyController 静态倍率 + resetStaticData 全覆盖 + takeDamage 三处挂钩
 *   ③ RewardDialog applyReward 三个新 case + 洞察地板接线
 *   ④ Meta 解锁树：META_PREREQS 门控、isUnlocked、buy 拒绝未解锁、getUpgradeList 十条带 prereq/describe
 *   ⑤ 碎片加成进 grantRunReward；enforceRarityFloor 纯函数真跑（达标/替换/优雅退化）
 *   ⑥ 新轨接线（扩容/实验台/战备护盾）+ 跨局解锁卡数据（禁忌×2 + 等离子球）
 *   ⑦ 第 5 球种「等离子球」全分支接线安全网（OrbBalance/ArtTheme/OrbController/takeDamage/DeckManager）
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { register } from 'node:module';
register('../../ts-resolve-hook.mjs', import.meta.url);
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};
const { CARD_DATABASE, META_UNLOCKED_CARDS, enforceRarityFloor } = await import('../../assets/scripts/Core/DataModels.ts');
const { MetaManager, META_PREREQS } = await import('../../assets/scripts/Core/MetaManager.ts');

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

// ── ④ Meta 解锁树（行为真跑）：12 轨三条根深度链 ──
const LV = (o: Partial<Record<string, number>>): any =>
    ({ castle: 0, orbCap: 0, boardLab: 0, startShield: 0, siege: 0, damage: 0, gold: 0, shard: 0, bargain: 0, insight: 0, orbLab: 0, forbiddenPack: 0, ...o });
check('META_PREREQS 树形：三根轨 null + orbCap←castle3 / boardLab←orbCap2 / startShield←castle2 / siege←castle4 / shard←gold3 / bargain←gold2 / insight←damage3 / orbLab←damage2 / forbiddenPack←insight2',
    META_PREREQS.castle === null && META_PREREQS.damage === null && META_PREREQS.gold === null
    && META_PREREQS.orbCap.id === 'castle' && META_PREREQS.orbCap.lv === 3
    && META_PREREQS.boardLab.id === 'orbCap' && META_PREREQS.boardLab.lv === 2
    && META_PREREQS.startShield.id === 'castle' && META_PREREQS.startShield.lv === 2
    && META_PREREQS.siege.id === 'castle' && META_PREREQS.siege.lv === 4
    && META_PREREQS.shard.id === 'gold' && META_PREREQS.shard.lv === 3
    && META_PREREQS.bargain.id === 'gold' && META_PREREQS.bargain.lv === 2
    && META_PREREQS.insight.id === 'damage' && META_PREREQS.insight.lv === 3
    && META_PREREQS.orbLab.id === 'damage' && META_PREREQS.orbLab.lv === 2
    && META_PREREQS.forbiddenPack.id === 'insight' && META_PREREQS.forbiddenPack.lv === 2);
MetaManager.levels = LV({});
MetaManager.shards = 99999;
check('深度链初始全锁：castle/damage/gold Lv0 时九条子轨全未解锁',
    !MetaManager.isUnlocked('orbCap') && !MetaManager.isUnlocked('boardLab') && !MetaManager.isUnlocked('startShield') && !MetaManager.isUnlocked('siege')
    && !MetaManager.isUnlocked('shard') && !MetaManager.isUnlocked('bargain') && !MetaManager.isUnlocked('insight') && !MetaManager.isUnlocked('orbLab') && !MetaManager.isUnlocked('forbiddenPack'));
check('未解锁拒绝购买（碎片充足也买不了 orbCap）', !MetaManager.buy('orbCap') && MetaManager.getLv('orbCap') === 0);
// castle Lv2 → startShield；castle Lv3 → orbCap；orbCap Lv2 → boardLab（castle 双分支）
MetaManager.levels = LV({ castle: 2 });
check('castle Lv2 → startShield 解锁可买（战备护盾）',
    MetaManager.isUnlocked('startShield') && MetaManager.buy('startShield') && MetaManager.getLv('startShield') === 1);
check('castle Lv2 < 3 → orbCap 仍锁（同父不同档）', !MetaManager.isUnlocked('orbCap'));
MetaManager.levels = LV({ castle: 3 });
check('一级解锁：castle Lv3 → orbCap 解锁可买',
    MetaManager.isUnlocked('orbCap') && MetaManager.buy('orbCap') && MetaManager.getLv('orbCap') === 1);
check('二级链未通：orbCap Lv1 < 2 → boardLab 仍锁', !MetaManager.isUnlocked('boardLab'));
MetaManager.levels = LV({ castle: 3, orbCap: 2 });
check('二级解锁：orbCap Lv2 → boardLab 解锁可买',
    MetaManager.isUnlocked('boardLab') && MetaManager.buy('boardLab') && MetaManager.getLv('boardLab') === 1);
// damage Lv2 → orbLab（球种工坊）；damage Lv3 → insight → forbiddenPack（damage 双分支）
MetaManager.levels = LV({ damage: 2 });
check('damage Lv2 → orbLab 解锁可买（球种工坊）',
    MetaManager.isUnlocked('orbLab') && MetaManager.buy('orbLab') && MetaManager.getLv('orbLab') === 1);
check('damage Lv2 < 3 → insight 仍锁（同父不同档）', !MetaManager.isUnlocked('insight'));
MetaManager.levels = LV({ damage: 3, insight: 2 });
check('三级链：damage Lv3+insight Lv2 → forbiddenPack 解锁可买',
    MetaManager.isUnlocked('forbiddenPack') && MetaManager.buy('forbiddenPack') && MetaManager.getLv('forbiddenPack') === 1);
check('canAfford 对未解锁子轨恒 false（shard 父轨 gold 未达标）',
    MetaManager.canAfford('shard') === false);
// castle Lv4 → siege（攻城炮台）；gold Lv2 → bargain（商道）
MetaManager.levels = LV({ castle: 4 });
check('castle Lv4 → siege 解锁可买（攻城炮台，深分支）',
    MetaManager.isUnlocked('siege') && MetaManager.buy('siege') && MetaManager.getLv('siege') === 1);
MetaManager.levels = LV({ gold: 2 });
check('gold Lv2 → bargain 解锁可买（商道）',
    MetaManager.isUnlocked('bargain') && MetaManager.buy('bargain') && MetaManager.getLv('bargain') === 1);
check('getUpgradeList 返回十二条且带 prereq/describe（六条 describe 子轨齐全）',
    (() => {
        const list = MetaManager.getUpgradeList();
        const byId = (id: string) => list.find((u: any) => u.id === id);
        return list.length === 12
            && byId('castle').prereq === null
            && byId('orbCap').prereq !== null && byId('boardLab').prereq !== null && byId('forbiddenPack').prereq !== null
            && byId('siege').prereq !== null && byId('bargain').prereq !== null
            && typeof byId('insight').describe === 'function'
            && typeof byId('boardLab').describe === 'function'
            && typeof byId('orbLab').describe === 'function'
            && typeof byId('forbiddenPack').describe === 'function'
            && typeof byId('bargain').describe === 'function'
            && typeof byId('siege').describe === 'function';
    })());
check('describe 档位文案：boardLab Lv1→版型D / Lv3→版型D+E；orbLab Lv1→等离子 / Lv3→等离子+熔核；forbiddenPack Lv1→奇点 / Lv3→奇点+猎神；bargain/siege 百分比',
    (() => {
        const list = MetaManager.getUpgradeList();
        const bl = list.find((u: any) => u.id === 'boardLab').describe;
        const ol = list.find((u: any) => u.id === 'orbLab').describe;
        const fp = list.find((u: any) => u.id === 'forbiddenPack').describe;
        const bg = list.find((u: any) => u.id === 'bargain').describe;
        const sg = list.find((u: any) => u.id === 'siege').describe;
        return bl(1).includes('版型D') && !bl(1).includes('E') && bl(3).includes('D+E')
            && ol(0).includes('未解锁') && ol(1).includes('等离子球') && ol(3).includes('熔核') && !ol(3).includes('吸血') && ol(5).includes('吸血')
            && fp(1).includes('奇点') && !fp(1).includes('猎神') && fp(3).includes('猎神') && !fp(3).includes('不朽') && fp(5).includes('不朽')
            && bg(2).includes('16') && sg(1).includes('20');
    })());

// ── ⑤ 碎片加成 + enforceRarityFloor 纯函数 ──
MetaManager.levels = LV({ gold: 3, shard: 2 });
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

// ── ⑥ 新轨接线 + 禁忌卡数据 ──
const deck = strip(read('Core', 'DeckManager.ts'));
const board = strip(read('Pinball', 'PegBoardManager.ts'));
check('弹珠槽扩容接线：maxDeckSize = 基础 8 + getOrbCapBonus，canAddOrb 走有效容量',
    /get maxDeckSize\(\): number \{\s*return MAX_DECK_SIZE \+ MetaManager\.getOrbCapBonus\(\);/.test(deck)
    && /this\.masterDeck\.length < this\.maxDeckSize/.test(deck));
check('getOrbCapBonus 行为：orbCap Lv3 → +3',
    (() => { MetaManager.levels = LV({ orbCap: 3 }); return MetaManager.getOrbCapBonus() === 3; })());
check('钉板实验台接线：PegBoardManager 经 activePegLayouts 消费 getBoardLabLv',
    /getBoardLabLv\(\)/.test(board) && /activePegLayouts\(\)/.test(board));
check('战备护盾接线：CastleController.onLoad 套 getStartShieldBonus 到 shield',
    /this\.shield \+= MetaManager\.getStartShieldBonus\(\)/.test(read('Battle', 'CastleController.ts')));
check('getStartShieldBonus 行为：startShield Lv3 → +45',
    (() => { MetaManager.levels = LV({ startShield: 3 }); return MetaManager.getStartShieldBonus() === 45; })());
check('跨局解锁卡数据：6 张专属卡（禁忌×3 + 球种×3），metaLock 各指自己子轨，复用既有 actionType',
    META_UNLOCKED_CARDS.length === 6
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_singularity').metaLock.track === 'forbiddenPack'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_singularity').metaLock.lv === 1
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_singularity').actionType === 'BuffHeavy'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_godslayer').metaLock.lv === 3
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_godslayer').actionType === 'AntiElite'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_immortal').metaLock.track === 'forbiddenPack'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_immortal').metaLock.lv === 5
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_immortal').actionType === 'MaxHp'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'forb_immortal').value === 80
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_plasma').metaLock.track === 'orbLab'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_plasma').metaLock.lv === 1
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_plasma').actionType === 'AddOrb'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_plasma').orbType === 4
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_magma').metaLock.track === 'orbLab'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_magma').metaLock.lv === 3
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_magma').actionType === 'AddOrb'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_magma').orbType === 5
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_leech').metaLock.track === 'orbLab'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_leech').metaLock.lv === 5
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_leech').actionType === 'AddOrb'
    && META_UNLOCKED_CARDS.find((c: any) => c.id === 'orb_leech').orbType === 6);
check('跨局卡默认不在 CARD_DATABASE（常规局抽不到，仅经对应子轨解锁并入池）',
    !CARD_DATABASE.some((c: any) => ['forb_singularity', 'forb_godslayer', 'forb_immortal', 'orb_plasma', 'orb_magma', 'orb_leech'].includes(c.id)));
check('RewardDialog 按 metaLock 档位过滤并入跨局卡（getLv(track) >= lv）',
    /META_UNLOCKED_CARDS/.test(reward)
    && /!c\.metaLock \|\| MetaManager\.getLv\(c\.metaLock\.track as MetaUpgradeId\) >= c\.metaLock\.lv/.test(reward)
    && /\[\.\.\.REWARD_CARD_POOL, \.\.\.unlockedSpecials\]/.test(reward));

// ── ⑦ 第 5/6/7 球种「等离子 / 熔核 / 吸血」全分支接线安全网（新球种最易漏挂分支 → 逐项锁死） ──
const { OrbType, OrbBalance: OB } = await import('../../assets/scripts/Core/OrbBalance.ts');
const { OrbType: OT } = await import('../../assets/scripts/Core/DataModels.ts');
const artTheme = strip(read('Core', 'ArtTheme.ts'));
const orbCtrl = strip(read('Pinball', 'OrbController.ts'));
// Task 006 拆分：球种配色命名/缩放等视觉半程已迁至 OrbView（OrbController 只留物理半程）
const orbView = strip(read('Pinball', 'OrbView.ts'));
const deckMgr = strip(read('Core', 'DeckManager.ts'));
check('OrbType.Plasma = 4（枚举新增值，不与既有 0-3 冲突）', OT.Plasma === 4);
check('OrbBalance.configFor(Plasma) 行为真跑：返回 plasma 配置 baseDamage=30 pegEnergyGain=12',
    (() => {
        const cfg = OB.configFor(OT.Plasma);
        return cfg === OB.plasma && cfg.baseDamage === 30 && cfg.pegEnergyGain === 12;
    })());
check('等离子球权衡成立：伤害吞吐低于普通球（防"无视护盾"变严格占优）',
    OB.plasma.baseDamage < OB.normal.baseDamage && OB.plasma.pegEnergyGain < OB.normal.pegEnergyGain);
check('OrbBalance 全覆盖：applyMetaBonus 与 reset 均含 plasma（漏一处即伤害/重开不生效）',
    /this\.plasma\.baseDamage = DEFAULT_PLASMA\.baseDamage \+ bonus/.test(OB_src())
    && /Object\.assign\(this\.plasma, DEFAULT_PLASMA\)/.test(OB_src()));
function OB_src(): string { return strip(read('Core', 'OrbBalance.ts')); }
check('ArtTheme 配色全覆盖：Theme.orb.plasma + 拖尾[4] + 瞄准[4]（漏拖尾/瞄准即回退银白）',
    /plasma: hex\(C_PLASMA\)/.test(artTheme)
    && /4: hex\(C_PLASMA\)/.test(artTheme)
    && /4: hex\(C_PLASMA, 240\)/.test(artTheme));
check('Plasma 赋型拆双文件：OrbView 配色命名（Theme.orb.plasma + PlasmaOrb）+ OrbController 略重物理',
    /type === OrbType\.Plasma/.test(orbView) && /Theme\.orb\.plasma/.test(orbView) && /PlasmaOrb/.test(orbView)
    && /type === OrbType\.Plasma/.test(orbCtrl));
check('EnemyController.takeDamage：铁甲格挡与 Boss 坚盾两处均放行 Plasma（无视护盾签名机制）',
    /this\.shieldCharges > 0 && orbType !== OrbType\.Plasma/.test(enemy)
    && /this\._bulwarkLayers > 0 && !rawFloor && orbType !== OrbType\.Plasma/.test(enemy));
check('DeckManager.ORB_TYPE_NAMES 补第 5 名（漏则选卡/日志显示 undefined）',
    /'等离子球'/.test(deckMgr));
// —— 第 6 球种「熔核球」：走通用累积路径（无溅射分支），身份=超重重压 + 剥坚盾 3 层 ——
check('OrbType.Magma = 5（枚举新增值，不与既有 0-4 冲突）', OT.Magma === 5);
check('OrbBalance.configFor(Magma) 行为真跑：返回 magma 配置 baseDamage=45 pegEnergyGain=75（>熔岩 60）',
    (() => {
        const cfg = OB.configFor(OT.Magma);
        return cfg === OB.magma && cfg.baseDamage === 45 && cfg.pegEnergyGain === 75;
    })());
check('熔核球为高阶奖励：每钉能量累积高于熔岩（75>60）且起始伤害更高（45>40）',
    OB.magma.pegEnergyGain > OB.lava.pegEnergyGain && OB.magma.baseDamage > OB.lava.baseDamage);
check('OrbBalance 全覆盖：applyMetaBonus 与 reset 均含 magma',
    /this\.magma\.baseDamage = DEFAULT_MAGMA\.baseDamage \+ bonus/.test(OB_src())
    && /Object\.assign\(this\.magma, DEFAULT_MAGMA\)/.test(OB_src()));
check('ArtTheme 配色全覆盖：Theme.orb.magma + 拖尾[5] + 瞄准[5]',
    /magma: hex\(C_MAGMA\)/.test(artTheme)
    && /5: hex\(C_MAGMA\)/.test(artTheme)
    && /5: hex\(C_MAGMA, 240\)/.test(artTheme));
check('Magma 赋型拆双文件：OrbView 配色（Theme.orb.magma）+ OrbController 延迟密度重建含 Magma',
    /Theme\.orb\.magma/.test(orbView) && /type === OrbType\.Magma/.test(orbCtrl)
    && /this\.orbType === OrbType\.Magma/.test(orbCtrl));
check('EnemyController：熔核球剥坚盾 bulwarkPeelMagma=3 + 受击闪光 Magma',
    /orbType === OrbType\.Magma/.test(enemy) && /bulwarkPeelMagma/.test(enemy)
    && /case OrbType\.Magma/.test(enemy));
check('DataModels：bulwarkPeelMagma=3', /bulwarkPeelMagma: 3/.test(strip(read('Core', 'DataModels.ts'))));
check('DeckManager.ORB_TYPE_NAMES 补第 6 名 + DeckViewDialog 图例含熔核球',
    /'熔核球'/.test(deckMgr) && /OrbType\.Magma/.test(strip(read('UI', 'DeckViewDialog.ts'))));
// —— 第 7 球种「吸血球」：普通物理（非重球），身份=命中后治疗城堡（不改伤害分配） ——
check('OrbType.Leech = 6（枚举新增值，不与既有 0-5 冲突）', OT.Leech === 6);
check('OrbBalance.configFor(Leech) 行为真跑：返回 leech 配置 baseDamage=40 pegEnergyGain=18',
    (() => {
        const cfg = OB.configFor(OT.Leech);
        return cfg === OB.leech && cfg.baseDamage === 40 && cfg.pegEnergyGain === 18;
    })());
check('吸血球为普通物理球（非重球）：leech 配置无 scale/density（不碰延迟密度重建分支）',
    (OB.leech as any).scale === undefined && (OB.leech as any).density === undefined);
check('leechHealRatio = 0.25（回血倍率单一来源，OrbBalance 定义）',
    OB.leechHealRatio === 0.25);
check('OrbBalance 全覆盖：applyMetaBonus 与 reset 均含 leech',
    /this\.leech\.baseDamage = DEFAULT_LEECH\.baseDamage \+ bonus/.test(OB_src())
    && /Object\.assign\(this\.leech, DEFAULT_LEECH\)/.test(OB_src()));
check('ArtTheme 配色全覆盖：Theme.orb.leech + 拖尾[6] + 瞄准[6]',
    /leech: hex\(C_LEECH\)/.test(artTheme)
    && /6: hex\(C_LEECH\)/.test(artTheme)
    && /6: hex\(C_LEECH, 240\)/.test(artTheme));
check('Leech 赋型仅视觉（OrbView 配色命名 LeechOrb；OrbController 无 Leech 物理分支，不进延迟密度重建）',
    /type === OrbType\.Leech/.test(orbView) && /Theme\.orb\.leech/.test(orbView) && /LeechOrb/.test(orbView)
    && !/OrbType\.Leech/.test(orbCtrl));
check('TurretController：Leech 命中后按 leechHealRatio 治疗城堡（单一投递点，命中才回血；豁免单局治疗阀门，难度方案B）',
    /data\.orbType === OrbType\.Leech/.test(strip(read('Battle', 'TurretController.ts')))
    && /CastleController\.instance\?\.heal\(heal, true\)/.test(strip(read('Battle', 'TurretController.ts')))
    && /dmg \* OrbBalance\.leechHealRatio/.test(strip(read('Battle', 'TurretController.ts'))));
check('吸血单发封顶（难度方案B）：min(25%转化, leechHitHealCap=60) 在兑现处生效',
    /Math\.min\(Math\.round\(dmg \* OrbBalance\.leechHealRatio\), OrbBalance\.leechHitHealCap\)/.test(strip(read('Battle', 'TurretController.ts')))
    && OB.leechHitHealCap === 60);
check('TurretController：Leech 回血附带翠绿飘字（FloatingTextManager.showText + Theme.orb.leech）',
    /FloatingTextManager\.instance\?\.showText\(/.test(strip(read('Battle', 'TurretController.ts')))
    && /Theme\.orb\.leech/.test(strip(read('Battle', 'TurretController.ts'))));
check('EnemyController：吸血球受击闪光 case OrbType.Leech',
    /case OrbType\.Leech/.test(enemy));
check('DeckManager.ORB_TYPE_NAMES 补第 7 名 + DeckViewDialog 图例含吸血球',
    /'吸血球'/.test(deckMgr) && /OrbType\.Leech/.test(strip(read('UI', 'DeckViewDialog.ts'))));
// —— ③ 新数值轨接线：商道（ShopDialog）+ 攻城炮台（TurretController） ——
check('商道接线：ShopDialog 经 finalPrice 统一扣费与显示（乘 1 - getBargainDiscount）',
    /MetaManager\.getBargainDiscount\(\)/.test(strip(read('UI', 'ShopDialog.ts')))
    && /price = this\.finalPrice\(price\)/.test(strip(read('UI', 'ShopDialog.ts'))));
check('getBargainDiscount 行为：bargain Lv2 → 0.16，Lv5 → 封顶 0.40',
    (() => {
        MetaManager.levels = LV({ bargain: 2 });
        const a = Math.abs(MetaManager.getBargainDiscount() - 0.16) < 1e-9;
        MetaManager.levels = LV({ bargain: 5 });
        return a && Math.abs(MetaManager.getBargainDiscount() - 0.40) < 1e-9;
    })());
check('攻城炮台接线：TurretController 子弹伤害乘 (1 + getSiegeBonus)',
    /MetaManager\.getSiegeBonus\(\)/.test(strip(read('Battle', 'TurretController.ts'))));
check('getSiegeBonus 行为：siege Lv3 → 0.60',
    (() => { MetaManager.levels = LV({ siege: 3 }); return Math.abs(MetaManager.getSiegeBonus() - 0.60) < 1e-9; })());

console.log(failed === 0 ? '\n✅ 应答卡 + Meta 解锁树自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) process.exit(1);
