/**
 * 全局美术主题（唯一视觉真源）：语义色板 + 动效常量。
 *
 * 背景：全项目曾有 94 处 `new Color(...)` 硬编码（18 文件），同色系严重漂移——
 * "金" 6 个版本、"冰蓝" 9 个版本、面板底色 5 个版本。本文件按「同色系取最亮最纯
 * 的一支为基准，其余全部指向它」归并，此后任何视觉调整只改这里。
 *
 * 约定：
 *  - 业务代码禁止再写 `new Color(...)` 字面量（selfcheck-art-fx.ts 机器校验）；
 *  - 需要长周期持有并可 mut（.set / .a）的色值，用 cloneColor(token) 克隆，
 *    绝不直接把共享 token 实例交给会被就地修改的字段；
 *  - @property(Color) 默认值同样必须 cloneColor，避免组件间共享同一实例。
 */
import { Color } from 'cc';

/** hex 工厂：0xRRGGBB + alpha（替代散落全项目的 new Color 字面量） */
export function hex(rgb: number, a: number = 255): Color {
    return new Color((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF, a);
}

/** rgb 三元组工厂：DataModels 的 {r,g,b} 纯数据 → cc.Color */
export function rgb(r: number, g: number, b: number, a: number = 255): Color {
    return new Color(r, g, b, a);
}

/** 克隆一份可安全就地修改的色值（@property 默认值等长生命周期持有场景必须用克隆） */
export function cloneColor(c: Color): Color {
    return c.clone();
}

// ---------- 共享基色（每个色值字面量全项目只允许出现一次） ----------
const C_WHITE = 0xFFFFFF;
const C_BLACK = 0x000000;
const C_GOLD = 0xFFD878;         // 主题金（归并 6 个金变体）
const C_GOLD_DIM = 0xFFBE46;     // 暗金（CTA / 可购行强调）
const C_ICE = 0x00FFFF;          // 冰蓝电光（归并 9 个冰蓝变体）
const C_HIT_GREEN = 0x90EE90;    // 受击浅绿（钉子受击高亮 = 撞钉跳字绿）
const C_RED = 0xFF4646;          // 伤害红（跳字 / 城堡受击 / 商店报错）
const C_RED_DEEP = 0xFF2828;     // 重击深红（炸药钉 / 熔岩暴击字）
const C_BODY_RED = 0xFF5050;     // 敌人标准体红（DataModels.Normal 同色）
const C_VIGNETTE = 0x060A14;     // 暗角基色
const C_FROST = 0xE0F7FA;        // 霜冻淡冰蓝
const C_LAVA = 0xFF4400;         // 熔岩火红
const C_CANNON = 0xFF3333;       // 聚能（重炮）红
const C_PANEL = 0x1E2438;        // UI 面板靛蓝

/** 语义色板：按 bg / machine / ui / orb / peg / enemy / funnel / wing / fx 分族 */
export const Theme = {
    /** 纯白（通用基色） */
    white: hex(C_WHITE),

    /** 背景层：深靛蓝族（与 UI 面板 #1E2438 同族，取代原灰绿 #262928） */
    bg: {
        top: hex(0x273452),
        bottom: hex(0x121826),
        vignette: [26, 54, 92, 136].map((a) => hex(C_VIGNETTE, a)),
    },

    /** 机关（导流板 / 蹦床 / 分流帽）：深灰板体 + 青蓝发光描边 */
    machine: {
        body: hex(0x2A2E38),
        edge: hex(0x35E0FF),
        glow: hex(0x00E5FF, 70),
    },

    /** UI：面板 / 金环 / 文本层级 */
    ui: {
        panel: hex(C_PANEL, 240),
        panelOpaque: hex(0x1E2230),
        badgeBg: hex(C_PANEL, 204),
        overlay: hex(C_BLACK, 160),
        gold: hex(C_GOLD),
        goldDim: hex(C_GOLD_DIM),
        tileGoldBg: hex(0x2E2810, 200),
        treasureBg: hex(0x281E0C),
        header: hex(0xAAD6FF),
        text: hex(0xE2E6EC),
        textDim: hex(0xB9BCC2),
        whiteGhost: hex(C_WHITE, 120),
        disabled: hex(0x4E525C),
        disabledGray: hex(0x787878),
        gray: hex(0x9E9E9E),
        green: hex(0x34763E),
        greenBright: hex(0x8CFFA0),
        blueActive: hex(0x2E5480),
        red: hex(C_RED),
        redDot: hex(0xFF5252),
    },

    /** 弹珠：4 球种核心色 + 受击反馈 */
    orb: {
        normal: hex(C_WHITE),
        lightning: hex(C_ICE),
        lava: hex(C_LAVA),
        frost: hex(C_FROST),
        textOk: hex(C_HIT_GREEN),
        lavaText: hex(0xFF6628),
        lightningFlash: hex(0xDCFFFF),
        lavaFlash: hex(0xFFDC78),
    },

    /** 钉子：4 钉型 + 受击 / 力竭 / 计量环 */
    peg: {
        normal: hex(C_WHITE),
        multiplier: hex(C_GOLD),
        bomb: hex(C_RED_DEEP),
        refresh: hex(0x32E664),
        hit: hex(C_HIT_GREEN),
        exhaust: hex(0x999999),
        lavaSplash: hex(0xFF3300),
        ringOff: hex(0x3A4050),
    },

    /** 敌人：受击 / 护盾 / 血条 / 轮廓装饰 */
    enemy: {
        freeze: hex(C_ICE),
        heavyHit: hex(0xFF0000),
        lightningHit: hex(0xBEFFFF),
        shieldBlock: hex(0xBED2FF),
        shieldText: hex(0x78C8FF),
        shieldPip: hex(0x5ABEFF),
        bossRegen: hex(0x5AE682),
        hurtText: hex(C_RED),
        hurtTextHeavy: hex(C_RED_DEEP),
        lightningText: hex(0x78E6FF),
        hpBarBack: hex(C_BLACK, 170),
        hpBarFill: hex(0x46E65A),
        bodyFallback: hex(C_BODY_RED),
        shadow: hex(C_BLACK, 80),
        outline: hex(C_BLACK, 110),
        mark: hex(C_WHITE, 150),
    },

    /** 漏斗槽：聚能红 / 精炼冰蓝 / 金币金 */
    funnel: {
        cannon: hex(C_CANNON),
        ice: hex(C_ICE),
        gold: hex(C_GOLD),
    },

    /** 侧翼蹦床受击闪光 */
    wing: {
        flash: hex(0xBEFAFF),
    },

    /** 特效层：火花 / 冲击 / 烟雾 / 枪口 / 屏幕脉冲 */
    fx: {
        white: hex(C_WHITE),
        fadeWhite: hex(C_WHITE, 0),
        shock: hex(C_WHITE),
        ember: hex(0xFF8844),
        smoke: hex(0x6A6F80),
        muzzle: hex(0xFFEE88),
        blood: hex(C_BODY_RED),
        redPulse: hex(0xFF3030),
    },
};

// ---------- 球种 / 漏斗 颜色映射（数字键，杜绝模块加载期循环引用未定义） ----------

const ORB_TRAIL_COLORS: Record<number, Color> = {
    0: hex(C_WHITE),       // 普通：银白
    1: hex(C_ICE),         // 雷电：青蓝电光
    2: hex(C_LAVA),        // 熔岩：炽热橙红
    3: hex(C_FROST),       // 霜冻：雪白微蓝
};

const ORB_AIM_COLORS: Record<number, Color> = {
    0: hex(C_WHITE, 220),
    1: hex(C_ICE, 240),
    2: hex(C_LAVA, 240),
    3: hex(C_FROST, 240),
};

const FUNNEL_COLORS: Record<number, Color> = {
    0: hex(C_CANNON),      // 聚能（重炮）红
    1: hex(C_ICE),         // 精炼（急冻）冰蓝
    2: hex(C_GOLD),        // 金币金
};

/** 球种拖尾 / 炮弹 / 汇总跳字色（未知类型回退银白） */
export function orbTrailColor(type: number): Color {
    return ORB_TRAIL_COLORS[type] ?? Theme.orb.normal;
}

/** 球种瞄准线颜色（未知类型回退普通） */
export function orbAimColor(type: number): Color {
    return ORB_AIM_COLORS[type] ?? ORB_AIM_COLORS[0];
}

/** 漏斗槽主题色（0 聚能红 / 1 精炼冰蓝 / 2 金币金） */
export function funnelColor(type: number): Color {
    return FUNNEL_COLORS[type] ?? FUNNEL_COLORS[0];
}

/** 背景渐变取色：t∈[0,1] 顶部→底部在 bg.top / bg.bottom 间插值（共享暂存，随取随用不持有） */
const _gradientScratch = new Color();
export function bgGradientColor(t: number): Color {
    const a = Theme.bg.top;
    const b = Theme.bg.bottom;
    _gradientScratch.set(
        Math.round(a.r + (b.r - a.r) * t),
        Math.round(a.g + (b.g - a.g) * t),
        Math.round(a.b + (b.b - a.b) * t),
        255,
    );
    return _gradientScratch;
}

// ---------- 动效常量 ----------

/** 受击 punch 缓动（回弹过冲，替代原线性 to） */
export const EASE_PUNCH = 'backOut';

/** 弹性 pop 缓动（归位弹性振荡） */
export const EASE_POP = 'elasticOut';

/** 受击压扁比例（squash & stretch：X 撑、Y 压，XY 分离替代等比缩放） */
export const SQUASH_SCALE_X = 1.32;
export const SQUASH_SCALE_Y = 0.82;
