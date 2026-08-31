// 一次性变异测试：证明 selfcheck-scene-wiring 真能抓到回归（跑完自动还原场景）
const fs = require('fs');
const { execFileSync } = require('child_process');
const P = 'assets/scenes/MainScene.scene';
const orig = fs.readFileSync(P, 'utf8');
try {
    const o = JSON.parse(orig);
    const peg = o.find((x) => typeof x.__type__ === 'string' && x.__type__.startsWith('2d4dc'));
    peg.bombCount = 2;                                   // 变异1：Inspector 偏离代码默认
    const bar = o.find((x) => x.__type__ === 'cc.Node' && x._name === 'RelicBar');
    bar._components.push(bar._components[bar._components.length - 1]); // 变异2：重复组件
    const div = o.find((x) => x.__type__ === 'cc.Node' && x._name === 'Divider_Left');
    o[div._components.map((r) => r.__id__).find((i) => o[i].__type__ === 'cc.CircleCollider2D')]._group = 1; // 变异3：分组不一致
    fs.writeFileSync(P, JSON.stringify(o, null, 2));
    let out = '';
    try {
        out = execFileSync(process.execPath, ['--experimental-transform-types', 'selfcheck-scene-wiring.ts'], { encoding: 'utf8' });
    } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
    }
    const fails = out.split('\n').filter((l) => l.startsWith('[FAIL]'));
    console.log('变异后 FAIL 数 =', fails.length);
    fails.forEach((l) => console.log('  ' + l));
    console.log(fails.length >= 3 ? '变异测试通过：自检确实会失败 ✔' : '变异测试失败：自检抓不到回归 ✘');
} finally {
    fs.writeFileSync(P, orig);
    console.log('场景已还原，与备份一致：', fs.readFileSync(P, 'utf8') === orig);
}
