/**
 * 图标 / UI 立体件自检（纯 Node；IconGlyph 无引擎依赖可直连，IconLib 走源码提取）：
 *   node --experimental-transform-types selfcheck-icon-ui.ts
 *
 * 锁定「自绘矢量图标体系」的地基不变式：
 *  规则 A  IconLib 注册表数据健康：全量可解析 / 轮廓非退化（点数≥3 且鞋带面积>0）
 *          / 坐标有限 / 不越出 100×100 设计网格（±6 容差）/ 注册键唯一；
 *  规则 B  引用完整性：代码里出现的图标名（mountIcon / drawIcon 第二参、BTN_ICON /
 *          BADGE_ICON 常量、icon: 'camelCase' 字段）必须已注册——拼错在自检期暴露，
 *          不进运行时；
 *  规则 C  渲染文案 emoji 禁令：字符串字面量出现 pictographic emoji 即 FAIL
 *          （白名单：console.* 日志行 / 单色 dingbat ✓ ✕ ✖ ◆ / icon 数据值 /
 *          CardArchetype 枚举显示名——后两者为不渲染的遗留数据，注释已标注）；
 *  规则 D  HitStop 护栏（同步公式副本）：时长钳制区间 sane、重叠触发取 max 不叠加、
 *          开火顿帧落在区间内。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { geometryBounds, parseIconPath } from './assets/scripts/Core/IconGlyph.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, 'assets', 'scripts');

let failed = 0;
function check(name: string, ok: boolean, detail: string = ''): void {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' —— ' + detail : ''}`);
    if (!ok) failed += 1;
}

/** 递归收集 .ts 源文件（排除 .d.ts） */
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
const rel = (p: string): string => relative(ROOT, p).split('\\').join('/');

// ---------- 规则 A：注册表数据健康 ----------

// IconLib import 了 'cc'（Graphics/Node），Node 下无法直接 import —— 从源码提取
// 「参数化生成器 + ICON_SOURCES 字面量」两段纯 JS 代码求值，拿到与运行时完全一致的数据。
const iconLibSrc = readFileSync(join(ROOT, 'Core', 'IconLib.ts'), 'utf8');
const genBlock = iconLibSrc.match(/\/\/ ---------- 参数化生成器[\s\S]*?(?=\/\/ ---------- 图标注册表)/)?.[0] ?? '';
const dataBlock = iconLibSrc.match(/const ICON_SOURCES[\s\S]*?\n\};/)?.[0] ?? '';
check('IconLib 源码含参数化生成器段与 ICON_SOURCES 注册表', genBlock.length > 100 && dataBlock.includes('ICON_SOURCES'));

let sources: Record<string, string> = {};
let evalError = '';
try {
    // 生成器段含 TS 类型标注，先剥类型再求值（与 --experimental-transform-types 同源语义）
    const js = stripTypeScriptTypes(`${genBlock}\n${dataBlock}`);
    sources = new Function(`${js}\n;return ICON_SOURCES;`)() as Record<string, string>;
} catch (err) {
    evalError = (err as Error).message;
}
check('ICON_SOURCES 求值成功（生成器纯 JS，无引擎依赖）', Object.keys(sources).length > 0, evalError);

// 键唯一：对象字面量重复键会被静默覆盖，改用文本正则查重
const keyRe = /^    ([a-zA-Z]\w*): /gm;
const allKeys = [...dataBlock.matchAll(keyRe)].map((m) => m[1]);
const dupKeys = allKeys.filter((k, i) => allKeys.indexOf(k) !== i);
check('注册表键唯一（无重复键覆盖）', dupKeys.length === 0, dupKeys.join(', '));

// 全量解析：可解析 / 有限坐标（parse+bounds 抛错）/ 轮廓退化 / 越界
const GRID = 100;
const TOL = 6;
for (const [name, d] of Object.entries(sources)) {
    try {
        const geo = parseIconPath(d);
        const b = geometryBounds(geo);
        const oob = b.minX < -TOL || b.minY < -TOL || b.maxX > GRID + TOL || b.maxY > GRID + TOL;
        check(`图标 ${name} 包围盒在网格容差内`, !oob,
            `[${b.minX.toFixed(1)},${b.minY.toFixed(1)} ~ ${b.maxX.toFixed(1)},${b.maxY.toFixed(1)}]`);
        let degenerate = '';
        for (let ci = 0; ci < geo.contours.length; ci++) {
            const pts = geo.contours[ci].pts;
            if (pts.length < 6) {
                degenerate = `轮廓${ci} 点数 ${pts.length / 2} < 3`;
                break;
            }
            let area2 = 0;
            for (let i = 0; i < pts.length; i += 2) {
                const j = (i + 2) % pts.length;
                area2 += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
            }
            if (Math.abs(area2) / 2 < 0.5) {
                degenerate = `轮廓${ci} 鞋带面积 ${Math.abs(area2) / 2} ≈ 0`;
                break;
            }
        }
        check(`图标 ${name} 轮廓无退化（${geo.contours.length} 条）`, degenerate === '', degenerate);
    } catch (err) {
        check(`图标 ${name} 可解析`, false, (err as Error).message);
    }
}

