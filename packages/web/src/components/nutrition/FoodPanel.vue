<script setup lang="ts">
// On a food's page: its portions ("slice" = 30 g), what it can be logged by besides grams. On a
// recipe's page: its ingredients with their grams, and what it comes to per 100 g and per serving
// (worked out from the foods as they are now). Both say how often they were eaten lately.
// Portions and ingredients are props without a property definition; the page saves them.
import { computed, nextTick, ref, watch } from 'vue'
import {
  INGREDIENTS_PROPERTY_ID,
  PORTIONS_PROPERTY_ID,
  addDays,
  foodBrand,
  foodNutrients,
  foodPortions,
  ingredientsValue,
  isRecipe,
  portionsValue,
  recipeFacts,
  recipeIngredients,
  scaleNutrients,
  sourceUsage,
  type FoodPortion,
  type ObjectSummary,
  type ObjectRecord,
  type PropertyValue,
  type RecipeIngredient,
} from '@vasta/core'
import { api } from '../../lib/api.ts'
import { dayKey } from '../../lib/actions.ts'
import { formatLongDay } from '../../lib/format.ts'
import { dailyNotesBetween, formatGrams, formatKcal, useFoodLibrary } from '../../lib/nutrition.ts'
import AppIcon from '../AppIcon.vue'
import NutrientLine from './NutrientLine.vue'
import ObjectLink from '../ObjectLink.vue'

const props = defineProps<{ object: ObjectRecord }>()
const emit = defineEmits<{ set: [key: string, value: PropertyValue | undefined] }>()

const library = useFoodLibrary()
const recipe = computed(() => isRecipe(props.object))
const self = computed(() => ({ ...props.object, preview: '' }))
const lookup = (id: string) => (id === props.object.id ? self.value : library.lookup(id))

// Usage: how often it was eaten, and the recipes it is in (their ingredients link to it).
const usage = ref<{ count: number; lastDay?: string } | null>(null)
const inRecipes = ref<ObjectSummary[]>([])
watch(
  () => props.object.id,
  async (id) => {
    const notes = await dailyNotesBetween(addDays(dayKey(), -365), dayKey())
    usage.value = sourceUsage([...notes.values()], id)
    inRecipes.value = (await api.backlinks(id)).filter((l) => l.kind === 'relation' && l.via === INGREDIENTS_PROPERTY_ID && !l.object.deletedAt).map((l) => l.object)
  },
  { immediate: true }
)

// Portions ------------------------------------------------------------------------
const portions = computed(() => foodPortions(props.object))
function setPortions(next: FoodPortion[]) {
  emit('set', PORTIONS_PROPERTY_ID, next.length ? portionsValue(next) : undefined)
}
const newPortion = ref({ name: '', grams: '' })
const num = (text: string) => {
  const value = Number(text.replace(',', '.'))
  return text.trim() && Number.isFinite(value) && value > 0 ? value : undefined
}
function addPortion() {
  const grams = num(newPortion.value.grams)
  if (!newPortion.value.name.trim() || !grams) return
  setPortions([...portions.value, { name: newPortion.value.name.trim(), grams }])
  newPortion.value = { name: '', grams: '' }
}
function changePortion(index: number, key: 'name' | 'grams', text: string) {
  const next = portions.value.map((p) => ({ ...p }))
  if (key === 'name' && text.trim()) next[index]!.name = text.trim()
  const grams = num(text)
  if (key === 'grams' && grams) next[index]!.grams = grams
  setPortions(next)
}

// Ingredients ---------------------------------------------------------------------
const ingredients = computed(() => recipeIngredients(props.object))
const facts = computed(() => (recipe.value ? recipeFacts(self.value, lookup) : undefined))
function setIngredients(next: RecipeIngredient[]) {
  emit('set', INGREDIENTS_PROPERTY_ID, next.length ? ingredientsValue(next) : undefined)
}
function ingredientKcal(item: RecipeIngredient): number | undefined {
  const source = lookup(item.id)
  if (!source) return undefined
  const per100 = isRecipe(source) ? recipeFacts(source, lookup, new Set([props.object.id])).per100 : foodNutrients(source)
  return per100 ? scaleNutrients(per100, item.grams).kcal : undefined
}
function changeGrams(index: number, text: string) {
  const grams = num(text)
  if (!grams) return
  setIngredients(ingredients.value.map((item, i) => (i === index ? { ...item, grams } : item)))
}
const removeIngredient = (index: number) => setIngredients(ingredients.value.filter((_, i) => i !== index))
function moveIngredient(index: number, delta: number) {
  const next = [...ingredients.value]
  const [item] = next.splice(index, 1)
  next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, item!)
  setIngredients(next)
}

