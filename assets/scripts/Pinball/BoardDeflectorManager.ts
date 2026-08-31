import {
    _decorator, Component, Node, director, Director, find, Color, Graphics, Vec2, Size,
    RigidBody2D, ERigidBody2DType, BoxCollider2D, PolygonCollider2D, UITransform, Tween,
} from 'cc';
import { WingTrampoline } from './WingTrampoline';

const { ccclass } = _decorator;

// ---------- 物理分组 ----------
/** 静态机关统一使用场景墙体分组 WALL（索引 3，位掩码 1<<3=8）：碰撞矩阵 WALL↔ORB 互通，弹珠必撞；与场景 Divider/墙体同组 */
const GROUP_WALL = 8;

// ---------- 1. 底部左右角落导流挡板（Corner Deflectors） ----------
/**
 * 挡板两端点（side 乘 x 得左/右板）：外端（高、嵌入左右外墙 10px，封死钉板边缘缝与外墙间的死角）
 * (±370,-312)；内端（低、伸入最侧漏斗 Funnel_A/C 的 sensor 区正上方）(±230,-396)。
 * 端点距约 163px → Cocos angle 等效左 -31° / 右 +31°（逆时针为正口径，落在需求 -30°~-35°）：
 * 左板左高右低、右板右高左低，均「朝内下方倾斜」，把掉落到左/右边缘的弹珠顺滑导向侧漏斗与中间漏斗。
 * 布局经几何精算（assets 外自检脚本 D:\CODE\pinball-verify\check-corner-deflector.js 全项 PASS）：
 * 与最底行最外钉 (±344,-264,r16) 全通道净空 >5px（弹珠 r14）、避开 SplitCap (±180,-300) 20px、
 * 避开 Divider (±120,-370) 110px、不侵入钉板区（上缘最高 y=-304 < -280）。
 */
const CORNER_INNER_X = 230;
const CORNER_INNER_Y = -396;
const CORNER_OUTER_X = 370;
const CORNER_OUTER_Y = -312;
/** 挡板厚度（px） */
const CORNER_THICKNESS = 18;
/** 挡板弹性系数（需求 ≈0.7，防弹珠停滞或穿模） */
const CORNER_RESTITUTION = 0.7;

// ---------- 2. 左右侧翼弹力蹦床（Bumper Wings） ----------
/** 蹦床中心：(±310, 100)，等腰尖楔底边贴外墙、尖端指向场地中央 */
const WING_X = 310;
const WING_Y = 100;
/** 蹦床弹性系数（高弹力） */
const WING_RESTITUTION = 0.9;
// （蹦床受击行为常量 WING_BOOST_DELTA_V / WING_BOOST_COOLDOWN_MS 已随 WingTrampoline 组件迁至 ./WingTrampoline）

// ---------- 3. 漏斗上方人字形分流挡帽（Funnel Deflectors） ----------
/** 分流帽中心：(±180, -300)。经钉板布局精算下移至 -300：与全部版型最底行钉（y=-264, r16）净空 >7px、避开 Divider 顶圆头(-120,-310,r8) */
const CAP_X = 180;
const CAP_Y = -300;
/** 帽宽 60px（半宽 30） */
const CAP_HALF_WIDTH = 30;
/** 帽高 25px（半高 12.5） */
const CAP_HALF_HEIGHT = 12.5;
/** 分流帽弹性系数 */
const CAP_RESTITUTION = 0.85;

// ---------- 外观（深灰板体 + 青蓝发光描边） ----------
const BAR_FILL_COLOR = new Color(42, 46, 56, 255);      // 深灰板体
const EDGE_COLOR = new Color(53, 224, 255, 255);        // 亮青蓝描边
const GLOW_COLOR = new Color(0, 229, 255, 70);          // 青蓝辉光（半透明外晕）
// （蹦床受击闪光色 FLASH_COLOR 已随 WingTrampoline 组件迁至 ./WingTrampoline）


// ---------- 纯代码绘制与构建辅助 ----------

/** 按顶点序列走线（闭合多边形路径） */
function tracePoly(g: Graphics, pts: readonly Vec2[]): void {
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
        g.lineTo(pts[i].x, pts[i].y);
    }
    g.close();
}

