/**
 * 图标库（IconLib）：自绘矢量图标注册表 + 运行时 Graphics 挂载工厂（零图片资产）。
 *
 * 设计约定（与 ArtTheme 白图染色哲学同源）：
 *  - 所有图形以「单色填充剪影」在 100×100 设计网格上手工/参数化产出，渲染时整体缩放；
 *  - 颜色完全由调用方传入 ArtTheme 语义色（本文件禁止构造 cc.Color，selfcheck 规则 A 把关）；
 *  - 带孔图形（盾内沿 / 金币方孔 / 骷髅眼窝）= 外轮廓 + 内含子路径同次 fill，
 *    交给引擎 Graphics 的 earcut 洞检测；
 *  - mount() 幂等：同名子节点存在则清空重绘（对话框 rebuild 范式天然兼容）。
 *
 * 数据格式：SVG path d 子集（M/L/H/V/Q/C/Z，见 IconGlyph.parseIconPath）；
 * 参数化图形（圆/星/齿轮/雪花/原子轨道）由生成器产出，避免手写坐标出错。
 * 网格坐标 y 向下（同屏幕直觉），draw() 统一翻转适配 Cocos UI 的 y 向上坐标系。
 */
import { Graphics, Node, UITransform } from 'cc';
import type { Color } from 'cc';
import { geometryBounds, parseIconPath } from './IconGlyph';
import type { IconGeometry } from './IconGlyph';

/** 设计网格边长（所有手绘数据按此网格产出） */
export const ICON_GRID = 100;

// ---------- 参数化生成器（产出 path d 字符串） ----------

/** 圆（四段三次贝塞尔近似，kappa 标准） */
function circlePath(cx: number, cy: number, r: number): string {
    const k = 0.5522847498 * r;
    return `M ${cx + r} ${cy} `
        + `C ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} `
        + `C ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} `
        + `C ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} `
        + `C ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} Z`;
}

/** n 角星（rotDeg: 0 = 第一个外顶点朝右，-90 朝上） */
function starPath(cx: number, cy: number, n: number, rOuter: number, rInner: number, rotDeg: number): string {
    const pts: string[] = [];
    const rot = (rotDeg * Math.PI) / 180;
    for (let i = 0; i < n * 2; i++) {
        const r = i % 2 === 0 ? rOuter : rInner;
        const a = rot + (i * Math.PI) / n;
        pts.push(`${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`);
    }
    return `M ${pts.join(' L ')} Z`;
}

/** 雪花：arms 条从圆心到边缘的细长风筝臂（重叠成实心） */
function snowPath(cx: number, cy: number, r: number, arms: number): string {
    const parts: string[] = [];
    const half = 7; // 臂根半宽
    for (let i = 0; i < arms; i++) {
        const a = (i * 2 * Math.PI) / arms - Math.PI / 2;
        const tx = cx + Math.cos(a) * r;
        const ty = cy + Math.sin(a) * r;
        const lx = cx + Math.cos(a - Math.PI / 2) * half;
        const ly = cy + Math.sin(a - Math.PI / 2) * half;
        const rx = cx + Math.cos(a + Math.PI / 2) * half;
        const ry = cy + Math.sin(a + Math.PI / 2) * half;
        parts.push(`M ${tx.toFixed(2)} ${ty.toFixed(2)} L ${lx.toFixed(2)} ${ly.toFixed(2)} L ${cx} ${cy} L ${rx.toFixed(2)} ${ry.toFixed(2)} Z`);
    }
    return parts.join(' ');
}

/** 齿轮：teeth 个方齿 + 中孔 */
function gearPath(cx: number, cy: number, teeth: number, rOuter: number, rRoot: number, rHole: number): string {
    const pts: string[] = [];
    const pitch = (Math.PI * 2) / teeth;
    for (let i = 0; i < teeth; i++) {
        const a0 = i * pitch - Math.PI / 2;
        // 齿占 40% 节距，根占 60%：根A → 齿A → 齿B → 根B
        const seq: Array<[number, number]> = [
            [rRoot, a0],
            [rOuter, a0 + pitch * 0.1],
            [rOuter, a0 + pitch * 0.4],
            [rRoot, a0 + pitch * 0.5],
        ];
        for (const [r, a] of seq) {
            pts.push(`${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`);
        }
    }
    return `M ${pts.join(' L ')} Z ${circlePath(cx, cy, rHole)}`;
}

