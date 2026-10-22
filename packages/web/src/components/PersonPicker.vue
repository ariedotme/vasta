<script setup lang="ts">
// Choose space members: the members (the user first, as "Me"), then anyone selected who left.
import { computed, ref } from 'vue'
import type { Id } from '@vasta/core'
import { meId, people, personName } from '../lib/people.ts'
import AppIcon from './AppIcon.vue'
import PersonAvatar from './PersonAvatar.vue'

const props = defineProps<{ selected: Id[] }>()
const emit = defineEmits<{ toggle: [id: Id] }>()

const search = ref('')
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const choices = computed(() => {
  const me = meId()
  const members = [...people.list].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name)))
  const former = props.selected.filter((id) => !people.list.some((p) => p.id === id)).map((id) => ({ id, username: '', name: personName(id) }))
  const wanted = fold(search.value.trim())
  return [...members, ...former].filter((p) => !wanted || fold(p.name).includes(wanted) || fold(p.username).includes(wanted))
})
</script>

<template>
  <input
    v-if="people.list.length > 6"
    v-model="search"
    class="mb-1 w-full rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint"
    placeholder="Search people…"
    @keydown.enter.prevent="choices[0] && emit('toggle', choices[0].id)"
  />
  <button
    v-for="person in choices"
    :key="person.id"
    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover"
    @click="emit('toggle', person.id)"
  >
    <PersonAvatar :id="person.id" />
    <span class="min-w-0 truncate">{{ person.name }}</span>
    <span v-if="person.id === meId()" class="text-xs text-ink-faint">me</span>
    <span v-else-if="person.username" class="truncate text-xs text-ink-faint">@{{ person.username }}</span>
    <AppIcon v-if="selected.includes(person.id)" fallback="ph:check" class="ml-auto shrink-0 text-accent" />
  </button>
  <p v-if="!choices.length" class="px-2 py-1.5 text-sm text-ink-faint">Nobody found</p>
  <p v-if="people.list.length <= 1" class="px-2 pb-1 pt-2 text-xs text-ink-faint">Add people to this space in Settings › Space.</p>
</template>
