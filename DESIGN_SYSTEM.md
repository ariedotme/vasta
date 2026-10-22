# Vasta Design System

Calm, dense and quiet, in the spirit of Capacities: a warm canvas around a white page, color only
where it carries meaning (types, select options, tags), the content as the loudest thing on screen.

## Tokens

**Color**: surface and text tokens in `packages/web/src/style.css` (`@theme`, redefined under
`.dark`); the 18 named colors' class sets (chips, icons, groups, highlights) in
`packages/web/src/lib/colors.ts`.
**Typography**: the system font (`--font-sans`); UI at 14px (`text-sm`), 15px in the phone drawer;
notes at 16px, line height 1.6. Page titles bold with tight tracking.
**Spacing**: Tailwind's 4px scale. Sidebar rows 30px on desktop, 40px+ on phones.
**Theme**: system, light or dark per device (`lib/theme.ts`, Settings › Appearance and the sidebar's
footer).

## Patterns

**The shell**: the sidebar runs the full height with the space switcher on top; the top bar holds
back/forward and where you are (an object's type, then the object); the page is a rounded panel
(`bg-surface`, border, faint shadow) sitting on the canvas. On phones the panel is flat and full
width, the sidebar is a drawer, and the top bar shows the menu, the page and Search.

**Sidebar top**: Calendar, Inbox and Tasks (⌘1, ⌘2, ⌘3, in that order), the places visited every
day, above the user's sections; Tasks is never listed again among the types. Today is not a row:
⌘D ("day"), G then T.

**Sidebar rows**: the open page's row is raised (surface, `ring-1 ring-line`, small shadow) rather
than tinted, so it reads as "the card you're on". Section carets and the "+" of All types show on
hover only (always on touch). The footer holds icon tools: Settings, theme, shortcuts, Trash with
its count.

**Pinning**: any type or object can sit in one or more sidebar sections, mixed. Every right-click
menu on one has "Pin to sidebar ›", a submenu with a checkbox per section (it stays open, so several
can be ticked) and New section…; the More menus of type and object pages open the same list. In the
sidebar, rows drag within and between sections (⌥ copies), types drag in from All types, links to
objects or types (cards, list rows) drag in from the page, and section headers drag to reorder.

**Hover-only affordances**: secondary actions that would clutter an empty page (an object's Icon
and Cover buttons, section carets) appear on hover or focus, and are always visible on touch
screens (`[@media(hover:none)]:opacity-100`), which have no hover.

**Chips**: soft background, dark text of the same color and a hairline ring of that color
(`chipClasses`). One shape for types, select options and tags everywhere. A tag chip takes the
tag's color (its own, else its nearest parent's, else violet) and shows its path with the parents
faded: `recipe/`**`breakfast`** (`ObjectChip`, `lib/tags.ts`).

**Type icons**: in a rounded square tinted with the type's color (the default, as in Capacities) or
bare in that color, per device (Settings › Appearance, `iconStyle` in `lib/theme.ts`). Everything
that shows a type's or an object's icon goes through `TypeIcon`; emoji are never boxed. App
navigation icons (Today, Inbox, Settings…) stay bare and gray.

**Properties**: a two-column table: name | value, with a hairline between the columns and between
rows (`.vasta-prop-row`, `.vasta-prop-name` in `style.css`), shared by own and reverse relations.

**Settings**: one page of cards (`SettingsSection`), one per area, with a sticky side list that
marks the card in view on wide screens and a wrap of buttons above on narrow ones. Section
labels and icons live in `components/settings/sections.ts`.

**Today is a day in the calendar**: Today (⌘D, G then T, ⌘K, the desktop app's menu, `/day/…`; not a
sidebar row, Calendar is) opens
the calendar's Day view for today, not the daily note alone. The Day view is a page (`DayPage`):
what is scheduled that day, the daily note edited in place (`ObjectPage` with `embedded`) with what
refers to the day, and what was created that day. Today's note is started on open; other days wait
for "Start the daily note", so browsing does not litter empty notes.

