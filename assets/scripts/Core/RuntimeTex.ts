/**
 * 运行时程序化纹理（零资源、跨平台一致）：glow 柔光 / streak 拖尾截面 / smoke 烟团。
 *
 * 意义：把「硬边白方块 / 实心圆」升级为柔光体积感，且不引入任何 PNG 资源。
 * 输出缓存的 SpriteFrame（glow/smoke）与 Texture2D（streak 供 MotionStreak 直接使用），
 * 供特效层、弹珠高光、炮弹辉光共用。
 *
 * 失败兜底：任何一步异常（个别原生平台 uploadData 不兼容等）自动置 useGraphicsFallback=true
 * 并返回 null，调用方退回 Graphics 实心圆绘制。
 */
import { SpriteFrame, Texture2D } from 'cc';

/** glow 柔光纹理边长（px） */
const GLOW_SIZE = 64;
/** streak 拖尾截面纹理：宽（截面方向） */
const STREAK_W = 32;
/** streak 拖尾截面纹理：长（沿轨迹方向） */
const STREAK_H = 64;
/** smoke 烟团纹理边长（px） */
const SMOKE_SIZE = 64;

/** glow 径向衰减公式：(1-d)²，中心 1 → 边缘 0，严格单调递减（selfcheck-art-fx 有同步副本校验） */
export function glowFalloff(d: number): number {
    const t = Math.max(0, 1 - d);
    return t * t;
}

/** glow：白色径向柔光（RGB 恒 255，色相交给 Sprite.color 染色；加法混合下即柔光体积） */
function buildGlowData(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const nx = ((x + 0.5) / size) * 2 - 1;
            const ny = ((y + 0.5) / size) * 2 - 1;
            const d = Math.min(1, Math.hypot(nx, ny));
            const i = (y * size + x) * 4;
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = Math.round(glowFalloff(d) * 255);
        }
    }
    return data;
}

/** streak：拖尾截面（横向柔边 + 纵向两端收口；沿轨迹的淡出交给 MotionStreak.fadeTime 顶点色） */
function buildStreakData(): Uint8Array {
    const data = new Uint8Array(STREAK_W * STREAK_H * 4);
    for (let y = 0; y < STREAK_H; y++) {
        for (let x = 0; x < STREAK_W; x++) {
            const nx = ((x + 0.5) / STREAK_W) * 2 - 1;
            const ny = ((y + 0.5) / STREAK_H) * 2 - 1;
            const edge = Math.pow(Math.max(0, 1 - Math.abs(nx)), 1.5);
            const cap = Math.sqrt(Math.max(0, 1 - Math.abs(ny)));
            const i = (y * STREAK_W + x) * 4;
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = Math.round(255 * edge * cap);
        }
    }
    return data;
}

/** smoke：确定性伪随机 value-noise（8×8 双线性）× 径向衰减 → 有起伏的烟团（跨平台结果一致） */
function buildSmokeData(): Uint8Array {
    const grid = 8;
    let seed = 0x2F6E2B1;
    const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const noise: number[] = [];
    for (let i = 0; i < (grid + 1) * (grid + 1); i++) {
        noise.push(rnd());
    }
    const sample = (gx: number, gy: number): number => {
        const x0 = Math.min(grid, Math.floor(gx));
        const y0 = Math.min(grid, Math.floor(gy));
        const x1 = Math.min(grid, x0 + 1);
        const y1 = Math.min(grid, y0 + 1);
        const fx = gx - x0;
        const fy = gy - y0;
        const n00 = noise[y0 * (grid + 1) + x0];
        const n10 = noise[y0 * (grid + 1) + x1];
        const n01 = noise[y1 * (grid + 1) + x0];
        const n11 = noise[y1 * (grid + 1) + x1];
        return (n00 * (1 - fx) + n10 * fx) * (1 - fy) + (n01 * (1 - fx) + n11 * fx) * fy;
    };

    const data = new Uint8Array(SMOKE_SIZE * SMOKE_SIZE * 4);
    for (let y = 0; y < SMOKE_SIZE; y++) {
        for (let x = 0; x < SMOKE_SIZE; x++) {
            const nx = ((x + 0.5) / SMOKE_SIZE) * 2 - 1;
            const ny = ((y + 0.5) / SMOKE_SIZE) * 2 - 1;
            const d = Math.min(1, Math.hypot(nx, ny));
            const billow = 90 + 150 * sample((x / SMOKE_SIZE) * grid, (y / SMOKE_SIZE) * grid);
            const i = (y * SMOKE_SIZE + x) * 4;
            data[i] = 200;
            data[i + 1] = 200;
            data[i + 2] = 205;
            data[i + 3] = Math.round(glowFalloff(d) * billow);
        }
    }
    return data;
}