/** 深灰填充 + 青蓝发光描边的圆角长条（局部坐标，中心对称）：外晕 → 填充 → 亮边三层叠加模拟辉光 */
function drawGlowBar(g: Graphics, w: number, h: number): void {
    const corner = Math.min(5, h / 2);
    g.lineWidth = 9;
    g.strokeColor = GLOW_COLOR;
    g.roundRect(-w / 2, -h / 2, w, h, corner);
    g.stroke();
    g.fillColor = BAR_FILL_COLOR;
    g.roundRect(-w / 2, -h / 2, w, h, corner);
    g.fill();
    g.lineWidth = 2.5;
    g.strokeColor = EDGE_COLOR;
    g.roundRect(-w / 2, -h / 2, w, h, corner);
    g.stroke();
}

/** 深灰填充 + 青蓝发光描边的多边形（同三层辉光） */
function drawGlowPoly(g: Graphics, pts: readonly Vec2[]): void {
    g.lineWidth = 8;
    g.strokeColor = GLOW_COLOR;
    tracePoly(g, pts);
    g.stroke();
    g.fillColor = BAR_FILL_COLOR;
    tracePoly(g, pts);
    g.fill();
    g.lineWidth = 2.5;
    g.strokeColor = EDGE_COLOR;
    tracePoly(g, pts);
    g.stroke();
}

/**
 * 构建一个机关节点：UI 变换 + Graphics（矢量绘制），定位后挂到宿主之下。
 * 节点入树激活时机在物理字段写入之前，确保 RigidBody2D 建体时一次性采用
 * type / group / restitution（与 OrbController.initOrbType 的预写时序同理）。
 */
function buildPieceNode(parent: Node, name: string, x: number, y: number): Node {
    const node = new Node(name);
    node.layer = parent.layer;
    node.addComponent(UITransform);
    node.addComponent(Graphics);
    node.setPosition(x, y, 0);
    node.setParent(parent);
    return node;
}

/** 挂静态刚体：不随重力掉落、永不移动，分组 WALL 保证与弹珠（ORB 组）碰撞矩阵互通 */
function attachStaticBody(node: Node): RigidBody2D {
    const rb = node.addComponent(RigidBody2D);
    rb.type = ERigidBody2DType.Static;
    rb.group = GROUP_WALL;
    return rb;
}

/**
 * 钉板区域物理导流与弹力板管理器（纯代码自建，零 Inspector / 零场景配置）：
 *
 * 挂载：全局自举自动挂到 Canvas/PinballLayer/Deflectors 节点（场景无 PinballLayer 时
 * 回退既有 Canvas/PegboardLayer，两者均在 (0,0)、以屏幕中心为原点，坐标系一致）；
 * start() 自动执行 buildDeflectors()。
 *
 * 机关清单（全部为 Static 静态碰撞体，不随重力掉落）：
 *  1. 底部左右角落导流挡板（左下/右下）：斜条外端嵌入左右外墙 (±370,-312)、内端低伸至侧漏斗
 *     sensor 区正上方 (±230,-396)，节点居端点中点 (±300,-354)、倾角 ≈31°（左 -31°/右 +31°），弹性 0.7；
 *     把掉落到左/右边缘死角的弹珠顺滑导向侧漏斗与中间漏斗；两板内端之间中央通道 460px 全开阔，
 *     中间漏斗 (0,-400) 正上方无任何遮挡；
 *  2. 左右侧翼弹力蹦床：(±310,100) 等腰尖楔（底边贴外墙、尖端指向中央），弹性 0.9，
 *     撞击播放闪光 + AudioManager.playHit()，并把弹珠高速补冲向场地中央；
 *  3. 漏斗上方人字形分流挡帽：(±180,-300) 倒 V（▲，宽 60 高 25），尖顶分流垂直落珠，
 *     任何直落重炮 / 金币漏斗的弹珠必被帽尖分向两侧，必须经折返弹射才能滚入下方开口。
 *
 * 注意：机关节点名刻意避开 'Peg' / 'Funnel' 子串（OrbController.onBeginContact
 * 以节点名兜底识别钉子与漏斗，误命中会错误触发入槽结算）。
 */
