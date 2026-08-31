/**
 * 场景接线自检（纯 Node，无引擎依赖）——
 *   node --experimental-transform-types selfcheck-scene-wiring.ts
 *
 * 存在理由：其余自检全部只跑纯逻辑，验不出「代码正确、场景接线错误」这一整类 bug。
 * 本文件把 MainScene.scene 当数据解析，并与源码里的字符串常量交叉断言，
 * 覆盖三个已发生的真实回归：
 *   1. 能量 HUD：EnergyLabel 节点从未挂 EnergyLabelController → UPDATE_ENERGY 零监听、读数永久冻结；
 *   2. 弹珠回收：recycleAllOrbs 找 'Canvas/BattleLayer'，而弹珠实际挂在 Canvas 下 → 恒空转；
 *   3. RelicBar：同一节点序列化出 25× RelicManager + 32× RelicBarController → 互相抹除重建。
 * 另含手术后的首要不变量：全量扫描 __id__，确保重编号未留下悬空引用。
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const REPO = resolve(process.cwd());
const SCENE_PATH = join(REPO, 'assets', 'scenes', 'MainScene.scene');
const SCRIPTS = join(REPO, 'assets', 'scripts');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' —— ' + detail : ''}`);
    if (!ok) failed += 1;
}

/** 递归收集目录下全部 .ts */
function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walkTs(p));
        else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

/** 文件名（= 类名，规则 1 保证单文件单组件）-> 场景 __type__ 前缀
 *  注意不能用 @ccclass 注册名建键：RelicBarController 的注册名是 'RelicBar'，与类名不一致。
 *  场景 __type__ 是 .meta uuid 的压缩形式，与注册名无关，故以文件名为准。 */