**The month beside the calendar**: week, three-day and day views have a small month on the right
(toggle in the header, remembered per device). Dots under a day say what it holds, one color each
(`DAY_MARKS` in `lib/calendar.ts`): a daily note with text, tasks due, dated objects, references
(objects linking to the day's note or date objects), events. A legend sits under it and the day's
tooltip gives the counts. The dots follow the calendar's Show filters.

**Fixed views**: some built-in types open on a view of their own before their saved views (`FIXED_VIEWS`
in `TypePage`): Tags a Tree (sub-tags fold under their parent like folders, folding remembered per
device), Habits a Tracker (habits × the last 14 days, 7 on phones). They are not stored on the type.

**Habits**: checked off where the day is: the calendar's day view (in the side column under the
month, or as pills in the page when that column is hidden), daily notes (pills), the habit's page
(as many weeks as fit, up to a year: click to change, right click for an amount) and the Tracker. A
habit with a daily goal ("8 glasses") shows a ring filling toward it; a click adds 1, a right click
or long press types the amount; its squares fill from the bottom as far as the day got. Hovering a square shows its day, amount
and state at once (a tooltip, not the browser's slow title). A check shows at once and rolls back if the
save fails. Days a habit does not repeat on are shown faded ("day off"), never as missed.

**Food** (once a space tracks food, Settings › Food tracking): a Food block where the day is (the
calendar's day page under the habits, a daily note's page), never anywhere else. It leads with the
week's budget when the goal shares its week (eaten of the target, what is left, and on today how
much today may take), then the day against its goal (kcal and macro bars, amber past 105%), then
the meals with their entries. A past day with nothing logged is one line ("Log food" opens it); a
future day cannot be logged. "+" on a meal opens the picker: search (most eaten lately first), pick,
type the amount ("150", "2 fatias") with a live preview and the food's portions as chips, Enter;
it stays open for the next item and lists what was added; a food not found is made right there
(numbers as on the label, per any amount). A tap on an entry changes its amount or meal; right
click or long press for move, update from the food, open it, delete; a meal's menu copies it from
another day or saves it as a recipe. Foods and recipes edit their portions and ingredients on their
own page, under the properties.

**Nutrient colors**: kcal blue, protein pink, carbs yellow, fat green, fiber gray (`--color-kcal`…
in style.css, `nutrientColor` in lib/nutrition.ts), the same everywhere a nutrient shows: the Food
block's bars, a food's property rows, recipes' and entries' numbers (`NutrientLine`), the
Nutrition page. Always a dot or bar beside the nutrient's name, never colored text. Past the goal,
the bar keeps its color, the goal shows as a tick and the number turns amber.

**The Nutrition page** (`/nutrition`; ⌘K, a day's Food menu, Settings › Food tracking): the
week's budget first, then the last 7/30/90 days (stat tiles, a column chart, where the kcal came
from), then the goals over time with New goal. The calendar's month shows each day's kcal.

**Charts** (`components/charts/BarChart.vue`): one series of columns (≤24px, 4px rounded top,
square at the baseline) with an optional target per column as a hairline across its slot;
recessive hairline gridlines with compact ticks (0 / 1.5k / 3k); a column past its target in the
"over" color, with the tooltip saying so in words. Every column has a hover and keyboard-focus
tooltip (value first, then the day), and "Show as a table" holds every value. Colors are the
`--color-chart` and `--color-chart-over` tokens, checked with the dataviz validator for both
themes. One series has no legend: the heading names it.

**Keyboard shortcuts**: one list in `lib/shortcuts.ts`, which drives the handler, the ⌘/ dialog and
the hints (sidebar rows, ⌘K). Navigation uses ⌘1–3 for the sidebar's top rows in order (Calendar,
Inbox, Tasks; Things uses the same idea) and ⌘D for today, and works while typing (⌘D duplicates
blocks instead while blocks are selected in a note); "G then a letter" works outside text fields and in browser tabs,
where ⌘1–3 belong to the browser. Pages with their own single-key shortcuts (the calendar) skip
keys the app already handled (`defaultPrevented`).

## Open questions

- In the desktop app, an overlay title bar (traffic lights inside the top bar, like Capacities)
  instead of the native one. Needs a desktop release and the drag permission for the server's
  origin.
- Tabs or split view were set aside on 2026-10-19; the top bar has room for them if that changes.
