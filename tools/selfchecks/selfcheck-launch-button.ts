/**
 * 反向深渊拖拽发射 自检（纯 Node，无引擎依赖）——2026-09-08 改版回归锁：
 *   node --experimental-transform-types selfcheck-launch-button.ts
 *
 * 布局反转：玩家手指拖拽瞄准、从屏幕底部向上发射，弹珠零随机扰动、飞出屏顶回收。
 * 锁定六件事：
 *  1) 随机散布整体退役：rollLaunchAngle / Math.random 角度加工 / LAUNCH_ANGLE 常量零残留；
 *  2) 纯拖拽发射：全局 input TOUCH_END 释放 → 冷却节流 → launchOrb(aimDir)，无 Button click 依赖；
 *  3) 零误差瞄准链：方向 = (松手触点 - 发射座)，launchOrb 归一化零角度加工；
 *  4) 布局反转落位：发射座兜底置屏底 + 场景 LauncherNode 已迁 (0, -560) + 顶部回收 y ≥ 680；
 *  5) 按钮链路残留清零：ensureLaunchButton / attachPressFx / raisedButton / LaunchBtn 全部退役；
 *  6) 回合推进 / 雷球散射保留：TURN_ADVANCE 单点派发 + lightningSpread 扇形旋转复用不回归。
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
const orb = strip(read('Pinball', 'OrbController.ts'));
const balanceSrc = strip(read('Core', 'OrbBalance.ts'));
const scene = readFileSync(join(resolve(process.cwd()), 'assets', 'scenes', 'MainScene.scene'), 'utf8');

// ── 1. 随机散布退役 ──
check('随机滚角退役：rollLaunchAngle / LAUNCH_ANGLE_MIN_DEG / LAUNCH_ANGLE_MAX_DEG 零残留',
    !launcher.includes('rollLaunchAngle') && !launcher.includes('LAUNCH_ANGLE_MIN_DEG')
    && !launcher.includes('LAUNCH_ANGLE_MAX_DEG'));
check('发射链路零 Math.random（发射角度 100% 贴合拖拽瞄准线）',
    !launcher.includes('Math.random'));

// ── 2. 纯拖拽发射 ──
check('全局松手发射：input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this)',
    /input\.on\(Input\.EventType\.TOUCH_END, this\.onTouchEnd, this\)/.test(launcher));
check('注销成对：onDestroy input.off(TOUCH_END)（防场景重载泄漏）',
    /input\.off\(Input\.EventType\.TOUCH_END, this\.onTouchEnd, this\)/.test(launcher));
check('发射入口唯一化：launchOrb 仅由 onTouchEnd 松手链路调用（一处）',
    (launcher.match(/this\.launchOrb\(/g) ?? []).length === 1);
check('Button click 回调零依赖（cc.Button / onLaunchClicked 退役）',
    !launcher.includes('Button') && !launcher.includes('onLaunchClicked'));
check('弹窗互斥 + 冷却节流保留（_modalOpen / launchCooldown）',
    /if \(this\._modalOpen \|\| !this\.launcherNode\?\.isValid\)/.test(launcher)
    && /now - this\._lastLaunchTime < this\.launchCooldown/.test(launcher));

// ── 3. 零误差瞄准链 ──
check('方向 = 松手触点 - 发射座（getUILocation - worldPosition，所见即所得）',
    /event\.getUILocation\(\)/.test(launcher)
    && /aimDir = new Vec2\(ui\.x - origin\.x, ui\.y - origin\.y\)/.test(launcher));
check('launchOrb 归一化后零角度加工：初速 = 单位方向 × launchSpeed',
    /const dir = new Vec2\(aimDir\.x \/ len, aimDir\.y \/ len\)/.test(launcher)
    && /dir\.x \* this\.launchSpeed/.test(launcher) && /dir\.y \* this\.launchSpeed/.test(launcher));
check('轻点误触 / 朝下拖拽不发射（MIN_AIM_LENGTH + aimDir.y <= 0 双过滤）',
    /MIN_AIM_LENGTH/.test(launcher) && /aimDir\.y <= 0/.test(launcher));

// ── 4. 布局反转落位 ──
check('发射座兜底置屏底：position.y >= 0 时强制 (0, LAUNCHER_BOTTOM_Y)',
    /if \(this\.launcherNode\.position\.y >= 0\)/.test(launcher)
    && /LAUNCHER_BOTTOM_Y = -560/.test(launcher));
check('发射初速爽快档：launchSpeed 默认 1500（场景序列化同步 ≥1500，零重力匀速直线够快）',
    /launchSpeed = 1500/.test(launcher)
    && Number(scene.match(/"launchSpeed": (\d+)/)?.[1] ?? 0) >= 1500);
check('场景 LauncherNode 已迁屏底 (0, -560)（launchSpeed 序列化块同段）',
    (() => {
        const from = scene.indexOf('81OMDIZNdAIZwXraUwXPIt');
        const seg = scene.lastIndexOf('_lpos', from);
        return from >= 0 && seg >= 0 && scene.indexOf('"y": -560', seg) < from;
    })());
check('顶部回收：y >= 680 触发 recycleAtCeiling（屏高 1280 半屏 640 + 余量）',
    /const CEILING_RECYCLE_Y = 680;/.test(orb)
    && /this\.node\.position\.y >= CEILING_RECYCLE_Y/.test(orb)
    && /this\.recycleAtCeiling\(\)/.test(orb));
check('顶部回收走卡组守恒管线（弃牌堆回收 + 副球不入库）',
    /recycleAtCeiling\(\): void \{[\s\S]{0,600}discardOrbType/.test(orb)
    && !/recycleAtCeiling[\s\S]{0,600}FIRE_TURRET/.test(orb));

// ── 5. 按钮链路残留清零 ──
check('按钮链路退役：ensureLaunchButton / attachPressFx / raisedButton / LaunchBtn 零残留',
    !launcher.includes('ensureLaunchButton') && !launcher.includes('attachPressFx')
    && !launcher.includes('raisedButton') && !launcher.includes('LaunchBtn')
    && !launcher.includes('LAUNCH_BTN'));

// ── 6. 回合推进 / 雷球散射 / 零重力保留 ──
check('launchOrb 成功路径广播 TURN_ADVANCE（单点派发一次）',
    (launcher.match(/EventBus\.emit\(GameEvents\.TURN_ADVANCE\)/g) ?? []).length === 1);
check('雷球散射链路保留（消费 splitCount/scatterAngle，中心主球判定）',
    /OrbBalance\.lightningSpread\(splitCount, scatterAngle\)/.test(launcher)
    && /i !== centerIdx/.test(launcher));
check('OrbBalance 四球种 gravityScale 字面量全 0（normal/frost/leech 无重力字段，走统一零重力赋值）',
    (() => {
        const vals = balanceSrc.match(/gravityScale:\s*([\d.]+)/g) ?? [];
        return vals.length === 4 && vals.every((v) => Number(v.split(':')[1].trim()) === 0);
    })());

console.log(failed === 0 ? '\n全部自检通过 ✔' : `\n存在 ${failed} 项失败 ✘`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);