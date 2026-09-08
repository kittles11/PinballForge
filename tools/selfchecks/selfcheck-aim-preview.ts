/**
 * P1-2 瞄准预测线自检（纯 Node，无引擎依赖）——首段轨迹模拟 + 发射器接线校验：
 *   node --experimental-transform-types selfcheck-aim-preview.ts
 *
 * 覆盖：① simulateAimPreview 行为真跑（命中截断 / 擦边不误报 / 墙与漏斗截断 / 半隐式欧拉数值锚点）
 *       ② segHitsCircle 线段-圆扫掠单元
 * （2026-09-07 退役：发射器改为「随机角度+按钮发射」，AimPreview 不再被 LauncherController
 *   消费，原 ③ 源码级接线断言整体移除；模块本身保留零 cc 依赖可独立真跑）
 * AimPreview 零 cc 依赖 → 动态 import 直接跑真实现；LauncherController 依赖引擎 → 源码级断言。
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { simulateAimPreview, segHitsCircle } from '../../assets/scripts/Core/AimPreview.ts';
import type { AimPreviewParams } from '../../assets/scripts/Core/AimPreview.ts';

const ROOT = resolve(process.cwd());
const SCRIPTS = join(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(join(SCRIPTS, ...p), 'utf8');

const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

/** 构造参数的便捷封装：起点 (0,300)，dt=1/120，标准场地 */
function sim(over: Partial<AimPreviewParams>): AimPreviewResult {
    return simulateAimPreview({
        startX: 0, startY: 300, vx: 0, vy: -600, gravity: -320,
        orbR: 16, maxTime: 0.6, dt: 1 / 120,
        fieldHalfW: 352, floorY: -340, pegs: [],
        ...over,
    });
}

// ── ① 轨迹模拟行为 ──
const hit = sim({ pegs: [{ x: 0, y: 100, r: 16 }] });
const hitEnd = hit.points[hit.points.length - 1];
check('直落命中正下方钉：endReason=peg 且返回该钉',
    hit.endReason === 'peg' && hit.hitPeg !== null && hit.hitPeg.r === 16);
check('截断点停在钉面上缘附近（100+2r=132，误差一个步长内）',
    hitEnd[1] >= 132 - 4 && hitEnd[1] <= 132 + 4);
check('命中即截断：点列远短于满时长采样数（72 步）',
    hit.points.length < 72);

const miss = sim({ pegs: [{ x: 50, y: 100, r: 16 }] });
check('擦边钉（x=50 > r+orbR=32）不误报：走满时长',
    miss.endReason === 'end' && miss.hitPeg === null);

const wall = sim({ vx: 900, vy: -100, gravity: 0 });
check('横向飞出左/右墙 → wall 截断（x 钳在 ±352 附近）',
    wall.endReason === 'wall' && Math.abs(wall.points[wall.points.length - 1][0] - 352) < 5);

const floor = sim({ vy: -1200 });
check('直落进入漏斗区 → floor 截断（y ≤ -340）',
    floor.endReason === 'floor' && floor.points[floor.points.length - 1][1] <= -340);

const line = sim({ gravity: 0, vy: -600 });
check('零重力轨迹共线（首末 x 相等）', line.points[line.points.length - 1][0] === 0);

// 半隐式欧拉数值锚点：maxTime=0.5（不触漏斗截断线）
// 先更新速度再用新速度推进位置：y(60步) = y0 - v0·t - g·dt²·Σk = y0 - 500 - 40.667 = -240.667
const euler = sim({ vy: -1000, maxTime: 0.5 });
const eulerEndY = euler.points[euler.points.length - 1][1];
check('半隐式欧拉数值锚点：0.5s 末点 y ≈ -240.67（±0.5）',
    Math.abs(eulerEndY - (300 - 540.6667)) < 0.5);

// ── ② segHitsCircle 单元 ──
check('线段穿过圆心 → true', segHitsCircle(0, 300, 0, 100, 0, 100, 16));
check('线段远离圆 → false', !segHitsCircle(0, 300, 0, 100, 200, 100, 16));
check('线段端点落在圆内 → true', segHitsCircle(0, 300, 0, 110, 0, 100, 16));
check('零长线段（点）在圆内 → true', segHitsCircle(0, 100, 0, 100, 0, 100, 16));

// （原 ③ LauncherController 接线断言已随触摸瞄准退役移除——见文件头 2026-09-07 说明）

console.log(failed === 0 ? '\n✅ P1-2 瞄准预测线自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);
