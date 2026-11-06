# "vasta" as outlines from Manrope (SIL OFL 1.1), at a chosen weight, tracked a little tighter.
# Usage: python wordmark.py <font.ttf> <weight> <tracking em> <out.svg>
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
src, weight, tracking, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
font = instantiateVariableFont(TTFont(src), {'wght': weight})
gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font['hmtx']
upm = font['head'].unitsPerEm
text = 'vasta'
paths, x = [], 0
xs = []
for ch in text:
    name = cmap[ord(ch)]
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))  # flip y: SVG grows downwards
    paths.append(pen.getCommands())
    xs.append(x)
    x += hmtx[name][0] + tracking * upm
# Bounds of the whole word.
bp = BoundsPen(gs)
for ch, ox in zip(text, xs):
    gs[cmap[ord(ch)]].draw(TransformPen(bp, (1, 0, 0, -1, ox, 0)))
x0, y0, x1, y1 = bp.bounds
xh = font['OS/2'].sxHeight
d = ' '.join(paths)
w, h = x1 - x0, y1 - y0
svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.0f} {y0:.0f} {w:.0f} {h:.0f}" data-x-height="{xh}"><title>Vasta</title><path d="{d}"/></svg>\n'
open(out, 'w').write(svg)
print(out, 'bbox', round(x0), round(y0), round(w), round(h), 'x-height', xh, 'upm', upm)
