<script setup lang="ts">
// Food tracking in the open space: on (the Food, Recipe and Nutrition goal types appear, and a
// Food block in each day) or off (hidden; nothing is deleted), and the meals of the day with their
// usual times. Meals save as soon as they change.
import { computed, ref, watch } from 'vue'
import type { Meal } from '@vasta/core'
import { meals, nutritionOn, saveMeals, setNutrition } from '../../lib/nutrition.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, secondary } from './styles.ts'

const busy = ref(false)
const error = ref('')
const draft = ref<Meal[]>([])
watch(meals, (value) => (draft.value = value.map((m) => ({ ...m }))), { immediate: true })
const spaceName = computed(() => workspace.space?.name ?? 'this space')

async function run(change: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await change()
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

const toggle = () => run(() => setNutrition(!nutritionOn.value))

function save() {
  const next = draft.value.filter((m) => m.name.trim()).map((m) => ({ id: m.id, name: m.name.trim(), ...(m.time ? { time: m.time } : {}) }))
  if (JSON.stringify(next) === JSON.stringify(meals.value)) return
  return run(() => saveMeals(next))
}

function add() {
  draft.value.push({ id: crypto.randomUUID().slice(0, 8), name: 'Meal' })
  return save()
}

function remove(index: number) {
  draft.value.splice(index, 1)
  return save()
}

function move(index: number, delta: number) {
  const [meal] = draft.value.splice(index, 1)
  draft.value.splice(index + delta, 0, meal!)
  return save()
}
</script>

<template>
  <SettingsSection id="nutrition" title="Food tracking">
    <div class="space-y-4">
      <label class="flex items-start gap-2.5 text-sm">
        <input :checked="nutritionOn" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" :disabled="busy" @change="toggle" />
        <span>
          Track food in {{ spaceName }}
          <span class="block text-xs text-ink-faint">Each day gets a Food block to log meals against a goal, with Foods, Recipes and Nutrition goals as types. Turning it off hides it and keeps everything.</span>
        </span>
      </label>

      <div v-if="nutritionOn">
        <RouterLink to="/nutrition" class="mb-4 inline-flex items-center gap-1 text-sm text-accent hover:underline">Nutrition: the week, the last days and goals <AppIcon fallback="ph:arrow-right" :size="13" /></RouterLink>
        <div class="mb-1.5 text-xs text-ink-faint">Meals, in the order of the day. Food logged without one goes to the meal nearest its time.</div>
        <div class="space-y-1.5">
          <div v-for="(meal, index) in draft" :key="meal.id" class="flex items-center gap-2">
            <input v-model="meal.name" :class="field" class="!mt-0 min-w-0 flex-1" :aria-label="`Meal ${index + 1}`" @change="save" />
            <input v-model="meal.time" type="time" :class="field" class="!mt-0 !w-36 shrink-0" :aria-label="`${meal.name} usual time`" @change="save" />
            <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-30" title="Earlier" :disabled="index === 0" @click="move(index, -1)"><AppIcon fallback="ph:caret-up" :size="14" /></button>
            <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-30" title="Later" :disabled="index === draft.length - 1" @click="move(index, 1)"><AppIcon fallback="ph:caret-down" :size="14" /></button>
            <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600 disabled:opacity-30" title="Remove" :disabled="draft.length === 1" @click="remove(index)"><AppIcon fallback="ph:x" :size="14" /></button>
          </div>
        </div>
        <button :class="secondary" class="mt-2 flex items-center gap-1" @click="add"><AppIcon fallback="ph:plus" :size="13" /> Add meal</button>
      </div>
      <p v-if="error" :class="errorText">{{ error }}</p>
    </div>
  </SettingsSection>
</template>
