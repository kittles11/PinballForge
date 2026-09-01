/**
 * 战场背景重绘（零场景改动、零贴图）：深靛蓝垂直渐变 + 四周暗角。
 *
 * 背景：原场景底色为灰绿 #262928，与 UI 面板 #1E2438（靛蓝族）互相打架。
 * 本组件自举插到 Canvas 最底（insertChild 0 = 渲染垫底），用 Graphics 分带插值
 * 画一段 bg.top → bg.bottom 的垂直渐变，再叠 4 层由内到外逐层加深的暗角描边；
 * 一次性绘制、零逐帧开销。宿主查找/挂载复用 BoardDeflectorManager.ensureMounted 同款范式。
 */
import { _decorator, Component, Director, director, find, Graphics, Node, UITransform } from 'cc';
import { bgGradientColor, Theme } from './ArtTheme';

const { ccclass } = _decorator;

/** 设计分辨率宽（渐变与暗角按此铺满，外扩 OVERSCAN 兜底更宽画布） */
const DESIGN_W = 720;
/** 设计分辨率高 */
const DESIGN_H = 1280;
/** 外扩余量（px）：超宽屏下四周仍是底色而非露边 */
const OVERSCAN = 240;
/** 垂直渐变带数：带间线性插值，14 带肉眼近似平滑 */
const GRADIENT_BANDS = 14;
/** 暗角描边层数（由内到外逐层加深） */
const VIGNETTE_LAYERS = 4;
/** 暗角描边宽度（px） */
const VIGNETTE_LINE_WIDTH = 190;

@ccclass('BackdropFx')
export class BackdropFx extends Component {
    private static _bootstrapped = false;

    protected start(): void {
        this.draw();
    }

    /** 一次性绘制：垂直渐变（全幅）+ 同心暗角（越靠边越深），此后不再逐帧重绘 */
    private draw(): void {
        const g = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        if (!g?.isValid) {
            return;
        }
        g.clear();
        const halfW = DESIGN_W / 2 + OVERSCAN;
        const halfH = DESIGN_H / 2 + OVERSCAN;

        // ① 垂直渐变：顶部微亮 → 底部压暗（与 UI 面板同族深靛蓝）
        const bandH = (halfH * 2) / GRADIENT_BANDS;
        for (let i = 0; i < GRADIENT_BANDS; i++) {
            const t = (i + 0.5) / GRADIENT_BANDS;
            g.fillColor = bgGradientColor(t);
            // 顶带先画（i=0 在最上），+1px 重叠消除带缝
            g.rect(-halfW, halfH - (i + 1) * bandH, halfW * 2, bandH + 1);
            g.fill();
        }

        // ② 四角暗角：4 层同心描边，由内（浅）到外（深）
        for (let i = 0; i < VIGNETTE_LAYERS; i++) {
            const k = 0.52 + i * 0.13;
            g.lineWidth = VIGNETTE_LINE_WIDTH;
            g.strokeColor = Theme.bg.vignette[i];
            g.rect(-halfW * k, -halfH * k, halfW * 2 * k, halfH * 2 * k);
            g.stroke();
        }
    }

    /** 全局自举：幂等把 BackdropFx 挂到 Canvas 最底（渲染垫底），零场景改动 */
    public static ensureMounted(): void {
        const canvas = find('Canvas');
        if (!canvas?.isValid) {
            return; // 场景未就绪（早于 EVENT_AFTER_SCENE_LAUNCH 的兜底调用时静默跳过）
        }
        let host = canvas.getChildByName('Backdrop');
        if (!host?.isValid) {
            host = new Node('Backdrop');
            host.layer = canvas.layer; // 与 Canvas 同 layer，确保被同一 UI 相机渲染
            host.addComponent(UITransform);
            canvas.insertChild(host, 0); // 子节点最前 = 渲染最底
        }
        if (!host.getComponent(BackdropFx)) {
            host.addComponent(BackdropFx);
        }
    }

    /** 注册场景启动自举事件（幂等） */
    public static bootstrap(): void {
        if (BackdropFx._bootstrapped) {
            return;
        }
        BackdropFx._bootstrapped = true;
        director.on(Director.EVENT_AFTER_SCENE_LAUNCH, BackdropFx.ensureMounted, BackdropFx);
    }
}

// ---------- 模块级自举 ----------
BackdropFx.bootstrap();
// 兜底：脚本加载晚于场景启动（编辑器脚本刷新等）时，Canvas 已存在则立即挂载
BackdropFx.ensureMounted();
