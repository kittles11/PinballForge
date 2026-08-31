/**
 * 瞄准预测线：纯数学首段轨迹模拟（零 cc 依赖，自检可动态 import 真跑）。
 * 半隐式欧拉积分 + 步进线段-圆扫掠；命中钉子 / 撞墙 / 进入漏斗区即截断。
 * ponytail: 只做首段（不模拟反弹链）——P1-2 对齐结论：全链路影子世界在 Cocos 2D 单物理世界下
 * 是 bug 温床（污染钉子计数/弹珠上限），且泄题让游戏失去瞄准乐趣。
 */

/** 钉子快照（圆心为绘制节点本地系坐标） */
export interface PreviewPeg {
    x: number;
    y: number;
    /** 钉子半径 */
    r: number;
}

export interface AimPreviewParams {
    /** 起点与初速（px / px每秒），与绘制节点同坐标系 */
    startX: number;
    startY: number;
    vx: number;
    vy: number;
    /** 重力加速度 px/s²（y 轴向下为负；取 PhysicsSystem2D.gravity.y 真值） */
    gravity: number;
    /** 弹珠半径（与钉子半径求和判定相交） */
    orbR: number;
    /** 模拟总时长（s）——决定预测线长度 */
    maxTime: number;
    /** 积分步长（s），越小越准（弹珠 2400px/s 高速，半帧步长保证钉子不被步进跳过） */
    dt: number;
    /** 场地左右半宽（|x| 超出即截断；物理墙位置的近似边界） */
    fieldHalfW: number;
    /** 底部截断线（漏斗接收区上沿，进入即终点） */
    floorY: number;
    /** 钉子快照（调用方在触摸开始时收集一次） */
    pegs: PreviewPeg[];
}

export interface AimPreviewResult {
    /** 轨迹采样点 [x, y] 序列（含起点） */
    points: Array<[number, number]>;
    /** 命中的钉子（无则 null） */
    hitPeg: PreviewPeg | null;
    /** 截断原因：peg=命中钉子 / wall=左右墙 / floor=进入漏斗区 / end=模拟时长用尽 */
    endReason: 'peg' | 'wall' | 'floor' | 'end';
}

/** 线段 (x1,y1)→(x2,y2) 与圆 (cx,cy,r) 是否相交（圆心到线段最近距离 ≤ r） */
export function segHitsCircle(
    x1: number, y1: number, x2: number, y2: number,
    cx: number, cy: number, r: number,
): boolean {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    // 圆心在线段上的投影参数 t∈[0,1]（钳到端点；零长线段退化为点测）
    let t = 0;
    if (lenSq > 0) {
        t = ((cx - x1) * dx + (cy - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
    }
    const nx = x1 + dx * t - cx;
    const ny = y1 + dy * t - cy;
    return nx * nx + ny * ny <= r * r;
}

/** 模拟瞄准首段轨迹：返回采样点列 + 命中钉子（纯函数，无副作用） */
export function simulateAimPreview(p: AimPreviewParams): AimPreviewResult {
    const points: Array<[number, number]> = [];
    let x = p.startX;
    let y = p.startY;
    let vx = p.vx;
    let vy = p.vy;
    points.push([x, y]);

    const steps = Math.max(1, Math.ceil(p.maxTime / p.dt));
    for (let i = 0; i < steps; i++) {
        // 半隐式欧拉：先更新速度，再用新速度推进位置（与物理引擎步进习惯一致，轨迹不发散）
        vy += p.gravity * p.dt;
        const nx = x + vx * p.dt;
        const ny = y + vy * p.dt;

        // 同一小步内钉子优先判定（步长足够小，先后差异可忽略）
        for (let k = 0; k < p.pegs.length; k++) {
            const peg = p.pegs[k];
            if (segHitsCircle(x, y, nx, ny, peg.x, peg.y, peg.r + p.orbR)) {
                points.push([nx, ny]);
                return { points, hitPeg: peg, endReason: 'peg' };
            }
        }

        x = nx;
        y = ny;
        points.push([x, y]);

        if (Math.abs(x) >= p.fieldHalfW) {
            return { points, hitPeg: null, endReason: 'wall' };
        }
        if (y <= p.floorY) {
            return { points, hitPeg: null, endReason: 'floor' };
        }
    }
    return { points, hitPeg: null, endReason: 'end' };
}
