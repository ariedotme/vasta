<script setup lang="ts">
import { ref, watch } from 'vue'
import type { BlockInfo, ObjectSummary } from '@vasta/core'
import AppIcon from '../components/AppIcon.vue'
import { iconTextClasses } from '../lib/colors.ts'
import { displayTitle } from '../lib/format.ts'
import { typesById } from '../lib/state.ts'

// `drill` is Tab on an object: "@Title#", to list its blocks.
export type MentionItem =
  | { kind: 'object'; object: ObjectSummary }
  | { kind: 'create'; title: string }
  | { kind: 'block'; object: ObjectSummary; block: BlockInfo }
  | { kind: 'drill'; object: ObjectSummary }

const BLOCK_ICONS: Record<string, string> = { heading: 'ph:text-h', paragraph: 'ph:text-align-left', listItem: 'ph:list-bullets', taskItem: 'ph:check-square', codeBlock: 'ph:code' }

const props = defineProps<{ items: MentionItem[]; command: (item: MentionItem) => void }>()
const active = ref(0)
watch(() => props.items, () => (active.value = 0))

function onKeyDown(event: KeyboardEvent): boolean {
  if (event.key === 'ArrowDown') active.value = (active.value + 1) % Math.max(props.items.length, 1)
  else if (event.key === 'ArrowUp') active.value = (active.value - 1 + props.items.length) % Math.max(props.items.length, 1)
  else if (event.key === 'Enter' || event.key === 'Tab') {
    const item = props.items[active.value]
    if (!item) return false
    props.command(event.key === 'Tab' && item.kind === 'object' ? { kind: 'drill', object: item.object } : item)
  } else return false
  return true
}

defineExpose({ onKeyDown })
</script>

<template>
  <div class="max-h-80 w-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl shadow-black/10">
    <button
      v-for="(item, i) in items"
      :key="i"
      class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm"
      :class="i === active ? 'bg-hover' : ''"
      @mouseenter="active = i"
      @mousedown.prevent="command(item)"
    >
      <template v-if="item.kind === 'object'">
        <AppIcon
          :icon="item.object.icon ?? typesById.get(item.object.typeId)?.icon"
          fallback="ph:file-text"
          :class="typesById.get(item.object.typeId)?.color ? iconTextClasses[typesById.get(item.object.typeId)!.color!] : 'text-ink-soft'"
        />
        <span class="min-w-0 flex-1 truncate">{{ displayTitle(item.object, typesById.get(item.object.typeId)) }}</span>
        <span class="shrink-0 text-xs text-ink-faint">{{ typesById.get(item.object.typeId)?.name }}</span>
      </template>
      <template v-else-if="item.kind === 'drill'">
        <AppIcon
          :icon="item.object.icon ?? typesById.get(item.object.typeId)?.icon"
          fallback="ph:file-text"
          :class="typesById.get(item.object.typeId)?.color ? iconTextClasses[typesById.get(item.object.typeId)!.color!] : 'text-ink-soft'"
        />
        <span class="min-w-0 flex-1 truncate">{{ displayTitle(item.object, typesById.get(item.object.typeId)) }}</span>
        <span class="shrink-0 text-xs text-ink-faint">{{ typesById.get(item.object.typeId)?.name }}</span>
        <AppIcon fallback="ph:caret-right" :size="12" class="text-ink-faint" />
      </template>
      <template v-else-if="item.kind === 'block'">
        <AppIcon :fallback="BLOCK_ICONS[item.block.type] ?? 'ph:text-align-left'" class="text-ink-soft" />
        <span class="min-w-0 flex-1 truncate" :class="item.block.type === 'heading' ? 'font-semibold' : ''">{{ item.block.text }}</span>
      </template>
      <template v-else-if="item.kind === 'create'">
        <AppIcon fallback="ph:plus-circle" class="text-accent" />
        <span class="truncate">Create page “{{ item.title }}”</span>
      </template>
    </button>
    <p v-if="!items.length" class="px-2.5 py-2 text-sm text-ink-faint">Type to search…</p>
    <p v-else-if="items[0]?.kind === 'drill'" class="border-t border-line px-2.5 pt-1.5 pb-1 text-xs text-ink-faint">Several have this name: choose one to see its blocks</p>
    <p v-else-if="items[0]?.kind === 'block'" class="border-t border-line px-2.5 pt-1.5 pb-1 text-xs text-ink-faint">Blocks of {{ displayTitle(items[0].object, typesById.get(items[0].object.typeId)) }} · {{ typesById.get(items[0].object.typeId)?.name }}</p>
    <p v-else-if="items[0]?.kind === 'object'" class="border-t border-line px-2.5 pt-1.5 pb-1 text-xs text-ink-faint">Tab, or # after the name: one of its blocks</p>
  </div>
</template>
