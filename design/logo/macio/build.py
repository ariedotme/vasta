# Macio, refined: a soft tile with a V notch from the top, every corner a true fillet. Variants test
# what reads less like a tooth: tighter outer radius, a deeper notch, a lifted optical centre.
import math, sys
sys.path.insert(0, 'b')
from build import rounded_polygon
def svg(d, title='Vasta'): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><title>{title}</title><path d="{d}"/></svg>\n'
def tile(size=200, R=52, top_half=40, angle=75, rc=12, rt=14, lift=0):
    x0, y0 = 128 - size / 2, 128 - size / 2 - lift
    x1, y1 = x0 + size, y0 + size
    tip_y = y0 + top_half * math.tan(math.radians(angle))
    pts = [(x0, y0), (128 - top_half, y0), (128, tip_y), (128 + top_half, y0), (x1, y0), (x1, y1), (x0, y1)]
    return rounded_polygon(pts, [R, rc, rt, rc, R, R, R]), tip_y
V = {
    'macio-1': dict(R=52, top_half=40, angle=75, rc=12, rt=14),            # as chosen
    'macio-2': dict(R=46, top_half=42, angle=75, rc=12, rt=14, lift=2),    # tighter corners, a hair deeper
    'macio-3': dict(R=46, top_half=46, angle=75, rc=14, rt=16, lift=2),    # wider, deeper V: the letter leads
    'macio-4': dict(R=40, top_half=44, angle=75, rc=12, rt=14, lift=2),    # squarer: more tile, less tooth
}
for name, kw in V.items():
    d, tip = tile(**kw)
    open(f'macio/{name}.svg', 'w').write(svg(d))
    print(name, 'tip', round(tip, 1))

# Small-size cut (favicon, 16–32 px): a wider notch with a rounder tip, so the gap stays open when
# pixels are few. Slightly steeper than the master on purpose (70°): at 16 px nobody sees the angle,
# everybody sees whether the V is still there.
small, tip = tile(R=36, top_half=54, angle=70, rc=14, rt=22, lift=2)
open('macio/macio-small.svg', 'w').write(svg(small))
print('small tip', round(tip, 1))