/** 旋转椭圆环带（原子轨道）：外椭圆 + 内椭圆（反向即孔），samples 采样折线 */
function ellipseBandPath(
    cx: number, cy: number, rxOuter: number, ryOuter: number, rxInner: number, ryInner: number,
    rotDeg: number, samples: number = 44,
): string {
    const rot = (rotDeg * Math.PI) / 180;
    const ring = (rx: number, ry: number, dir: number): string => {
        const pts: string[] = [];
        for (let i = 0; i < samples; i++) {
            const t = (dir > 0 ? i : samples - i) * 2 * Math.PI / samples;
            const ex = Math.cos(t) * rx;
            const ey = Math.sin(t) * ry;
            pts.push(
                `${(cx + ex * Math.cos(rot) - ey * Math.sin(rot)).toFixed(2)} `
                + `${(cy + ex * Math.sin(rot) + ey * Math.cos(rot)).toFixed(2)}`,
            );
        }
        return `M ${pts.join(' L ')} Z`;
    };
    return `${ring(rxOuter, ryOuter, 1)} ${ring(rxInner, ryInner, -1)}`;
}

// ---------- 图标注册表（name → path d） ----------

/** 图标名 → path d（手绘图形直接写字符串；参数化图形用生成器拼装） */
const ICON_SOURCES: Record<string, string> = {
    // 盾（铁壁词缀 / 荆棘要塞遗物）：外沿 + 内沿孔
    shield: 'M50 6 L90 20 L90 48 Q90 78 50 94 Q10 78 10 48 L10 20 Z '
        + 'M50 20 L78 30 L78 48 Q78 68 50 80 Q22 68 22 48 L22 30 Z',
    // 闪电（疾风词缀 / 雷球）
    bolt: 'M57 4 L20 56 L43 56 L37 96 L80 40 L53 40 Z',
    // 血滴（血怒词缀 / 吸血球）
    drop: 'M50 8 C50 8 86 50 86 66 C86 84 70 93 50 93 C30 93 14 84 14 66 C14 50 50 8 50 8 Z',
    // 王冠（随从词缀 / 王者之冕遗物）：三尖冠体 + 底座
    crown: 'M12 70 L12 32 L32 50 L50 20 L68 50 L88 32 L88 70 Z M12 76 L88 76 L88 90 L12 90 Z',
    // 镐（黄金矿工遗物）：弧形镐头 + 斜柄
    pickaxe: 'M14 34 Q50 4 90 40 L82 52 Q50 22 22 46 Z M42 24 L54 18 L88 80 L76 88 Z',
    // 爆炸星芒（高能烈药遗物）：8 角炸星
    boom: starPath(50, 52, 8, 46, 19, 0),
    // 波浪（潮汐镀金遗物）：波峰带 + 平底
    wave: 'M6 48 Q18 32 30 48 Q42 64 54 48 Q66 32 78 48 Q86 58 94 50 L94 76 L6 76 Z',
    // 普通弹珠：圆体 + 高光孔
    orbPlain: `${circlePath(50, 50, 34)} ${circlePath(64, 36, 9)}`,
    // 火焰（熔岩球）：右肩饱满 + 顶部内凹火舌
    flame: 'M50 6 C56 22 64 30 72 40 C82 52 84 60 84 68 C84 86 70 94 50 94 '
        + 'C30 94 16 86 16 68 C16 58 20 50 28 42 C34 36 38 30 40 22 '
        + 'C44 30 50 32 54 28 C52 20 51 12 50 6 Z',
    // 雪花（霜冻冰球）：六臂
    snow: snowPath(50, 50, 42, 6),
    // 原子（等离子球）：核心 + 双交叉轨道环带
    plasma: `${circlePath(50, 50, 13)} ${ellipseBandPath(50, 50, 44, 15, 35, 6, 28)} `
        + `${ellipseBandPath(50, 50, 44, 15, 35, 6, -28)}`,
    // 流星（熔核球）：本体圆 + 左上三道速度线
    magma: `${circlePath(58, 58, 28)} M28 36 L36 28 L52 44 L44 52 Z `
        + 'M10 26 L18 18 L30 30 L22 38 Z M28 12 L34 6 L46 18 L40 24 Z',
    // 背包（牌库按钮 / 弹珠工坊）：背体 + 提手 + 前袋孔
    bag: 'M28 36 Q28 20 50 20 Q72 20 72 36 L72 84 Q72 92 64 92 L36 92 Q28 92 28 84 Z '
        + 'M40 20 Q40 8 50 8 Q60 8 60 20 L54 20 Q54 14 50 14 Q46 14 46 20 Z '
        + 'M34 58 L66 58 L66 82 Q66 88 60 88 L40 88 Q34 88 34 82 Z',
    // 写字板（每日任务）：板体 + 顶部夹子 + 三道栏线孔
    clipboard: 'M24 14 L76 14 Q80 14 80 18 L80 90 Q80 94 76 94 L24 94 Q20 94 20 90 L20 18 Q20 14 24 14 Z '
        + 'M40 8 L60 8 Q64 8 64 12 L64 22 L36 22 L36 12 Q36 8 40 8 Z '
        + 'M30 36 L70 36 L70 42 L30 42 Z M30 52 L70 52 L70 58 L30 58 Z M30 68 L58 68 L58 74 L30 74 Z',
    // 双卡（牌库分区标题）：两张错位圆角卡
    cards: 'M30 20 L74 20 Q78 20 78 24 L78 72 Q78 76 74 76 L30 76 Q26 76 26 72 L26 24 Q26 20 30 20 Z '
        + 'M22 34 L66 34 Q70 34 70 38 L70 86 Q70 90 66 90 L22 90 Q18 90 18 86 L18 38 Q18 34 22 34 Z',
    // 宝石（遗物分区标题 / 传奇遗物）：钻石 + 腰线孔
    gem: 'M50 10 L78 32 L50 90 L22 32 Z M30 32 L70 32 L70 37 L30 37 Z',
    // 开卷（锻造总览）：左右两页 + 中缝
    book: 'M48 26 Q30 14 12 18 L12 80 Q30 76 48 86 Z M52 26 Q70 14 88 18 L88 80 Q70 76 52 86 Z',
    // 金币（货币）：圆币 + 方孔（方孔铜钱式）
    coin: `${circlePath(50, 50, 36)} M42 42 L58 42 L58 58 L42 58 Z`,
    // 垃圾桶（精简卡组）：桶盖 + 提手 + 桶身 + 三道竖槽孔
    trash: 'M42 16 L58 16 L58 28 L42 28 Z M22 28 L78 28 L78 36 L22 36 Z '
        + 'M28 42 L72 42 L72 88 Q72 94 66 94 L34 94 Q28 94 28 88 Z '
        + 'M38 50 L43 50 L43 86 L38 86 Z M48 50 L53 50 L53 86 L48 86 Z M58 50 L63 50 L62 86 L57 86 Z',
    // 城堡（城堡维修）：雉堞塔体 + 拱门孔 + 台基
    castle: 'M20 94 L20 30 L32 30 L32 42 L44 42 L44 30 L56 30 L56 42 L68 42 L68 30 L80 30 L80 94 Z '
        + 'M42 94 L42 74 Q50 64 58 74 L58 94 Z M14 88 L86 88 L86 94 L14 94 Z',
    // 锤（领取 / 锻造）：横锤头 + 竖柄
    hammer: 'M18 18 L82 18 L82 46 L18 46 Z M44 46 L56 46 L56 92 L44 92 Z',
    // 右箭头（继续下一关）
    arrowRight: 'M10 40 L56 40 L56 22 L92 50 L56 78 L56 60 L10 60 Z',
    // 五角星（战斗胜利）
    star: starPath(50, 50, 5, 44, 18, -90),
    // 骷髅（城堡沦陷）：颅圆 + 颚齿 + 眼窝孔 + 鼻腔孔
    skull: `${circlePath(50, 44, 30)} `
        + 'M30 62 L30 84 Q30 90 36 90 L42 90 L42 82 L46 82 L46 90 L54 90 L54 82 L58 82 L58 90 L64 90 '
        + 'Q70 90 70 84 L70 62 Z '
        + `${circlePath(38, 42, 8)} ${circlePath(62, 42, 8)} M50 54 L56 66 L44 66 Z`,
    // 齿轮（锻造背景暗纹）：8 齿 + 中孔
    gear: gearPath(50, 50, 8, 46, 36, 14),
};

