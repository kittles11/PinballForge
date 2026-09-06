/**
 * UI 立体件绘制库（UiKit）：凸起按钮 / 面板的统一「浮雕感」绘制（纯 Graphics，零贴图）。
 *
 * 背景（GAME_PLAN 4.3 可供性）：此前各弹窗按钮都是一层平涂色块，无厚度、无投影，
 * 看不出「可以按」。本库用三层色阶（投影层 → 底座暗边 → 本体 + 顶部高光线）画出
 * 统一的凸起语言；颜色全部由调用方传入 ArtTheme 语义色经 shadeColor 派生，
 * 不新增 hex 字面量。绘制为一次性静态成本，无逐帧开销。
 *
 * 用法（各弹窗 buildUI 内替换原 roundRect+fill 两行）：
 *   const g = node.addComponent(Graphics);
 *   UiKit.raisedButton(g, BTN_W, BTN_H, Theme.ui.blueActive);
 */
import { Graphics, Node, Tween, tween, UIOpacity, UITransform } from 'cc';
import type { Color } from 'cc';
import { shadeColor, Theme } from './ArtTheme';

/** 圆角半径缺省值（与现有弹窗 18px 面板 / 10px 瓷片同族） */
const DEFAULT_RADIUS = 14;
/** 投影下坠偏移（px）：浮雕「悬浮」感的关键，过大显脏 */
const SHADOW_OFFSET = 5;
/** 投影 alpha */
const SHADOW_ALPHA = 70;
/** 底座暗边厚度（px）：本体下缘露出的深色边 = 厚度 */
const BASE_EDGE = 4;
/** 顶部高光线 alpha */
const HIGHLIGHT_ALPHA = 90;

/**
 * 凸起按钮/面板：投影 + 底座暗边 + 本体 + 顶缘高光，四层一次画完。
 * @param g      目标 Graphics（调用方自行 clear）
 * @param w/h    尺寸（节点锚点居中坐标系）
 * @param body   本体色（ArtTheme 语义色）
 * @param radius 圆角半径
 */
export function raisedButton(g: Graphics, w: number, h: number, body: Color, radius: number = DEFAULT_RADIUS): void {
    if (!g?.isValid) {
        return;
    }
    const left = -w / 2;
    const top = -h / 2;

    // ① 投影：整体下坠 offset 的深色同形圆角矩形
    g.fillColor = shadeColor(body, -1, SHADOW_ALPHA);
    g.roundRect(left, top + SHADOW_OFFSET, w, h, radius);
    g.fill();

    // ② 底座暗边：本体位置向下露出 BASE_EDGE 厚度的深色边（厚度感）
    g.fillColor = shadeColor(body, -0.45);
    g.roundRect(left, top, w, h, radius);
    g.fill();

    // ③ 本体：上移 BASE_EDGE 的主体面
    g.fillColor = body;
    g.roundRect(left, top, w, h - BASE_EDGE, radius);
    g.fill();

    // ④ 顶部高光线：一条贴顶的浅色圆角横带（受光面）
    g.fillColor = shadeColor(body, 0.35, HIGHLIGHT_ALPHA);
    g.roundRect(left + radius * 0.4, top + 2, w - radius * 0.8, 5, 2.5);
    g.fill();
}

/**
 * 凹陷槽（漏斗槽口 / 输入位等「可投入」暗示）：外缘亮环 + 内部暗陷 + 底部反光。
 * 与 raisedButton 相反的光照方向（内暗外亮 = 往里凹），可供性语义对立但成对统一。
 * @param cx/cy 槽中心（宿主局部坐标）
 */
export function recessedSlot(
    g: Graphics, cx: number, cy: number, w: number, h: number, rim: Color, inner: Color, radius: number = 10,
): void {
    if (!g?.isValid) {
        return;
    }
    const left = cx - w / 2;
    const top = cy - h / 2;
    // ① 亮环（外缘受光 → 凹陷边界）
    g.fillColor = shadeColor(rim, 0.3, 200);
    g.roundRect(left - 3, top - 3, w + 6, h + 6, radius + 3);
    g.fill();
    // ② 暗陷本体
    g.fillColor = shadeColor(inner, -0.6, 235);
    g.roundRect(left, top, w, h, radius);
    g.fill();
    // ③ 底缘反光：凹陷底部的微光（深底上的一条亮线，托出纵深）
    g.fillColor = shadeColor(rim, 0.15, 60);
    g.roundRect(left + 4, top + h - 6, w - 8, 3.5, 1.75);
    g.fill();
}

// ---------- 卡面稀有度边框（GAME_PLAN 4.2：史诗边框必须做出「贵」） ----------

