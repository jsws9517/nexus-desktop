# App icon

`../icon.svg` is the source of truth. `npm run icon` renders it at **1024px** and
derives every platform asset (`build/icon.ico`, `build/icon.icns`,
`build/icon.png`, `build/icons/*.png`).

## Why the design looks the way it does

The previous icon (archived at `archive/icon-legacy-512.svg`) had six problems,
and each one is addressed here:

| 旧问题 | 现方案 |
|---|---|
| 512 全出血直角方块，被系统圆角裁切 | 1024 画布 + 824 安全区 + squircle（r=186），四角真透明 |
| 用 `<text>` 当 logo，依赖 Arial 字形 | 纯几何路径，无字体依赖 |
| 10+ 个装饰元素（角标/走线/扫描线/基线） | 1 个主体 + 2 个端点节点 |
| 2 层高斯发光，小尺寸发糊 | 0 层滤镜 |
| 斜向四色渐变，右半部对比度不足 | 单色系垂直渐变，整体亮度一致 |
| 构图重心偏高 12px、光晕与主字错位 10px | 亮部包围盒中心 = 画布中心（各尺寸实测） |

The mark is one continuous path (`M 366 696 → 366 328 → 658 696 → 658 328`)
with `linejoin="bevel"`: the N is drawn as a single connection route from one
agent node to the other. `bevel` rather than `miter` matters — the diagonal meets
the stems at a 38° interior angle, so a miter join would grow a ~3× spike past
the glyph box.

## Regenerating the comparison sheet
```
electron scripts/render-icon-drafts.cjs
```

Renders `../icon.svg` (A) plus the two alternates into `preview/`, then captures
`preview/compare.png` — 深色 / 浅色 / 中性灰三种底色 × 16→128px 真实缩放。

## Tray / menu-bar icon

The tray is a different surface from the app icon, so it has its own glyphs
(`tray-dark.svg`, `tray-light.svg`): no squircle tile (at 16px the tile is a
~13px near-black square that disappears into a dark taskbar) and a 2px-equivalent
stroke instead of the mark's 1.3px hairline. Same N route, `stroke-linejoin="bevel"`.

`npm run icon` renders both at 256px, emits 16/24/32px PNGs to `build/tray/` for
inspection, and writes `build/tray-icon.dataurl.txt` with the two constants that
`src/main/index.ts` embeds (the packaged app ships only `dist/`, so the tray cannot
read `build/` at runtime). Re-paste that file whenever the glyph changes.

Tinting: Windows/Linux get the variant matching the taskbar (Windows uses
`shouldUseDarkColorsForSystemIntegratedUI`, since the taskbar follows the *system*
theme while apps can be set independently); macOS gets `tray-light.svg` as a
template image, so the OS recolours the alpha channel per menu-bar appearance.

## Files

- `B-hub.svg`, `C-lettermark.svg` — the two rejected directions, kept for
  reference. Palette and safe area are shared with the chosen design, so they can
  be re-evaluated by swapping `../icon.svg`.
- `tray-dark.svg`, `tray-light.svg` — tray/menu-bar glyphs (see above); not app
  icons, do not swap them into `../icon.svg`.
- `archive/icon-legacy-512.svg` — the old 512px text-based icon.
- `compare.html` — generator output for the sheet; edit `scripts/render-icon-drafts.cjs`
  to change layout.

## If small sizes ever regress

16/24px are the hard constraint. The pipeline downscales one master, so any
future decorative detail must survive a 1.3px stroke. If it does not, add a
hand-tuned 16px/24px SVG and have `make-icon.cjs` use it for those sizes instead
of resampling.
