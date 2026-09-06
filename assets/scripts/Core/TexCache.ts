/**
 * 资源贴图缓存加载器（TexCache）：resources/textures 下生成图 → SpriteFrame 的统一入口。
 *
 * 约定（与 AudioManager 三层保障同源的设计取向）：
 *  - 进程级缓存：同名贴图只 load 一次（含失败结果——失败也缓存，避免弹窗重建期反复打 IO）；
 *  - 优雅降级：回调恒以 SpriteFrame | null 收尾，null = 加载失败，调用方走各自的矢量兜底路径
 *    （城堡=矢量要塞 / 敌人=色块+剪影 / 卡面=UiKit 稀有度边框），绝不阻塞游戏逻辑；
 *  - 路径约定：loadTex('enemy_boss') ← assets/resources/textures/enemy_boss.png
 *    （Cocos 约定 texture 的 spriteFrame 子资源路径 = '<资源路径>/spriteFrame'）。
 */
import { resources, SpriteFrame } from 'cc';

/** 进程级缓存：路径 → 已解析 SpriteFrame（null = 已确认失败，不再重试） */
const CACHE = new Map<string, SpriteFrame | null>();
/** 加载中挂起的回调队列：同一贴图并发请求只发起一次 IO */
const PENDING = new Map<string, Array<(sf: SpriteFrame | null) => void>>();

/**
 * 加载 textures 下贴图的 SpriteFrame（缓存 + 幂等；失败回调 null，由调用方降级）。
 * @param name 资源名（不含扩展名），如 'turret_forge_castle'
 */
export function loadTex(name: string, cb: (sf: SpriteFrame | null) => void): void {
    const hit = CACHE.get(name);
    if (hit !== undefined) {
        cb(hit);
        return;
    }
    const queue = PENDING.get(name);
    if (queue) {
        queue.push(cb); // 已在加载中：挂队即可
        return;
    }
    PENDING.set(name, [cb]);
    resources.load(`textures/${name}/spriteFrame`, SpriteFrame, (err, sf) => {
        const frame = err || !sf || !sf.isValid ? null : sf;
        CACHE.set(name, frame);
        const waiters = PENDING.get(name) ?? [];
        PENDING.delete(name);
        for (const w of waiters) {
            w(frame);
        }
        if (frame === null) {
            console.warn(`[TexCache] 贴图加载失败，走矢量兜底：textures/${name}（${err?.message ?? '空帧'}）`);
        }
    });
}

/** 已注册贴图名清单（selfcheck-icon-ui 校验文件落盘一致性用；与 assets/resources/textures 对齐） */
export const TEX_NAMES = [
    'turret_forge_castle',
    'enemy_normal', 'enemy_shield', 'enemy_speed', 'enemy_slime', 'enemy_boss',
    'card_frame_common', 'card_frame_rare', 'card_frame_epic',
] as const;
