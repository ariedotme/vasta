<script setup lang="ts">
// Logging food on a day: search the foods and recipes (the ones eaten most lately first), pick
// one, type an amount ("150", "2 slices", "1 serving"), Enter. The picker stays open for the next
// item and lists what was added. A food not found can be made right here with its nutrition. A
// search with kcal in it ("muffin 350 kcal", "300 kcal") logs just those numbers, without a food.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  AmountError,
  addDays,
  foodBrand,
  foodNutrients,
  frequentSources,
  isRecipe,
  parseAmount,
  portionsValue,
  quickEntry,
  readQuickEntry,
  recipeFacts,
  scaleNutrients,
  sourcePortions,
  type Id,
  type Meal,
  type ObjectRecord,
  type ObjectSummary,
  type PropertyValue,
} from '@vasta/core'
import { createObject, dayKey } from '../../lib/actions.ts'
import { dailyNotesBetween, entryTime, formatGrams, formatKcal, logEntry, meals, nutritionTypeId, writeEntries } from '../../lib/nutrition.ts'
import { lastError } from '../../lib/state.ts'
import { isTouch } from '../../lib/viewport.ts'
import AppIcon from '../AppIcon.vue'
import ModalDialog from '../ModalDialog.vue'

const props = defineProps<{ day: string; meal?: Meal | undefined; sources: ObjectSummary[]; lookup: (id: Id) => ObjectSummary | undefined }>()
const emit = defineEmits<{ close: []; logged: [note: ObjectRecord] }>()

const mealId = ref(props.meal?.id ?? '')
const chosenMeal = computed(() => meals.value.find((m) => m.id === mealId.value))
const query = ref('')
const picked = ref<ObjectSummary | null>(null)
const amount = ref('')
const added = ref<{ name: string; amount: string; kcal?: number }[]>([])
const busy = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
const amountInput = ref<HTMLInputElement | null>(null)
const highlighted = ref(0)

/** Eaten in the last 30 days, most often first. */
const frequent = ref<Id[]>([])
onMounted(async () => {
  focusSearch()
  const notes = await dailyNotesBetween(addDays(dayKey(), -30), dayKey())
  frequent.value = frequentSources([...notes.values()], addDays(dayKey(), -30))
})

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const results = computed(() => {
  const q = fold(query.value.trim())
  const live = props.sources.filter((s) => !s.deletedAt)
  if (!q) {
    const rank = new Map(frequent.value.map((id, i) => [id, i]))
    return [...live].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.title.localeCompare(b.title)).slice(0, 50)
  }
  const words = q.split(/\s+/)
  return live
    .filter((s) => words.every((w) => fold(`${s.title} ${foodBrand(s)}`).includes(w)))
    .sort((a, b) => Number(!fold(a.title).startsWith(q)) - Number(!fold(b.title).startsWith(q)) || a.title.localeCompare(b.title))
    .slice(0, 50)
})
watch(results, () => (highlighted.value = 0))

/** The search read as a quick entry: kcal (and macros) typed with or without a name. */
const quick = computed(() => readQuickEntry(query.value))

async function logQuick() {
  const q = quick.value
  if (!q || busy.value) return
  busy.value = true
  try {
    const meal = chosenMeal.value
    const note = await writeEntries(props.day, undefined, { [crypto.randomUUID()]: quickEntry(q.name, q.nutrients, entryTime(props.day, meal), meal?.id) })
    added.value.unshift({ name: q.name || 'Quick entry', amount: '', kcal: q.nutrients.kcal })
    emit('logged', note)
    query.value = ''
    focusSearch()
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    busy.value = false
  }
}

/** "130 kcal / 100 g", or a recipe's serving. */
function describe(source: ObjectSummary): string {
  if (isRecipe(source)) {
    const facts = recipeFacts(source, props.lookup)
    if (facts.servingGrams && facts.per100) return `${formatKcal(scaleNutrients(facts.per100, facts.servingGrams).kcal)} kcal / serving`
    return facts.per100 ? `${formatKcal(facts.per100.kcal)} kcal / 100 g` : 'no ingredients with data yet'
  }
  const per100 = foodNutrients(source)
  return per100 ? `${formatKcal(per100.kcal)} kcal / 100 g` : 'no nutrition data yet'
}

