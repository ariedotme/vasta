<script setup lang="ts">
// The whiteboard's tools: a dock at the bottom, and above it a row for the tool in use (the pen's
// presets, the shapes, the notes' colors, the arrows' courses) with a panel for the rest of its
// settings. What the tools make is kept on this device (lib/board-tools.ts).
import { computed, ref } from 'vue'
import { ARROW_TIPS, SHAPES, type ArrowPath, type ArrowTip, type ColorName, type Dash, type Fill, type FontSize } from '@vasta/core'
import { HIGHLIGHT_SIZES, PEN_SIZES, activePen, toolSettings, type PenPreset } from '../../lib/board-tools.ts'
import { t } from '../../lib/i18n.ts'
import { PICKER_COLORS, SHAPE_ICONS, SHAPE_LABELS, stickyColor, strokeColor } from '../../lib/whiteboard.ts'
import type { MessageKey } from '../../locales/en.ts'
import AppIcon from '../AppIcon.vue'

export type Tool = 'select' | 'lasso' | 'hand' | 'text' | 'shape' | 'sticky' | 'pen' | 'eraser' | 'frame' | 'arrow'
export type DrawMode = 'auto' | 'pencil' | 'touch'

const props = defineProps<{ tool: Tool; narrow: boolean; drawMode: DrawMode; drawModes: { id: DrawMode; label: string; hint: string }[] }>()
const emit = defineEmits<{ 'update:tool': [tool: Tool]; 'update:drawMode': [mode: DrawMode]; object: [anchor: HTMLElement] }>()

const colorLabel = (c: ColorName) => t(`color.${c}` as MessageKey)

const TOOLS = computed<{ id: Tool; icon: string; label: string; key: string; group: number }[]>(() => [
  { id: 'select', icon: 'ph:cursor', label: t('whiteboard.tool.select'), key: 'V', group: 0 },
  { id: 'lasso', icon: 'ph:lasso', label: t('whiteboard.tool.lasso'), key: 'Q', group: 0 },
  { id: 'hand', icon: 'ph:hand', label: t('whiteboard.tool.hand'), key: 'H', group: 0 },
  { id: 'pen', icon: 'ph:pen-nib', label: t('whiteboard.tool.penAndHighlighter'), key: 'P, M', group: 1 },
  { id: 'eraser', icon: 'ph:eraser', label: t('whiteboard.tool.eraser'), key: 'E', group: 1 },
  { id: 'text', icon: 'ph:text-t', label: t('propKind.text'), key: 'T', group: 2 },
  { id: 'sticky', icon: 'ph:note-blank', label: t('whiteboard.tool.sticky'), key: 'S', group: 2 },
  { id: 'shape', icon: 'ph:square', label: t('whiteboard.tool.shape'), key: 'R, O, D', group: 2 },
  { id: 'frame', icon: 'ph:frame-corners', label: t('whiteboard.frame'), key: 'F', group: 2 },
  { id: 'arrow', icon: 'ph:arrow-up-right', label: t('whiteboard.tool.arrow'), key: 'L', group: 2 },
])
const icon = (item: { id: Tool; icon: string }) =>
  item.id === 'shape' ? SHAPE_ICONS[toolSettings.shape.kind] : item.id === 'pen' && activePen().highlight ? 'ph:highlighter' : item.id === 'arrow' ? PATH_ICONS[toolSettings.arrow.path ?? 'straight'] : item.icon

const PATH_ICONS: Record<ArrowPath, string> = { straight: 'ph:arrow-up-right', curved: 'ph:bezier-curve', elbow: 'ph:arrow-elbow-right' }
const PATHS = computed<{ id: ArrowPath; label: string }[]>(() => [
  { id: 'straight', label: t('whiteboard.path.straight') },
  { id: 'curved', label: t('whiteboard.path.curved') },
  { id: 'elbow', label: t('whiteboard.path.elbow') },
])
const DASHES = computed<{ id: Dash | undefined; label: string }[]>(() => [
  { id: undefined, label: t('whiteboard.dash.solid') },
  { id: 'dashed', label: t('whiteboard.dash.dashed') },
  { id: 'dotted', label: t('whiteboard.dash.dotted') },
])
const FILLS = computed<{ id: Fill | undefined; label: string }[]>(() => [
  { id: undefined, label: t('whiteboard.fill.tint') },
  { id: 'none', label: t('object.none') },
  { id: 'white', label: t('whiteboard.fill.white') },
  { id: 'solid', label: t('whiteboard.dash.solid') },
])
const WIDTHS = computed<{ id: number | undefined; label: string }[]>(() => [
  { id: 1, label: t('whiteboard.width.thin') },
  { id: undefined, label: t('whiteboard.width.regular') },
  { id: 4, label: t('whiteboard.width.thick') },
])
const FONT_SIZES: { id: FontSize | undefined; label: string }[] = [
  { id: 'sm', label: 'S' },
  { id: undefined, label: 'M' },
  { id: 'lg', label: 'L' },
  { id: 'xl', label: 'XL' },
]
const TIP_LABELS = computed<Record<ArrowTip, string>>(() => ({ arrow: t('whiteboard.tool.arrow'), dot: t('whiteboard.tip.dot'), none: t('object.none') }))

