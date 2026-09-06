# -*- coding: utf-8 -*-
"""
白底抠图 v3-final：新生成图（Gemini）为纯白背景全尺寸 PNG，键出白底 → 内容 bbox 裁剪
→ 按游戏内版位等比缩放 → 回写正式 PNG（RGBA）。

  1) 白键控：min(r,g,b) ≥ 238（近纯白，容 JPEG/PNG 压缩噪声）为候选背景；
  2) 边界连通泛洪：只剥离与图像四边连通的白底（立绘内部的高光/浅色不透）；
  3) 去晕：背景 2px 邻接、min(r,g,b) ≥ 200 的过渡像素一并置透明（吃软边）；
  4) bbox 裁剪（留 2px 余量）+ 目标宽等比缩放（LANCZOS）+ 写回。

已带真 alpha 的图（如 common/rare 卡框）自动跳过键控、只做裁剪缩放。
用法：python tools/cutout-checkerboard.py [--dry]   源：assets/resources/textures/*.png
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TEX = ROOT / 'assets' / 'resources' / 'textures'
DRY = '--dry' in sys.argv

# 每张图的目标显示宽（px）：与游戏内版位匹配 + 控制包体
TARGET_W = {
    'turret_forge_castle.png': 340,
    'enemy_normal.png': 220,
    'enemy_shield.png': 220,
    'enemy_speed.png': 220,
    'enemy_slime.png': 220,
    'enemy_boss.png': 260,
    'card_frame_common.png': 480,
    'card_frame_rare.png': 480,
    'card_frame_epic.png': 480,
}

WHITE_KEY = 238   # 白键阈值（逐通道）
HALO_KEY = 200    # 去晕阈值（背景邻接带）


def cutout(name: str) -> None:
    path = TEX / name
    img = Image.open(path)
    has_alpha = img.mode == 'RGBA' and (np.asarray(img)[:, :, 3] < 250).any()
    arr = np.asarray(img.convert('RGBA'))
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3].astype(np.int16)

    if has_alpha:
        print(f'  {name}: 已带真 alpha，跳过键控（仅裁剪缩放）')
        alpha = arr[:, :, 3].copy()
    else:
        whiteish = (rgb.min(axis=2) >= WHITE_KEY)
        bg = np.zeros((h, w), dtype=bool)
        frontier = np.zeros((h, w), dtype=bool)
        frontier[0, :] = whiteish[0, :]
        frontier[-1, :] = whiteish[-1, :]
        frontier[:, 0] |= whiteish[:, 0]
        frontier[:, -1] |= whiteish[:, -1]
        while frontier.any():
            bg |= frontier
            grow = np.zeros((h, w), dtype=bool)
            grow[1:, :] |= frontier[:-1, :]
            grow[:-1, :] |= frontier[1:, :]
            grow[:, 1:] |= frontier[:, :-1]
            grow[:, :-1] |= frontier[:, 1:]
            frontier = grow & whiteish & ~bg
        # 去晕：背景 2px 邻接、较白（≥HALO_KEY）的过渡像素一并置透明
        loose = (rgb.min(axis=2) >= HALO_KEY) & ~bg
        for _ in range(2):
            g = np.zeros((h, w), dtype=bool)
            g[1:, :] |= bg[:-1, :]
            g[:-1, :] |= bg[1:, :]
            g[:, 1:] |= bg[:, :-1]
            g[:, :-1] |= bg[:, 1:]
            new = g & loose & ~bg
            if not new.any():
                break
            bg |= new
            loose &= ~new
        alpha = np.where(bg, 0, 255).astype(np.uint8)
        print(f'  {name}: 白底剥离 {bg.mean() * 100:.0f}%', end='')

    rgba = np.dstack([arr[:, :, :3].astype(np.uint8), alpha])
    keep = alpha > 0
    if not keep.any():
        print(f'  !! {name}: 没有检出前景，跳过')
        return
    ys_i, xs_i = np.where(keep)
    t, b = max(0, ys_i.min() - 2), min(h, ys_i.max() + 3)
    l, r = max(0, xs_i.min() - 2), min(w, xs_i.max() + 3)
    out = Image.fromarray(rgba[t:b, l:r])

    tw = TARGET_W.get(name, 256)
    if out.width > tw:
        out = out.resize((tw, max(1, round(out.height * tw / out.width))), Image.LANCZOS)
    print(f' -> {out.width}x{out.height} ({path.stat().st_size // 1024}KB -> '
          f'{len(out.tobytes()) // 1024}KB 未压)')

    if not DRY:
        out.save(path, 'PNG', optimize=True)


def fill_frame_window(name: str) -> None:
    """卡框内部窗填充：框环内的白色窗口与外部白底不连通（键控不会触及），
    从图像中心泛洪近白像素并填充为面板深底 #1E2230——否则卡面文字（浅色）在白窗上不可读。"""
    path = TEX / name
    img = Image.open(path).convert('RGBA')
    arr = np.asarray(img).copy()
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3].astype(np.int16)
    whiteish = (rgb.min(axis=2) >= 232)
    interior = np.zeros((h, w), dtype=bool)
    frontier = np.zeros((h, w), dtype=bool)
    cy, cx = h // 2, w // 2
    frontier[cy - 3:cy + 3, cx - 3:cx + 3] = whiteish[cy - 3:cy + 3, cx - 3:cx + 3]
    while frontier.any():
        interior |= frontier
        grow = np.zeros((h, w), dtype=bool)
        grow[1:, :] |= frontier[:-1, :]
        grow[:-1, :] |= frontier[1:, :]
        grow[:, 1:] |= frontier[:, :-1]
        grow[:, :-1] |= frontier[:, 1:]
        frontier = grow & whiteish & ~interior
    if not interior.any():
        print(f'  {name}: 中心窗非白色，跳过填充')
        return
    arr[interior, :3] = (30, 34, 48)
    arr[interior, 3] = 255
    out = Image.fromarray(arr)
    if out.width > TARGET_W.get(name, 480):
        tw = TARGET_W.get(name, 480)
        out = out.resize((tw, max(1, round(out.height * tw / out.width))), Image.LANCZOS)
    print(f'  {name}: 框窗填充 {interior.mean() * 100:.0f}% -> {out.width}x{out.height}')
    if not DRY:
        out.save(path, 'PNG', optimize=True)


def main() -> None:
    names = sorted(p.name for p in TEX.glob('*.png'))
    print(f'处理 {len(names)} 张：')
    for n in names:
        cutout(n)
    for n in ('card_frame_common.png', 'card_frame_rare.png', 'card_frame_epic.png'):
        fill_frame_window(n)
    print('done' + ('（dry-run 未写盘）' if DRY else '，已回写真 PNG'))


if __name__ == '__main__':
    main()