// ---------- 规则 B：引用完整性 ----------

const srcOf: Record<string, string> = {};
for (const f of files) {
    srcOf[rel(f)] = readFileSync(f, 'utf8');
}
const registered = new Set(Object.keys(sources));
const unknown: string[] = [];
for (const [file, src] of Object.entries(srcOf)) {
    // mountIcon(parent, 'name' / drawIcon(g, 'name'：第二参字符串字面量
    for (const m of src.matchAll(/(?:mountIcon|drawIcon)\(\s*[\w.?!]+\s*,\s*'([a-zA-Z]\w*)'/g)) {
        if (!registered.has(m[1])) {
            unknown.push(`${file}: ${m[1]}`);
        }
    }
    // 常量图标名（徽章 / 按钮配置）
    for (const m of src.matchAll(/(?:BTN_ICON|BADGE_ICON)\s*=\s*'([a-zA-Z]\w*)'/g)) {
        if (!registered.has(m[1])) {
            unknown.push(`${file}: ${m[1]}`);
        }
    }
    // icon: 'camelCase' 数据字段（RELIC_DATABASE / AFFIX_STATS / ORB_DISPLAY 等；
    // emoji 值为遗留未渲染数据，正则限定 camelCase 形态才视为图标引用）
    for (const m of src.matchAll(/icon:\s*'([a-zA-Z]\w*)'/g)) {
        if (!registered.has(m[1])) {
            unknown.push(`${file}: ${m[1]}`);
        }
    }
}
check('代码引用的图标名全部已注册', unknown.length === 0, unknown.join(', '));

// ---------- 规则 C：渲染文案 emoji 禁令 ----------

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const ALLOW_CHARS = new Set(['✓', '✕', '✖', '◆']);
/** 提取一行内所有字符串字面量内容 */
const STR_RE = /(['"])((?:\\.|(?!\1).)*?)\1/g;
const offenders: string[] = [];
for (const [file, src] of Object.entries(srcOf)) {
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) {
            return; // 注释中的 emoji 不渲染
        }
        if (/^console\./.test(trimmed)) {
            return; // 日志行不渲染
        }
        const inCardArchetype = /CardArchetype/.test(file) || trimmed.startsWith('Lava =') || trimmed.startsWith('Lightning =')
            || trimmed.startsWith('Frost =') || trimmed.startsWith('Universal =');
        for (const m of line.matchAll(STR_RE)) {
            const text = m[2];
            for (const ch of text) {
                if (EMOJI_RE.test(ch)) {
                    // icon 数据值：遗留 emoji 数据不渲染（规则 B 已锁定 camelCase 引用）
                    if (/\bicon:\s*'/.test(m[2]) || /\bicon:\s*'/.
                        test(line) && line.includes(`'${text}'`)) {
                        break;
                    }
                    if (inCardArchetype) {
                        break;
                    }
                    if (ALLOW_CHARS.has(ch)) {
                        continue;
                    }
                    offenders.push(`${file}:${idx + 1}: ${text.slice(0, 40)}`);
                    break;
                }
            }
        }
    });
}
check('渲染文案零 emoji（白名单：✓✕✖◆ / console / icon 数据 / CardArchetype）',
    offenders.length === 0, offenders.slice(0, 6).join(' | '));

// ---------- 规则 D：HitStop 护栏（同步公式副本） ----------

const hitSrc = srcOf['Core/HitStop.ts'] ?? '';
const D_MIN = 20;   // 与 Core/HitStop.ts DURATION_MIN_MS 同步
const D_MAX = 110;  // 与 Core/HitStop.ts DURATION_MAX_MS 同步
const FIRE_STOP = 40; // 与 Core/HitStop.ts TURRET_FIRE_STOP_MS 同步
check('HitStop 时长区间 sane（10ms ≤ min < max ≤ 150ms）', D_MIN >= 10 && D_MIN < D_MAX && D_MAX <= 150);
const clampMs = (ms: number): number => Math.max(D_MIN, Math.min(D_MAX, ms));
check('HitStop 钳制公式副本（5→20 / 40→40 / 500→110）',
    clampMs(5) === 20 && clampMs(40) === 40 && clampMs(500) === 110);
