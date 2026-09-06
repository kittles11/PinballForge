/**
 * 清理 MainScene.scene 中被固化的运行时 UI 脏数据（2026-09-04 排查）。
 *
 * 背景：本项目的弹窗/徽章 UI 全部是运行时 ensureMounted 代码自举（挂 Canvas/UILayer 下），
 * 场景文件里本不该有它们的节点。但「热重载反复 addComponent」的堆积物曾被编辑器保存
 * 固化进场景：DailyTaskDialog 节点挂 34 个同名组件、DailyTaskBadge 34 个、DeckViewDialog
 * 40 个，且节点全部 _active=true——旧代码靠 start() 无条件隐藏兜底，start 一旦不再隐藏
 * （热重载竞态修复），弹窗就开场常驻挡屏。
 *
 * 处理原则：
 * - 纯代码自举弹窗（DailyTaskDialog / DeckViewDialog）：节点保留（ensureMounted 复用），
 *   _active 改 false、_components 清空——被移除引用的序列化组件成孤儿数据，反序列化时
 *   不可达、不会实例化，无需（也不应）删除数组元素重排 __id__。
 * - 右上角徽章已下线（2026-09-04 用户要求取消）：DailyTaskBadge 壳节点同样隐藏 + 去组件。
 * - ResultDialog / RewardDialog / ShopDialog：Inspector 配置型场景节点（@property 引用），
 *   且自带 start() 隐藏逻辑，一律不动。
 *
 * 用法：node tools/scene-clean-ui-nodes.js
 * 注意：改前会由调用方先备份场景文件；改完后让 Cocos Creator 重新导入资产，
 *       编辑器里若开着该场景，请勿在旧状态下再按保存（会把脏数据写回来）。
 */
const fs = require('fs');

const SCENE_PATH = 'assets/scenes/MainScene.scene';
const HIDE_NODES = ['DailyTaskDialog', 'DeckViewDialog', 'DailyTaskBadge'];
const DEDUPE_NODES = [];

const scene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
const report = [];

scene.forEach((obj) => {
    if (!obj || obj.__type__ !== 'cc.Node') return;
    if (HIDE_NODES.includes(obj._name)) {
        const removed = (obj._components || []).length;
        obj._active = false;
        obj._components = [];
        report.push(`${obj._name}: _active=true→false, 移除 ${removed} 个序列化组件引用`);
    } else if (DEDUPE_NODES.includes(obj._name)) {
        const n = (obj._components || []).length;
        if (n > 1) {
            obj._components = obj._components.slice(0, 1);
            report.push(`${obj._name}: 重复组件 ${n} 个 → 1 个`);
        }
    }
});

if (report.length === 0) {
    console.log('场景干净，无需处理。');
    process.exit(0);
}
fs.writeFileSync(SCENE_PATH, JSON.stringify(scene, null, 2) + '\n');
console.log(report.join('\n'));
console.log(`已写回 ${SCENE_PATH}（原文件备份为 MainScene.scene.bak）`);
