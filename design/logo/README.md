# Vasta logo

The mark is **Macio**: a soft tile, Vasta's object, with a V cut from its top. The tile is the thing
your notes are made of; the V names it without spelling it, and leaves room inside, which is what
*vasta* (wide, vast) means.

Everything final is in [`final/`](final/). The other folders are the way there (concepts, the B
direction's variants, the Macio refinements) and the scripts that build the files.

## Files

| File | Use |
|---|---|
| `final/vasta-mark.svg` | The mark, in ink. The master: every other version comes from it |
| `final/vasta-mark-small.svg` | The mark for 16–32 px (favicons): a wider V with a rounder tip, so it stays open |
| `final/vasta-horizontal.svg` | Mark and wordmark side by side: headers, the README, the site |
| `final/vasta-stacked.svg` | Mark over wordmark: square spaces, splash screens, stickers |
| `final/vasta-wordmark.svg` | The word alone, where the mark is already on screen |
| `final/variants/*-black.svg`, `*-white.svg`, `*-mono-2f6fea.svg` | One-colour versions: black, white (on dark or photos), Vasta blue |
| `final/icons/app-icon.svg`, `icon-512.png`, `icon-192.png`, `apple-touch-icon.png` | App icon (PWA, iOS): ink square, paper mark at 56 % |
| `final/icons/icon-maskable-512.png` | Android maskable icon: the mark inside the 80 % safe circle |
| `final/icons/app-icon-rounded.svg` | The app icon with its corners rounded, for places that show the file as it is |
| `final/icons/favicon.svg` | Favicon: the small cut, ink on light tabs and paper on dark ones |
| `final/icons/favicon.ico` | Fallback favicon (16, 32, 48 px): the small cut on an ink tile |
| `final/presentation.html` | Presentation board with the mark in use (README, app icon, site, terminal, sticker, social) |

All marks are plain paths: no live text, filters, masks or rasters.

## Colour

| Name | HEX | RGB | Use |
|---|---|---|---|
| Ink | `#1F1E1C` | 31 30 28 | The mark, the wordmark, app-icon background |
| Paper | `#F7F6F3` | 247 246 243 | Light backgrounds; the mark on ink |
| Vasta blue | `#2F6FEA` | 47 111 234 | Accent: links, buttons, a one-colour mark where colour helps |

Ink and paper are the app's own (`--color-ink`, `--color-canvas`); the blue is its accent. Ink on
paper is 15.4 : 1. Vasta blue on white is 4.58 : 1 (fine for text, AA), on paper 4.24 : 1 and on ink
3.63 : 1 (fine for the mark and large type, not for small text).

The mark is one colour, always: ink on light, paper (or white) on dark, or Vasta blue on white or
paper. Never two colours in the mark, never a gradient, never a shadow.

## Type

The wordmark is **Manrope Bold (700)**, lowercase, tracked −0.02 em, converted to outlines
([SIL Open Font License 1.1](https://github.com/googlefonts/manrope): use in a logo is allowed).
Its rounded geometry matches the tile's soft corners; 700 balances the heavy mark (600 looked thin
beside it, 800 competed with it). Manrope also suits headings on the site.

In the horizontal lockup the word's x-height is 60 % of the tile and is centred on it; the gap
between them is 28 % of the tile. In the stacked lockup the x-height is 42 % of the tile and the word
sits 22 % of a tile below it. `kit/lockup.py` builds both.

## Clear space and sizes

- **Clear space**: keep a quarter of the tile's height free all around the mark or a lockup (for the
  256-unit master, 50 units).
- **Minimum sizes**: the mark 16 px (below 32 px use `vasta-mark-small.svg`); the horizontal lockup
  96 px wide; the stacked lockup 64 px high. Below that, use the mark alone.

## Don't

- Stretch, slant or rotate the mark, or round its corners differently.
- Change the V: its angle (75°), depth or rounding.
- Set "vasta" in another typeface, or retype it instead of using the outlines.
- Put the mark on a busy photo without a solid field behind it.
- Use the small cut above 32 px (its wider V is only for small sizes).
- Add a second colour, an outline, a gradient or a shadow.

## How it was made and tested

- Concepts (`concepts/concepts.png`): three directions; B (the notched tile) was chosen.
- B variants (`b/variants.png`): soft, valley, deep, geometric; the soft one was chosen.
- Refinement (`macio/refined.png`): tighter outer radius (40 instead of 52), a wider and deeper V,
  the optical centre raised 2 units; every curve a true fillet from one radius family
  (`b/build.py`, `macio/build.py`).
- Tests: the skill's SVG audit (100/100 for the mark and the small cut), its test sheets at 96, 32
  and 16 px, one colour and reversed (`b/preview.html`, `macio/preview.html`), and the app icon on
  light, dark and blue (`macio/look.html`).

## Open items

- At 16 px the mark can still read as a "U with two bumps" from afar; the small cut helps. Look at it
  in real browser tabs and on the home screen before calling it done.
- No trademark search was made. Before using the mark widely, search trademark databases and do a
  reverse image search.
- Manrope's `v` has a sharp vertex; giving it the mark's rounded tip would make the wordmark more
  Vasta's own.