/** The settings panel above the tool's row. */
const settingsOpen = ref(false)
const hasRow = computed(() => props.tool === 'pen' || props.tool === 'shape' || props.tool === 'sticky' || props.tool === 'arrow')

function pick(next: Tool) {
  if (next === props.tool && hasRow.value) settingsOpen.value = !settingsOpen.value
  else settingsOpen.value = false
  emit('update:tool', next)
}

const pen = computed(() => activePen())
const penSizes = computed(() => (pen.value.highlight ? HIGHLIGHT_SIZES : PEN_SIZES))
function setPen(patch: Partial<PenPreset>) {
  const next = { ...pen.value, ...patch }
  // A pen and a highlighter keep a width of their own kind.
  if (patch.highlight !== undefined && patch.highlight !== pen.value.highlight) next.size = patch.highlight ? 18 : 2
  if (next.highlight) delete next.dash
  for (const key of Object.keys(next) as (keyof PenPreset)[]) if (next[key] === undefined) delete next[key]
  toolSettings.pens[toolSettings.pen] = next
}
const penColor = (p: PenPreset) => strokeColor(p.color ?? (p.highlight ? 'yellow' : undefined))

const object = ref<HTMLElement | null>(null)

const chip = 'grid h-8 min-w-8 place-items-center rounded-lg px-1.5 text-xs'
const on = (active: boolean) => (active ? 'bg-accent/15 text-accent' : 'text-ink-soft hover:bg-hover hover:text-ink')
</script>

