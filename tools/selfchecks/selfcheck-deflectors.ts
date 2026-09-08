/**
 * 导流机关几何自检（纯数学断言，无引擎依赖，node 直接运行）：
 *   node --experimental-transform-types selfcheck-deflectors.ts
 *
 * 校验 BoardDeflectorManager 生成的三类机关与场景既有元素（钉板 / 外墙 / 隔墙 / 漏斗）
 * 的空间关系：不重叠、不堵塞、必分流。常量为 BoardDeflectorManager.ts 中的同步副本
 * （引擎模块无法在 node 下 import，修改机关常量时请同步本文件，跑通全部 PASS 即安全）。
 */

// ---------- 常量副本（与 BoardDeflectorManager.ts / 场景事实同步） ----------
// 底部角落导流挡板：内端（低、朝漏斗）(±230,-396)、外端（高、贴墙）(±370,-312)、板厚 18
const CORNER_INNER_X = 230, CORNER_INNER_Y = -396;
const CORNER_OUTER_X = 370, CORNER_OUTER_Y = -312;
const CORNER_THICKNESS = 18;
// 左板线段（世界坐标）与节点位置（端点中点，即需求 position x:-300 y:-354）
const CORNER_SEG_L: [number, number][] = [[-CORNER_INNER_X, CORNER_INNER_Y], [-CORNER_OUTER_X, CORNER_OUTER_Y]];
const CORNER_CENTER_X = -(CORNER_INNER_X + CORNER_OUTER_X) / 2;
const CORNER_CENTER_Y = (CORNER_INNER_Y + CORNER_OUTER_Y) / 2;
const CORNER_ANGLE_DEG = (Math.atan(Math.abs((CORNER_OUTER_Y - CORNER_INNER_Y) / (CORNER_OUTER_X - CORNER_INNER_X))) * 180) / Math.PI;

const WING_X = 310, WING_Y = 100;
// 左蹦床顶点（世界坐标）：底边贴外墙 x=-360，尖端指向中央
const WING_TRI_L: [number, number][] = [[-360, 110], [-360, 45], [-260, 100]];

const CAP_X = 180, CAP_Y = -300;
const CAP_HALF_W = 30, CAP_HALF_H = 12.5;
// 左分流帽顶点（世界坐标）：▲ 尖顶朝上
const CAP_TRI_L: [number, number][] = [
    [CAP_X - CAP_HALF_W, CAP_Y - CAP_HALF_H],
    [CAP_X + CAP_HALF_W, CAP_Y - CAP_HALF_H],
    [CAP_X, CAP_Y + CAP_HALF_H],
];

// 钉板布局（PegBoardManager 精算）：720×560 铺满、EDGE_PADDING=16、maxCols=5
// → spacingX=172、spacingY=132；行 y = 264/132/0/-132/-264；
// 最宽行 5 颗 x=±344/±172/0；4 颗行 x=±258/±86；3 颗行 x=±172/0。
// 各版型最底行（y=-264）：A:x=±172,0  B:x=±344,±172,0  C:x=±258,±86 —— 距帽最近恒为 x=±172。
const PEG_RADIUS = 16;
const ORB_RADIUS = 12;
const PEG_BOTTOM_ROW_Y = -264;
const OUTER_PEG_X = -344;
const PEG_UPPER_Y = 132, PEG_MIDDLE_Y = 0;
const NEAREST_PEG_TO_CAP_X = -172; // 底行距帽最近的钉（A/B 版型底行均有 x=±172）
// Divider_Left：中心 (-120,-370)，顶面 y=-310，顶圆头 r=8 圆心 (-120,-310)
const DIVIDER_TOP_Y = -310;
const DIVIDER_CAP_RADIUS = 8;
// 漏斗 sensor：中心 (±240,-400)，220×80 → 顶缘 y=-360、内缘 x=±130、外缘 x=±350
const FUNNEL_SENSOR_TOP_Y = -360;
const FUNNEL_SENSOR_INNER_X = 130;
const FUNNEL_SENSOR_OUTER_X = 350;
// 急冻漏斗 sensor 半宽 110（中心 x=0）
const FUNNEL_B_HALF_W = 110;