@ccclass('BoardDeflectorManager')
export class BoardDeflectorManager extends Component {
    /** 场景启动自举是否已注册（幂等，防重复监听） */
    private static _bootstrapped = false;

    protected start(): void {
        this.buildDeflectors();
    }

    protected onDestroy(): void {
        Tween.stopAllByTarget(this.node);
    }

    /**
     * 构建全部导流机关（幂等）：先清空旧机关子节点，再依次生成
     * 底部角落导流挡板 ×2 + 侧翼弹力蹦床 ×2 + 漏斗人字形分流帽 ×2。
     */
    public buildDeflectors(): void {
        if (!this.node?.isValid) {
            return;
        }

        // 幂等重建：销毁并移除全部旧机关子节点（同 PegBoardManager.generateBoard 的清除方式）
        const oldChildren = [...this.node.children];
        for (const child of oldChildren) {
            child?.destroy();
        }
        this.node.removeAllChildren();

        // 1. 底部左右角落导流挡板（左下/右下死角）
        this.buildCornerDeflector(-1);
        this.buildCornerDeflector(1);
        // 2. 左右侧翼弹力蹦床（Bumper Wings）
        this.buildWingTrampoline(-1);
        this.buildWingTrampoline(1);
        // 3. 漏斗上方人字形分流挡帽（Funnel Deflectors）
        this.buildFunnelCap(-1);
        this.buildFunnelCap(1);

        console.log('[Deflectors] 导流机关构建完成：底部角落导流挡板 ×2 + 侧翼蹦床 ×2 + 分流帽 ×2');
    }

    /**
     * 底部角落导流挡板（side=-1 左下角 / 1 右下角）：
     * 斜向长条：外端（高）嵌入左右外墙封死边缘死角，内端（低）伸至最侧漏斗 sensor 区正上方；
     * 节点位置自动取端点中点 (±300,-354)。
     * 角度沿「外端→内端」连线方向 atan2(dy,dx) 写入：Cocos angle 逆时针为正（Quat.fromAngleZ），
     * 左板等效 -31°/右板等效 +31°（长条 180° 旋转对称，写入值渲染与碰撞完全等效），
     * 常量改动时角度自动跟随；弹珠落板后顺板面滚向侧漏斗（FunnelSlot sensor 结算，
     * FUNNEL_FALLBACK_Y 保底兜底），不会在死角停滞。
     * Static RigidBody2D 由 attachStaticBody 挂载（WALL 分组保证与弹珠必撞）；
     * BoxCollider2D 长度取端点间距 + 板厚端帽，并同步 UITransform.contentSize 与
     * collider.apply()（引擎有空守卫，夹具未建时安全），弹性 0.7。
     */
    private buildCornerDeflector(side: -1 | 1): void {
        const innerX = side * CORNER_INNER_X;
        const outerX = side * CORNER_OUTER_X;
        const dx = outerX - innerX;
        const dy = CORNER_OUTER_Y - CORNER_INNER_Y;
        const length = Math.hypot(dx, dy) + CORNER_THICKNESS;

        const node = buildPieceNode(
            this.node,
            side < 0 ? 'CornerDeflector_Left' : 'CornerDeflector_Right',
            (innerX + outerX) / 2,
            (CORNER_INNER_Y + CORNER_OUTER_Y) / 2,
        );
        // 长条沿端点连线方向旋转（长条 180° 旋转对称，atan2 直接可用）
        node.angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        // 渲染/变换尺寸与碰撞盒对齐（需求：UITransform ContentSize 同步碰撞体长宽）
        node.getComponent(UITransform)!.setContentSize(length, CORNER_THICKNESS);

        attachStaticBody(node);
        const box = node.addComponent(BoxCollider2D);
        box.size = new Size(length, CORNER_THICKNESS);
        box.friction = 0.1;
        box.restitution = CORNER_RESTITUTION;
        box.apply(); // 显式重建 box2d 夹具，保证 size 修改后的碰撞盒同步生效

        drawGlowBar(node.getComponent(Graphics)!, length, CORNER_THICKNESS);
    }

