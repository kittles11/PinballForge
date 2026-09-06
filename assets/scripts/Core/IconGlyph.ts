/**
 * 图标路径解析器（IconGlyph）：把紧凑的 SVG path d 字符串解析成可被 Graphics 填充的轮廓组。
 *
 * 背景：项目零图片资产，图标体系走「自绘矢量路径数据 + 运行时 Graphics 填充 + ArtTheme 染色」。
 * 本解析器只支持 IconLib 自产数据用到的命令子集（M/L/H/V/Q/C/Z，绝对+相对），
 * 不支持 A 弧命令——参数化图形（圆/齿轮/星形）由 IconLib 的生成器产出折线/贝塞尔，
 * 数据面完全自控，杜绝第三方 SVG 的兼容风险（弧转贝塞尔、非零环绕差异等）。
 *
 * 输出约定：
 *  - 轮廓为展平后的折线（平面 xy 数组），曲线按固定段数采样（Q 8 段 / C 10 段），
 *    图标渲染尺寸 ≤ 512px 下肉眼无差；
 *  - 所有轮廓隐式闭合（子路径结束或遇到新 M 即封口）；
 *  - 带孔图形（盾牌内沿 / 金币方孔 / 骷髅眼窝）= 外轮廓 + 内含子路径，交给引擎
 *    Graphics fill 的 earcut 洞检测（与 Cocos Graphics 多子路径同次 fill 的语义一致）。
 */

/** 解析后的单条闭合轮廓：平面 [x0,y0,x1,y1,...] 折线 */
export interface IconContour {
    pts: number[];
}

/** 解析后的完整图形：一组闭合轮廓（首条为外轮廓，其余按需为孔/独立部件） */
export interface IconGeometry {
    contours: IconContour[];
}

/** 二次贝塞尔采样段数 */
const QUAD_SEGMENTS = 8;
/** 三次贝塞尔采样段数 */
const CUBIC_SEGMENTS = 10;

/** 数值 token（含科学计数法，与 SVG 数字语法对齐） */
const NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/** 命令字符 → 期望的参数个数（SVG path 约定） */
const ARG_COUNT: Record<string, number> = {
    M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, Z: 0,
    m: 2, l: 2, h: 1, v: 1, q: 4, c: 6, z: 0,
};

/**
 * 解析 path d 字符串。
 * 抛错条件（selfcheck-icon-ui 会在构建期拦住）：未知命令 / 参数数量非整倍 / 空数据。
 */
export function parseIconPath(d: string): IconGeometry {
    const contours: IconContour[] = [];
    let cur: number[] = [];
    // 当前点 / 上一条曲线控制点（S/T 平滑命令未开放，故无需记录；保留 curOnly 结构便于扩展）
    let cx = 0;
    let cy = 0;
    let startX = 0;
    let startY = 0;
    let cmd = '';
    let args: number[] = [];

    const closeContour = (): void => {
        if (cur.length >= 6) {
            contours.push({ pts: cur });
        }
        cur = [];
    };
    const lineTo = (x: number, y: number): void => {
        cur.push(x, y);
        cx = x;
        cy = y;
    };

    const tokens = d.match(/[MmLlHhVvQqCcZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
    for (const tok of tokens) {
        if (tok.length === 1 && ARG_COUNT[tok] !== undefined) {
            // 新命令落位：先把上一条命令的剩余参数消费完（同一命令可重复多组参数）
            flushPending();
            cmd = tok;
            args = [];
            if (cmd === 'Z' || cmd === 'z') {
                lineTo(startX, startY);
                closeContour();
                cmd = '';
            }
            continue;
        }
        if (!cmd) {
            throw new Error(`IconGlyph: 数据以裸数字开头（缺少初始命令）: "${tok}"`);
        }
        args.push(parseFloat(tok));
        if (args.length === ARG_COUNT[cmd]) {
            consume(cmd, args);
            args = [];
        }
    }
    flushPending();

    function flushPending(): void {
        if (cmd && args.length > 0) {
            if (args.length !== ARG_COUNT[cmd]) {
                throw new Error(`IconGlyph: 命令 ${cmd} 参数数量 ${args.length} 不是 ${ARG_COUNT[cmd]} 的整数倍`);
            }
            consume(cmd, args);
            args = [];
        }
    }

    function consume(c: string, a: number[]): void {
        const rel = c === c.toLowerCase();
        switch (c.toLowerCase()) {
            case 'm': {
                const x = a[0] + (rel ? cx : 0);
                const y = a[1] + (rel ? cy : 0);
                closeContour();
                cur.push(x, y);
                cx = x;
                cy = y;
                startX = x;
                startY = y;
                // SVG 约定：M 后续多余的参数对按 L 处理（IconLib 数据不产此形态，防御支持）
                cmd = rel ? 'l' : 'L';
                break;
            }
            case 'l': {
                lineTo(a[0] + (rel ? cx : 0), a[1] + (rel ? cy : 0));
                break;
            }
            case 'h': {
                lineTo(a[0] + (rel ? cx : 0), cy);
                break;
            }
            case 'v': {
                lineTo(cx, a[0] + (rel ? cy : 0));
                break;
            }
            case 'q': {
                const x1 = a[0] + (rel ? cx : 0);
                const y1 = a[1] + (rel ? cy : 0);
                const x2 = a[2] + (rel ? cx : 0);
                const y2 = a[3] + (rel ? cy : 0);
                for (let i = 1; i <= QUAD_SEGMENTS; i++) {
                    const t = i / QUAD_SEGMENTS;
                    const u = 1 - t;
                    lineTo(
                        u * u * cx + 2 * u * t * x1 + t * t * x2,
                        u * u * cy + 2 * u * t * y1 + t * t * y2,
                    );
                }
                break;
            }
            case 'c': {
                const x1 = a[0] + (rel ? cx : 0);
                const y1 = a[1] + (rel ? cy : 0);
                const x2 = a[2] + (rel ? cx : 0);
                const y2 = a[3] + (rel ? cy : 0);
                const x3 = a[4] + (rel ? cx : 0);
                const y3 = a[5] + (rel ? cy : 0);
                for (let i = 1; i <= CUBIC_SEGMENTS; i++) {
                    const t = i / CUBIC_SEGMENTS;
                    const u = 1 - t;
                    lineTo(
                        u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
                        u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
                    );
                }
                break;
            }
            default:
                throw new Error(`IconGlyph: 不支持的命令 ${c}`);
        }
    }

    closeContour();
    if (contours.length === 0) {
        throw new Error('IconGlyph: 数据没有产出任何轮廓');
    }
    return { contours };
}

/** 几何包围盒：selfcheck 校验数据越界用（相对 100×100 设计网格） */
export function geometryBounds(g: IconGeometry): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of g.contours) {
        for (let i = 0; i < c.pts.length; i += 2) {
            const x = c.pts[i];
            const y = c.pts[i + 1];
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                throw new Error('IconGlyph: 轮廓含非有限坐标');
            }
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    return { minX, minY, maxX, maxY };
}
