/**
 * 战场背景重绘（零场景改动、零贴图）：深靛蓝垂直渐变 + 四周暗角 + 锻造齿轮暗纹。
 *
 * 背景：原场景底色为灰绿 #262928，与 UI 面板 #1E2438（靛蓝族）互相打架。
 * 本组件自举插到 Canvas 最底（insertChild 0 = 渲染垫底），用 Graphics 分带插值
 * 画一段 bg.top → bg.bottom 的垂直渐变，再叠 4 层由内到外逐层加深的暗角描边；
 * 一次性绘制、零逐帧开销。齿轮暗纹（IconLib gear，低透明大尺寸、极慢双向旋转）
 * 垫在渐变与暗角之间，给「锻造工坊」主题提供克制的动态景深。
 * 宿主查找/挂载复用 BoardDeflectorManager.ensureMounted 同款范式。
 */
import { _decorator, Component, Director, director, find, Graphics, Node, UITransform } from 'cc';
import { bgGradientColor, cloneColor, Theme } from './ArtTheme';
import { drawIcon } from './IconLib';

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
/** 齿轮暗纹配置：[x, y, 直径, 每秒转角(度)，负值反转] —— 全部半出血贴边，避免喧宾夺主 */
const GEARS: Array<[number, number, number, number]> = [
    [-290, 420, 340, 3.2],
    [300, -160, 260, -4.2],
    [-320, -460, 300, 2.4],
];
/** 齿轮暗纹透明度：垫底氛围层，越低越「存在而不打扰」 */
const GEAR_ALPHA = 16;

@ccclass('BackdropFx')
export class BackdropFx extends Component {
    private static _bootstrapped = false;

    /** 齿轮节点引用（update 旋转驱动用） */
    private _gears: Node[] = [];

    protected start(): void {
        this.draw();
        this.mountGears();
        this.mountVignette();
    }

    protected update(dt: number): void {
        // 极慢双向旋转：@property 无需暴露，旋转量累计在节点角度上
        for (let i = 0; i < this._gears.length && i < GEARS.length; i++) {
            const node = this._gears[i];
            if (node?.isValid) {
                node.angle += GEARS[i][3] * dt;
            }
        }
    }

    /** 一次性绘制：垂直渐变（全幅）；暗角与齿轮由子节点分层叠放（渐变 < 齿轮 < 暗角） */
    private draw(): void {
        const g = this.getComponent(Graphics) ?? this.addComponent(Graphics);
        if (!g?.isValid) {
            return;
        }
        g.clear();
        const halfW = DESIGN_W / 2 + OVERSCAN;
        const halfH = DESIGN_H / 2 + OVERSCAN;

        // 垂直渐变：顶部微亮 → 底部压暗（与 UI 面板同族深靛蓝）
        const bandH = (halfH * 2) / GRADIENT_BANDS;
        for (let i = 0; i < GRADIENT_BANDS; i++) {
            const t = (i + 0.5) / GRADIENT_BANDS;
            g.fillColor = bgGradientColor(t);
            // 顶带先画（i=0 在最上），+1px 重叠消除带缝
            g.rect(-halfW, halfH - (i + 1) * bandH, halfW * 2, bandH + 1);
            g.fill();
        }
    }

    /** 齿轮暗纹层：IconLib gear 矢量图形，极慢双向旋转提供锻造工坊氛围景深 */
    private mountGears(): void {
        const host = this.node;
        if (!host?.isValid) {
            return;
        }
        for (const [x, y, size, ] of GEARS) {
            const gear = new Node(`Gear_${x}_${y}`);
            gear.layer = host.layer;
            gear.addComponent(UITransform).setContentSize(size, size);
            gear.setPosition(x, y, 0);
            const g = gear.addComponent(Graphics);
            const col = cloneColor(Theme.machine.glow);
            col.a = GEAR_ALPHA;
            drawIcon(g, 'gear', 0, 0, size, col);
            host.addChild(gear);
            this._gears.push(gear);
        }
    }

    /** 暗角层：独立子节点最后挂载（渲染于齿轮之上），四周压暗罩住半出血的齿轮边缘 */
    private mountVignette(): void {
        const host = this.node;
        if (!host?.isValid) {
            return;
        }
        const node = new Node('Vignette');
        node.layer = host.layer;
        node.addComponent(UITransform);
        const g = node.addComponent(Graphics);
        const halfW = DESIGN_W / 2 + OVERSCAN;
        const halfH = DESIGN_H / 2 + OVERSCAN;
        // 四角暗角：4 层同心描边，由内（浅）到外（深）
        for (let i = 0; i < VIGNETTE_LAYERS; i++) {
            const k = 0.52 + i * 0.13;
            g.lineWidth = VIGNETTE_LINE_WIDTH;
            g.strokeColor = Theme.bg.vignette[i];
            g.rect(-halfW * k, -halfH * k, halfW * 2 * k, halfH * 2 * k);
            g.stroke();
        }
        host.addChild(node);
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
        // 热重载防御：脚本热更后 getComponent 按新类匹配不到旧实例，会反复 addComponent——
        // 只保留首个实例、多余销毁（曾堆出 128 份并被编辑器序列化回场景，规则 G 因此告警）
        const comps = host.getComponents(BackdropFx);
        for (let i = 1; i < comps.length; i++) {
            comps[i].destroy();
        }
        if (comps.length === 0) {
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