/** 由 RGBA 像素数据构建 Texture2D：reset + uploadData（CC 3.8 运行时纹理标准路径） */
function makeTexture(w: number, h: number, data: Uint8Array): Texture2D | null {
    try {
        const tex = new Texture2D();
        tex.reset({ width: w, height: h, format: Texture2D.PixelFormat.RGBA8888 });
        tex.uploadData(data);
        return tex;
    } catch (err) {
        console.warn('[RuntimeTex] 运行时纹理生成失败，自动回退 Graphics 绘制', err);
        RuntimeTex.useGraphicsFallback = true;
        return null;
    }
}

/**
 * 运行时纹理缓存门面：glow / streak / smoke（全部惰性生成、进程级缓存）。
 * ★ disc（程序化白圆盘）已于 2026-09-05 移除：钉子 / 球体本体改由 Graphics 矢量实心圆盘绘制，
 *   不再依赖运行时纹理上传。旧「贴图悬空引用 → 运行时补 disc」自愈方案之所以反复复发，
 *   根因正在于此——useGraphicsFallback 是全局共享开关、_discSF 是进程级缓存，
 *   任一纹理上传失败即永久连坐，把 null 原样赋回 spriteFrame 造成全场隐形。
 * 加法混合不再自建 Material（2026-09-05 根修）：手写 blendState 覆盖挂到普通 Material 上
 * 会整体替换 BlendTarget、实测渲染成不透明方块——改由各调用点直接设置 Sprite 的
 * srcBlendFactor/dstBlendFactor（引擎原生路径，_updateBlendFunc 会在材质实例上正确叠加）。
 */
export class RuntimeTex {
    /** 手动强制回退开关：个别原生平台纹理异常时置 true（生成入口同步联动） */
    static useGraphicsFallback = false;

    private static _glowTex: Texture2D | null | undefined;
    private static _streakTex: Texture2D | null | undefined;
    private static _glowSF: SpriteFrame | null | undefined;
    private static _smokeSF: SpriteFrame | null | undefined;

    /** glow 纹理（失败返回 null，并自动置 useGraphicsFallback） */
    static glowTexture(): Texture2D | null {
        if (this._glowTex === undefined) {
            this._glowTex = this.useGraphicsFallback
                ? null
                : makeTexture(GLOW_SIZE, GLOW_SIZE, buildGlowData(GLOW_SIZE));
        }
        return this._glowTex;
    }

    /** glow SpriteFrame（供 Sprite 消费） */
    static glow(): SpriteFrame | null {
        if (this._glowSF === undefined) {
            const tex = this.glowTexture();
            if (!tex) {
                this._glowSF = null;
            } else {
                const sf = new SpriteFrame();
                sf.texture = tex;
                this._glowSF = sf;
            }
        }
        return this._glowSF;
    }

    /** streak 纹理（供 MotionStreak.texture 直接使用；失败返回 null 走内置贴图兜底） */
    static streakTexture(): Texture2D | null {
        if (this._streakTex === undefined) {
            this._streakTex = this.useGraphicsFallback
                ? null
                : makeTexture(STREAK_W, STREAK_H, buildStreakData());
        }
        return this._streakTex;
    }

    /** smoke SpriteFrame（供烟团 Sprite 消费；失败返回 null 由调用方退 glow） */
    static smoke(): SpriteFrame | null {
        if (this._smokeSF === undefined) {
            const tex = this.useGraphicsFallback
                ? null
                : makeTexture(SMOKE_SIZE, SMOKE_SIZE, buildSmokeData());
            if (!tex) {
                this._smokeSF = null;
            } else {
                const sf = new SpriteFrame();
                sf.texture = tex;
                this._smokeSF = sf;
            }
        }
        return this._smokeSF;
    }

}