    /**
     * 侧翼弹力蹦床（side=-1 左 / 1 右）：
     * 等腰尖楔 PolygonCollider2D，底边贴外墙、尖端指向场地中央；
     * 顶点经几何核算避开钉板最外列钉子（x=±344, r=16），弹性 0.9；
     * 挂 WingTrampoline 实现受击闪光 + 撞击音 + 朝中央定向补冲。
     */
    private buildWingTrampoline(side: -1 | 1): void {
        const node = buildPieceNode(
            this.node,
            side < 0 ? 'WingTrampoline_Left' : 'WingTrampoline_Right',
            side * WING_X,
            WING_Y,
        );
        // 左楔顶点（局部）：(-50,10)/(-50,-55)/(50,0) → 世界 (-360,110)/(-360,45)/(-260,100)，右楔镜像
        const pts = side < 0
            ? [new Vec2(-50, 10), new Vec2(-50, -55), new Vec2(50, 0)]
            : [new Vec2(50, 10), new Vec2(50, -55), new Vec2(-50, 0)];

        attachStaticBody(node);
        const poly = node.addComponent(PolygonCollider2D);
        poly.points = pts;
        poly.friction = 0.1;
        poly.restitution = WING_RESTITUTION;

        drawGlowPoly(node.getComponent(Graphics)!, pts);
        node.addComponent(WingTrampoline);
    }

    /**
     * 漏斗上方人字形分流挡帽（side=-1 重炮漏斗 / 1 金币漏斗）：
     * 倒 V（▲）三角形，宽 60 高 25，尖顶朝上分流垂直落珠；
     * 坐标 (±180,-300) 经钉板布局精算：与全部版型最底行钉、Divider 隔墙顶圆头、漏斗 sensor 均不重叠。
     */
    private buildFunnelCap(side: -1 | 1): void {
        const node = buildPieceNode(
            this.node,
            side < 0 ? 'SplitCap_Left' : 'SplitCap_Right',
            side * CAP_X,
            CAP_Y,
        );
        const pts = [
            new Vec2(-CAP_HALF_WIDTH, -CAP_HALF_HEIGHT),
            new Vec2(CAP_HALF_WIDTH, -CAP_HALF_HEIGHT),
            new Vec2(0, CAP_HALF_HEIGHT),
        ];

        attachStaticBody(node);
        const poly = node.addComponent(PolygonCollider2D);
        poly.points = pts;
        poly.friction = 0.05;
        poly.restitution = CAP_RESTITUTION;

        drawGlowPoly(node.getComponent(Graphics)!, pts);
    }

    /**
     * 全局自举：幂等把 BoardDeflectorManager 挂到 Canvas/PinballLayer/Deflectors。
     * 宿主查找顺序：PinballLayer（需求指定）→ PegboardLayer（现有场景实际层）→ Canvas 兜底。
     * Deflectors 插到宿主子节点最前（渲染垫底：钉子与弹珠绘制在机关之上）。
     */
    public static ensureMounted(): void {
        const canvas = find('Canvas');
        if (!canvas?.isValid) {
            return; // 场景未就绪（早于 EVENT_AFTER_SCENE_LAUNCH 的兜底调用时静默跳过）
        }
        const layer = find('Canvas/PinballLayer') ?? find('Canvas/PegboardLayer') ?? canvas;
        let host = layer.getChildByName('Deflectors');
        if (!host?.isValid) {
            host = new Node('Deflectors');
            host.layer = layer.layer;
            layer.insertChild(host, 0);
        }
        if (!host.getComponent(BoardDeflectorManager)) {
            host.addComponent(BoardDeflectorManager);
        }
    }

    /** 注册场景启动自举事件（幂等） */
    public static bootstrap(): void {
        if (BoardDeflectorManager._bootstrapped) {
            return;
        }
        BoardDeflectorManager._bootstrapped = true;
        // 复用 RelicManager.ensureMounted 同款模式：每次场景启动后自动挂载（重开局也会重建）
        director.on(Director.EVENT_AFTER_SCENE_LAUNCH, BoardDeflectorManager.ensureMounted, BoardDeflectorManager);
    }
}

// ---------- 模块级自举 ----------
BoardDeflectorManager.bootstrap();
// 兜底：脚本加载晚于场景启动（编辑器脚本刷新等）时，Canvas 已存在则立即挂载
BoardDeflectorManager.ensureMounted();
