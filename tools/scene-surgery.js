/**
 * MainScene 一次性外科手术（幂等：已是目标状态则报 no-op）。
 *
 * 修复项（全部经 assets/scenes/MainScene.scene 实测确认）：
 *  1. 删除 WallLayer/LeftWall、WallLayer/RightWall —— pos(0,0) + BoxCollider 100×100 的
 *     遗留隐形块，钉在弹板正中心；当前仅因 group=1(Default) 与 ORB mask 不交而侥幸失效，
 *     任何人改其分组即在场地中心出现隐形挡板。真墙是 Canvas/LeftWall(-360)、Canvas/RightWall(360)。
 *  2. 删除 UILayer/TrajectoryGraphics —— 死节点（LauncherController.trajectoryGraphics
 *     实际指向 Canvas/TrajectoryGraphics）。
 *  3. 删除 Canvas/PegContainer —— 空壳，与 PegboardLayer/PegContainer 重名重复。
 *  4. RelicBar 组件去重：25× RelicManager + 45× RelicBarController → 各保留 1 个。
 *  5. Divider_Left/Right 的 CircleCollider2D（隔墙顶部圆头收口）group 1(Default) → 8(WALL)：
 *     此前圆头不参与碰撞，弹珠在隔墙顶端挂角。
 *  6. PegBoardManager Inspector 覆盖值 bombCount 2→1、refreshCount 2→1，归位代码默认与类注释。
 *
 * 用法：node tools/scene-surgery.js [--dry]   （--dry-run 等价；其余参数一律报错退出）
 */
const fs = require('fs');
const path = require('path');

const SCENE = path.join(__dirname, '..', 'assets', 'scenes', 'MainScene.scene');
// --dry-run 是 --dry 最常见的误拼。若不显式接受，它会静默降级成「写入模式」直接改写场景文件，
// 而调用者以为自己在做只读校验 —— 对破坏性脚本而言这是必须堵住的脚枪，故同时拒绝任何未知参数。
const ARGV = process.argv.slice(2);
const DRY = ARGV.includes('--dry') || ARGV.includes('--dry-run');
const UNKNOWN = ARGV.filter((a) => a !== '--dry' && a !== '--dry-run');
if (UNKNOWN.length) {
    console.error('未知参数：' + UNKNOWN.join(' ') + '（本脚本仅支持 --dry）');
    process.exit(2);
}

/** RelicBar 上需去重保留的组件（压缩 uuid 前 5 位）→ 保留份数 */
const RELIC_BAR_KEEP = { f9ef4: 1, '7fb7d': 1 };

const raw = fs.readFileSync(SCENE, 'utf8');
const s = JSON.parse(raw);
s.forEach((o, i) => { o.__i = i; });

const drop = new Set();
const log = [];

/** 递归收集节点自身 + 全部子孙 + 全部组件的下标 */
function collectNode(idx) {
    const out = [idx];
    for (const c of (s[idx]._children || [])) out.push(...collectNode(c.__id__));
    for (const c of (s[idx]._components || [])) out.push(c.__id__);
    return out;
}

// ---------- 1~3. 删除遗留 / 死 / 空壳节点 ----------
const VICTIMS = [
    { parent: 'WallLayer', names: ['LeftWall', 'RightWall'], why: '场地中心隐形遗留块' },
    { parent: 'UILayer', names: ['TrajectoryGraphics'], why: '死节点（发射器指向 Canvas 下同名节点）' },
    { parent: 'Canvas', names: ['PegContainer'], why: '空壳重名（真钉板在 PegboardLayer 下）' },
];
for (const spec of VICTIMS) {
    for (const n of s.filter((o) => o.__type__ === 'cc.Node' && spec.names.includes(o._name))) {
        const par = n._parent ? s[n._parent.__id__] : null;
        if (!par || par._name !== spec.parent) continue;
        // 安全阀：只删无子节点、无自定义组件的纯遗留节点（杜绝误伤 TopWall 等真在用的节点）
        if ((n._children || []).length > 0) continue;
        if ((n._components || []).some((c) => !s[c.__id__].__type__.startsWith('cc.'))) continue;
        collectNode(n.__i).forEach((i) => drop.add(i));
        log.push(`del node #${n.__i} ${spec.parent}/${n._name}  (${spec.why})`);
    }
}

