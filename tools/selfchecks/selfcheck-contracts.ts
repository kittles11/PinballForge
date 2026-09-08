/**
 * 锻造契约自检（方案C：开局 Build Around）——纯 Node，无引擎依赖：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-contracts.ts
 *
 * 覆盖：
 *  ① 数据表健康：CONTRACTS 三条契约、id 唯一、icon 必须已在 IconLib 注册（拼错开发期暴露）、
 *     增益/代价文案非空、CONTRACT_UNLOCK_LEVEL = 2；
 *  ② ContractManager 解锁流真跑：通关第 1 关不解锁 / 通关第 2 关解锁并落盘 / 幂等；
 *  ③ OrbBalance.applyContract 三契约数值真跑（增益乘区、代价软启动 ×CONTRACT_DEBUFF_SCALE=0.5）、
 *     castleHpMult / contractGoldMult 查询式、reset() 清运行时契约且解锁资格保留；
 *  ④ 接线正则：城堡血量上限消费、金币槽产出消费、WaveManager 通关登记、RewardDialog 契约
 *     三选一门（先于藏宝箱、宝箱关豁免、每局一次）、换一批按钮契约态隐藏。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(process.cwd());
const SCRIPTS = resolve(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(resolve(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

// node 无 DOM：localStorage stub（ContractManager / MetaManager / Analytics 读档容错）
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
};

const { CONTRACTS, CONTRACT_UNLOCK_LEVEL, ContractManager } = await import('../../assets/scripts/Core/DataModels.ts');
const { OrbBalance } = await import('../../assets/scripts/Core/OrbBalance.ts');

const orbBalance = strip(read('Core', 'OrbBalance.ts'));
const reward = strip(read('UI', 'RewardDialog.ts'));
const castle = strip(read('Battle', 'CastleController.ts'));
const orbCtrl = strip(read('Pinball', 'OrbController.ts'));
const wave = strip(read('Battle', 'WaveManager.ts'));

// ---------- ① 数据表健康 ----------

check('CONTRACTS 三条契约（雷霆/熔炉/寒霜）', Array.isArray(CONTRACTS) && CONTRACTS.length === 3);
check('契约 id 唯一且为约定三值',
    new Set(CONTRACTS.map((c: { id: string }) => c.id)).size === 3
    && CONTRACTS.every((c: { id: string }) => ['contract_thunder', 'contract_forge', 'contract_frost'].includes(c.id)));
check('契约增益/代价文案非空', CONTRACTS.every((c: { boon: string; bane: string }) => c.boon.length > 0 && c.bane.length > 0));
check(`契约解锁门槛 = 通关第 ${CONTRACT_UNLOCK_LEVEL} 关`, CONTRACT_UNLOCK_LEVEL === 2);

// 契约图标必须已在 IconLib 注册（复用 selfcheck-icon-ui 的注册表键提取法）
const iconLibSrc = read('Core', 'IconLib.ts');
const dataBlock = iconLibSrc.match(/const ICON_SOURCES[\s\S]*?\n\};/)?.[0] ?? '';
const registered = new Set([...dataBlock.matchAll(/^    ([a-zA-Z]\w*): /gm)].map((m) => m[1]));
const badIcons = CONTRACTS.filter((c: { icon: string }) => !registered.has(c.icon));
check('契约图标全部已在 IconLib 注册（bolt/flame/snow）', badIcons.length === 0, badIcons.map((c: { icon: string }) => c.icon).join(', '));

// ---------- ② ContractManager 解锁流真跑 ----------

store.clear(); // 干净存档起点
check('无存档：未解锁', ContractManager.unlocked === false);
ContractManager.notifyLevelCleared(1);
check('通关第 1 关：仍不解锁（第 1 关裸体验）', ContractManager.unlocked === false);
ContractManager.notifyLevelCleared(2);
check('通关第 2 关：解锁', ContractManager.unlocked === true);
check('解锁已落盘 pinballforge_contract', store.get('pinballforge_contract') === 'true');
ContractManager.notifyLevelCleared(2);
ContractManager.notifyLevelCleared(3);
check('重复登记幂等（不覆盖已解锁状态）', ContractManager.unlocked === true);

// ---------- ③ OrbBalance 契约数值真跑（软启动 CONTRACT_DEBUFF_SCALE = 0.5） ----------

check('软启动缩放常量 0.5（验证期旋钮）', (OrbBalance as any).CONTRACT_DEBUFF_SCALE === 0.5);
OrbBalance.reset();
check('未立约：castleHpMult ×1 / contractGoldMult ×1',
    (OrbBalance as any).castleHpMult === 1 && (OrbBalance as any).contractGoldMult === 1);

// 雷霆契约：增益相对基准断言（不写死 40，兼容未来平衡调整）
const normalBase = OrbBalance.normal.baseDamage;
const lightningBase = OrbBalance.lightning.baseDamage;
OrbBalance.applyContract('contract_thunder');
check('雷霆增益：雷球伤害 ×1.5',
    Math.abs(OrbBalance.lightning.baseDamage - lightningBase * 1.5) < 1e-6);
check('雷霆增益：散射 splitCount = 5（3 连发 → 5 连发）', OrbBalance.lightning.splitCount === 5);
check('雷霆代价（软启动）：普通弹珠平伤 ×0.8（特殊球种不吞减益）',
    Math.abs(OrbBalance.normal.baseDamage - normalBase * 0.8) < 1e-6
    && Math.abs(OrbBalance.leech.baseDamage - normalBase) < 1e-6);

OrbBalance.reset();
OrbBalance.applyContract('contract_forge');
check('熔炉增益：熔岩溅射常驻（lavaAreaSplashEnabled）', OrbBalance.lavaAreaSplashEnabled === true);
check('熔炉增益：殉爆半径 ×1.5（120 → 180）', Math.abs(OrbBalance.lava.splashRadius - 180) < 1e-6);
check('熔炉代价（软启动）：金币槽产出 ×0.75', (OrbBalance as any).contractGoldMult === 0.75);

OrbBalance.reset();
OrbBalance.applyContract('contract_frost');
check('寒霜增益：冰封易伤 0.25 → 0.5', OrbBalance.frost.freezeVulnerability === 0.5);
check('寒霜增益：冻结时长 4s → 6s', OrbBalance.frost.freezeDuration === 6);
check('寒霜代价（软启动）：城堡生命上限 ×0.9', (OrbBalance as any).castleHpMult === 0.9);

OrbBalance.reset();
check('reset 清运行时契约：activeContract null / contractGoldMult ×1 / castleHpMult ×1',
    (OrbBalance as any).activeContract === null
    && (OrbBalance as any).contractGoldMult === 1
    && (OrbBalance as any).castleHpMult === 1);
check('reset 恢复全部默认：平伤/散射/溅射半径/易伤/冻结/溅射开关',
    OrbBalance.lightning.splitCount === 3 && OrbBalance.lava.splashRadius === 120
    && OrbBalance.frost.freezeVulnerability === 0.25 && OrbBalance.frost.freezeDuration === 4
    && OrbBalance.lavaAreaSplashEnabled === false);
check('reset 不清解锁资格（跨局存档独立）', ContractManager.unlocked === true);
store.clear();

// ---------- ⑤ 接线正则 ----------

check('OrbBalance.applyContract 三契约分支齐备',
    /static applyContract\(id: ContractId\): void/.test(orbBalance)
    && (orbBalance.match(/case 'contract_/g) ?? []).length === 3);
check('reset 清契约字段（activeContract / contractGoldMult）',
    /this\.activeContract = null;/.test(orbBalance) && /this\.contractGoldMult = 1;/.test(orbBalance));

check('城堡消费：生命上限 ×OrbBalance.castleHpMult（meta 加成后、Math.round 取整）',
    /this\.maxHp = Math\.round\(this\.maxHp \* OrbBalance\.castleHpMult\);/.test(castle));
check('金币槽消费：payout = Math.round(GOLD_REWARD_AMOUNT × OrbBalance.contractGoldMult)',
    /const payout = Math\.round\(GOLD_REWARD_AMOUNT \* OrbBalance\.contractGoldMult\);/.test(orbCtrl)
    && /GoldManager\.instance\.addGold\(payout\)/.test(orbCtrl)
    && /\+\$\{payout\} 金币/.test(orbCtrl));
check('WaveManager 通关登记：notifyLevelCleared(currentLevel) 在 nextLevel 之前（登记刚打通的关卡号）',
    /ContractManager\.notifyLevelCleared\(LevelManager\.currentLevel\);\s*LevelManager\.nextLevel\(\);/.test(wave));

check('RewardDialog 契约门：解锁 && 未立约 && 关卡最后一波 && 非宝箱关（5/10）',
    /contractGate = !this\._chestMode && LevelManager\.currentWave >= WAVES_PER_LEVEL/
    .test(reward)
    && /ContractManager\.unlocked/.test(reward)
    && /LevelManager\.currentLevel !== 5 && LevelManager\.currentLevel !== 10/.test(reward)
    && /OrbBalance\.activeContract === null/.test(reward));
check('契约判定先于藏宝箱（contractGate 分支在前）',
    reward.indexOf('contractGate') < reward.indexOf('showRelicChest()'));
check('契约模式展示/选择链：showContractOffer → setContractCard → selectReward 分派 selectContract',
    /private showContractOffer\(\): void/.test(reward)
    && /private setContractCard\(card: Node \| null, index: number\): void/.test(reward)
    && /if \(this\._contractMode\) \{\s*this\.selectContract\(index\);\s*return;\s*\}/.test(reward));
check('契约立约调用 OrbBalance.applyContract（contract_pick 埋点在先）',
    /Analytics\.track\('contract_pick', \{ pickedId: contract\.id \}\);\s*OrbBalance\.applyContract\(contract\.id\);/.test(reward));
check('契约展示埋点 contract_offer（附录 A 只增不改）', /contract_offer/.test(reward));
check('换一批按钮契约态隐藏（不重抽契约三选一）',
    /!this\._chestMode && !this\._contractMode && !this\._adRefreshUsed/.test(reward)
    && /if \(this\._adRefreshUsed \|\| this\._chestMode \|\| this\._contractMode\)/.test(reward));
check('契约模式随每次展示复位（showRewards 入口 _contractMode = false）',
    /this\._contractMode = false;/.test(reward));
check('卡面复用清理遗留图标（clearCardIcons，契约/遗物/常规三模式互不残留）',
    /private clearCardIcons\(card: Node\): void/.test(reward)
    && (reward.match(/this\.clearCardIcons\(card\);/g) ?? []).length >= 3);

// ---------- 汇总 ----------

console.log(failed === 0 ? '\n✅ 锻造契约自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) {
    process.exit(1);
}

