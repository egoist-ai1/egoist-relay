"""Растровые ассеты Egoist Social из геометрии знака (build_logo.py). Нужны Pillow, fontTools, brotli, resvg-py.
Запуск из корня проекта: python docs/brand/build_assets.py
Пишет иконки Tauri (png/ico/icns), установщика, веб-клиента (favicon, PWA, apple-touch, mstile) и картинки NSIS.
Подписи NSIS — контуры Unbounded 500 и Onest 400: результат не зависит от шрифтов системы."""
import io, pathlib, shutil, sys
import resvg_py
from PIL import Image
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

BRAND = pathlib.Path(__file__).parent
ROOT = BRAND.parent.parent
sys.path.insert(0, str(BRAND))
import build_logo as logo  # noqa: E402

INK_DARK, INK_LIGHT = logo.DARK_BG_INK, logo.LIGHT_BG_INK
TILE_DARK, TILE_LIGHT = logo.TILE_DARK, logo.TILE_LIGHT
NAME = logo.NAME
CAPTION = ('Telegram, X и Instagram', 'в одном окне')


def render(svg, w, h=None):
    data = resvg_py.svg_to_bytes(svg_string=svg, width=w, height=h or w)
    return Image.open(io.BytesIO(bytes(data))).convert('RGBA')


def tile_svg(rounded=True, scale=1.0, dot=False):
    """Плитка 64 со знаком. rounded=False — в край (apple-touch, mstile); scale < 1 уменьшает знак к центру."""
    rx = ' rx="14"' if rounded else ''
    glyph = logo.glyph(INK_DARK)
    if scale != 1.0:
        glyph = f'<g transform="translate({32 * (1 - scale):.2f} {32 * (1 - scale):.2f}) scale({scale})">{glyph}</g>'
    # значок непрочитанного: кольцо цвета плитки отделяет точку от знака
    badge = (f'<circle cx="54" cy="10" r="9" fill="{INK_DARK}" stroke="{TILE_DARK}" stroke-width="3"/>'
             f'<circle cx="54" cy="10" r="4.5" fill="{TILE_DARK}"/>') if dot else ''
    return logo.svg(64, 64, f'<rect width="64" height="64"{rx} fill="{TILE_DARK}"/>{glyph}{badge}', NAME)


def save_png(svg, path, size, rgb=False):
    im = render(svg, size)
    (im.convert('RGB') if rgb else im).save(path, optimize=True)


def save_ico(svg, path, sizes):
    # каждый размер рисуется отдельно, а не уменьшается из большого: мелкие размеры остаются чёткими
    images = [render(svg, s) for s in sizes]
    images[-1].save(path, format='ICO', sizes=[(s, s) for s in sizes], append_images=images[:-1])


def save_icns(svg, path):
    sizes = (16, 32, 64, 128, 256, 512, 1024)
    images = [render(svg, s) for s in sizes]
    images[-1].save(path, format='ICNS', append_images=images[:-1])


# --- текст контурами: Unbounded для имени, Onest для подписи (кириллица и латиница в разных файлах) ---

def load(path, wght):
    return instantiateVariableFont(TTFont(path), {'wght': wght})


def text_path(fonts, text, size, x0=0.0, y0=0.0, tracking_em=0.0):
    """Контур строки: шрифт для каждого символа — первый, где он есть. Возвращает (d, ширина в px)."""
    parts, x = [], 0.0
    for ch in text:
        font = next(f for f in fonts if ord(ch) in f.getBestCmap())
        gs, upm = font.getGlyphSet(), font['head'].unitsPerEm
        k = size / upm
        name = font.getBestCmap()[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: f'{v:.2f}'.rstrip('0').rstrip('.'))
        gs[name].draw(TransformPen(pen, (k, 0, 0, -k, x0 + x, y0)))
        parts.append(pen.getCommands())
        x += (gs[name].width + tracking_em * upm) * k
    return ' '.join(p for p in parts if p), x


def nsis_header(unbounded):
    """150×57, светлая шапка мастера: имя в две строки слева, плитка справа."""
    w, h = 150, 57
    size = 15
    cap = unbounded['OS/2'].sCapHeight / unbounded['head'].unitsPerEm * size
    gap = 6
    top = (h - (2 * cap + gap)) / 2 + cap
    d1, _ = text_path([unbounded], 'Egoist', size, 12, top, -0.02)
    d2, _ = text_path([unbounded], 'Social', size, 12, top + cap + gap, -0.02)
    t = 34
    tile = (f'<g transform="translate({w - 12 - t} {(h - t) / 2}) scale({t / 64})">'
            f'<rect width="64" height="64" rx="14" fill="{TILE_DARK}"/>{logo.glyph(INK_DARK)}</g>')
    body = (f'<rect width="{w}" height="{h}" fill="{TILE_LIGHT}"/>'
            f'<path d="{d1} {d2}" fill="{INK_LIGHT}"/>{tile}')
    return logo.svg(w, h, body, NAME), w, h