<template>
  <!-- Narrow: above the zoom and undo buttons, from the left; wide: centered beside them. -->
  <div
    data-ui
    class="pointer-events-none absolute inset-x-0 flex flex-col gap-1.5 px-3"
    :class="narrow ? 'bottom-[calc(3.75rem+env(safe-area-inset-bottom))] items-start' : 'bottom-[calc(0.75rem+env(safe-area-inset-bottom))] items-center'"
  >
    <!-- The tool's settings -->
    <div v-if="settingsOpen && hasRow" class="pointer-events-auto w-[19rem] max-w-full space-y-3 rounded-xl border border-line bg-surface p-3 text-xs shadow-lg" @keydown.stop>
      <template v-if="tool === 'pen'">
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('common.type') }}</p>
          <div class="grid grid-cols-2 gap-1">
            <button v-for="h in [false, true]" :key="String(h)" :class="[chip, on(pen.highlight === h)]" class="!flex gap-1.5" @click="setPen({ highlight: h })">
              <AppIcon :fallback="h ? 'ph:highlighter' : 'ph:pen-nib'" :size="15" />{{ h ? t('whiteboard.highlighter') : t('whiteboard.pen') }}
            </button>
          </div>
        </div>
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('whiteboard.width') }}</p>
          <div class="flex gap-1">
            <button v-for="s in penSizes" :key="s" :class="[chip, on(pen.size === s)]" class="flex-1" :title="`${s} px`" @click="setPen({ size: s })">
              <span class="rounded-full bg-current" :style="{ width: '22px', height: `${Math.max(1, Math.min(10, pen.highlight ? s / 3 : s))}px` }" />
            </button>
          </div>
        </div>
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('object.color') }}</p>
          <div class="flex flex-wrap gap-1">
            <button v-for="c in [undefined, ...PICKER_COLORS]" :key="c ?? 'none'" class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover" :title="c ? colorLabel(c) : pen.highlight ? t('color.yellow') : t('whiteboard.ink')" @click="setPen({ color: c })">
              <span class="h-4 w-4 rounded-full" :class="pen.color === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''" :style="{ background: strokeColor(c ?? (pen.highlight ? 'yellow' : undefined)) }" />
            </button>
          </div>
        </div>
        <div v-if="!pen.highlight">
          <p class="mb-1 font-medium text-ink-soft">{{ t('whiteboard.line') }}</p>
          <div class="flex gap-1">
            <button v-for="d in DASHES" :key="d.id ?? 'solid'" :class="[chip, on(pen.dash === d.id)]" class="flex-1" @click="setPen({ dash: d.id })">{{ d.label }}</button>
          </div>
        </div>
        <div class="border-t border-line pt-2">
          <p class="mb-1 font-medium text-ink-soft">{{ t('whiteboard.penAndFingers') }}</p>
          <div class="flex gap-1">
            <button v-for="m in drawModes" :key="m.id" :class="[chip, on(drawMode === m.id)]" class="flex-1" :title="m.hint" @click="emit('update:drawMode', m.id)">{{ m.label }}</button>
          </div>
        </div>
      </template>

      <template v-else-if="tool === 'shape'">
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('object.color') }}</p>
          <div class="flex flex-wrap gap-1">
            <button v-for="c in [undefined, ...PICKER_COLORS]" :key="c ?? 'none'" class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover" :title="c ? colorLabel(c) : t('whiteboard.ink')" @click="toolSettings.shape.color = c">
              <span class="h-4 w-4 rounded-full" :class="toolSettings.shape.color === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''" :style="{ background: strokeColor(c) }" />
            </button>
          </div>
        </div>
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('whiteboard.fill') }}</p>
          <div class="flex gap-1">
            <button v-for="f in FILLS" :key="f.id ?? 'tint'" :class="[chip, on(toolSettings.shape.fill === f.id)]" class="flex-1" @click="toolSettings.shape.fill = f.id">{{ f.label }}</button>
          </div>
        </div>
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('whiteboard.outline') }}</p>
          <div class="flex gap-1">
            <button v-for="w in WIDTHS" :key="w.id ?? 'regular'" :class="[chip, on(toolSettings.shape.border === w.id)]" class="flex-1" @click="toolSettings.shape.border = w.id">{{ w.label }}</button>
          </div>
          <div class="mt-1 flex gap-1">
            <button v-for="d in DASHES" :key="d.id ?? 'solid'" :class="[chip, on(toolSettings.shape.dash === d.id)]" class="flex-1" @click="toolSettings.shape.dash = d.id">{{ d.label }}</button>
          </div>
        </div>
      </template>

      <template v-else-if="tool === 'sticky'">
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('whiteboard.textSize') }}</p>
          <div class="flex gap-1">
            <button v-for="f in FONT_SIZES" :key="f.label" :class="[chip, on(toolSettings.sticky.fontSize === f.id)]" class="flex-1" @click="toolSettings.sticky.fontSize = f.id">{{ f.label }}</button>
          </div>
        </div>
      </template>

      <template v-else-if="tool === 'arrow'">
        <div class="grid grid-cols-2 gap-2">
          <div>
            <p class="mb-1 font-medium text-ink-soft">{{ t('dateEditor.start') }}</p>
            <div class="flex gap-1">
              <button v-for="tip in ARROW_TIPS" :key="tip" :class="[chip, on(toolSettings.arrow.start === tip)]" class="flex-1" @click="toolSettings.arrow.start = tip">{{ TIP_LABELS[tip] }}</button>
            </div>
          </div>
          <div>
            <p class="mb-1 font-medium text-ink-soft">{{ t('dateEditor.end') }}</p>
            <div class="flex gap-1">
              <button v-for="tip in ARROW_TIPS" :key="tip" :class="[chip, on(toolSettings.arrow.end === tip)]" class="flex-1" @click="toolSettings.arrow.end = tip">{{ TIP_LABELS[tip] }}</button>
            </div>
          </div>
        </div>
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('whiteboard.line') }}</p>
          <div class="flex gap-1">
            <button v-for="d in DASHES" :key="d.id ?? 'solid'" :class="[chip, on(toolSettings.arrow.dash === d.id)]" class="flex-1" @click="toolSettings.arrow.dash = d.id">{{ d.label }}</button>
          </div>
          <div class="mt-1 flex gap-1">
            <button v-for="w in WIDTHS" :key="w.id ?? 'regular'" :class="[chip, on(toolSettings.arrow.width === w.id)]" class="flex-1" @click="toolSettings.arrow.width = w.id">{{ w.label }}</button>
          </div>
        </div>
        <div>
          <p class="mb-1 font-medium text-ink-soft">{{ t('object.color') }}</p>
          <div class="flex flex-wrap gap-1">
            <button v-for="c in [undefined, ...PICKER_COLORS]" :key="c ?? 'none'" class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover" :title="c ? colorLabel(c) : t('color.gray')" @click="toolSettings.arrow.color = c">
              <span class="h-4 w-4 rounded-full" :class="toolSettings.arrow.color === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''" :style="{ background: c ? strokeColor(c) : 'var(--color-ink-soft)' }" />
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- The tool's row: presets and kinds -->
    <div v-if="hasRow" class="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <template v-if="tool === 'pen'">
        <button
          v-for="(p, i) in toolSettings.pens"
          :key="i"
          class="relative grid h-8 w-8 shrink-0 place-items-center rounded-lg"
          :class="on(toolSettings.pen === i)"
          :title="`${p.highlight ? t('whiteboard.highlighter') : t('whiteboard.pen')}${p.color ? `, ${colorLabel(p.color)}` : ''}`"
          @click="toolSettings.pen === i ? (settingsOpen = !settingsOpen) : (toolSettings.pen = i)"
        >
          <AppIcon :fallback="p.highlight ? 'ph:highlighter' : 'ph:pen-nib'" :size="17" />
          <span class="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface" :style="{ background: penColor(p) }" />
        </button>
      </template>
      <template v-else-if="tool === 'shape'">
        <button v-for="s in SHAPES" :key="s" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg" :class="on(toolSettings.shape.kind === s)" :title="SHAPE_LABELS[s]" @click="toolSettings.shape.kind = s">
          <AppIcon :fallback="SHAPE_ICONS[s]" :size="17" />
        </button>
      </template>
      <template v-else-if="tool === 'sticky'">
        <button v-for="c in PICKER_COLORS" :key="c" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-hover" :title="colorLabel(c)" @click="toolSettings.sticky.color = c === 'yellow' ? undefined : c">
          <span class="h-5 w-5 rounded" :class="(toolSettings.sticky.color ?? 'yellow') === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : 'ring-1 ring-line'" :style="{ background: stickyColor(c as ColorName) }" />
        </button>
      </template>
      <template v-else-if="tool === 'arrow'">
        <button v-for="p in PATHS" :key="p.id" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg" :class="on((toolSettings.arrow.path ?? 'straight') === p.id)" :title="p.label" @click="toolSettings.arrow.path = p.id === 'straight' ? undefined : p.id">
          <AppIcon :fallback="PATH_ICONS[p.id]" :size="17" />
        </button>
      </template>
      <span class="mx-0.5 h-5 w-px shrink-0 bg-line" />
      <button class="grid h-8 w-8 shrink-0 place-items-center rounded-lg" :class="on(settingsOpen)" :title="settingsOpen ? t('whiteboard.hideSettings') : t('whiteboard.moreSettings')" :aria-pressed="settingsOpen" @click="settingsOpen = !settingsOpen">
        <AppIcon fallback="ph:sliders-horizontal" :size="16" />
      </button>
    </div>

    <!-- The dock -->
    <div class="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <template v-for="(item, i) in TOOLS" :key="item.id">
        <span v-if="i && TOOLS[i - 1]!.group !== item.group" class="mx-1 h-5 w-px shrink-0 bg-line" />
        <button
          class="relative grid h-9 w-9 shrink-0 place-items-center rounded-lg"
          :class="on(tool === item.id)"
          :title="`${item.label} (${item.key})`"
          :aria-label="item.label"
          :aria-pressed="tool === item.id"
          @click="pick(item.id)"
        >
          <AppIcon :fallback="icon(item)" :size="18" />
          <span v-if="item.id === 'pen'" class="absolute bottom-1 right-1 h-2 w-2 rounded-full ring-2 ring-surface" :style="{ background: penColor(pen) }" />
        </button>
      </template>
      <span class="mx-1 h-5 w-px shrink-0 bg-line" />
      <button
        ref="object"
        class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-hover hover:text-ink"
        :title="t('whiteboard.addObjectShortcut')"
        @click="object && emit('object', object)"
      >
        <AppIcon fallback="ph:cards" :size="18" /><span v-if="!narrow">{{ t('whiteboard.object') }}</span>
      </button>
    </div>
  </div>
</template>
