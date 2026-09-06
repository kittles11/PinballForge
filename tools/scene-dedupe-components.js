// 通用场景手术：全场景「同类型脚本组件去重」（每节点每脚本 uuid 只保留 1 份）+ 清理重复的自举宿主节点。
// 背景：编辑器热重载每次都会给场景节点叠加脚本组件并随保存落盘（BackdropFx 曾 19 份、
// DeckViewDialog ~300 份、DailyTaskDialog ~250 份、DailyTaskBadge 21 份、HitStopHost 节点 ×11）。
// 范式与 scene-surgery.js / backdrop-dedup.js 一致：剔除 → 剥离引用 → 重索引 → 断言校验 → 落盘。
// 幂等：已是目标状态则 no-op。用法：node tools/scene-dedupe-components.js [--dry]
const fs = require('fs');
const SCENE = 'assets/scenes/MainScene.scene';
const DRY = process.argv.includes('--dry');
const RESERVED_NODE_NAMES = new Set(['HitStopHost', 'FxLayer', 'FloatingTextLayer']); // 自举宿主节点：只留第一个

const s = JSON.parse(fs.readFileSync(SCENE, 'utf8'));
const isNode = (o) => o && o.__type__ === 'cc.Node';
const drop = new Set();
let dedupedComps = 0;
let droppedNodes = 0;

// 1) 每节点脚本组件去重（cc.* 内建组件不去重——同类型多内建组件是合法配置）
const seenByNode = new Map();
for (let i = 0; i < s.length; i++) {
    const o = s[i];
    if (!isNode(o)) continue;
    const seen = new Set();
    seenByNode.set(i, seen);
    const kept = [];
    for (const ref of o._components || []) {
        const comp = s[ref.__id__];
        const t = comp && comp.__type__;
        if (!t) continue;
        if (t.startsWith('cc.')) { kept.push(ref); continue; }
        if (seen.has(t)) { drop.add(ref.__id__); dedupedComps++; continue; }
        seen.add(t);
        kept.push(ref);
    }
    if (kept.length !== (o._components || []).length) o._components = kept;
}

// 2) 自举宿主节点去重：同名宿主节点只保留第一个（其余整节点连同组件剔除）
const firstHost = new Map();
for (let i = 0; i < s.length; i++) {
    const o = s[i];
    if (!isNode(o) || !RESERVED_NODE_NAMES.has(o._name)) continue;
    const parent = o._parent ? s[o._parent.__id__] : null;
    const key = (parent ? parent._name : '?') + '/' + o._name;
    if (!firstHost.has(key)) { firstHost.set(key, i); continue; }
    drop.add(i);
    for (const c of o._components || []) drop.add(c.__id__);
    (function collect(node) {
        for (const ch of node._children || []) { drop.add(ch.__id__); collect(s[ch.__id__]); }
    })(o);
    droppedNodes++;
}

if (drop.size === 0) {
    console.log('no-op: 场景无重复脚本组件/宿主节点');
    process.exit(0);
}

// 3) 从存活对象的 _children/_components 剔除待删引用
for (let i = 0; i < s.length; i++) {
    if (drop.has(i)) continue;
    for (const key of ['_children', '_components']) {
        const arr2 = s[i][key];
        if (!Array.isArray(arr2)) continue;
        s[i][key] = arr2.filter((r) => !(r && typeof r.__id__ === 'number' && drop.has(r.__id__)));
    }
}

// 4) 重索引
const map = new Map();
s.forEach((o, i) => { if (!drop.has(i)) map.set(i, map.size); });
const survivors = s.filter((_, i) => !drop.has(i));
(function reindex(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(reindex); return; }
    if (typeof obj.__id__ === 'number') obj.__id__ = map.get(obj.__id__);
    for (const k in obj) reindex(obj[k]);
})(survivors);

// 5) 校验后落盘
const out = JSON.stringify(survivors, null, 2) + '\n';
const v = JSON.parse(out);
const vn = v.filter((o) => o && (o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene'));
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL: ' + msg); process.exit(1); } };
assert(v.every((o) => typeof o.__type__ === 'string'), 'every object keeps __type__');
assert(vn.every((n) => !n._parent || (v[n._parent.__id__] && (v[n._parent.__id__].__type__ === 'cc.Node' || v[n._parent.__id__].__type__ === 'cc.Scene'))), 'parents resolve');
assert(vn.every((n) => (n._components || []).every((c) => v[c.__id__] && typeof v[c.__id__].__type__ === 'string')), 'component refs resolve');
assert(vn.every((n) => (n._children || []).every((c) => v[c.__id__] && v[c.__id__].__type__ === 'cc.Node')), 'child refs resolve');

if (!DRY) fs.writeFileSync(SCENE, out);
console.log(`${DRY ? '[dry] ' : ''}done: 去重脚本组件 ${dedupedComps} 份，剔除宿主节点 ${droppedNodes} 个，全文件 ${s.length} -> ${survivors.length} 对象`);
