/**
 * P1 死亡补偿 meta 自检（纯 Node，无引擎依赖）—— 碎片发放 + 永久升级 + 存档隔离 + 各系统接线校验：
 *   node --experimental-transform-types selfcheck-meta-reward.ts
 *
 * 覆盖：① 碎片公式与锚点（15 + (章-1)×6 + (关-1)×2，胜利×3） ② 升级价格阶梯 / 封顶 / 购买 / 余额不足
 *       ③ 三条加成接口（城堡+10 / 伤害+2 / 金币+25 每级） ④ 存档独立 key 且重开不清
 *       ⑤ 接线：ResultDialog 发放+锻造区 / CastleController / OrbBalance / DeckManager / GoldManager / GoldLabelController
 * 行为断言（MetaManager 零 cc 依赖，直接 import 真跑）+ 源码级断言（stripComments 后检查，杜绝注释干扰）。
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
    MetaManager, META_MAX_LV, META_SHARDS_BASE,
    META_SHARDS_PER_CHAPTER, META_SHARDS_PER_LEVEL, META_WIN_MULT,
} from './assets/scripts/Core/MetaManager.ts';

// ── node 无 DOM：装 localStorage stub（MetaManager 模块加载期不读档，此处先于首次 ensureLoaded 即可） ──
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

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

// ── ① 碎片公式（行为真跑） ──
check('公式常量：base=15 / 章=6 / 关=2 / 胜=3',
    META_SHARDS_BASE === 15 && META_SHARDS_PER_CHAPTER === 6
    && META_SHARDS_PER_LEVEL === 2 && META_WIN_MULT === 3);
check('新档碎片为 0（stub 无残留）', MetaManager.getShards() === 0);
check('1-1 死亡发放 15', MetaManager.grantRunReward(1, 1, false) === 15);
check('3-2 死亡发放 29（15+2×6+1×2）', MetaManager.grantRunReward(3, 2, false) === 29);
check('5-10 通关发放 171（(15+4×6+9×2)×3）', MetaManager.grantRunReward(5, 10, true) === 171);
check('非法进度（0/NaN）clamp 到 1-1 → 15', MetaManager.grantRunReward(0, Number.NaN, false) === 15);
check('发放累计入账（15+29+171+15=230）', MetaManager.getShards() === 230);

// 纯算术锚点（防公式被手滑改坏）
const shardsOf = (ch: number, lv: number, win: boolean): number =>
    (15 + (ch - 1) * 6 + (lv - 1) * 2) * (win ? 3 : 1);
check('锚点：10-10 死亡 = 87', shardsOf(10, 10, false) === 87);
check('锚点：50-10 通关 = 981', shardsOf(50, 10, true) === 981);

// ── ② 价格阶梯 / 购买 / 封顶 ──
check('首级价格：城堡20 / 打磨25 / 资金15',
    MetaManager.getPrice('castle') === 20 && MetaManager.getPrice('damage') === 25 && MetaManager.getPrice('gold') === 15);
check('购买城堡 Lv1：扣 20，加成 +10', MetaManager.buy('castle') && MetaManager.getShards() === 210 && MetaManager.getCastleBonus() === 10);
check('二级价格线性阶梯（20→40）', MetaManager.getPrice('castle') === 40);
check('购买城堡 Lv2：加成 +20', MetaManager.buy('castle') && MetaManager.getCastleBonus() === 20);
check('打磨 Lv1：伤害加成 +2', MetaManager.buy('damage') && MetaManager.getDamageBonus() === 2);
check('资金 Lv1：开局金币加成 +25', MetaManager.buy('gold') && MetaManager.getGoldBonus() === 25);

(MetaManager as any).shards = 10;
check('余额不足拒绝购买（10 < 50）', !MetaManager.buy('damage') && MetaManager.getLv('damage') === 1);

(MetaManager as any).shards = 999;
const bought = [MetaManager.buy('castle'), MetaManager.buy('castle'), MetaManager.buy('castle')];
check('补足碎片后连买城堡三级到满级（60+80+100）', bought.every(Boolean) && MetaManager.getLv('castle') === 5);
check('满级：Lv5 / isMaxed / getPrice=-1 / 再买拒绝',
    META_MAX_LV === 5 && MetaManager.isMaxed('castle')
    && MetaManager.getPrice('castle') === -1 && !MetaManager.buy('castle'));
check('满级加成封顶 +50', MetaManager.getCastleBonus() === 50);

// ── ③ 存档持久化（stub round-trip：清内存重读档，状态恢复） ──
MetaManager.shards = 1;
MetaManager.levels = { castle: 0, damage: 0, gold: 0, shard: 0, insight: 0 };
(MetaManager as any)._loaded = false;
MetaManager.ensureLoaded();
check('存档 round-trip：碎片/等级从 localStorage 恢复',
    MetaManager.getShards() === 759 && MetaManager.getLv('castle') === 5
    && MetaManager.getLv('damage') === 1 && MetaManager.getLv('gold') === 1);


// ── ④ 存档隔离：meta key 独立于进度 key，重开不清 meta ──
const meta = strip(read('Core', 'MetaManager.ts'));
const level = strip(read('Core', 'LevelManager.ts'));
const result = strip(read('UI', 'ResultDialog.ts'));

check("meta 存档用独立 key 'pinballforge_meta'", /'pinballforge_meta'/.test(meta));
check('meta 不触碰进度 key（pinballforge_progress 只归 LevelManager）',
    !meta.includes('pinballforge_progress') && /'pinballforge_progress'/.test(level));
const restartBody = (result.match(/private onRestartClick\(\): void \{[\s\S]*?\n    \}/) || [''])[0];
check('重开流程不清 meta（onRestartClick 不触碰 MetaManager）',
    restartBody.length > 0 && !restartBody.includes('MetaManager'));

// ── ⑤ 结算发放 + 锻造区接线（ResultDialog） ──
check('showResult 发放碎片：grantRunReward(章节, 关卡, isWin)',
    /MetaManager\.grantRunReward\(\s*LevelManager\.currentChapter, LevelManager\.currentLevel, isWin,?\s*\)/.test(result));
check('发放防重标志 _rewardGranted（一次结算只发一次）', /if \(!this\._rewardGranted\)/.test(result));
check('锻造区幂等创建 ensureForgeSection + 刷新 refreshForge',
    /this\.ensureForgeSection\(\);/.test(result) && /this\.refreshForge\(\);/.test(result));
check('锻造区十二条升级来自 getUpgradeList（整行可点 onForgeRowClick → MetaManager.buy）',
    /const list = MetaManager\.getUpgradeList\(\);/.test(result)
    && /\.map\(\(u, i\) =>/.test(result)
    && /private onForgeRowClick\(id: MetaUpgradeId\): void/.test(result)
    && /MetaManager\.buy\(id\)/.test(result));
check('锻造区摆位在 descLabel(y=40) 与 RestartButton(y=-140) 之间（12 轨三列自适应，root y=-44）',
    /setPosition\(0, -44, 0\)/.test(result));
check('锻造区列数自适应：≤4 单列 / ≤10 双列 / >10 三列（cols 三元）',
    /cols = n <= 4 \? 1 : n <= 10 \? 2 : 3/.test(result)
    && /const perCol = Math\.ceil\(n \/ cols\)/.test(result));
check('可买金色 / 不可买灰 / 满级暗灰（颜色反馈三态）',
    /FORGE_COLOR_BUYABLE : FORGE_COLOR_LOCKED/.test(result) && /FORGE_COLOR_MAXED/.test(result));
check('解锁总览预览切换：📖/💰 按钮 toggleForgePreview 翻 _forgePreview，预览模式行显效果且点击不购买',
    /private _forgePreview = false/.test(result)
    && /private toggleForgePreview\(\): void/.test(result)
    && /this\._forgePreview = !this\._forgePreview/.test(result)
    && /if \(this\._forgePreview\) \{\s*return;/.test(result)
    && /u\.describe\(lv\)/.test(result));

// ── ⑥ 加成挂点：城堡血量 / 弹珠伤害 / 开局金币 ──
const castle = strip(read('Battle', 'CastleController.ts'));
const orbBalance = strip(read('Core', 'OrbBalance.ts'));
const deck = strip(read('Core', 'DeckManager.ts'));
const gold = strip(read('Core', 'GoldManager.ts'));
const goldLabel = strip(read('Game', 'GoldLabelController.ts'));

const maxHpIdx = castle.indexOf('this.maxHp += MetaManager.getCastleBonus();');
const hpInitIdx = castle.indexOf('this.currentHp = this.maxHp;');
check('CastleController.onLoad：maxHp 先套 meta 加成再初始化 currentHp', maxHpIdx >= 0 && hpInitIdx > maxHpIdx);
check('OrbBalance.applyMetaBonus 赋值式幂等（默认值 + bonus，七球种全覆盖）',
    /static applyMetaBonus\(\): void/.test(orbBalance)
    && /this\.normal\.baseDamage = DEFAULT_NORMAL\.baseDamage \+ bonus;/.test(orbBalance)
    && /this\.lightning\.baseDamage = DEFAULT_LIGHTNING\.baseDamage \+ bonus;/.test(orbBalance)
    && /this\.lava\.baseDamage = DEFAULT_LAVA\.baseDamage \+ bonus;/.test(orbBalance)
    && /this\.frost\.baseDamage = DEFAULT_FROST\.baseDamage \+ bonus;/.test(orbBalance)
    && /this\.plasma\.baseDamage = DEFAULT_PLASMA\.baseDamage \+ bonus;/.test(orbBalance)
    && /this\.magma\.baseDamage = DEFAULT_MAGMA\.baseDamage \+ bonus;/.test(orbBalance)
    && /this\.leech\.baseDamage = DEFAULT_LEECH\.baseDamage \+ bonus;/.test(orbBalance));
const resetBody = (orbBalance.match(/static reset\(\): void \{[\s\S]*?\n    \}/) || [''])[0];
check('OrbBalance.reset() 末尾套用 meta 加成（重开一局也生效）', resetBody.includes('this.applyMetaBonus();'));
const deckOnLoad = (deck.match(/protected onLoad\(\): void \{[\s\S]*?\n    \}/) || [''])[0];
check('DeckManager.onLoad 场景首局套用 meta 加成（且不破坏 TutorialManager 自举时序）',
    deckOnLoad.includes('TutorialManager.ensureMounted();')
    && deckOnLoad.indexOf('OrbBalance.applyMetaBonus();') > deckOnLoad.indexOf('TutorialManager.ensureMounted();'));
check('GoldManager.onLoad：开局金币 = meta 加成值',
    /protected onLoad\(\): void \{\s*GoldManager\.instance = this;\s*[\s\S]*?this\.currentGold = MetaManager\.getGoldBonus\(\);/.test(gold));
const goldReset = (gold.match(/public resetGold\(\): void \{[\s\S]*?\n    \}/) || [''])[0];
check('GoldManager.resetGold：重开回到开局资金（而非清 0）',
    goldReset.includes('this.currentGold = MetaManager.getGoldBonus();'));
check('GoldLabelController.start：HUD 显示实际开局金币（硬编码 💰 0 已移除）',
    /GoldManager\.instance\?\.currentGold \?\? 0/.test(goldLabel) && !/'💰 0'/.test(goldLabel));

console.log(failed === 0 ? '\n✅ P1 死亡补偿 meta 自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
