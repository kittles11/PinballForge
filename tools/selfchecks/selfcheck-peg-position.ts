/**
 * 🛡 钉板位置根修锁定（2026-09-06「钉板塌缩成画布中心一坨 / 红闪后钉板变空」）— 源码级自检（不依赖 cc 运行时）。
 * 运行：node --experimental-transform-types selfcheck-peg-position.ts
 *
 * 实证链：[generate] 快照 21 颗全散开（位 -344..344 × 264..-264）→ 1 秒后 [boss+1s] 全 (0,0)；
 * 全库无用户代码写钉子位置 → RigidBody2D 在 setParent 激活瞬间按 prefab 默认 (0,0) 建立物理体，
 * 节点被引擎钉回物理体位置。锁定修复契约：
 *  1) generateBoard：setPosition 必须先于 setParent（物理体建立瞬间即在正确坐标）；
 *  2) 生成尾部存档 _spawnPositions（位置漂移审计基准）；
 *  3) auditPegBoard 幂等审计接线：WAVE_START 下一帧 + 每 1s 例行；
 *  4) 审计体：位置偏差 >1px 当场恢复、Graphics 被清空（paths=0）强制重绘、自愈必打日志；
 *  5) PegComponent.forceRedraw 公开入口（审计重绘调用）。
 * 说明：不 import 项目文件（cc 别名无法在 Node ESM 下解析），一律从源码正则提取真源，顺带锁定「源码形状」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Task 005: 自检已迁至 tools/selfchecks/，仓库根锚点从 here 上提两级
const REPO_ROOT = join(here, '..', '..');
const read = (...p: string[]): string => readFileSync(join(REPO_ROOT, ...p), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const board = strip(read('assets', 'scripts', 'Pinball', 'PegBoardManager.ts'));
const peg = strip(read('assets', 'scripts', 'Pinball', 'PegComponent.ts'));

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!cond) {
        failed++;
    }
}

// ── 1. 生成顺序：坐标先于挂载（物理体建立瞬间即在正确坐标，钉回的也是正确位置） ──
const spawnBody = board.match(/const pegNode = instantiate\(this\.pegPrefab\);[\s\S]*?peg\.setPegType/)?.[0] ?? '';
const setPosIdx = spawnBody.indexOf('pegNode.setPosition(positions[i])');
const setParentIdx = spawnBody.indexOf('pegNode.setParent(this.node)');
check('generateBoard：setPosition 先于 setParent（根修：物理体不再以 prefab 默认 (0,0) 建立）',
    setPosIdx >= 0 && setParentIdx > setPosIdx);

// ── 2. 生成坐标存档（审计基准） ──
check('generateBoard 尾部存档 _spawnPositions（清空重建 + 逐钉 clone）',
    /_spawnPositions\.length = 0;/.test(board)
    && /_spawnPositions\.push\(child\.position\.clone\(\)\)/.test(board));

// ── 3. 审计接线：换波下一帧 + 每秒例行 ──
check('start() 每秒例行审计（schedule 1s）',
    /this\.schedule\(\(\) => this\.auditPegBoard\(\), 1\)/.test(board));
check('WAVE_START 下一帧审计（scheduleOnce 0，暴露生成窗口内改写）',
    /this\.scheduleOnce\(\(\) => this\.auditPegBoard\('wave-start\+1f'\), 0\)/.test(board));

// ── 4. 审计体：位置漂移恢复 + paths=0 重绘 + 自愈必打日志 ──
const audit = board.match(/private auditPegBoard\([\s\S]*?\n    \}/)?.[0] ?? '';
check('auditPegBoard：位置偏差 >1px 当场恢复（setPosition 回生成坐标）',
    /Vec3\.distance\(child\.position, want\) > 1/.test(audit) && /child\.setPosition\(want\)/.test(audit));
check('auditPegBoard：Graphics 被清空（impl.paths 空）强制 forceRedraw',
    /impl\.paths\?\.length/.test(audit) && /peg\.forceRedraw\(\)/.test(audit));
check('auditPegBoard：自愈发生时打 [PegBoard] 🛡 汇总日志（点名时间窗）',
    audit.includes('[PegBoard] 🛡') && /fixedPos|fixedArt/.test(audit));
check('auditPegBoard：空板/失效守卫（_spawnPositions 空或节点无效直接返回）',
    /!this\.node\?\.isValid \|\| this\._spawnPositions\.length === 0/.test(audit));

// ── 5. PegComponent 渲染自愈入口 ──
check('PegComponent.forceRedraw 公开入口存在（审计重绘调用，内部走 redrawArt）',
    /public forceRedraw\(\): void \{\s*this\.redrawArt\(\);\s*\}/.test(peg));

if (failed > 0) {
    console.error(`\n❌ ${failed} 项未通过`);
    process.exit(1);
}
console.log('\n✅ 钉板位置根修自检全部通过');
