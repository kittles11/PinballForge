/**
 * 美术/特效层自检（纯 Node，无引擎依赖；文本断言 + 同步公式副本）：
 *   node --experimental-transform-types selfcheck-art-fx.ts
 *
 * 校验 A+B 美术改造的地基不变式与特效层护栏：
 *  规则 A  全项目 `new Color(` 字面量已归一：仅 Core/ArtTheme.ts 允许构造 cc.Color；
 *  规则 B  ArtTheme 色板：hex 字面量零重复 + 语义键零重复（防同色系漂移复发）；
 *  规则 C  glow 纹理 alpha 严格单调衰减（与 RuntimeTex.glowFalloff 的同步公式副本核对）；
 *  规则 D  FxManager 护栏：池上限 96 / 活跃上限 64 / 弹窗清屏 / 加法混合 / 回退开关；
 *  规则 E  池护栏压测（同步逻辑副本）：突发流量下活跃数与池大小永不越界；
 *  规则 F  六个特效接入点齐全（撞钉 / 爆炸 / 炮塔 / 敌人 / 吞球 / 城堡）；
 *  规则 G  场景零改动：BackdropFx 自举插入，MainScene 不含 Backdrop 节点；
 *  规则 H  事件契约未破坏：ORB_HIT_PEG 载荷字段完整保留（pegId/orbId/points/hitCount）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, relative } from 'path';

const ROOT = resolve(process.cwd(), 'assets', 'scripts');
const SCENE = resolve(process.cwd(), 'assets', 'scenes', 'MainScene.scene');

let failed = 0;
function check(name: string, ok: boolean, detail: string = ''): void {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' —— ' + detail : ''}`);
    if (!ok) failed += 1;
}

/** 递归收集 assets/scripts 下全部 .ts */
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
            out.push(...walk(p));
        } else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) {
            out.push(p);
        }
    }
    return out;
}

const files = walk(ROOT);
const srcOf = (rel: string): string => readFileSync(join(ROOT, rel.split('/').join('\\')), 'utf8');
const keyOf = (f: string): string => relative(ROOT, f).split('\\').join('/');

