<script setup lang="ts">
import { newId } from '@vasta/core'
// Food tracking in the open space: on (the Food, Recipe and Nutrition goal types appear, and a
// Food block in each day) or off (hidden; nothing is deleted), and the meals of the day with their
// usual times. Meals save as soon as they change.
import { computed, ref, watch } from 'vue'
import type { Meal } from '@vasta/core'
import { t } from '../../lib/i18n.ts'
import { meals, nutritionOn, saveMeals, setNutrition } from '../../lib/nutrition.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, secondary } from './styles.ts'

const busy = ref(false)
const error = ref('')
const draft = ref<Meal[]>([])
watch(meals, (value) => (draft.value = value.map((m) => ({ ...m }))), { immediate: true })
const spaceName = computed(() => workspace.space?.name ?? t('settings.thisSpace'))

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
  draft.value.push({ id: newId().slice(0, 8), name: t('settings.nutrition.defaultMealName') })
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
  <SettingsSection id="nutrition" :title="t('settings.section.nutrition')">
    <div class="space-y-4">
      <label class="flex items-start gap-2.5 text-sm">
        <input :checked="nutritionOn" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" :disabled="busy" @change="toggle" />
        <span>
          {{ t('settings.nutrition.trackIn', { space: spaceName }) }}
          <span class="block text-xs text-ink-faint">{{ t('settings.nutrition.trackHint') }}</span>
        </span>
      </label>

      <div v-if="nutritionOn">
        <RouterLink to="/nutrition" class="mb-4 inline-flex items-center gap-1 text-sm text-accent hover:underline">{{ t('settings.nutrition.pageLink') }} <AppIcon fallback="ph:arrow-right" :size="13" /></RouterLink>
        <div class="mb-1.5 text-xs text-ink-faint">{{ t('settings.nutrition.mealsHint') }}</div>
        <div class="space-y-1.5">
          <div v-for="(meal, index) in draft" :key="meal.id" class="flex items-center gap-2">
            <input v-model="meal.name" :class="field" class="!mt-0 min-w-0 flex-1" :aria-label="t('settings.nutrition.mealAria', { index: index + 1 })" @change="save" />
            <input v-model="meal.time" type="time" :class="field" class="!mt-0 !w-36 shrink-0" :aria-label="t('settings.nutrition.usualTimeAria', { name: meal.name })" @change="save" />
            <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-30" :title="t('settings.nutrition.earlier')" :disabled="index === 0" @click="move(index, -1)"><AppIcon fallback="ph:caret-up" :size="14" /></button>
            <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-30" :title="t('settings.nutrition.later')" :disabled="index === draft.length - 1" @click="move(index, 1)"><AppIcon fallback="ph:caret-down" :size="14" /></button>
            <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600 disabled:opacity-30" :title="t('common.remove')" :disabled="draft.length === 1" @click="remove(index)"><AppIcon fallback="ph:x" :size="14" /></button>
          </div>
        </div>
        <button :class="secondary" class="mt-2 flex items-center gap-1" @click="add"><AppIcon fallback="ph:plus" :size="13" /> {{ t('settings.nutrition.addMeal') }}</button>
      </div>
      <p v-if="error" :class="errorText">{{ error }}</p>
    </div>
  </SettingsSection>
</template>
