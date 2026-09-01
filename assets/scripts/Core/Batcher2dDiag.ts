/**
 * 【临时诊断工具】batcher-2d「localSetLayout」崩溃定位器（dev-only，问题解决后可整文件删除）。
 *
 * 症状：控制台逐帧刷 "Uncaught TypeError: Cannot read properties of undefined
 * (reading 'localSetLayout')"，崩在引擎 batcher-2d.ts 的 DescriptorSetCache.getDescriptorSet。
 * 成因（引擎源码层面唯一）：某个 2D 渲染批次的 passes 为空——引擎 fillPasses 拿到 null 材质
 * 或「passes 为空的材质」（如 effectName 查表失败时引擎静默不建 passes）都会直接空跑，
 * 批次 _passes 保持 []，update() 里 batch.passes[0] 即炸，且逐帧重复。
 *
 * 做法：模块加载即自举（与 BackdropFx.bootstrap 同款时序，无需挂场景）。场景启动后包一层
 * batcher2D.update 的 try/catch；首次捕获该错误时，反查场景里所有「渲染材质 passes 为空」
 * 的 UIRenderer，打印节点路径 / 组件类型 / 材质名，一次定位肇事组件；随后摘钩并原样
 * rethrow，不改引擎任何行为（错误弹窗照常出现）。
 */
import { director, Director, UIRenderer } from 'cc';

let _installed = false;

/** 节点全路径（诊断输出用） */
function nodePath(node: any): string {
    const parts: string[] = [];
    for (let n = node; n; n = n.parent) {
        parts.unshift(n.name ?? '?');
    }
    return parts.length > 0 ? parts.join('/') : '(null)';
}

/** 反查场景内所有「渲染材质 passes 为空」的渲染组件（肇事者通常就在其中） */
function diagnoseEmptyMaterialComps(): void {
    const scene = director.getScene();
    if (!scene) {
        return;
    }
    const comps = scene.getComponentsInChildren(UIRenderer);
    let found = 0;
    for (const comp of comps) {
        if (!comp.isValid) {
            continue;
        }
        const mat: any = (comp as any).getRenderMaterial?.(0) ?? comp.customMaterial;
        if (mat && (!mat.passes || mat.passes.length === 0)) {
            found += 1;
            console.error(
                `[BatcherDiag] 肇事组件 #${found}: ${nodePath(comp.node)}` +
                `（${comp.constructor.name}），材质="${mat.name ?? '(unnamed)'}"，passes=[]`,
            );
        }
    }
    if (found === 0) {
        console.warn('[BatcherDiag] 场景内未发现空 passes 材质的存活组件（肇事批次可能来自已销毁组件的残留批次，请把控制台输出发给开发者）');
    }
}

function install(): void {
    if (_installed) {
        return;
    }
    const batcher = (director.root as any)?.batcher2D;
    if (!batcher || typeof batcher.update !== 'function') {
        return;
    }
    _installed = true;
    const origUpdate: (...args: unknown[]) => void = batcher.update;
    batcher.update = function (this: unknown, ...args: unknown[]): void {
        try {
            origUpdate.apply(this, args);
        } catch (err) {
            if (String((err as Error)?.message).includes('localSetLayout')) {
                console.error('[BatcherDiag] 捕获 localSetLayout 崩溃，开始反查空材质组件 ——');
                diagnoseEmptyMaterialComps();
                batcher.update = origUpdate; // 一次性诊断：打印后摘钩，零常驻开销
            }
            throw err; // 行为与未挂钩时完全一致
        }
    };
}

// ---------- 模块级自举（与 BackdropFx.bootstrap 同款时序） ----------
director.once(Director.EVENT_AFTER_SCENE_LAUNCH, install);
// 兜底：脚本加载晚于场景启动（编辑器脚本刷新等）时，引擎已就绪则立即挂
if (director.getScene()) {
    install();
}
