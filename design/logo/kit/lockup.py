# Lockups: the mark and the wordmark, built from the master SVGs.
#   horizontal: the word's x-height centred on the tile, a gap of 0.28 tile between them
#   stacked:    the word centred under the mark
import re, sys
mark_svg = open('macio/vasta-mark.svg').read()
MARK = re.search(r' d="([^"]+)"', mark_svg).group(1)
TILE_TOP, TILE_BOTTOM, TILE_LEFT, TILE_RIGHT = 26, 226, 28, 228  # the tile inside the 256 canvas (lifted 2)
TILE = TILE_BOTTOM - TILE_TOP

def word(weight):
    s = open(f'kit/word-{weight}.svg').read()
    vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', s).group(1).split()]
    return re.search(r' d="([^"]+)"', s).group(1), vb, float(re.search(r'data-x-height="([^"]+)"', s).group(1))

def horizontal(weight, color='#000'):
    d, (wx, wy, ww, wh), xh = word(weight)
    k = TILE * 0.60 / xh                      # x-height = 60% of the tile
    baseline = (TILE_TOP + TILE_BOTTOM) / 2 + xh * k / 2
    gap = TILE * 0.28
    tx = TILE_RIGHT + gap - wx * k
    width = TILE_RIGHT + gap + ww * k + TILE_LEFT
    body = f'<path d="{MARK}"/><path transform="translate({tx:.2f} {baseline:.2f}) scale({k:.5f})" d="{d}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.1f} 256" fill="{color}"><title>Vasta</title>{body}</svg>\n'

def stacked(weight, color='#000'):
    d, (wx, wy, ww, wh), xh = word(weight)
    k = TILE * 0.42 / xh
    word_w = ww * k
    width = max(256, word_w + 2 * TILE_LEFT)
    mx = (width - 256) / 2
    baseline = TILE_BOTTOM + TILE * 0.22 + (-wy) * k   # the word's ascender starts a gap below the tile
    height = baseline + (wy + wh) * k + TILE_LEFT
    tx = (width - word_w) / 2 - wx * k
    body = f'<path transform="translate({mx:.2f} 0)" d="{MARK}"/><path transform="translate({tx:.2f} {baseline:.2f}) scale({k:.5f})" d="{d}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.1f} {height:.1f}" fill="{color}"><title>Vasta</title>{body}</svg>\n'

if __name__ == '__main__':
    for w in sys.argv[1:]:
        open(f'kit/lockup-h-{w}.svg', 'w').write(horizontal(w))
        open(f'kit/lockup-s-{w}.svg', 'w').write(stacked(w))
