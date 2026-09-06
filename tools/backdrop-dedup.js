// 一次性外科：Backdrop 节点的 BackdropFx 组件热重载去重（17 份 → 1 份）。
// 自检规则 G 允许 ≤3；当前工作区序列化出 16 份同脚本组件（HEAD 为 0，编辑器热重载堆积）。
// 范式与 tools/scene-surgery.js 一致：剔除对象 → 剥离引用 → 全文件重索引 → 断言校验 → 落盘。
const fs = require('fs');
const SCENE = 'assets/scenes/MainScene.scene';
const BACKDROP_FX_PREFIX = 'c9f3e'; // BackdropFx 脚本 uuid 压缩前缀
const KEEP = 1;

const s = JSON.parse(fs.readFileSync(SCENE, 'utf8'));
const node = s.find((o) => o && o._name === 'Backdrop');
if (!node) {
    console.log('no-op: 场景无 Backdrop 节点（运行时自举创建）');
    process.exit(0);
}
const fxRefs = node._components.filter((c) => s[c.__id__].__type__.startsWith(BACKDROP_FX_PREFIX));
console.log(`Backdrop 组件总数 ${node._components.length}，其中 BackdropFx ${fxRefs.length} 份`);
if (fxRefs.length <= KEEP) {
    console.log('no-op: BackdropFx 已 ≤ 目标份数');
    process.exit(0);
}

// 标记待删：保留前 KEEP 份 BackdropFx，其余连同组件对象一并删除
const drop = new Set();
for (const ref of fxRefs.slice(KEEP)) {
    drop.add(ref.__id__);
}

// 从所有存活对象的 _children/_components 中剔除待删引用
for (let i = 0; i < s.length; i++) {
    if (drop.has(i)) continue;
    for (const key of ['_children', '_components']) {
        const arr = s[i][key];
        if (!Array.isArray(arr)) continue;
        s[i][key] = arr.filter((r) => !(r && typeof r.__id__ === 'number' && drop.has(r.__id__)));
    }
}

// 重索引：删除数组元素后重写全文件所有 __id__ 引用
const map = new Map();
s.forEach((o, i) => { if (!drop.has(i)) map.set(i, map.size); });
const survivors = s.filter((_, i) => !drop.has(i));
(function reindex(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(reindex); return; }
    if (typeof obj.__id__ === 'number') obj.__id__ = map.get(obj.__id__);
    for (const k in obj) reindex(obj[k]);
})(survivors);

// 校验后落盘
const out = JSON.stringify(survivors, null, 2) + '\n';
const v = JSON.parse(out);
const isNode = (o) => o && (o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene');
const vn = v.filter(isNode);
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL: ' + msg); process.exit(1); } };
assert(v.every((o) => typeof o.__type__ === 'string'), 'every object keeps a __type__');
assert(vn.every((n) => !n._parent || isNode(v[n._parent.__id__])), 'every node parent resolves');
assert(vn.every((n) => (n._components || []).every((c) => typeof v[c.__id__].__type__ === 'string')), 'every component ref resolves');
const b2 = v.find((o) => o && o._name === 'Backdrop');
assert(b2._components.filter((c) => v[c.__id__].__type__.startsWith(BACKDROP_FX_PREFIX)).length === KEEP, `BackdropFx 恰保留 ${KEEP} 份`);
assert(vn.every((n) => (n._components || []).every((c) => v[c.__id__].node.__id__ === v.indexOf(n))), 'component back-ref intact');

fs.writeFileSync(SCENE, out);
console.log(`done: BackdropFx ${fxRefs.length} -> ${KEEP}，全文件 ${s.length} -> ${survivors.length} 对象`);