check('开火顿帧落在钳制区间内', FIRE_STOP >= D_MIN && FIRE_STOP <= D_MAX);
check('HitStop 重叠触发取 max 不叠加（源码锁定）',
    /inst\._remainMs = Math\.max\(inst\._remainMs, want\)/.test(hitSrc));
check('HitStop 弹窗期免疫锁存在（与 CameraShake/FxManager 同策略）',
    /_modalOpen/.test(hitSrc) && /UI_MODAL_CHANGED/.test(hitSrc));
// 回归护栏（2026-09-03 预览实测炸点）：访问器单例的 getter/setter 必须成对——
// 只写 getter 时 onLoad 里的 `HitStop.instance = this` 会抛
// "Cannot set property instance ... which has only a getter"，场景启动即白屏报错。
check('HitStop 单例访问器成对：onLoad 回写 instance 的前提是存在 static set instance',
    !/HitStop\.instance = this/.test(hitSrc) || /public static set instance/.test(hitSrc));

// ---------- 规则 E：城堡矢量精绘（GAME_PLAN 4.2 场景件：色块 → 主题化造型） ----------

const castleSrc = srcOf['Battle/CastleController.ts'] ?? '';
check('城堡精绘接线：onLoad 调用 ensureCastleArt，旧单色 Sprite 退役（销毁组件）',
    /this\.ensureCastleArt\(\);/.test(castleSrc)
    && /node\.getComponent\(Sprite\)\?\.destroy\(\)/.test(castleSrc));
check('城堡造型要素齐备：CastleArt 层 + 基座/双塔/主楼/雉堞/饰带/拱门/铆钉',
    /getChildByName\('CastleArt'\)/.test(castleSrc)
    && /roundRect\(-33, -45, 66, 9, 4\)/.test(castleSrc) // 基座
    && /g\.rect\(-31, -38, 14, 80\)/.test(castleSrc) // 左塔
    && /g\.rect\(-15, -38, 30, 72\)/.test(castleSrc) // 主楼
    && /g\.rect\(-31, 6, 62, 4\)/.test(castleSrc) // 铜饰带
    && /g\.circle\(0, -22, 8\)/.test(castleSrc) // 拱门
    && /g\.circle\(rx, ry, 1\.7\)/.test(castleSrc)); // 铆钉
check('炉火窗随血量脉动（update：亮度 = (70+185×血量比例) × 正弦颤动，同步公式副本）',
    /protected update\(dt: number\)/.test(castleSrc)
    && /const base = 70 \+ 185 \* ratio;/.test(castleSrc)
    && /0\.86 \+ 0\.14 \* Math\.sin\(this\._glowClock \* 2\.6\)/.test(castleSrc));
// 血量比例与亮度公式的纯函数副本：钳制/单调性回归
const glowBase = (hp: number, maxHp: number): number => {
    const ratio = maxHp > 0 ? Math.min(1, hp / maxHp) : 0;
    return 70 + 185 * ratio;
};
check('炉火亮度公式副本：满血 255 / 半血 162 / 零血 70（单调衰减不越界）',
    glowBase(100, 100) === 255 && Math.round(glowBase(50, 100)) === 163 && glowBase(0, 100) === 70);

// ---------- 规则 F：卡面稀有度边框（普通铁灰 / 稀有电光青 / 史诗金 + 贵气脉冲） ----------

const uikitSrc = srcOf['Core/UiKit.ts'] ?? '';
const rewardSrc = srcOf['UI/RewardDialog.ts'] ?? '';
check('UiKit 卡面四件套齐备：rarityTier / rarityColor / cardFrame / attachEpicGlow+removeEpicGlow',
    /export function rarityTier/.test(uikitSrc)
    && /export function rarityColor/.test(uikitSrc)
    && /export function cardFrame/.test(uikitSrc)
    && /export function attachEpicGlow/.test(uikitSrc)
    && /export function removeEpicGlow/.test(uikitSrc));
check('档位色相锁定：普通=铁灰 / 稀有=电光青 / 史诗=金（无新增 hex 字面量）',
    /tier === 2 \? Theme\.ui\.gold : tier === 1 \? Theme\.machine\.edge : Theme\.ui\.gray/.test(uikitSrc));
