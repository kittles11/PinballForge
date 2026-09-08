/**
 * 发射按钮 × 每发随机角度 × 漏斗中性化 自检（纯 Node，无引擎依赖）——2026-09-07 改版回归锁：
 *   node --experimental-transform-types selfcheck-launch-button.ts
 *
 * 锁定六件事：
 *  1) 触摸瞄准整体退役：全局触屏监听 / AimPreview 消费 / inputWatchdog / 输入注册对不回潮；
 *  2) 「发 射」按钮接线：ensureLaunchButton 自举 + raisedButton（具名导入，UiKit 无命名空间对象）+ CLICK→互斥→冷却→launchOrb；
 *  3) 每发随机角度：rollLaunchAngle 在 launchOrb 内部（每发重滚，非开局一次），[-165°,-15°] 恒向上；
 *  4) 漏斗中性化：无 themeColor/funnelColor/光柱，EMOJ 标注 + 白色装饰；
 *  5) 球种专用色 token：C_GOLDEN/C_ICEBLUE/C_ORB_RED 接线，共享 C_ICE（冻结特效）未被波及；
 *  6) 按压手感（2026-09-07 按压反馈加版）：attachPressFx 下沉/弹回接线 + UiKit pressed 按压态重绘链路。
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const SCRIPTS = resolve(process.cwd(), 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

const launcher = strip(read('Game', 'LauncherController.ts'));
const funnel = strip(read('Pinball', 'FunnelSlot.ts'));
const theme = strip(read('Core', 'ArtTheme.ts'));

// ── 1. 触摸瞄准退役 ──
check('全局触屏输入监听已移除（Input.EventType / input.on|off 零残留）',
    !launcher.includes('Input.EventType') && !/\binput\.(on|off)\(/.test(launcher));
check('AimPreview 预测线消费已移除（simulateAimPreview / trajectoryGraphics / previewSpeedScale）',
    !launcher.includes('simulateAimPreview') && !launcher.includes('trajectoryGraphics')
    && !launcher.includes('previewSpeedScale'));
check('inputWatchdog 看门狗已移除（schedule 心跳不再需要）',
    !launcher.includes('inputWatchdog') && !launcher.includes('this.schedule('));
check('onEnable/onDisable 输入注册对已移除（无输入可注册）',
    !/protected onEnable\(\)/.test(launcher) && !/protected onDisable\(\)/.test(launcher));

// ── 2. 「发 射」按钮 ──
check('ensureLaunchButton 在 onLoad 自举（场景无需布置，幂等）',
    /protected onLoad\(\): void[\s\S]{0,900}this\.ensureLaunchButton\(\);/.test(launcher));
check('按钮自举路径 UILayer/LaunchBtn + 金色凸起（raisedButton 具名导入 + Theme.ui.gold）',
    /getChildByName\('UILayer'\)/.test(launcher) && /getChildByName\('LaunchBtn'\)/.test(launcher)
    && /raisedButton\(/.test(launcher) && !/UiKit\./.test(launcher) && /Theme\.ui\.gold/.test(launcher));
check('按钮固定位置 (0, -545)，屏底漏斗下方（LAUNCH_BTN_POS_Y）',
    /LAUNCH_BTN_POS_Y = -545/.test(launcher));
check('点击链路：CLICK → onLaunchClicked（互斥→冷却→launchOrb）',
    /btn\.on\(Button\.EventType\.CLICK, this\.onLaunchClicked, this\)/.test(launcher)
    && /private onLaunchClicked\(\): void[\s\S]{0,300}this\.launchOrb\(\);/.test(launcher));
check('冷却节流沿用 launchCooldown @property（Date.now 差值 < cooldown 拒发）',
    /now - this\._lastLaunchTime < this\.launchCooldown/.test(launcher));
check('弹窗互斥保留：UI_MODAL_CHANGED / GAME_OVER / _modalOpen 拦截点按',
    /EventBus\.on\(GameEvents\.UI_MODAL_CHANGED/.test(launcher)
    && /EventBus\.on\(GameEvents\.GAME_OVER/.test(launcher)
    && /if \(this\._modalOpen\) \{\s*return;/.test(launcher));
check('按钮 Label 挂子节点（cc.Label 与 cc.Graphics 同节点互斥，直加曾致按钮创建中断、节点从未入场景）',
    /const labelNode = new Node\('Label'\);\s*labelNode\.layer = btn\.layer;\s*btn\.addChild\(labelNode\);/.test(launcher)
    && !/btn\.addComponent\(Label\)/.test(launcher));

// ── 3. 每发随机角度（用户拍板：每次发射都随机）──
check('rollLaunchAngle 使用 Math.random 均匀滚定',
    /private rollLaunchAngle\(\): number[\s\S]{0,200}Math\.random\(\)/.test(launcher));
check('随机发生在 launchOrb 内部（每发重滚，而非开局一次）',
    /private launchOrb\(\): void[\s\S]{0,400}this\.rollLaunchAngle\(\)/.test(launcher));
const minDeg = Number(launcher.match(/LAUNCH_ANGLE_MIN_DEG = (-?\d+)/)?.[1]);
const maxDeg = Number(launcher.match(/LAUNCH_ANGLE_MAX_DEG = (-?\d+)/)?.[1]);
check(`随机角范围恒向上且对称（实际 ${minDeg}°~${maxDeg}°，应 -165~-15）`,
    minDeg === -165 && maxDeg === -15 && minDeg < maxDeg);
check('fireLightningBurst 散射链路保留（随机方向 → 扇形旋转复用）',
    /lightningSpread\(splitCount,\s*scatterAngle\)/.test(launcher));
check('发射入口唯一化：launchOrb 仅由按钮链路调用（onLaunchClicked 一处）',
    (launcher.match(/this\.launchOrb\(\)/g) ?? []).length === 1);

// ── 4. 漏斗中性化 + EMOJ 标注 ──
check('漏斗主题色语言整体移除（themeColor/funnelColor/ensureNeonPillar 零残留）',
    !/themeColor|funnelColor|ensureNeonPillar/.test(funnel)
    && !/themeColor|funnelColor|ensureNeonPillar/.test(launcher));
check('场景烘焙色 Sprite 运行时覆白（neutralizeSprite → Theme.white）',
    /private neutralizeSprite\(\): void[\s\S]{0,200}sp\.color = Theme\.white;/.test(funnel));
check('装饰中性白：吞球汇聚 converge(Theme.white)',
    /FxManager\.converge\(this\.node\.worldPosition, Theme\.white\)/.test(funnel));
check('EMOJ 标注：💥 聚能 ×2 / ❄️ 精炼 ×1.5 / 💰 金币 +20',
    /💥 聚能 ×2/.test(funnel) && /❄️ 精炼 ×1\.5/.test(funnel) && /💰 金币 \+20/.test(funnel));

// ── 5. 球种专用色 token 接线（ArtTheme）──
check('新 token：C_GOLDEN #FFD700 / C_ICEBLUE #4FC3F7 / C_ORB_RED 球种专用正红',
    /C_GOLDEN = 0xFFD700/.test(theme) && /C_ICEBLUE = 0x4FC3F7/.test(theme)
    && /C_ORB_RED = 0xFF3232/.test(theme));
check('Theme.orb 接线：lightning=C_GOLDEN / lava=C_ORB_RED / frost=C_ICEBLUE / normal 白',
    /lightning: hex\(C_GOLDEN\)/.test(theme) && /lava: hex\(C_ORB_RED\)/.test(theme)
    && /frost: hex\(C_ICEBLUE\)/.test(theme));
check('拖尾/瞄准线映射同步：1=C_GOLDEN、2=C_ORB_RED、3=C_ICEBLUE；共享 C_ICE（冻结特效）未被动',
    /1: hex\(C_GOLDEN\)/.test(theme) && /2: hex\(C_ORB_RED\)/.test(theme)
    && /3: hex\(C_ICEBLUE\)/.test(theme) && /freeze: hex\(C_ICE\)/.test(theme));

// ── 6. 按压手感（attachPressFx × UiKit pressed 按压态）──
const uikit = strip(read('Core', 'UiKit.ts'));
check('UiKit.raisedButton 支持 pressed 按压态（缺省 false，旧 4/5 参调用方零破坏）',
    /export function raisedButton\(\s*g: Graphics, w: number, h: number, body: Color, radius: number = DEFAULT_RADIUS, pressed: boolean = false,?\s*\)/.test(uikit));
check('按压态三变：影子塌缩贴地 / 暗边减半 / 面部减光（静止态逐层同形）',
    /const shadowOffset = pressed \? 0 : SHADOW_OFFSET;/.test(uikit)
    && /const edge = pressed \? BASE_EDGE \/ 2 : BASE_EDGE;/.test(uikit)
    && /const dim = pressed \? -0\.16 : 0;/.test(uikit)
    && /g\.roundRect\(left, top, w, h - edge, radius\);/.test(uikit));
check('attachPressFx 接线于按钮自举（TOUCH_START 下沉 + 重绘，END/CANCEL 弹回）',
    /this\.attachPressFx\(btn, LAUNCH_BTN_W, LAUNCH_BTN_H, Theme\.ui\.gold, LAUNCH_BTN_PRESS_DIP_Y\);/.test(launcher)
    && /Node\.EventType\.TOUCH_START/.test(launcher)
    && /Node\.EventType\.TOUCH_END[\s\S]{0,120}Node\.EventType\.TOUCH_CANCEL/.test(launcher));
check('下沉量 LAUNCH_BTN_PRESS_DIP_Y = 3（与暗边厚度同量级，压满才「按得进去」）',
    /LAUNCH_BTN_PRESS_DIP_Y = 3;/.test(launcher));
check('松手 backOut 弹回（to(0.06) 弹性缓动，回弹先过冲再落位）',
    /tween\(btn\)\s*\.to\(0\.06, \{ position: new Vec3\(btn\.position\.x, restY, 0\) \}, \{ easing: 'backOut' \}\)/.test(launcher));
check('重绘走 raisedButton pressed（g.clear 后同函数重画，形状语言不漂移）',
    /g\.clear\(\);\s*raisedButton\(g, w, h, body, undefined, pressed\);/.test(launcher));
check('弹回前停旧 tween（Tween.stopAllByTarget，防连按中断态叠加）',
    (launcher.match(/Tween\.stopAllByTarget\(btn\);/g) ?? []).length === 2);

console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);