const prefixOfScript = new Map<string, string>();
const ALL_TS = walkTs(SCRIPTS);
for (const ts of ALL_TS) {
    const meta = ts + '.meta';
    let uuid = '';
    try {
        uuid = (JSON.parse(readFileSync(meta, 'utf8')) as { uuid?: string }).uuid ?? '';
    } catch {
        continue;
    }
    const code = readFileSync(ts, 'utf8');
    if (uuid && /@ccclass\(/.test(code)) {
        prefixOfScript.set(ts.slice(0, -3).split(/[\\/]/).pop() as string, uuid.slice(0, 5));
    }
}

/** 去掉块注释 / 行注释：源码注释里常原样引用 find('Canvas') 等待匹配文本，不剥会误判 */
function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 解析场景为扁平对象数组（__id__ 即下标） */
const scene = JSON.parse(readFileSync(SCENE_PATH, 'utf8')) as any[];
const at = (i: number) => scene[i] as Record<string, any>;
const isNode = (o: any) => o && (o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene');
const nodes = scene.filter((o: any) => isNode(o)) as any[];
const nameOf = (o: any) => (o?._name as string) ?? '';
/** 场景节点 -> 其组件对象列表 */
const compsOf = (n: any) => (n._components ?? []).map((r: any) => at(r.__id__));
/** 某个脚本组件（按文件名，如 'RelicManager'）在场景中的全部实例 */
const compsOfClass = (cls: string) => {
    const p = prefixOfScript.get(cls);
    if (!p) throw new Error(`场景中无法定位脚本 ${cls}（检查 .ts.meta 是否存在）`);
    return scene.filter((o: any) => typeof o.__type__ === 'string' && o.__type__.startsWith(p)) as any[];
};
/** 由节点反查其完整路径（'Canvas/UILayer/EnergyLabel' 形式，场景根不入路径） */
function pathOf(n: any): string {
    const segs: string[] = [];
    for (let cur = n; isNode(cur) && cur.__type__ === 'cc.Node'; cur = cur._parent ? at(cur._parent.__id__) : null) {
        segs.unshift(nameOf(cur));
    }
    return segs.join('/');
}
/** 按 'a/b/c' 路径在场景里找节点 */
function nodeByPath(path: string): any {
    return nodes.find((n) => n.__type__ === 'cc.Node' && pathOf(n) === path) ?? null;
}
/** 读某脚本的源码（已剥注释：注释里会原样引用待匹配的字符串，不剥会误判） */
const src = (cls: string) => {
    const file = ALL_TS.find((f) => f.endsWith(`${cls}.ts`));
    if (!file) throw new Error(`找不到源码 ${cls}.ts`);
    return stripComments(readFileSync(file, 'utf8'));
};

// ==================== 1. 能量 HUD 接线 ====================
// 不变量：ensureMounted 里 find 的路径必须在场景中真实存在、带 cc.Label，且确有代码调用它。
// 三者缺一，能量读数就永久冻结在编辑器默认文案（本 bug 曾长期存在）。
{
    const ctl = src('EnergyLabelController');
    const boot = ctl.match(/ensureMounted\s*\([^)]*\)\s*:[\s\S]*?find\(\s*'([^']+)'/);
    check('能量1 EnergyLabelController.ensureMounted 存在且含 find 路径', !!boot, boot ? boot[1] : '未找到自举方法');
    const path = boot?.[1] ?? '';
    const node = path ? nodeByPath(path) : null;
    check(`能量2 场景中存在节点 ${path || '<无路径>'}`, !!node);
    if (node) {
        const mounted = compsOfClass('EnergyLabelController').some((c) => at(c.node.__id__) === node);
        const hasLabel = compsOf(node).some((c) => c.__type__ === 'cc.Label');
        check('能量3 该节点带 cc.Label（控制器 onLoad 依赖）', hasLabel);
        check('能量4 控制器已挂载 或 已被代码自举',
            mounted || /EnergyLabelController\.ensureMounted\(\)/.test(src('DeckManager')),
            mounted ? '场景直挂' : 'DeckManager.onLoad 自举');
    }
}

// ==================== 2. 弹珠回收宿主 ====================
// 不变量：recycleAllOrbs 的 find 路径 === 弹珠真实父节点路径（= LauncherController 宿主的父节点）。
// 二者不一致时该方法静默返回空数组，弹窗背后残球继续撞钉发声。
{
    const oc = src('OrbController');
    const fn = oc.match(/recycleAllOrbs[\s\S]*?\{([\s\S]*?)\n    \}/)?.[1] ?? '';
    const finds = [...fn.matchAll(/find\(\s*'([^']+)'/g)].map((m) => m[1]);
    check('回收1 recycleAllOrbs 内有且仅有一个 find 宿主路径', finds.length === 1, finds.join(' | '));
    const lc = compsOfClass('LauncherController')[0];
    const host = lc ? at(lc.node.__id__) : null;
    const orbParent = host?._parent ? at(host._parent.__id__) : null;
    const actual = orbParent ? pathOf(orbParent) : '';
    check('回收2 LauncherController 宿主确有父节点（orb.setParent(this.node.parent)）', !!orbParent);
    check('回收3 回收宿主路径与弹珠真实父节点一致', finds[0] === actual, `代码 find('${finds[0]}') vs 场景 '${actual}'`);
}

// ==================== 3. RelicBar 组件唯一性 ====================
// 同一节点上的重复实例会互相抢静态标志、并把彼此刚重建的瓷片抹掉。
{
    const bar = nodes.find((n) => nameOf(n) === 'RelicBar');
    check('遗物1 场景中存在 RelicBar 节点', !!bar);
    if (bar) {
        for (const cls of ['RelicManager', 'RelicBarController']) {
            const p = prefixOfScript.get(cls) ?? '';
            const dup = compsOf(bar).filter((c) => typeof c.__type__ === 'string' && c.__type__.startsWith(p)).length;
            check(`遗物2 RelicBar 上 ${cls} ≤1 个`, dup <= 1, `实际 ${dup} 个`);
        }
    }
}

// ==================== 4. 隔墙圆头碰撞分组 ====================
// 圆头与方身分组不一致时，隔墙顶端不闭合，弹珠在墙角挂住。
{
    const dividers = nodes.filter((n) => /^Divider_/.test(nameOf(n)));
    check('隔墙1 存在 Divider_Left / Divider_Right', dividers.length === 2, `${dividers.length} 个`);
    for (const d of dividers) {
        const cs = compsOf(d);
        const box = cs.find((c) => c.__type__ === 'cc.BoxCollider2D');
        const circ = cs.find((c) => c.__type__ === 'cc.CircleCollider2D');
        check(`隔墙2 ${nameOf(d)} 圆头与方身同分组`, !!box && !!circ && box._group === circ._group,
            `box=${box?._group} circle=${circ?._group}`);
    }
}

// ==================== 5. Inspector 覆盖值不得偏离代码默认 ====================
// 场景序列化值会静默覆盖代码默认，是「改了平衡参数没生效」的头号来源。
{
    const peg = compsOfClass('PegBoardManager')[0];
    check('数值1 场景中存在 PegBoardManager', !!peg);
    if (peg) {
        const code = src('PegBoardManager');
        for (const field of ['bombCount', 'refreshCount']) {
            const def = Number(code.match(new RegExp(`${field}\\s*=\\s*(\\d+)`))?.[1]);
            check(`数值2 ${field} 场景值 == 代码默认 ${def}`, peg[field] === def, `场景 ${peg[field]}`);
        }
    }
}

// ==================== 6. 场地中心不得有隐形遗留碰撞块 ====================
{
    const wallLayer = nodes.find((n) => nameOf(n) === 'WallLayer');
    const kids = wallLayer ? (wallLayer._children ?? []).map((r) => at(r.__id__)) : [];
    const stale = kids.filter((n) => nameOf(n) !== 'TopWall'
        && (n._lpos?.x ?? 0) === 0 && (n._lpos?.y ?? 0) === 0);
    check('墙体1 WallLayer 下无居中隐形遗留块', stale.length === 0, stale.map((n) => nameOf(n)).join(', '));
    const realWalls = nodes.filter((n) => /^(Left|Right)Wall$/.test(nameOf(n)));
    check('墙体2 真侧墙各存 1 个', realWalls.length === 2, `${realWalls.length} 个`);
}

// ==================== 7. 引用完整性（手术重编号后的首要不变量）====================
// 场景是扁平数组 + __id__ 下标引用；删除节点会让其后所有下标前移，
// 任何漏改都表现为「编辑器里引用变空 / 指向错误对象」，故必须全量扫描。
{
    const N = scene.length;
    const dangling: string[] = [];
    const scan = (v: any, at2: string): void => {
        if (Array.isArray(v)) {
            v.forEach((x, i) => scan(x, `${at2}[${i}]`));
            return;
        }
        if (v && typeof v === 'object') {
            const keys = Object.keys(v);
            if (keys.length === 1 && keys[0] === '__id__') {
                const id = v.__id__;
                if (!Number.isInteger(id) || id < 0 || id >= N || !scene[id]) {
                    dangling.push(`${at2} -> ${JSON.stringify(v)}`);
                }
                return;
            }
            for (const k of keys) scan(v[k], `${at2}.${k}`);
        }
    };
    scene.forEach((o: any, i: number) => scan(o, `#${i}`));
    check('引用1 无越界 / 悬空 __id__', dangling.length === 0, dangling.slice(0, 5).join('; '));
}

console.log(`\n解析 ${SCENE_PATH}：${scene.length} 个序列化对象 / ${nodes.length} 个节点。`);
if (failed > 0) {
    console.log(`场景接线自检失败：${failed} 项`);
    process.exit(1);
}
console.log('场景接线自检全部通过 ✔');