check('史诗贵气三层合成：金框 + 四角钻石饰 + EpicGlow 呼吸（repeatForever yoyo 结构）',
    /const d = 8;/.test(uikitSrc)
    && /repeatForever\(tween\(\)\.to\(0\.8, \{ opacity: 150 \}\)\.to\(0\.8, \{ opacity: 70 \}\)\)/.test(uikitSrc));
check('RewardDialog 接线：色条 → cardFrame(CARD_W,CARD_H,tier) → 史诗挂金晕 / 非史诗移除金晕',
    /g\.roundRect\(-CARD_W \/ 2 \+ 8, -CARD_H \/ 2 \+ 14, 4\.5, CARD_H - 28, 2\.25\)/.test(rewardSrc)
    && /cardFrame\(g, CARD_W, CARD_H, tier\)/.test(rewardSrc)
    && /attachEpicGlow\(card, CARD_W, CARD_H\)/.test(rewardSrc)
    && /removeEpicGlow\(card\)/.test(rewardSrc)
    && /attachCardFrameImage\(card, tier\)/.test(rewardSrc));
check('RewardDialog 流派色条映射四流派（熔岩/电光/冰封/中立金）',
    /archetype\.includes\('熔岩'\)/.test(rewardSrc)
    && /archetype\.includes\('电光'\)/.test(rewardSrc)
    && /archetype\.includes\('冰封'\)/.test(rewardSrc)
    && /return Theme\.ui\.gold;/.test(rewardSrc));

// ---------- 规则 G：全按钮凸起统一（raisedButton 接入面清点） ----------

const raisedConsumers = Object.entries(srcOf)
    .filter(([, src]) => /import \{[^}]*raisedButton[^}]*\} from '\.\.\/Core\/UiKit'|import \{[^}]*raisedButton[^}]*\} from '\.\/Core\/UiKit'/.test(src))
    .map(([f]) => f);
check('raisedButton 统一凸起接入 ≥3 个弹窗（商店/背包/每日任务）', raisedConsumers.length >= 3,
    raisedConsumers.join(', '));

// ---------- 规则 H：生成贴图接线（textures/ 落盘文件 ↔ 代码引用一致性 + 格式拦截） ----------

const texCacheSrc = srcOf['Core/TexCache.ts'] ?? '';
const texDir = join(here, 'assets', 'resources', 'textures');
if (existsSync(texDir)) {
// H1 注册清单与落盘文件一一对应（防改名/漏提交）
for (const name of ['turret_forge_castle', 'enemy_normal', 'enemy_shield', 'enemy_speed', 'enemy_slime', 'enemy_boss', 'card_frame_common', 'card_frame_rare', 'card_frame_epic']) {
    check(`贴图 ${name}.png 已落盘且登记于 TexCache.TEX_NAMES`,
        existsSync(join(texDir, `${name}.png`)) && texCacheSrc.includes(`'${name}'`));
}
// H2 三类消费点接线存在（城堡/敌人/卡面；敌人与卡面为动态拼名，锁定前缀）
check('贴图消费点接线：城堡 loadTex / 敌人 enemy_<type> 前缀 / 卡面三档动态名',
    /loadTex\('turret_forge_castle'/.test(castleSrc)
    && /loadTex\(`enemy_\$\{name\}`/.test(srcOf['Battle/EnemyController.ts'] ?? '')
    && /'card_frame_common', 'card_frame_rare', 'card_frame_epic'/.test(srcOf['UI/RewardDialog.ts'] ?? ''));
// H3 真 PNG 拦截：生成器导出常把透明底烧成棋盘格 JPEG 再改 .png 扩展名——
// Cocos 编辑器虽能导入，但立绘周围会显示灰白棋盘格（alpha 已丢失，无法在运行时恢复）。
// 必须从生成器重新导出「透明背景 PNG」覆盖同名文件，本项才会转绿。
const badFmt: string[] = [];
for (const f of readdirSync(texDir)) {
    if (!f.endsWith('.png')) {
        continue;
    }
    const head = readFileSync(join(texDir, f)).subarray(0, 4);
    if (!(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)) {
        badFmt.push(f);
    }
}
check('贴图全部为真 PNG（JPEG 假 PNG = 透明底已烧成棋盘格，需重导出透明 PNG）',
    badFmt.length === 0,
    badFmt.length ? `JPEG 内容: ${badFmt.join(', ')}` : '');
} else {
    console.log('[SKIP] 规则H 未找到 assets/resources/textures/，跳过贴图断言');
}

// ---------- 汇总 ----------

console.log(failed === 0 ? '\n✅ 图标 / UI 立体件自检全部通过' : `\n❌ ${failed} 项未通过`);
if (failed > 0) {
    process.exit(1);
}