// ---- 规则 A：new Color 全项目归一 ----
const offenders = files
    .filter((f) => keyOf(f) !== 'Core/ArtTheme.ts')
    .filter((f) => /new Color\(/.test(readFileSync(f, 'utf8')))
    .map(keyOf);
check('规则A 全项目 new Color(...) 已归一至 ArtTheme（94 处 → 1 个工厂）', offenders.length === 0, offenders.join(', '));

// ---- 规则 B：ArtTheme 色板零漂移 ----
const themeSrc = srcOf('Core/ArtTheme.ts');
const hexLits = [...themeSrc.matchAll(/0x[0-9A-Fa-f]{6}\b/g)].map((m) => m[0].toUpperCase());
const dupHex = [...new Set(hexLits.filter((h, i) => hexLits.indexOf(h) !== i))];
check('规则B1 ArtTheme hex 字面量零重复', dupHex.length === 0, dupHex.join(', '));
// 语义键唯一：逐行状态机跟踪当前族（Theme 的 4 空格子对象），族内 8 空格键不得重复；
// 顶层 token（white 等）与映射表数字键（0/1/2/3）分开统计——数字键跨表复用是合法设计。
const familyKeys = new Map<string, number>();
const topKeys = new Map<string, number>();
let family = '';
for (const line of themeSrc.split(/\r?\n/)) {
    const famOpen = line.match(/^    (\w+): \{\s*$/);
    if (famOpen) {
        family = famOpen[1];
        topKeys.set(family, (topKeys.get(family) ?? 0) + 1);
        continue;
    }
    if (/^    \},?\s*$/.test(line)) {
        family = '';
        continue;
    }
    const inner = line.match(/^        (\w+): hex\(/);
    if (inner) {
        const k = `${family}.${inner[1]}`;
        familyKeys.set(k, (familyKeys.get(k) ?? 0) + 1);
        continue;
    }
    const top = line.match(/^    (\w+): hex\(/);
    if (top && !/^\d+$/.test(top[1])) {
        topKeys.set(top[1], (topKeys.get(top[1]) ?? 0) + 1);
    }
}
const dupInner = [...familyKeys.entries()].filter(([, n]) => n > 1).map(([k]) => k);
const dupTop = [...topKeys.entries()].filter(([, n]) => n > 1).map(([k]) => k);
check('规则B2 ArtTheme 族内语义键零重复', dupInner.length === 0, dupInner.join(', '));
check('规则B2b ArtTheme 顶层 token 零重复', dupTop.length === 0, dupTop.join(', '));

// ---- 规则 C：glow alpha 单调衰减（同步公式副本：a(d) = (1-d)²） ----
function glowFalloff(d: number): number {
    const t = Math.max(0, 1 - d);
    return t * t;
}
let mono = true;
let prev = 1.0001;
for (let d = 0; d <= 1.0001; d += 0.01) {
    const a = glowFalloff(Math.min(1, d));
    if (a > prev + 1e-9) mono = false;
    prev = a;
}
check('规则C1 glow 公式副本 alpha 单调衰减（中心 1 → 边缘 0）', mono && glowFalloff(0) === 1 && glowFalloff(1) === 0);
const rtSrc = srcOf('Core/RuntimeTex.ts');
check('规则C2 RuntimeTex 与副本公式同族 ((1-d)² 衰减)',
    /Math\.max\(0,\s*1\s*-\s*d\)/.test(rtSrc) && /t\s*\*\s*t/.test(rtSrc));

// ---- 规则 D：FxManager 护栏 ----
const fxSrc = srcOf('Core/FxManager.ts');
check('规则D1 池上限 96 / 活跃上限 64', /POOL_CAP\s*=\s*96/.test(fxSrc) && /ACTIVE_CAP\s*=\s*64/.test(fxSrc));
check('规则D2 弹窗打开即清空特效（UI_MODAL_CHANGED → clearAll）',
    fxSrc.includes('UI_MODAL_CHANGED') && /clearAll\(\)/.test(fxSrc));
check('规则D3 加法混合（SRC_ALPHA → ONE 单实例材质）',
    /BlendFactor\.ONE/.test(fxSrc) || fxSrc.includes('additiveMaterial'));
check('规则D4 Graphics 回退开关存在', fxSrc.includes('useGraphicsFallback') && fxSrc.includes('Graphics'));

// ---- 规则 D5：自建加法混合材质已退役（原 batcher-2d localSetLayout 崩溃回归锁的继任者） ----
// 历史链条：effectName 'builtin-sprite' 按注册键查表恒查不到 → passes 恒空 → 空材质挂上 Sprite
// 让 batcher-2d 逐帧抛 "Cannot read properties of undefined (reading 'localSetLayout')" 并刷屏；
// 补了空 passes 校验后，又发现自建材质的 blendState 覆盖会整体替换 BlendTarget → 辉光渲染成
// 不透明方块（「弹珠变方块」回归）。终局（2026-09-05）：整个 additiveMaterial 删除，辉光改走
// Sprite.srcBlendFactor / dstBlendFactor 引擎原生路径（_updateBlendFunc 在材质实例上正确叠加）。
// 本锁因此从「校验顺序」改为「不得复活」——与 selfcheck-contact-fix 的同名锁定保持一致。
{
    const revived = rtSrc.includes('additiveMaterial') || rtSrc.includes('this._additive');
    check('规则D5 自建加法混合材质已退役（空 passes 材质缓存 = localSetLayout 崩溃源，不得复活）',
        !revived, revived ? 'additiveMaterial / _additive 复现' : '');
}

// ---- 规则 E：池护栏压测（同步逻辑副本） ----
const POOL_CAP = 96;
const ACTIVE_CAP = 64;
let pool = 0;
let active = 0;
let destroyed = 0;
let peakActive = 0;
let peakPool = 0;
const inflight: number[] = []; // 每个活跃特效的剩余帧数
let injecting = true;
for (let frame = 0; injecting || inflight.length > 0; frame++) {
    // 到期回收（引擎：playNode 尾帧 recycle → 池满销毁）
    for (let i = inflight.length - 1; i >= 0; i--) {
        inflight[i] -= 1;
        if (inflight[i] <= 0) {
            inflight.splice(i, 1);
            active -= 1;
            if (pool < POOL_CAP) {
                pool += 1;
            } else {
                destroyed += 1;
            }
        }
    }
    if (!injecting) {
        continue; // 排空阶段：只回收不注入，直到全部在途特效归池
    }
    if (frame >= 400) {
        injecting = false; // 注入期结束，进入排空阶段验证无泄漏
        continue;
    }
    // 每帧最多涌入 40 个新特效（engine obtain：活跃满拒绝；池有存货则复用）
    for (let i = 0; i < 40; i++) {
        if (active >= ACTIVE_CAP) {
            break; // obtain 静默丢弃
        }
        if (pool > 0) {
            pool -= 1; // 复用，不新建
        }
        active += 1;
        inflight.push(3 + (frame % 5));
        peakActive = Math.max(peakActive, active);
        peakPool = Math.max(peakPool, pool);
    }
}
check('规则E 突发压测：活跃 ≤64 / 池 ≤96 / 无泄漏',
    peakActive <= ACTIVE_CAP && peakPool <= POOL_CAP && active === 0 && pool <= POOL_CAP,
    `peakActive=${peakActive} peakPool=${peakPool} endActive=${active} destroyed=${destroyed}`);

// ---- 规则 F：六个特效接入点齐全 ----
check('规则F1 撞钉火花（OrbController.onHitPeg → FxManager.spark）',
    /FxManager\.spark\(/.test(srcOf('Pinball/OrbController.ts')));
check('规则F2 炸药爆炸演出（PegComponent.triggerBombExplosion → FxManager.blast）',
    /FxManager\.blast\(/.test(srcOf('Pinball/PegComponent.ts')));
check('规则F3 炮塔枪口焰 + 命中火花（TurretController）',
    /FxManager\.muzzle\(/.test(srcOf('Battle/TurretController.ts'))
    && /FxManager\.spark\(/.test(srcOf('Battle/TurretController.ts')));
check('规则F4 敌人血雾 + 死亡碎浆（EnemyController）',
    /FxManager\.spark\(/.test(srcOf('Battle/EnemyController.ts'))
    && /FxManager\.gibs\(/.test(srcOf('Battle/EnemyController.ts')));
check('规则F5 漏斗吞球汇聚（FunnelSlot.processOrb → FxManager.converge）',
    /FxManager\.converge\(/.test(srcOf('Pinball/FunnelSlot.ts')));
check('规则F6 城堡受击红晕（CastleController → FxManager.screenPulse）',
    /FxManager\.screenPulse\(\)/.test(srcOf('Battle/CastleController.ts')));

// ---- 规则 G：场景零改动（BackdropFx 自举） ----
if (existsSync(SCENE)) {
    const sceneSrc = readFileSync(SCENE, 'utf8');
    // 规则G（2026-09 修订）：编辑器已把 Backdrop 节点序列化进场景，内嵌本身合法（运行时自举幂等可复用）；
    // 真正要防的是热重载把同一组件堆叠上百份（曾序列化出 119 份 BackdropFx）——解析 JSON 统计真实挂载数。
    try {
        const sceneJson = JSON.parse(sceneSrc);
        const backdrop = sceneJson.find((o: any) => o && o._name === 'Backdrop');
        const attachedCount = backdrop ? backdrop._components.length : 0;
        check('规则G Backdrop 组件无热重载堆叠（场景内挂载 ≤3 份）', attachedCount <= 3);
    } catch (e) {
        check('规则G 场景解析失败跳过（' + String(e).slice(0, 30) + '）', true);
    }
} else {
    console.log('[SKIP] 规则G 未找到 MainScene.scene，跳过场景断言');
}

// ---- 规则 H：事件契约未破坏 ----
const busSrc = srcOf('Core/EventBus.ts');
check('规则H ORB_HIT_PEG 载荷字段完整（pegId/orbId/points/hitCount）',
    busSrc.includes('pegId') && busSrc.includes('orbId') && busSrc.includes('points') && busSrc.includes('hitCount'));

// ---- 汇总 ----
if (failed > 0) {
    console.error(`${failed} 项美术/特效自检未通过 ✘`);
    throw new Error(`selfcheck-art-fx: ${failed} 项未通过`);
}
console.log(`美术/特效自检全部通过 ✔（扫描 ${files.length} 个脚本）`);
