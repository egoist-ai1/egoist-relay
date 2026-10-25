"""Сборка SVG знака «Береста». Нужен fontTools (+ brotli для woff2): pip install fonttools brotli.
Запуск: python build_logo.py public/fonts/unbounded-cyrillic.woff2 (нужна кириллица Unbounded). Пишет SVG рядом со скриптом.
Знак — геометрия (не шрифт); wordmark — контуры Unbounded 500 (OFL), текст в SVG не зависит от шрифтов."""
import sys, pathlib
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = pathlib.Path(__file__).parent
NAME = 'Береста'
DARK_BG_INK = '#EDEBE6'   # graphite-100: знак на тёмном
LIGHT_BG_INK = '#0E0E0F'  # graphite-900: знак на светлом
TILE_DARK = '#141416'     # graphite-850
TILE_LIGHT = '#F5F5F2'    # graphite-50

# Знак «Береста»: три штриха берёзовой коры, расставленных лесенкой, как реплики диалога; нижний уходит хвостиком.
# Сетка 64, штрих 8, просвет 6, радиусы 4. Исходные координаты центрированы на (32, 32) и сжаты к центру в S раз:
# вокруг знака остаётся поле плитки. Сам штрих и просвет после сжатия остаются кратны сетке только приблизительно.
S = 0.9

def _n(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.')

def _p(v):
    return _n(32 + (v - 32) * S)

def _r(v):
    return _n(v * S)

def _pill(x1, x2, y):
    r = _r(4)
    return (f'M{_p(x1 + 4)} {_p(y)}H{_p(x2 - 4)}A{r} {r} 0 0 1 {_p(x2 - 4)} {_p(y + 8)}'
            f'H{_p(x1 + 4)}A{r} {r} 0 0 1 {_p(x1 + 4)} {_p(y)}Z')

def _tail_bar(x1, x2, y):
    r, rc = _r(4), _r(3)
    return (f'M{_p(x1 + 3)} {_p(y)}H{_p(x2 - 4)}A{r} {r} 0 0 1 {_p(x2 - 4)} {_p(y + 8)}'
            f'H{_p(x1 + 12)}L{_p(x1)} {_p(y + 15)}V{_p(y + 3)}A{rc} {rc} 0 0 1 {_p(x1 + 3)} {_p(y)}Z')

GLYPH = ' '.join((_pill(9, 39, 10.5), _pill(25, 55, 24.5), _tail_bar(12, 49, 38.5)))
GLYPH_X0, GLYPH_X1 = _p(9), _p(55)
GLYPH_Y0, GLYPH_Y1 = _p(10.5), _p(53.5)

def glyph(color):
    return f'<path d="{GLYPH}" fill="{color}"/>'

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
        gs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))  # переворот оси Y
        parts.append(pen.getCommands())
        x += gs[name].width + tracking_em * upm
    return ' '.join(p for p in parts if p), x - tracking_em * upm, upm

def main(font_path):
    font = instantiateVariableFont(TTFont(font_path), {'wght': 500})
    d, width, upm = wordmark_path(font, NAME)
    cap = font['OS/2'].sCapHeight or 700
    desc = round(upm * 0.24)  # «g» уходит ниже базовой линии
    for name, ink in (('mark', DARK_BG_INK), ('mark-light', LIGHT_BG_INK)):
        (OUT / f'{name}.svg').write_text(svg(64, 64, glyph(ink), NAME), 'utf-8')
    # иконка приложения: плитка 64, радиус 14
    for name, tile, ink in (('app-icon', TILE_DARK, DARK_BG_INK), ('app-icon-light', TILE_LIGHT, LIGHT_BG_INK)):
        body = f'<rect width="64" height="64" rx="14" fill="{tile}"/>' + glyph(ink)
        (OUT / f'{name}.svg').write_text(svg(64, 64, body, NAME), 'utf-8')
    # wordmark: базовая линия y=cap, снизу место под выносной элемент «g»
    wm_w, wm_h = round(width), cap + desc
    for name, ink in (('wordmark', DARK_BG_INK), ('wordmark-light', LIGHT_BG_INK)):
        body = f'<path transform="translate(0 {cap})" d="{d}" fill="{ink}"/>'
        (OUT / f'{name}.svg').write_text(svg(wm_w, wm_h, body, NAME), 'utf-8')
    # lockup: высота знака = 1,9 капители; зазор = 1,6 полосы знака
    glyph_x0, glyph_y0 = float(GLYPH_X0), float(GLYPH_Y0)
    glyph_w, glyph_h = float(GLYPH_X1) - glyph_x0, float(GLYPH_Y1) - glyph_y0
    k = cap * 1.9 / glyph_h
    gap = 8 * k * 1.6
    lock_w = round(glyph_w * k + gap + width)
    lock_h = round(glyph_h * k)
    wm_x = glyph_w * k + gap
    # центр капители — по центру трёх штрихов (без хвостика): от верха до низа нижнего штриха
    bars_center = (float(_p(10.5)) + float(_p(46.5))) / 2 - glyph_y0
    wm_y = bars_center * k + cap / 2
    for name, ink in (('lockup', DARK_BG_INK), ('lockup-light', LIGHT_BG_INK)):
        body = (f'<g transform="translate({-glyph_x0 * k:.1f} {-glyph_y0 * k:.1f}) scale({k:.4f})">{glyph(ink)}</g>'
                f'<path transform="translate({wm_x:.1f} {wm_y:.1f})" d="{d}" fill="{ink}"/>')
        (OUT / f'{name}.svg').write_text(svg(lock_w, max(lock_h, round(wm_y + desc)), body, NAME), 'utf-8')
    print('ok', round(width), cap, lock_w, lock_h)

if __name__ == '__main__':
    main(sys.argv[1])