const search = ref('')
const searchOpen = ref(false)
const adding = ref<{ id: string; title: string } | null>(null)
const addGrams = ref('')
const gramsInput = ref<HTMLInputElement | null>(null)
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const matches = computed(() => {
  const q = fold(search.value.trim())
  return library.sources.value.filter((s) => s.id !== props.object.id && !s.deletedAt && (!q || fold(`${s.title} ${foodBrand(s)}`).includes(q))).slice(0, 8)
})
function choose(id: string, title: string) {
  adding.value = { id, title }
  search.value = ''
  searchOpen.value = false
  void nextTick(() => gramsInput.value?.focus())
}
function addIngredient() {
  const grams = num(addGrams.value)
  if (!adding.value || !grams) return
  setIngredients([...ingredients.value, { id: adding.value.id, grams }])
  adding.value = null
  addGrams.value = ''
}

const small = 'rounded-md border border-line bg-surface px-2 py-1 text-sm tabular-nums outline-none focus:border-line-strong max-md:py-1.5 max-md:text-base'
</script>

<template>
  <section class="text-sm" data-food-panel>
    <!-- Recipe: ingredients and what it comes to. -->
    <template v-if="recipe">
      <h2 class="mb-2 flex items-center gap-1.5 font-semibold text-ink-soft"><AppIcon fallback="ph:list-bullets" /> Ingredients</h2>
      <div class="space-y-0.5">
        <div v-for="(item, index) in ingredients" :key="`${item.id}-${index}`" class="group flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-hover">
          <ObjectLink v-if="lookup(item.id)" :id="item.id" class="min-w-0 flex-1 truncate hover:underline">{{ lookup(item.id)!.title || 'Untitled' }}</ObjectLink>
          <span v-else class="min-w-0 flex-1 truncate text-ink-faint">Deleted food</span>
          <input :value="formatGrams(item.grams)" :class="small" class="w-20 text-right" inputmode="decimal" :aria-label="`Grams of ${lookup(item.id)?.title ?? 'ingredient'}`" @change="changeGrams(index, ($event.target as HTMLInputElement).value)" />
          <span class="text-ink-faint">g</span>
          <span class="w-16 shrink-0 text-right text-xs tabular-nums text-ink-faint">{{ ingredientKcal(item) !== undefined ? `${formatKcal(ingredientKcal(item)!)} kcal` : '—' }}</span>
          <span class="flex shrink-0 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <button class="rounded p-0.5 text-ink-faint hover:text-ink" title="Up" :disabled="index === 0" @click="moveIngredient(index, -1)"><AppIcon fallback="ph:caret-up" :size="13" /></button>
            <button class="rounded p-0.5 text-ink-faint hover:text-ink" title="Down" :disabled="index === ingredients.length - 1" @click="moveIngredient(index, 1)"><AppIcon fallback="ph:caret-down" :size="13" /></button>
            <button class="rounded p-0.5 text-ink-faint hover:text-red-600" title="Remove" @click="removeIngredient(index)"><AppIcon fallback="ph:x" :size="13" /></button>
          </span>
        </div>
      </div>

      <form v-if="adding" class="mt-1 flex items-center gap-2 px-1.5" @submit.prevent="addIngredient">
        <span class="min-w-0 flex-1 truncate">{{ adding.title }}</span>
        <input ref="gramsInput" v-model="addGrams" :class="small" class="w-20 text-right" inputmode="decimal" placeholder="grams" aria-label="Grams" @keydown.esc.prevent="adding = null" />
        <span class="text-ink-faint">g</span>
        <button type="submit" class="rounded-md bg-ink px-2 py-1 text-xs font-medium text-surface disabled:opacity-40" :disabled="!num(addGrams)">Add</button>
      </form>
      <div v-else class="relative mt-1">
        <input
          v-model="search"
          class="w-full rounded-md px-1.5 py-1 text-sm outline-none placeholder:text-ink-faint focus:bg-hover max-md:py-2"
          placeholder="+ Add an ingredient"
          aria-label="Add an ingredient"
          @focus="searchOpen = true"
          @blur="searchOpen = false"
          @keydown.enter.prevent="matches[0] && choose(matches[0].id, matches[0].title)"
        />
        <div v-if="searchOpen && matches.length" class="absolute left-0 right-0 z-10 mt-1 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <button v-for="m in matches" :key="m.id" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover" @mousedown.prevent="choose(m.id, m.title)">
            <AppIcon :fallback="isRecipe(m) ? 'ph:cooking-pot' : 'ph:bowl-food'" class="text-ink-faint" />
            <span class="truncate">{{ m.title || 'Untitled' }}</span>
          </button>
        </div>
        <p v-else-if="searchOpen && !library.sources.value.length" class="px-1.5 py-1 text-xs text-ink-faint">No foods yet: make some from "Log food" on a day, or New Food.</p>
      </div>

      <div v-if="facts && ingredients.length" class="mt-3 space-y-1 rounded-lg bg-hover/60 px-3 py-2 text-ink-soft" data-recipe-facts>
        <div>
          Makes <span class="tabular-nums">{{ formatGrams(facts.grams) }} g</span>
          <span v-if="facts.grams !== facts.ingredientGrams" class="text-ink-faint">(ingredients {{ formatGrams(facts.ingredientGrams) }} g)</span>
        </div>
        <div v-if="facts.per100">Per 100 g: <NutrientLine :nutrients="facts.per100" /></div>
        <div v-if="facts.per100 && facts.servingGrams">Per serving ({{ formatGrams(facts.servingGrams) }} g): <NutrientLine :nutrients="scaleNutrients(facts.per100, facts.servingGrams)" /></div>
        <div v-if="facts.missing.length" class="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AppIcon fallback="ph:warning" :size="13" /> {{ facts.missing.length }} {{ facts.missing.length === 1 ? 'ingredient has' : 'ingredients have' }} no nutrition data; the numbers leave {{ facts.missing.length === 1 ? 'it' : 'them' }} out.
        </div>
      </div>
    </template>

    <!-- Food: portions. -->
    <template v-else>
      <h2 class="mb-1 flex items-center gap-1.5 font-semibold text-ink-soft"><AppIcon fallback="ph:scales" /> Portions</h2>
      <p class="mb-2 text-xs text-ink-faint">Log it by these besides grams: "2 slices". The numbers above are per 100 g.</p>
      <div class="space-y-1">
        <div v-for="(portion, index) in portions" :key="index" class="flex items-center gap-2">
          <span class="text-ink-faint">1</span>
          <input :value="portion.name" :class="small" class="min-w-0 flex-1" :aria-label="`Portion ${index + 1} name`" @change="changePortion(index, 'name', ($event.target as HTMLInputElement).value)" />
          <span class="text-ink-faint">=</span>
          <input :value="formatGrams(portion.grams)" :class="small" class="w-20 text-right" inputmode="decimal" :aria-label="`Portion ${index + 1} grams`" @change="changePortion(index, 'grams', ($event.target as HTMLInputElement).value)" />
          <span class="text-ink-faint">g</span>
          <button class="rounded p-1 text-ink-faint hover:text-red-600" title="Remove" @click="setPortions(portions.filter((_, i) => i !== index))"><AppIcon fallback="ph:x" :size="13" /></button>
        </div>
        <form class="flex items-center gap-2" @submit.prevent="addPortion">
          <span class="text-ink-faint">1</span>
          <input v-model="newPortion.name" :class="small" class="min-w-0 flex-1" placeholder="slice, cup, unit…" aria-label="New portion name" />
          <span class="text-ink-faint">=</span>
          <input v-model="newPortion.grams" :class="small" class="w-20 text-right" inputmode="decimal" placeholder="g" aria-label="New portion grams" />
          <span class="text-ink-faint">g</span>
          <button type="submit" class="rounded p-1 text-ink-faint hover:text-ink disabled:opacity-40" title="Add portion" :disabled="!newPortion.name.trim() || !num(newPortion.grams)"><AppIcon fallback="ph:plus" :size="13" /></button>
        </form>
      </div>
    </template>

    <p v-if="inRecipes.length" class="mt-3 text-xs text-ink-faint">
      In
      <template v-for="(r, index) in inRecipes" :key="r.id"><ObjectLink :id="r.id" class="text-ink-soft hover:underline">{{ r.title || 'Untitled' }}</ObjectLink>{{ index < inRecipes.length - 1 ? ', ' : '.' }}</template>
    </p>
    <p v-if="usage" class="mt-1 text-xs text-ink-faint">
      <template v-if="usage.count">Eaten {{ usage.count }} {{ usage.count === 1 ? 'time' : 'times' }} in the last year, last on {{ formatLongDay(`${usage.lastDay}T00:00:00.000Z`) }}.</template>
      <template v-else>Not eaten in the last year.</template>
    </p>
  </section>
</template>
