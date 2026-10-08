"""Сборка SVG знака Sennit. Нужен fontTools: pip install fonttools.
Запуск: python build_logo.py <путь к Unbounded.ttf (variable)>. Пишет SVG рядом со скриптом.
Знак — геометрия (не шрифт); wordmark — контуры Unbounded 500 (OFL), текст в SVG не зависит от шрифтов."""
import sys, pathlib
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = pathlib.Path(__file__).parent
DARK_BG_INK = '#EDEBE6'   # graphite-100: знак на тёмном
LIGHT_BG_INK = '#0E0E0F'  # graphite-900: знак на светлом
TILE_DARK = '#141416'     # graphite-850
TILE_LIGHT = '#F5F5F2'    # graphite-50

# Знак: S из трёх полос (три сервиса, сплетённые в один шнур). Сетка 64, штрих 9, торцы прямые.
# Три полосы; на изгибах горизонтальный просвет 3,5 («нить проходит под нитью») вырезается маской.
GLYPH = 'M50 14.5H25A8.75 8.75 0 0 0 25 32H39A8.75 8.75 0 0 1 39 49.5H14'
MASK = ('<mask id="g" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
        '<rect width="64" height="64" fill="#fff"/><rect x="0" y="21.5" width="64" height="3.5"/>'
        '<rect x="0" y="39" width="64" height="3.5"/></mask>')
def glyph(color, extra=''):
    return (f'<defs>{MASK}</defs><path d="{GLYPH}" fill="none" stroke="{color}" stroke-width="9" '
            f'stroke-linecap="butt" stroke-linejoin="miter" mask="url(#g)"{extra}/>')

def svg(w, h, body, title, vb=None):
    vb = vb or f'0 0 {w} {h}'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')

def wordmark_path(font, text, tracking_em=-0.02):
    gs = font.getGlyphSet(); cmap = font.getBestCmap(); upm = font['head'].unitsPerEm
    x = 0; parts = []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: f'{v:.1f}'.rstrip('0').rstrip('.'))
        tp = TransformPen(pen, (1, 0, 0, -1, x, 0))  # переворот оси Y
        gs[name].draw(tp)
        parts.append(pen.getCommands())
        x += gs[name].width + tracking_em * upm
    return ' '.join(parts), x - tracking_em * upm, upm

def main(ttf):
    font = instantiateVariableFont(TTFont(ttf), {'wght': 500})
    d, width, upm = wordmark_path(font, 'Sennit')
    cap = font['OS/2'].sCapHeight or 700
    asc = cap + 40; desc = 40  # поля вокруг для t/i
    # --- знак
    for name, ink in (('mark', DARK_BG_INK), ('mark-light', LIGHT_BG_INK)):
        (OUT / f'{name}.svg').write_text(svg(64, 64, glyph(ink), 'Sennit'), 'utf-8')
    # --- иконка приложения (плитка 64, радиус 14)
    for name, tile, ink in (('app-icon', TILE_DARK, DARK_BG_INK), ('app-icon-light', TILE_LIGHT, LIGHT_BG_INK)):
        body = f'<rect width="64" height="64" rx="14" fill="{tile}"/>' + glyph(ink)
        (OUT / f'{name}.svg').write_text(svg(64, 64, body, 'Sennit'), 'utf-8')
    # --- wordmark: viewBox по контурам, базовая линия y=cap
    pad = 0
    wm_h = cap + 20  # t/i не уходят ниже базовой линии
    for name, ink in (('wordmark', DARK_BG_INK), ('wordmark-light', LIGHT_BG_INK)):
        body = f'<path transform="translate(0 {cap})" d="{d}" fill="{ink}"/>'
        (OUT / f'{name}.svg').write_text(svg(round(width), wm_h, body, 'Sennit', f'0 0 {round(width)} {wm_h}'), 'utf-8')
    # --- lockup: знак (S ~ 1.9 высоты капители) + wordmark; зазор = ширина штриха знака
    glyph_box = 40.5  # ширина S в сетке 64: 11.75..52.25
    s_h = 44.0        # высота S: 10..54
    target_h = cap * 1.9
    k = target_h / s_h
    gap = 9 * k * 1.6
    gx = -11.75 * k
    gy_top = -10 * k
    lock_w = round(glyph_box * k + gap + width)
    lock_h = round(target_h)
    wm_x = glyph_box * k + gap
    wm_y = (target_h - cap) / 2 + cap  # центр капители по центру знака
    for name, ink in (('lockup', DARK_BG_INK), ('lockup-light', LIGHT_BG_INK)):
        body = (f'<g transform="translate({gx:.1f} {gy_top:.1f}) scale({k:.4f})">{glyph(ink)}</g>'
                f'<path transform="translate({wm_x:.1f} {wm_y:.1f})" d="{d}" fill="{ink}"/>')
        (OUT / f'{name}.svg').write_text(svg(lock_w, lock_h, body, 'Sennit'), 'utf-8')
    print('ok', width, cap, lock_w, lock_h)

if __name__ == '__main__':
    main(sys.argv[1])
