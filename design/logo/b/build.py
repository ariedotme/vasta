# B-direction variants: a rounded tile with a V notch from the top, built as one outline whose every
# corner is a true circular fillet (radius per vertex).
import math, sys
f = lambda n: f"{n:.2f}".rstrip('0').rstrip('.')

def rounded_polygon(points, radii):
    n = len(points)
    segs = []
    for i in range(n):
        p0, p1, p2 = points[i - 1], points[i], points[(i + 1) % n]
        r = radii[i]
        v1 = (p0[0] - p1[0], p0[1] - p1[1]); v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1, l2 = math.hypot(*v1), math.hypot(*v2)
        u1 = (v1[0] / l1, v1[1] / l1); u2 = (v2[0] / l2, v2[1] / l2)
        phi = math.acos(max(-1, min(1, u1[0] * u2[0] + u1[1] * u2[1])))
        if r <= 0:
            segs.append((p1, p1, 0, 0)); continue
        t = r / math.tan(phi / 2)
        t = min(t, l1 / 2 - 0.01, l2 / 2 - 0.01) if False else t
        a = (p1[0] + u1[0] * t, p1[1] + u1[1] * t)
        b = (p1[0] + u2[0] * t, p1[1] + u2[1] * t)
        cross = u1[0] * u2[1] - u1[1] * u2[0]
        sweep = 1 if cross < 0 else 0
        segs.append((a, b, r, sweep))
    d = f"M{f(segs[0][1][0])},{f(segs[0][1][1])}"
    for i in range(1, n + 1):
        a, b, r, sweep = segs[i % n]
        d += f" L{f(a[0])},{f(a[1])}"
        if r: d += f" A{f(r)},{f(r)} 0 0 {sweep} {f(b[0])},{f(b[1])}"
    return d + " Z"

def tile(size=200, R=52, top_half=48, tip_y=150, rc=8, rt=10, cx=128):
    x0, y0 = cx - size / 2, 128 - size / 2
    x1, y1 = x0 + size, y0 + size
    pts = [(x0, y0), (cx - top_half, y0), (cx, tip_y), (cx + top_half, y0), (x1, y0), (x1, y1), (x0, y1)]
    rad = [R, rc, rt, rc, R, R, R]
    return rounded_polygon(pts, rad)

def svg(d, title): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><title>{title}</title><path d="{d}"/></svg>\n'

def by_angle(half_angle_deg, depth_or_tip, mode='tip'):
    pass

variants = {
    # name: (R corners, half width of the notch at the top, tip y, edge fillet, tip fillet)
    'b1-soft':     dict(R=52, top_half=40, tip_y=28 + 40 * math.tan(math.radians(75)), rc=12, rt=14),
    'b2-valley':   dict(R=34, top_half=62, tip_y=28 + 62 * math.tan(math.radians(60)), rc=10, rt=10),
    'b3-deep':     dict(R=48, top_half=36, tip_y=28 + 36 * math.tan(math.radians(78.69)), rc=8, rt=8),
    'b4-geometric':dict(R=30, top_half=58, tip_y=28 + 58 * math.tan(math.radians(60)), rc=4, rt=4),
}
for name, kw in variants.items():
    open(f'b/{name}.svg', 'w').write(svg(tile(**kw), 'Vasta'))
    print(name, {k: round(v, 1) for k, v in kw.items()})