// ---------- 4. RelicBar 组件去重 ----------
for (const bar of s.filter((o) => o.__type__ === 'cc.Node' && o._name === 'RelicBar')) {
    const seen = {};
    const kept = [];
    for (const ref of bar._components) {
        const kind = s[ref.__id__].__type__.slice(0, 5);
        if (RELIC_BAR_KEEP[kind]) {
            seen[kind] = (seen[kind] || 0) + 1;
            if (seen[kind] > RELIC_BAR_KEEP[kind]) {
                drop.add(ref.__id__);
                log.push(`del comp #${ref.__id__} ${kind}  (RelicBar 重复实例)`);
                continue;
            }
        }
        kept.push(ref);
    }
    bar._components = kept;
    log.push(`RelicBar #${bar.__i} 保留 ${JSON.stringify(seen)}`);
}

// ---------- 5. Divider 圆头碰撞分组 Default(1) → WALL(8) ----------
for (const d of s.filter((o) => o.__type__ === 'cc.Node' && /^Divider_/.test(o._name || ''))) {
    for (const ref of d._components) {
        const comp = s[ref.__id__];
        if (comp.__type__ === 'cc.CircleCollider2D' && comp._group !== 8) {
            log.push(`fix #${ref.__id__} ${d._name}.CircleCollider2D group ${comp._group} -> 8`);
            comp._group = 8;
        }
    }
}

// ---------- 6. PegBoardManager 特殊钉数量归位代码默认 ----------
for (const comp of s) {
    if (comp.__type__ && comp.__type__.slice(0, 5) === '2d4dc') {
        for (const k of ['bombCount', 'refreshCount']) {
            if (comp[k] !== 1) {
                log.push(`fix PegBoardManager.${k} ${comp[k]} -> 1`);
                comp[k] = 1;
            }
        }
    }
}

// ---------- 从存活对象的 _children / _components 中剔除已删引用 ----------
for (let i = 0; i < s.length; i++) {
    if (drop.has(i)) continue;
    for (const key of ['_children', '_components']) {
        const arr = s[i][key];
        if (!Array.isArray(arr)) continue;
        const kept = arr.filter((r) => !(r && typeof r.__id__ === 'number' && drop.has(r.__id__)));
        if (kept.length !== arr.length) {
            log.push(`strip ${arr.length - kept.length} ${key} ref(s) from #${i} ${s[i]._name || s[i].__type__}`);
            s[i][key] = kept;
        }
    }
}

// ---------- 重索引：删除数组元素后重写全文件所有 __id__ 引用 ----------
const map = new Map();
s.forEach((o, i) => { if (!drop.has(i)) map.set(i, map.size); });
const survivors = s.filter((_, i) => !drop.has(i)).map((o) => { delete o.__i; return o; });
(function reindex(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(reindex); return; }
    if (typeof node.__id__ === 'number') node.__id__ = map.get(node.__id__);
    for (const k in node) reindex(node[k]);
})(survivors);