const portions = computed(() => (picked.value ? sourcePortions(picked.value, props.lookup) : []))
/** What the amount typed comes to: its grams and kcal, or why it can't be read. */
const preview = computed((): { text: string; error: boolean; kcal?: number } => {
  if (!picked.value || !amount.value.trim()) return { text: '', error: false }
  try {
    const { grams } = parseAmount(amount.value, portions.value)
    const per100 = isRecipe(picked.value) ? recipeFacts(picked.value, props.lookup).per100 : foodNutrients(picked.value)
    const kcal = per100 ? scaleNutrients(per100, grams).kcal : undefined
    return { text: `${formatGrams(grams)} g${kcal !== undefined ? ` · ${formatKcal(kcal)} kcal` : ''}`, error: false, ...(kcal !== undefined ? { kcal } : {}) }
  } catch (error) {
    return { text: error instanceof AmountError ? error.message : String(error), error: true }
  }
})

function focusSearch() {
  void nextTick(() => searchInput.value?.focus())
}

function pick(source: ObjectSummary) {
  picked.value = source
  amount.value = ''
  void nextTick(() => amountInput.value?.focus())
}

function back() {
  picked.value = null
  focusSearch()
}

function onSearchKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') highlighted.value = Math.min(highlighted.value + 1, results.value.length - 1)
  else if (event.key === 'ArrowUp') highlighted.value = Math.max(highlighted.value - 1, 0)
  else if (event.key === 'Enter') {
    if (quick.value) {
      event.preventDefault()
      return void logQuick()
    }
    const source = results.value[highlighted.value]
    if (source) pick(source)
    else if (query.value.trim()) startCreating()
  } else return
  event.preventDefault()
}

async function log() {
  if (!picked.value || busy.value || preview.value.error || !amount.value.trim()) return
  busy.value = true
  try {
    const note = await logEntry(props.day, picked.value.id, amount.value, chosenMeal.value)
    const { kcal } = preview.value
    added.value.unshift({ name: picked.value.title, amount: amount.value.trim(), ...(kcal !== undefined ? { kcal } : {}) })
    emit('logged', note)
    picked.value = null
    query.value = ''
    focusSearch()
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    busy.value = false
  }
}

// A new food ------------------------------------------------------------------
const creating = ref(false)
const form = ref({ name: '', brand: '', base: '100', kcal: '', protein: '', carbs: '', fat: '', fiber: '', portion: '', portionGrams: '' })
const num = (text: string) => {
  const value = Number(text.replace(',', '.'))
  return text.trim() && Number.isFinite(value) && value >= 0 ? value : undefined
}

function startCreating() {
  form.value = { ...form.value, name: query.value.trim(), brand: '', kcal: '', protein: '', carbs: '', fat: '', fiber: '', portion: '', portionGrams: '' }
  creating.value = true
}

/** Make the food (numbers as typed per its base amount, kept per 100 g) and go on to its amount. */
async function createFood() {
  const f = form.value
  const base = num(f.base) || 100
  if (!f.name.trim()) return
  const per100 = (text: string) => {
    const value = num(text)
    return value === undefined ? undefined : Math.round((value * 100 * 100) / base) / 100
  }
  const props: Record<string, PropertyValue> = {}
  for (const key of ['kcal', 'protein', 'carbs', 'fat', 'fiber'] as const) {
    const value = per100(f[key])
    if (value !== undefined) props[key] = { kind: 'number', value }
  }
  if (f.brand.trim()) props.brand = { kind: 'text', value: f.brand.trim() }
  const portionGrams = num(f.portionGrams)
  if (f.portion.trim() && portionGrams) props.portions = portionsValue([{ name: f.portion.trim(), grams: portionGrams }])
  busy.value = true
  try {
    const food = await createObject(nutritionTypeId('food'), { title: f.name.trim(), props }, false)
    creating.value = false
    const { content: _content, ...summary } = food
    pick({ ...summary, preview: '' })
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    busy.value = false
  }
}

