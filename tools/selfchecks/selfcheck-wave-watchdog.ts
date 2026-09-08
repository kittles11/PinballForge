/**
 * 波次结算看门狗 & 战后弹窗监听注册 —— 源码级自检（不依赖 cc 运行时）。
 * 运行：node --experimental-transform-types selfcheck-wave-watchdog.ts
 *
 * 背景：2026-09-04 实测回归——场景启动时 DailyTaskDialog 的 closeAllModals() 把 RewardDialog
 * 节点失活，若监听注册依赖 start() 则永不执行 → SHOW_REWARDS 无监听（EventTarget 静默 no-op）
 * → 第三波全灭后弹窗不弹、REWARD_SELECTED 不发、关卡永远停在 3/3。
 * 主修复：监听注册提前到 onLoad（RewardDialog / ShopDialog 均已落地）。
 * 加固：WaveManager 在 SHOW_REWARDS 派发后挂看门狗——弹窗迟迟未激活则自动重发（自愈循环）。
 * 直连兜底（2026-09-04 1-3 第三波回归）：脚本热重载可把弹窗组件换成旧实例悬空在事件总线上
 * （入口 isValid 守卫静默吞事件），emit 静默 no-op——商店此前无任何兜底，SHOW_SHOP 空转
 * → 3/6/9 关选完卡永久卡死。锁定「emit + 组件直调」双通道：
 * WaveManager→RewardDialog、RewardDialog→ShopDialog，跳转永不依赖监听存活。
 * 本自检锁定（源码形状，防两处修复回潮）：
 *  1) 主修复：RewardDialog / ShopDialog 在 onLoad 调 ensureReady 且 ensureReady 内注册事件监听；
 *  2) 加固：onEnemyKilled 派发 SHOW_REWARDS 后紧接看门狗调度；看门狗带三重守卫 +
 *     anyModalOpen 检查 + 重发 + 自续期；
 *  3) ModalGate 弹窗名册涵盖 RewardDialog / ShopDialog（anyModalOpen 判定真源）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Task 005: 自检已迁至 tools/selfchecks/，仓库根锚点从 here 上提两级
const REPO_ROOT = join(here, '..', '..');
const waveSrc = readFileSync(join(REPO_ROOT, 'assets', 'scripts', 'Battle', 'WaveManager.ts'), 'utf8');
const rewardSrc = readFileSync(join(REPO_ROOT, 'assets', 'scripts', 'UI', 'RewardDialog.ts'), 'utf8');
const shopSrc = readFileSync(join(REPO_ROOT, 'assets', 'scripts', 'UI', 'ShopDialog.ts'), 'utf8');
const gateSrc = readFileSync(join(REPO_ROOT, 'assets', 'scripts', 'Core', 'ModalGate.ts'), 'utf8');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!cond) {
        failed++;
    }
}

// ── 1. 主修复：监听注册提前到 onLoad（节点被 closeAllModals 失活后 start 永不执行）──
check('RewardDialog.onLoad 调 ensureReady（主修复）',
    /protected onLoad\(\): void \{\s*this\.ensureReady\(\);/.test(rewardSrc));
check('RewardDialog.ensureReady 注册 SHOW_REWARDS 监听',
    /private ensureReady\(\): void \{[\s\S]{0,200}EventBus\.on\(GameEvents\.SHOW_REWARDS, this\.showRewards, this\)/.test(rewardSrc));
check('ShopDialog.onLoad 调 ensureReady（主修复）',
    /protected onLoad\(\): void \{\s*this\.ensureReady\(\);/.test(shopSrc));
check('ShopDialog.ensureReady 注册 SHOW_SHOP 监听',
    /EventBus\.on\(GameEvents\.SHOW_SHOP, this\.openShop, this\)/.test(shopSrc));

// ── 2. 加固：SHOW_REWARDS 派发后的结算看门狗 ──
check('WaveManager 导入 anyModalOpen（ModalGate 真源查询）',
    /import \{ anyModalOpen \} from '\.\.\/Core\/ModalGate';/.test(waveSrc));
check('看门狗延迟常量已定义（REWARD_WATCHDOG_DELAY = 正数）',
    /REWARD_WATCHDOG_DELAY\s*=\s*\d+/.test(waveSrc) &&
    Number(waveSrc.match(/REWARD_WATCHDOG_DELAY\s*=\s*(\d+)/)?.[1]) > 0);
// 派发 → 看门狗调度必须紧邻（emit 的 try/catch 结束后 300 字符内），且位于「本关清空」分支
check('onEnemyKilled：SHOW_REWARDS 派发后紧接看门狗调度',
    /SHOW_REWARDS\);\s*\}\s*catch[\s\S]{0,600}scheduleOnce\(this\.checkRewardWatchdog, REWARD_WATCHDOG_DELAY\)/.test(waveSrc));
check('看门狗三重守卫：终局 / 全局结算 / 未结算态不重发',
    /checkRewardWatchdog\(\): void \{\s*if \(this\._gameOver \|\| this\._runSettled \|\| !this\._waveSettled\) \{/.test(waveSrc));
check('看门狗弹窗激活检查（anyModalOpen 为真则交给玩家）',
    /if \(anyModalOpen\(\)\) \{\s*return;/.test(waveSrc));
check('看门狗重发 SHOW_REWARDS（自愈）', /console\.warn\('\[Wave\] 看门狗[\s\S]{0,200}emit\(GameEvents\.SHOW_REWARDS\)/.test(waveSrc));
check('看门狗自续期（重发后再次调度，弹窗打开/推进后由守卫终止）',
    (waveSrc.match(/scheduleOnce\(this\.checkRewardWatchdog, REWARD_WATCHDOG_DELAY\)/g)?.length ?? 0) >= 2);

// ── 3. ModalGate 弹窗名册（anyModalOpen 判定真源，新弹窗漏登记会使看门狗误判）──
for (const name of ['DailyTaskDialog', 'DeckViewDialog', 'ShopDialog', 'RewardDialog', 'ResultDialog']) {
    check(`ModalGate 名册包含 ${name}`, new RegExp(`'${name}'`).test(gateSrc));
}

// ── 4. 直连兜底（2026-09-04 1-3 第三波回归根因）：监听缺失/悬空时结算链不得只依赖 emit ──
check('RewardDialog 选卡商店分支：emit SHOW_SHOP 后紧接 openShopDirect()（emit + 直调双通道）',
    /emit\(GameEvents\.SHOW_SHOP\);[\s\S]{0,160}this\.openShopDirect\(\);/.test(rewardSrc));
check('RewardDialog.openShopDirect：按商店节点真实 active 短路 + 组件直调 openShop 兜底',
    rewardSrc.includes("find('Canvas/UILayer/ShopDialog')")
    && /node\?\.isValid && node\.active/.test(rewardSrc)
    && /getComponent\(ShopDialog\)/.test(rewardSrc)
    && /shop\.openShop\(\)/.test(rewardSrc));
check('WaveManager 兜底开门按 RewardDialog 节点真实 active 判定（监听悬空时 emit 不可信）',
    /private openRewardDialogFallback\(\): void \{[\s\S]{0,600}find\('Canvas\/UILayer\/RewardDialog'\)[\s\S]{0,200}node\?\.isValid && node\.active/.test(waveSrc));
check('WaveManager.onRewardSelected 节点有效性守卫（悬空旧实例让位现役实例）',
    /onRewardSelected\(\): void \{[\s\S]{0,300}if \(!this\.node\?\.isValid \|\| this\._gameOver \|\| this\._runSettled \|\| !this\._waveSettled\) \{/.test(waveSrc));
check('ShopDialog.openShop：UI 构建异常隔离（冻结发射 + 激活在隔离段之后必达）',
    /catch \(e\) \{[\s\S]{0,300}\}[\s\S]{0,200}emit\(GameEvents\.UI_MODAL_CHANGED, true\);[\s\S]{0,100}this\.node\.active = true;/.test(shopSrc));

console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