// ---------- 解析缓存与查询 ----------

const GEOMETRY_CACHE = new Map<string, IconGeometry>();

/** 取图标几何（惰性解析 + 进程级缓存；未知名字抛错——图标名是静态注册表，拼错应在开发期暴露） */
export function iconGeometry(name: string): IconGeometry {
    let geo = GEOMETRY_CACHE.get(name);
    if (!geo) {
        const src = ICON_SOURCES[name];
        if (!src) {
            throw new Error(`[IconLib] 未知图标名: ${name}（已注册: ${Object.keys(ICON_SOURCES).join(', ')}）`);
        }
        geo = parseIconPath(src);
        GEOMETRY_CACHE.set(name, geo);
    }
    return geo;
}

/** 图标名是否存在 */
export function hasIcon(name: string): boolean {
    return ICON_SOURCES[name] !== undefined;
}

/** 全部已注册图标名（selfcheck 遍历校验用） */
export function allIconNames(): string[] {
    return Object.keys(ICON_SOURCES);
}

// ---------- 渲染工厂 ----------

/**
 * 把图标画进已有 Graphics（不清屏，调用方自行 clear）：
 * cx/cy 为图标中心（宿主局部坐标），size 为渲染边长，color 为 ArtTheme 语义色。
 */
export function drawIcon(g: Graphics, name: string, cx: number, cy: number, size: number, color: Color): void {
    const geo = iconGeometry(name);
    const s = size / ICON_GRID;
    g.fillColor = color;
    for (const contour of geo.contours) {
        const pts = contour.pts;
        g.moveTo(cx + (pts[0] - ICON_GRID / 2) * s, cy + (ICON_GRID / 2 - pts[1]) * s);
        for (let i = 2; i < pts.length; i += 2) {
            g.lineTo(cx + (pts[i] - ICON_GRID / 2) * s, cy + (ICON_GRID / 2 - pts[i + 1]) * s);
        }
        g.close();
    }
    g.fill();
}