const input = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-line-strong max-md:py-2.5 max-md:text-base'
const small = 'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-line-strong max-md:py-2 max-md:text-base'
</script>

<template>
  <ModalDialog :title="`Log food${chosenMeal ? ` · ${chosenMeal.name}` : ''}`" width="34rem" @close="emit('close')">
    <template #icon><AppIcon fallback="ph:bowl-food" class="text-ink-soft" /></template>

    <div class="mb-3 flex flex-wrap gap-1.5">
      <button
        v-for="m in meals"
        :key="m.id"
        class="rounded-full px-2.5 py-1 text-xs ring-1 max-md:px-3 max-md:py-1.5 max-md:text-sm"
        :class="mealId === m.id ? 'bg-ink text-surface ring-ink' : 'text-ink-soft ring-line hover:bg-hover'"
        @click="mealId = m.id"
      >
        {{ m.name }}
      </button>
    </div>

    <!-- A new food: its nutrition, then its amount. -->
    <form v-if="creating" class="space-y-3" @submit.prevent="createFood">
      <div class="grid grid-cols-[1fr_auto] gap-2">
        <input v-model="form.name" :class="input" placeholder="Name" aria-label="Name" />
        <input v-model="form.brand" :class="input" class="w-32" placeholder="Brand" aria-label="Brand" />
      </div>
      <div class="flex items-center gap-2 text-sm text-ink-soft">
        Nutrition per
        <input v-model="form.base" :class="small" class="w-16" inputmode="decimal" aria-label="Base amount in grams" /> g
        <span class="text-xs text-ink-faint">(as on the label; kept per 100 g)</span>
      </div>
      <div class="grid grid-cols-5 gap-2 max-md:grid-cols-3">
        <label v-for="[key, name] in [['kcal', 'kcal'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['fiber', 'Fiber']] as const" :key="key" class="text-xs text-ink-faint">
          {{ name }}
          <input v-model="form[key]" :class="small" class="mt-0.5" inputmode="decimal" :placeholder="key === 'kcal' ? '0' : 'g'" />
        </label>
      </div>
      <div class="flex items-center gap-2 text-sm text-ink-soft">
        1
        <input v-model="form.portion" :class="small" class="flex-1" placeholder="portion (slice, cup…), optional" aria-label="Portion name" />
        =
        <input v-model="form.portionGrams" :class="small" class="w-20" inputmode="decimal" placeholder="g" aria-label="Portion grams" /> g
      </div>
      <div class="flex gap-2">
        <button type="submit" class="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40" :disabled="busy || !form.name.trim()">Create food</button>
        <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-ink-soft hover:bg-hover" @click="creating = false">Cancel</button>
      </div>
      <p class="text-xs text-ink-faint">Without kcal it is logged as "needs nutrition data"; fill it in on the food's page later.</p>
    </form>

    <!-- The amount of the food picked. -->
    <form v-else-if="picked" class="space-y-3" @submit.prevent="log">
      <div class="flex items-center gap-2">
        <button type="button" class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Back to the list" @click="back"><AppIcon fallback="ph:arrow-left" /></button>
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">{{ picked.title || 'Untitled' }}</div>
          <div class="text-xs text-ink-faint">{{ describe(picked) }}</div>
        </div>
      </div>
      <input
        ref="amountInput"
        v-model="amount"
        :class="input"
        :placeholder="portions[0] ? `150 g, or 1 ${portions[0].name}` : '150 g'"
        aria-label="Amount"
        enterkeyhint="done"
        @keydown.esc.prevent.stop="back"
      />
      <div v-if="portions.length" class="flex flex-wrap gap-1.5">
        <button
          v-for="p in portions"
          :key="p.name"
          type="button"
          class="rounded-full px-2.5 py-1 text-xs text-ink-soft ring-1 ring-line hover:bg-hover max-md:py-1.5 max-md:text-sm"
          @click="amount = `1 ${p.name}`; amountInput?.focus()"
        >
          1 {{ p.name }} <span class="text-ink-faint">{{ formatGrams(p.grams) }} g</span>
        </button>
      </div>
      <div class="flex items-center gap-3">
        <button type="submit" class="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40 max-md:px-4 max-md:py-2" :disabled="busy || !amount.trim() || preview.error">Log</button>
        <span class="text-sm" :class="preview.error ? 'text-red-600 dark:text-red-400' : 'tabular-nums text-ink-soft'">{{ preview.text }}</span>
      </div>
    </form>

    <!-- Search. -->
    <template v-else>
      <input ref="searchInput" v-model="query" :class="input" placeholder="Search foods and recipes" aria-label="Search foods and recipes" @keydown="onSearchKey" />
      <div class="mt-2 max-h-[45vh] overflow-y-auto max-md:max-h-none">
        <button v-if="quick" class="mb-1 flex w-full items-center gap-2.5 rounded-lg bg-hover px-2.5 py-2 text-left text-sm max-md:py-3" data-quick-entry :disabled="busy" @click="logQuick">
          <AppIcon fallback="ph:lightning" class="shrink-0 text-ink-faint" />
          <span class="min-w-0 flex-1 truncate">Log {{ quick.name ? `“${quick.name}”` : 'just the kcal' }} <span class="text-ink-faint">without a food</span></span>
          <span class="shrink-0 text-xs tabular-nums text-ink-faint">
            {{ formatKcal(quick.nutrients.kcal) }} kcal<template v-if="quick.nutrients.protein"> · {{ formatGrams(quick.nutrients.protein) }} g protein</template>
          </span>
        </button>
        <button
          v-for="(source, index) in results"
          :key="source.id"
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm max-md:py-3"
          :class="index === highlighted && !isTouch ? 'bg-hover' : 'hover:bg-hover'"
          @click="pick(source)"
          @mousemove="highlighted = index"
        >
          <AppIcon :fallback="isRecipe(source) ? 'ph:cooking-pot' : 'ph:bowl-food'" class="shrink-0 text-ink-faint" />
          <span class="min-w-0 flex-1 truncate">{{ source.title || 'Untitled' }}<span v-if="foodBrand(source)" class="text-ink-faint"> · {{ foodBrand(source) }}</span></span>
          <span class="shrink-0 text-xs tabular-nums text-ink-faint">{{ describe(source) }}</span>
        </button>
        <p v-if="!results.length && !query.trim()" class="px-2.5 py-3 text-sm text-ink-faint">No foods yet. Type a name to create the first one.</p>
        <p v-if="!query.trim()" class="px-2.5 pt-2 text-xs text-ink-faint">Not sure what it was? Type its kcal: “muffin ~350 kcal”, “300 kcal”.</p>
        <button v-if="query.trim() && !quick" class="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-accent hover:bg-hover max-md:py-3" @click="startCreating">
          <AppIcon fallback="ph:plus" /> Create food “{{ query.trim() }}”
        </button>
      </div>
    </template>

    <div v-if="added.length" class="mt-4 border-t border-line pt-3">
      <div class="mb-1 text-xs font-medium text-ink-faint">Added</div>
      <div v-for="(item, index) in added" :key="index" class="flex items-center gap-2 py-0.5 text-sm">
        <AppIcon fallback="ph:check" class="text-emerald-600 dark:text-emerald-400" :size="14" />
        <span class="min-w-0 flex-1 truncate">{{ item.name }} <span class="text-ink-faint">{{ item.amount }}</span></span>
        <span v-if="item.kcal !== undefined" class="text-xs tabular-nums text-ink-faint">{{ formatKcal(item.kcal) }} kcal</span>
      </div>
    </div>
  </ModalDialog>
</template>