def nsis_sidebar(unbounded, onest):
    """164×314, тёмная боковая панель: плитка, имя, линия, подпись."""
    w, h = 164, 314
    t = 64
    tile = (f'<g transform="translate({(w - t) / 2} 56)">'
            f'<rect width="64" height="64" rx="14" fill="{logo.TILE_DARK}" stroke="#2A2A2E" stroke-width="1"/>'
            f'{logo.glyph(INK_DARK)}</g>')
    name_d, name_w = text_path([unbounded], NAME, 13.5, 0, 0, -0.02)
    name = f'<path transform="translate({(w - name_w) / 2:.2f} 156)" d="{name_d}" fill="{INK_DARK}"/>'
    rule = f'<rect x="20" y="174" width="{w - 40}" height="1" fill="#2A2A2E"/>'
    lines = []
    for i, line in enumerate(CAPTION):
        d, lw = text_path(onest, line, 10.5)
        lines.append(f'<path transform="translate({(w - lw) / 2:.2f} {196 + i * 15})" d="{d}" fill="#8E8C87"/>')
    body = f'<rect width="{w}" height="{h}" fill="#0E0E0F"/>{tile}{name}{rule}{"".join(lines)}'
    return logo.svg(w, h, body, NAME), w, h


def main():
    tile = tile_svg()
    square = tile_svg(rounded=False)
    icons, public = ROOT / 'tauri' / 'icons', ROOT / 'public'

    # Tauri: окно, панель задач, установщик NSIS
    for target in (icons, icons / 'macos'):
        for size, name in ((32, '32x32'), (64, '64x64'), (128, '128x128'), (256, '128x128@2x'), (512, 'icon')):
            save_png(tile, target / f'{name}.png', size)
        save_ico(tile, target / 'icon.ico', (16, 24, 32, 48, 64, 256))
        save_icns(tile, target / 'icon.icns')
    save_ico(tile, ROOT / 'installer' / 'assets' / 'icon.ico', (16, 24, 32, 48, 64, 256))

    # веб-клиент: favicon, PWA (плитка со скруглением), maskable/square и apple-touch (в край), mstile (знак мельче)
    (public / 'favicon.svg').write_text(tile, 'utf-8')
    (public / 'favicon-unread.svg').write_text(tile_svg(dot=True), 'utf-8')
    save_png(tile, public / 'favicon-16x16.png', 16)
    save_png(tile, public / 'favicon-32x32.png', 32)
    save_ico(tile, public / 'favicon.ico', (16, 24, 32, 48, 64, 128, 256))
    for size in (192, 512):
        save_png(tile, public / f'icon-{size}.png', size)
    for size in (192, 384, 512):
        save_png(tile, public / f'icon-{size}x{size}.png', size)
        save_png(tile, public / f'icon-dev-{size}x{size}.png', size)
        save_png(square, public / f'icon-square-{size}x{size}.png', size, rgb=True)
        save_png(square, public / f'icon-square-dev-{size}x{size}.png', size, rgb=True)
    save_png(square, public / 'apple-touch-icon.png', 180, rgb=True)
    save_png(square, public / 'apple-touch-icon-dev.png', 180, rgb=True)
    save_png(tile_svg(rounded=False, scale=0.62), public / 'mstile-150x150.png', 150, rgb=True)

    # установщик: SVG знака и имени берутся из docs/brand как есть
    for name in ('mark', 'mark-light', 'wordmark', 'wordmark-light'):
        shutil.copyfile(BRAND / f'{name}.svg', ROOT / 'installer' / 'ui' / f'{name}.svg')

    # NSIS: 24-битные BMP без альфы
    unbounded = load(ROOT / 'public' / 'fonts' / 'unbounded-latin.woff2', 500)
    onest = [load(ROOT / 'public' / 'fonts' / f'onest-{s}-wght-normal.woff2', 400) for s in ('latin', 'cyrillic')]
    for (svg, w, h), name in ((nsis_header(unbounded), 'nsis-header'), (nsis_sidebar(unbounded, onest), 'nsis-sidebar')):
        render(svg, w, h).convert('RGB').save(icons / f'{name}.bmp')
    print('ok')


if __name__ == '__main__':
    main()