/**
 * 幂等挂载图标子节点（名字 `Icon_<name>`）：存在则清空重绘，否则创建。
 * 返回图标节点（调用方如需动画可对其 tween scale / UIOpacity）。
 */
export function mountIcon(
    parent: Node, name: string, size: number, color: Color, x: number = 0, y: number = 0,
): Node {
    const childName = `Icon_${name}`;
    let node = parent.getChildByName(childName);
    if (!node?.isValid) {
        node = new Node(childName);
        node.layer = parent.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
        node.addComponent(UITransform);
        parent.addChild(node);
    }
    node.getComponent(UITransform)?.setContentSize(size, size);
    node.setPosition(x, y, 0);
    const g = node.getComponent(Graphics) ?? node.addComponent(Graphics);
    g.clear();
    drawIcon(g, name, 0, 0, size, color);
    return node;
}

// ---------- 构建期自检辅助（selfcheck-icon-ui 消费） ----------

/** 校验全部注册图标：可解析、坐标有限、不越出网格容差。返回错误信息列表（空 = 全过） */
export function validateAllIcons(): string[] {
    const errors: string[] = [];
    for (const name of allIconNames()) {
        try {
            const geo = iconGeometry(name);
            const b = geometryBounds(geo);
            const TOL = 6; // 手绘坐标允许 ±6 越界容差（速度线等贴边元素）
            if (b.minX < -TOL || b.minY < -TOL || b.maxX > ICON_GRID + TOL || b.maxY > ICON_GRID + TOL) {
                errors.push(`${name}: 包围盒越界 [${b.minX.toFixed(1)},${b.minY.toFixed(1)} ~ ${b.maxX.toFixed(1)},${b.maxY.toFixed(1)}]`);
            }
        } catch (err) {
            errors.push(`${name}: ${(err as Error).message}`);
        }
    }
    return errors;
}