let failed = 0;
function check(name: string, ok: boolean): void {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
    if (!ok) failed++;
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function pointInTri(px: number, py: number, tri: [number, number][]): boolean {
    const [a, b, c] = tri;
    const d1 = cross(a, b, [px, py]);
    const d2 = cross(b, c, [px, py]);
    const d3 = cross(c, a, [px, py]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

function distPointSeg(px: number, py: number, a: [number, number], b: [number, number]): number {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = ((px - a[0]) * abx + (py - a[1]) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const dx = px - (a[0] + abx * t), dy = py - (a[1] + aby * t);
    return Math.hypot(dx, dy);
}

/** 圆与三角形是否相交：圆心在三角形内，或圆心到任一边距离 < 半径 */
function circleHitsTri(px: number, py: number, r: number, tri: [number, number][]): boolean {
    if (pointInTri(px, py, tri)) return true;
    for (let i = 0; i < tri.length; i++) {
        const a = tri[i], b = tri[(i + 1) % tri.length];
        if (distPointSeg(px, py, a, b) < r) return true;
    }
    return false;
}

// ---------- 1. 底部左右角落导流挡板（左下/右下死角） ----------
// 形态：内端低、朝漏斗；外端高、贴墙 → 两板均「朝内下方倾斜」（左 -31°/右 +31°，Cocos 逆时针为正）
check('挡板内端朝漏斗低、外端贴墙高', CORNER_INNER_Y < CORNER_OUTER_Y && CORNER_INNER_X < CORNER_OUTER_X);
// 倾角 ≈31°（斜率 84/140 = 0.6），落在需求 30°~35°
check('挡板倾角 30°~35°', CORNER_ANGLE_DEG >= 30 && CORNER_ANGLE_DEG <= 35);
// 节点位置 = 端点中点（需求 position x:∓300 y:-354）
check('挡板位置为端点中点 (±300,-354)', CORNER_CENTER_X === -300 && CORNER_CENTER_Y === -354);
// 外端嵌入外墙 10px：钉板边缘缝与外墙间的死角被完全封死，无缝隙可卡球
check('挡板外端嵌入外墙封死角', CORNER_OUTER_X === 370 && CORNER_OUTER_X > 360);
// 内端落在重炮/金币漏斗 sensor 横向范围 (130,350) 内且低于 sensor 顶缘 y=-360：
// 沿板滚落的弹珠必被导入侧漏斗接收区
check('挡板内端位于漏斗开口上方并伸入接收区', CORNER_INNER_X > FUNNEL_SENSOR_INNER_X && CORNER_INNER_X < FUNNEL_SENSOR_OUTER_X && CORNER_INNER_Y < FUNNEL_SENSOR_TOP_Y);
// 两挡板内端之间中央通道 460px 全开阔（中间急冻漏斗正上方无任何遮挡）
check('中央漏斗通道全开阔不被挡板侵入', CORNER_INNER_X >= FUNNEL_B_HALF_W && CORNER_INNER_X * 2 >= 440);
// 板面与最外底钉 (-344,-264,r16) 间净空 ≥ 弹珠直径（钉与板之间不形成夹缝卡球）
const orbGap = distPointSeg(OUTER_PEG_X, PEG_BOTTOM_ROW_Y, CORNER_SEG_L[0], CORNER_SEG_L[1]) - PEG_RADIUS - CORNER_THICKNESS / 2;
check('板面与最外底钉净空 ≥ 弹珠直径（无夹缝）', orbGap >= ORB_RADIUS * 2);
// 板体与分流帽 ▲ 不相交（帽顶点到左板线段距离 > 板半厚）
const capToCorner = Math.min(...CAP_TRI_L.map(([x, y]) => distPointSeg(x, y, CORNER_SEG_L[0], CORNER_SEG_L[1])));
check('角落挡板不与分流帽相交', capToCorner > CORNER_THICKNESS / 2);
// 板体与 Divider 顶圆头（圆心 (-120,-310) r8）不相交
check('角落挡板不与 Divider 顶圆头相交', distPointSeg(-120, DIVIDER_TOP_Y, CORNER_SEG_L[0], CORNER_SEG_L[1]) > DIVIDER_CAP_RADIUS + CORNER_THICKNESS / 2);
// 板体与侧翼蹦床楔不相交
const wingToCorner = Math.min(...WING_TRI_L.map(([x, y]) => distPointSeg(x, y, CORNER_SEG_L[0], CORNER_SEG_L[1])));
check('角落挡板不与侧翼蹦床相交', wingToCorner > CORNER_THICKNESS / 2);
// 板整体位于钉板最底行下缘（-264-16=-280）之下，不与任何钉行重叠
check('挡板整体位于钉板最底行下缘之下', CORNER_OUTER_Y + CORNER_THICKNESS / 2 < PEG_BOTTOM_ROW_Y - PEG_RADIUS);

// ---------- 2. 侧翼弹力蹦床 ----------
// 蹦床尖楔不得与最外列钉子（x=-344，行 y=132 / 0，r=16）相交
check('左蹦床不与最外列上钉(-344,132)相交', !circleHitsTri(OUTER_PEG_X, PEG_UPPER_Y, PEG_RADIUS, WING_TRI_L));
check('左蹦床不与最外列中钉(-344,0)相交', !circleHitsTri(OUTER_PEG_X, PEG_MIDDLE_Y, PEG_RADIUS, WING_TRI_L));
// 蹦床底边贴外墙 x=-360（无缝隙可卡球）
check('左蹦床底边贴合左外墙', WING_TRI_L[0][0] === -360 && WING_TRI_L[1][0] === -360);
// 蹦床尖端朝场地中央（尖端 x > 底边 x）
check('左蹦床尖端指向场地中央', WING_TRI_L[2][0] > WING_TRI_L[0][0]);

// ---------- 3. 漏斗上方人字形分流帽 ----------
// 帽与 Divider 顶圆头（圆心 (-120,-310) r8）不相交
check('左分流帽不与 Divider 顶圆头相交', !circleHitsTri(-120, DIVIDER_TOP_Y, DIVIDER_CAP_RADIUS, CAP_TRI_L));
// 帽与全部版型最底行距其最近的钉（x=±172, y=-264, r16）不相交（含 A/B/C 三版型并集）
check('左分流帽不与最底行最近钉(-172,-264)相交', !circleHitsTri(NEAREST_PEG_TO_CAP_X, PEG_BOTTOM_ROW_Y, PEG_RADIUS, CAP_TRI_L));
// 帽整体位于钉板最底行下缘（-264-16=-280）之下、钉群与隔墙之间空档，不与任何钉行重叠
check('分流帽整体位于钉板最底行下缘之下', CAP_TRI_L[2][1] < PEG_BOTTOM_ROW_Y - PEG_RADIUS);
// 帽底缘高于漏斗 sensor 顶缘（不堵漏斗开口）
check('分流帽底缘高于漏斗接收区', CAP_TRI_L[0][1] > FUNNEL_SENSOR_TOP_Y);
// 帽位于重炮/金币漏斗开口正上方：帽中心 |x|=180 落在 sensor 横向范围 (130,350) 内 → 直落必先撞帽
check('分流帽位于漏斗开口正上方（直落球必撞帽尖）', CAP_X > FUNNEL_SENSOR_INNER_X);
// 帽内缘 |x|=150 ≥ 急冻 sensor 半宽 110 → 中央急冻通道畅通（设计意图：直落急冻为合法路径）
check('中央急冻漏斗通道畅通不被帽侵入', CAP_X - CAP_HALF_W >= FUNNEL_B_HALF_W);
// 帽尺寸符合需求 60×25
check('分流帽尺寸为 60×25', CAP_HALF_W * 2 === 60 && CAP_HALF_H * 2 === 25);

// ---------- 4. 蹦床定向补冲方向 ----------
// 左蹦床 worldX=-310：球 x=-280（蹦床右侧）→ towardCenter=+1 → 推向 +x（场地中央）
const trampolineWorldX = -WING_X;
const orbWorldX = -280;
const towardCenter = trampolineWorldX <= orbWorldX ? 1 : -1;
check('左蹦床撞击补冲指向场地中央(+x)', towardCenter === 1);
// 方向含向上分量（滞空）：(0.8, 0.6) 归一化后 y 分量 ≈ 0.6
const dir = { x: towardCenter * 0.8, y: 0.6 };
const mag = Math.hypot(dir.x, dir.y);
check('补冲方向含向上滞空分量', dir.y / mag > 0.5);

// ---------- 汇总 ----------
if (failed > 0) {
    console.error(`${failed} 项几何自检未通过 ✘`);
    throw new Error(`selfcheck-deflectors: ${failed} 项未通过`);
}
console.log('全部几何自检通过 ✔');
