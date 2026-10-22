<script setup lang="ts">
// Pick a Phosphor icon (searchable) or an emoji. Emits undefined to remove the icon.
import { computed, onMounted, ref } from 'vue'
import type { Icon } from '@vasta/core'
import { loadPhosphor } from '../lib/icons.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ icon?: Icon | undefined; allowRemove?: boolean }>()
const emit = defineEmits<{ pick: [icon: Icon | undefined] }>()

const WEIGHTS = /-(bold|fill|light|thin|duotone)$/
/** Regular-weight Phosphor names; the other weights are variants of the same glyph. Empty while the set loads. */
const names = ref<string[]>([])
const loadError = ref('')

const EMOJI = [
  '📄', '📝', '📚', '📖', '🔖', '🏷️', '📌', '🗂️', '📁', '🗃️', '✅', '☑️', '🧠', '💡', '✨', '⭐',
  '🔥', '❤️', '🎯', '🚀', '🛠️', '⚙️', '🧪', '🔬', '🎨', '🎵', '🎬', '🎮', '📷', '🌍', '🏠', '🏢',
  '👤', '👥', '🗣️', '💬', '📅', '⏰', '💰', '🛒', '🍽️', '☕', '🏃', '🧘', '🌱', '🌙', '☀️', '🪐',
]

const tab = ref<'icons' | 'emoji'>(props.icon?.kind === 'emoji' ? 'emoji' : 'icons')
const query = ref('')
const custom = ref('')
const input = ref<HTMLInputElement | null>(null)

const matches = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, '-')
  return (q ? names.value.filter((n) => n.includes(q)) : names.value).slice(0, 240)
})

onMounted(() => {
  input.value?.focus()
  loadPhosphor().then(
    (set) => (names.value = Object.keys(set.icons).filter((name) => !WEIGHTS.test(name)).sort()),
    () => (loadError.value = 'Could not load the icons. Check the connection and open the picker again.')
  )
})
</script>

<template>
  <div class="w-[22rem]">
    <div class="mb-2 flex items-center gap-1 text-sm">
      <button class="rounded-md px-2.5 py-1" :class="tab === 'icons' ? 'bg-hover font-medium' : 'text-ink-soft hover:bg-hover'" @click="tab = 'icons'">Icons</button>
      <button class="rounded-md px-2.5 py-1" :class="tab === 'emoji' ? 'bg-hover font-medium' : 'text-ink-soft hover:bg-hover'" @click="tab = 'emoji'">Emoji</button>
      <button v-if="allowRemove && icon" class="ml-auto rounded-md px-2.5 py-1 text-ink-soft hover:bg-hover" @click="emit('pick', undefined)">Remove</button>
    </div>

    <template v-if="tab === 'icons'">
      <input
        ref="input"
        v-model="query"
        class="mb-2 w-full rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint"
        placeholder="Search icons (book, star, user…)"
      />
      <div class="grid max-h-64 grid-cols-8 gap-0.5 overflow-y-auto">
        <button
          v-for="name in matches"
          :key="name"
          class="grid aspect-square place-items-center rounded-md text-ink-soft hover:bg-hover hover:text-ink"
          :class="icon?.kind === 'icon' && icon.value === `ph:${name}` ? 'bg-hover text-accent' : ''"
          :title="name"
          @click="emit('pick', { kind: 'icon', value: `ph:${name}` })"
        >
          <AppIcon :fallback="`ph:${name}`" :size="18" />
        </button>
      </div>
      <p v-if="loadError" class="py-6 text-center text-sm text-ink-faint">{{ loadError }}</p>
      <p v-else-if="!names.length" class="py-6 text-center text-sm text-ink-faint">Loading icons…</p>
      <p v-else-if="!matches.length" class="py-6 text-center text-sm text-ink-faint">No icon matches “{{ query }}”</p>
    </template>

    <template v-else>
      <div class="grid grid-cols-8 gap-0.5">
        <button v-for="e in EMOJI" :key="e" class="grid aspect-square place-items-center rounded-md text-xl hover:bg-hover" @click="emit('pick', { kind: 'emoji', value: e })">
          {{ e }}
        </button>
      </div>
      <form class="mt-2 flex gap-1.5" @submit.prevent="custom.trim() && emit('pick', { kind: 'emoji', value: custom.trim() })">
        <input v-model="custom" class="flex-1 rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint" placeholder="Paste any emoji (⌃⌘Space)" />
        <button class="rounded-lg bg-ink px-3 text-sm text-surface disabled:opacity-40" :disabled="!custom.trim()">Use</button>
      </form>
    </template>
  </div>
</template>