// ---------- 校验：重新解析产物并断言目标状态，任一断言失败即不落盘 ----------
const out = JSON.stringify(survivors, null, 2) + '\n';
const v = JSON.parse(out);
// 场景根是 cc.Scene（其子节点 Canvas 的 _parent 指向它），节点断言须一并覆盖
const vn = v.filter((o) => o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene');
const isNode = (o) => o && (o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene');
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL: ' + msg); process.exit(1); } };

assert(v.every((o) => typeof o.__type__ === 'string'), 'every object keeps a __type__');
assert(vn.every((n) => !n._parent || isNode(v[n._parent.__id__])), 'every node parent resolves to a node');
assert(vn.every((n) => (n._children || []).every((c) => isNode(v[c.__id__]))), 'every child ref resolves to a node');
assert(vn.every((n) => (n._components || []).every((c) => typeof v[c.__id__].__type__ === 'string')), 'every component ref resolves');
assert(vn.every((n) => (n._components || []).every((c) => v[c.__id__].node.__id__ === v.indexOf(n))), 'component back-ref to owner intact');
assert(vn.filter((n) => n._name === 'TopWall').length === 1, 'TopWall preserved');
assert(vn.filter((n) => n._name === 'PegContainer').length === 1, 'PegboardLayer/PegContainer preserved');
assert(vn.filter((n) => n._name === 'TrajectoryGraphics').length === 1, 'one TrajectoryGraphics preserved');
assert(vn.filter((n) => n._name === 'LeftWall').length === 1, 'one LeftWall (the real one) preserved');
assert(vn.filter((n) => n._name === 'RightWall').length === 1, 'one RightWall (the real one) preserved');
assert(!vn.some((n) => n._parent && v[n._parent.__id__]._name === 'WallLayer' && n._name !== 'TopWall'), 'stale WallLayer walls gone');
assert(vn.every((n) => (n._children || []).every((c) => v[c.__id__]._parent.__id__ === v.indexOf(n))), 'parent/child links bidirectionally consistent');

const bar = vn.find((n) => n._name === 'RelicBar');
const kinds = bar._components.map((c) => v[c.__id__].__type__.slice(0, 5));
assert(kinds.filter((k) => k === 'f9ef4').length === 1, 'exactly 1 RelicManager on RelicBar');
assert(kinds.filter((k) => k === '7fb7d').length === 1, 'exactly 1 RelicBarController on RelicBar');

for (const d of vn.filter((n) => /^Divider_/.test(n._name))) {
    const circ = d._components.map((c) => v[c.__id__]).find((c) => c.__type__ === 'cc.CircleCollider2D');
    assert(circ && circ._group === 8, d._name + ' circle collider moved to WALL group');
}

const peg = v.find((o) => o.__type__ && o.__type__.slice(0, 5) === '2d4dc');
assert(peg.bombCount === 1 && peg.refreshCount === 1, 'PegBoardManager bomb/refresh counts = 1/1');

const lc = v.find((o) => o.__type__ && o.__type__.slice(0, 5) === 'c90d0');
const traj = v[lc.trajectoryGraphics.__id__];
assert(traj.__type__ === 'cc.Node' && traj._name === 'TrajectoryGraphics', 'LauncherController.trajectoryGraphics still resolves to the live node');
assert(traj._components.some((c) => v[c.__id__].__type__ === 'cc.Graphics'), 'referenced TrajectoryGraphics still owns a cc.Graphics');
assert(v[lc.launcherNode.__id__].__type__ === 'cc.Node', 'LauncherController.launcherNode still resolves');
assert(typeof lc.orbPrefab.__uuid__ === 'string', 'LauncherController.orbPrefab uuid intact');
assert(v.filter((o) => o.__type__ === 'cc.PrefabInfo').length === s.filter((o) => o.__type__ === 'cc.PrefabInfo').length, 'PrefabInfo count unchanged');

console.log(log.join('\n') || 'no-op (already clean)');
console.log(`\nobjects ${s.length} -> ${survivors.length}  (dropped ${drop.size})`);
if (DRY) {
    console.log('\n[dry-run] scene NOT written');
} else {
    fs.writeFileSync(SCENE + '.bak-surgery', raw);
    fs.writeFileSync(SCENE, out);
    console.log('written: ' + SCENE);
    console.log('backup : ' + SCENE + '.bak-surgery');
}