/** 卡面稀有度档位：0 普通 / 1 稀有 / 2 史诗 */
export type RarityTier = 0 | 1 | 2;

/** 稀有度字符串 → 档位（未知值回退普通） */
export function rarityTier(rarity: string): RarityTier {
    if (rarity === '史诗') {
        return 2;
    }
    if (rarity === '稀有') {
        return 1;
    }
    return 0;
}

/** 档位主题色：普通=铁灰 / 稀有=电光青 / 史诗=金（色相语义与全局一致，不新增 hex） */
export function rarityColor(tier: RarityTier): Color {
    return tier === 2 ? Theme.ui.gold : tier === 1 ? Theme.machine.edge : Theme.ui.gray;
}

/**
 * 卡面稀有度边框：在已填充的底色上描边框（调用方先画底色）。
 * 普通=细铁线；稀有=双线电光青；史诗=双线金 + 四角钻石饰（锚定效应：贵气由「金+饰+动」三层合成）。
 */
export function cardFrame(g: Graphics, w: number, h: number, tier: RarityTier): void {
    if (!g?.isValid) {
        return;
    }
    const c = rarityColor(tier);
    const left = -w / 2;
    const bottom = -h / 2;
    if (tier === 0) {
        g.lineWidth = 1.5;
        g.strokeColor = shadeColor(c, 0, 170);
        g.roundRect(left, bottom, w, h, 14);
        g.stroke();
        return;
    }
    if (tier === 1) {
        g.lineWidth = 2;
        g.strokeColor = c;
        g.roundRect(left, bottom, w, h, 14);
        g.stroke();
        g.lineWidth = 1;
        g.strokeColor = shadeColor(c, 0.35, 90);
        g.roundRect(left + 3.5, bottom + 3.5, w - 7, h - 7, 11);
        g.stroke();
        return;
    }
    // 史诗：外金线 + 内暗金线 + 四角钻石饰
    g.lineWidth = 2.5;
    g.strokeColor = c;
    g.roundRect(left, bottom, w, h, 14);
    g.stroke();
    g.lineWidth = 1.5;
    g.strokeColor = shadeColor(c, -0.35, 200);
    g.roundRect(left + 4, bottom + 4, w - 8, h - 8, 10);
    g.stroke();
    const d = 8;
    const corners: Array<[number, number]> = [
        [left + 12, bottom + 12], [left + w - 12, bottom + 12],
        [left + 12, bottom + h - 12], [left + w - 12, bottom + h - 12],
    ];
    g.fillColor = c;
    for (const [cx, cy] of corners) {
        g.moveTo(cx, cy - d);
        g.lineTo(cx + d, cy);
        g.lineTo(cx, cy + d);
        g.lineTo(cx - d, cy);
        g.close();
    }
    g.fill();
}

/**
 * 史诗卡面贵气脉冲：双层金晕描边子节点（`EpicGlow`），透明度 yoyo 循环呼吸。
 * 幂等：重入先清旧子节点；tween 挂在 UIOpacity 上，随节点销毁自然终止。
 */
export function attachEpicGlow(parent: Node, w: number, h: number): void {
    removeEpicGlow(parent);
    if (!parent?.isValid) {
        return;
    }
    const glow = new Node('EpicGlow');
    glow.layer = parent.layer;
    glow.addComponent(UITransform).setContentSize(w + 10, h + 10);
    const g = glow.addComponent(Graphics);
    const c = rarityColor(2);
    const layers: Array<[number, number, number]> = [
        [3, 3.5, 34], [6, 2.5, 60], [9, 1.5, 34],
    ];
    for (const [off, lw, alpha] of layers) {
        g.lineWidth = lw;
        g.strokeColor = shadeColor(c, 0.25, alpha);
        g.roundRect(-w / 2 - off, -h / 2 - off, w + off * 2, h + off * 2, 16 + off);
        g.stroke();
    }
    parent.addChild(glow);
    const op = glow.addComponent(UIOpacity);
    op.opacity = 70;
    tween(op)
        .repeatForever(tween().to(0.8, { opacity: 150 }).to(0.8, { opacity: 70 }))
        .start();
}

/** 移除史诗金晕子节点（卡面从史诗降级重绘时调用；幂等） */
export function removeEpicGlow(parent: Node): void {
    const old = parent?.getChildByName('EpicGlow');
    if (old?.isValid) {
        const oldOp = old.getComponent(UIOpacity);
        if (oldOp?.isValid) {
            Tween.stopAllByTarget(oldOp);
        }
        old.destroy();
    }
}
