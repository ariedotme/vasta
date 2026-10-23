<script setup lang="ts">
import { ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import type { SlashCommand } from './commands.ts'

const props = defineProps<{ items: SlashCommand[]; command: (item: SlashCommand) => void }>()
const active = ref(0)
watch(() => props.items, () => (active.value = 0))

function onKeyDown(event: KeyboardEvent): boolean {
  if (event.key === 'ArrowDown') active.value = (active.value + 1) % Math.max(props.items.length, 1)
  else if (event.key === 'ArrowUp') active.value = (active.value - 1 + props.items.length) % Math.max(props.items.length, 1)
  else if (event.key === 'Enter') {
    const item = props.items[active.value]
    if (!item) return false
    props.command(item)
  } else return false
  return true
}

defineExpose({ onKeyDown })
</script>

<template>
  <!-- The root must always render: the suggestion popup mounts this element. -->
  <div :class="items.length ? 'max-h-80 w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl shadow-black/10' : 'hidden'">
    <template v-for="(item, i) in items" :key="item.id">
      <div v-if="item.group && item.group !== items[i - 1]?.group" class="px-2.5 pb-1 pt-2 text-xs font-medium text-ink-faint">{{ item.group }}</div>
      <button
        class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm"
        :class="i === active ? 'bg-hover' : ''"
        @mouseenter="active = i"
        @mousedown.prevent="command(item)"
      >
        <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-raised text-ink-soft">
          <AppIcon :fallback="item.icon" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate">{{ item.label }}</span>
          <span v-if="item.detail" class="block truncate text-xs text-ink-faint">{{ item.detail }}</span>
        </span>
      </button>
    </template>
  </div>
</template>
