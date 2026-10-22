<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ARTICLE_PROPERTY_ID, HABIT_REMIND_PROPERTY_ID, afterSave, canonicalJson, formulaFromNames, formulaToNames, habitRemindAt, type ColorName, type DateValue, type Doc, type Icon, type ObjectRecord, type ObjectSummary, type PropertyDef, type PropertyValue, type QueryDef, type SelectOption } from '@vasta/core'
import AppIcon from '../components/AppIcon.vue'
import BacklinksPanel from '../components/BacklinksPanel.vue'
import ObjectActivity from '../components/ObjectActivity.vue'
import ObjectComments from '../components/ObjectComments.vue'
import SprintPanel from '../components/SprintPanel.vue'
import DateValueEditor from '../components/DateValueEditor.vue'
import IconPicker from '../components/IconPicker.vue'
import MediaView from '../components/MediaView.vue'
import ObjectChip from '../components/ObjectChip.vue'
import ObjectPicker from '../components/ObjectPicker.vue'
import ColorPicker from '../components/ColorPicker.vue'
import TagPanel from '../components/TagPanel.vue'
import HabitChecklist from '../components/HabitChecklist.vue'
import HabitStats from '../components/HabitStats.vue'
import FoodDay from '../components/nutrition/FoodDay.vue'
import FoodPanel from '../components/nutrition/FoodPanel.vue'
import { isNutrientKey, nutrientColor } from '../lib/nutrition.ts'
import { habitColor } from '../lib/habits.ts'
import PopoverMenu from '../components/PopoverMenu.vue'
import PropertyDisplay from '../components/PropertyDisplay.vue'
import PropertyValueEditor from '../components/PropertyValueEditor.vue'
import QueryEditor from '../components/QueryEditor.vue'
import QueryResults from '../components/QueryResults.vue'
import ReverseRelations from '../components/ReverseRelations.vue'
import WeblinkPanel from '../components/WeblinkPanel.vue'
import DocEditor from '../editor/DocEditor.vue'
import { dayKey, deleteForeverFlow, deleteObjectFlow, isInSidebar, openDay, pinItems, restoreObjectFlow, tagFromPath } from '../lib/actions.ts'
import { api, mediaUrl, serverApi } from '../lib/api.ts'
import { onChange } from '../lib/events.ts'
import { offline } from '../lib/network.ts'
import { openText, useReplica, type TextSession } from '../lib/replica.ts'
import { PAGE_OBJECT_ID } from '../lib/page.ts'
import { clone } from '../lib/clone.ts'
import { chip, iconTextClasses, swatchClasses } from '../lib/colors.ts'
import { colorSource, tagAncestors, tagColor } from '../lib/tags.ts'
import { displayTitle, formatDate, formatRelative } from '../lib/format.ts'
import { PROPERTY_KINDS, formulaValue, kindIcon, newPropertyDef } from '../lib/properties.ts'
import { lastError, primeFromObject, replaceType, systemType, typesById, workspace } from '../lib/state.ts'
import { personName, sharedSpace } from '../lib/people.ts'
import { openMenuAt, promptDialog, type MenuItem } from '../lib/overlays.ts'

/** `embedded`: only the text and what links here, inside another page (the calendar's day). */
const props = defineProps<{ id: string; embedded?: boolean; backlinksTitle?: string }>()
const route = useRoute()
const router = useRouter()
provide(PAGE_OBJECT_ID, props.id)

const object = ref<ObjectRecord | null>(null)
const missing = ref(false)
const status = ref<'saved' | 'saving' | 'unsaved'>('saved')
const titleInput = ref<HTMLTextAreaElement | null>(null)

const type = computed(() => typesById.value.get(object.value?.typeId ?? ''))
const tagType = computed(() => systemType('tag'))
/** Rich-text fields; one marked "hide when empty" (a weblink's readable text) shows once it has content. */
const richFields = computed(() =>
  (type.value?.properties ?? []).filter((p) => p.kind === 'rich-text' && (!p.hideWhenEmpty || object.value?.content[p.id]?.content.length))
)
const valueFields = computed(() => (type.value?.properties ?? []).filter((p) => p.kind !== 'rich-text'))
const hasValue = (def: PropertyDef) => (def.kind === 'formula' ? !!object.value && formulaValue(object.value, def).kind !== 'empty' : !!object.value?.props[def.id])
/** Fields shown only once they have a value: marked so, or a person field in a space nobody else is in. */
const quiet = (def: PropertyDef) => def.hideWhenEmpty || (def.kind === 'person' && !sharedSpace.value)
const visibleFields = computed(() => valueFields.value.filter((p) => !quiet(p) || hasValue(p) || showAllFields.value))
/** Who made it and who changed it last, in a shared space. */
const authorship = computed(() => {
  const o = object.value
  if (!o || !sharedSpace.value) return { by: '', title: '' }
  const by = o.updatedBy ? ` by ${personName(o.updatedBy)}` : ''
  const created = `Created ${formatRelative(o.createdAt)}${o.createdBy ? ` by ${personName(o.createdBy)}` : ''}`
  return { by, title: created }
})
const showAllFields = ref(false)
const hiddenCount = computed(() => valueFields.value.length - visibleFields.value.length)
const isNew = computed(() => route.query.new === '1')
/** A link to one of the text's blocks (#b-<id>): the editors scroll to it. */
const linkedBlock = computed(() => (route.hash.startsWith('#b-') ? route.hash.slice(3) : undefined))
/** Dashboards built with columns need room; everything else reads better at text width. */
const wide = computed(() => Object.values(object.value?.content ?? {}).some((doc) => doc.content.some((node) => node.type === 'columns')))

let timer: ReturnType<typeof setTimeout> | undefined

/**
 * With the local replica, the rich text is edited in the object's Y.Doc (merged live with other
 * devices), and a save writes only the fields changed since `base`, the copy last loaded or saved.
 */
const text = shallowRef<TextSession | null>(null)
let base: ObjectRecord | undefined
const textFields = computed(() => Object.fromEntries(richFields.value.map((p) => [p.id, text.value ? { doc: text.value.doc, field: p.id } : undefined])))
/** Editors wait for the text session when the replica runs. */
const editorsReady = ref(false)

async function save() {
  clearTimeout(timer)
  if (!object.value || status.value !== 'unsaved') return
  status.value = 'saving'
  try {
    const sent = clone(object.value)
    // Without a text session the editors edit JSON (this tab had no replica when the page opened).
    const saved = await (text.value ? api : serverApi).saveObject(object.value, base)
    base = clone(saved)
    primeFromObject(saved)
    // The saved copy has what changed elsewhere meanwhile (fields, items captured into the text);
    // show it, keeping what was typed during the save.
    if (object.value) assignChanged(object.value, afterSave(object.value, sent, saved))
    if (status.value !== 'saving') return // edited while saving: the next save sends that
    status.value = 'saved'
  } catch {
    status.value = 'unsaved'
  }
}

// A save that failed for lack of a network goes again once the server is back.
watch(offline, (value) => {
  if (!value && status.value === 'unsaved') void save()
})

/** Set the keys of `target` that differ in `next` (and drop those `next` lacks), leaving the rest untouched. */
function assignChanged(target: ObjectRecord, next: ObjectRecord) {
  const into = target as unknown as Record<string, unknown>
  const from = next as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(into), ...Object.keys(from)])) {
    if (canonicalJson(into[key] ?? null) === canonicalJson(from[key] ?? null)) continue
    if (key in from) into[key] = from[key]
    else delete into[key]
  }
}

/** Another channel changed this object (e.g. a Telegram capture): reload it unless there are unsaved edits. */
async function reloadIfIdle(updatedAt: string) {
  // Not `<=`: a change merged from elsewhere may leave updatedAt as it was (an older offline edit).
  if (!object.value || status.value !== 'saved' || updatedAt < object.value.updatedAt) return
  const fresh = await api.object(props.id).catch(() => undefined)
  if (!fresh || status.value !== 'saved' || !object.value) return // the user started typing; their save merges captures
  base = clone(fresh)
  primeFromObject(fresh)
  // In place, so only what changed is shown again (with a text session the editors have the text already).
  assignChanged(object.value, fresh)
}

const stopListening = onChange((event) => {
  if (event.kind === 'object' && event.id === props.id) void reloadIfIdle(event.updatedAt)
})

function changed() {
  status.value = 'unsaved'
  clearTimeout(timer)
  timer = setTimeout(save, 500)
}

function autosize() {
  const el = titleInput.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

onMounted(async () => {
  try {
    object.value = await api.object(props.id)
    base = clone(object.value)
    primeFromObject(object.value)
  } catch {
    missing.value = true
    return
  }
  if (useReplica()) text.value = await openText(props.id).catch(() => null)
  editorsReady.value = true
  await nextTick()
  autosize()
  if (typeof route.query.capture === 'string') revealCapture(route.query.capture)
  // A new weblink starts with its address field (WeblinkPanel focuses it).
  if (isNew.value && !(isWeblink.value && !object.value.media?.url)) titleInput.value?.focus()
})
onBeforeUnmount(() => {
  stopListening()
  void save()
  text.value?.release()
})

// Cover ---------------------------------------------------------------------
// An uploaded picture becomes an image object of the space (like images in notes), and the cover
// points at its file; a URL is used as it is.
const coverInput = ref<HTMLInputElement | null>(null)
const coverUploading = ref(false)

function setCover(url: string | undefined) {
  if (!object.value) return
  if (url) object.value.coverUrl = url
  else delete object.value.coverUrl
  changed()
}

async function uploadCover(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !object.value) return
  coverUploading.value = true
  try {
    const image = await api.uploadFile(object.value.spaceId, file)
    if (image.media?.file) setCover(mediaUrl(image.media.file.key))
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    coverUploading.value = false
  }
}

async function coverFromUrl() {
  const url = await promptDialog({ title: 'Cover from a URL', placeholder: 'https://…/picture.jpg', value: object.value?.coverUrl?.startsWith('http') ? object.value.coverUrl : '', confirmLabel: 'Use' })
  if (url === null) return
  if (!/^https?:\/\/\S+$/i.test(url.trim())) {
    lastError.value = 'The cover URL must start with http:// or https://'
    return
  }
  setCover(url.trim())
}

function coverMenu(x: number, y: number) {
  menuOpen.value = false
  openMenuAt(x, y, [
    { label: 'Upload a picture…', icon: 'ph:upload-simple', run: () => coverInput.value?.click() },
    { label: 'Use a URL…', icon: 'ph:link-simple', run: coverFromUrl },
    ...(object.value?.coverUrl ? [{ kind: 'separator' } as MenuItem, { label: 'Remove cover', icon: 'ph:trash', danger: true, run: () => setCover(undefined) }] : []),
  ])
}

function coverMenuFrom(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  coverMenu(rect.left, rect.bottom + 4)
}

/** Scroll to a captured item ("Open in the daily note" from the inbox) and flash it. */
function revealCapture(id: string, tries = 20) {
  const element = article.value?.querySelector<HTMLElement>(`[data-capture-id="${CSS.escape(id)}"]`)
  if (!element) {
    // The editor renders its content a moment after the page.
    if (tries > 0) setTimeout(() => revealCapture(id, tries - 1), 100)
    return
  }
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element.classList.add('vasta-flash')
  setTimeout(() => element.classList.remove('vasta-flash'), 1600)
}

function setContent(field: string, doc: Doc) {
  if (!object.value) return
  object.value.content[field] = doc
  // Text edited in the Y.Doc is already in the replica; the copy here only feeds the page's layout.
  if (!text.value) changed()
}

// Weblinks ------------------------------------------------------------------
const isWeblink = computed(() => type.value?.system === 'weblink')

/** Save pending edits, run a change on the server (new address, readable text…) and show the result. */
async function applyServerChange(run: () => Promise<ObjectRecord>) {
  clearTimeout(timer)
  if (status.value === 'unsaved') await save()
  const fresh = await run()
  primeFromObject(fresh)
  if (!object.value) return
  if (status.value === 'saved') {
    base = clone(fresh)
    object.value = fresh
    await nextTick()
    autosize()
    return
  }
  // Typed while the server worked: keep the edits, take what the server owns.
  if (fresh.media) object.value.media = fresh.media
  const article = fresh.content[ARTICLE_PROPERTY_ID]
  if (article) object.value.content[ARTICLE_PROPERTY_ID] = article
}

// Query objects -------------------------------------------------------------
const isQuery = computed(() => type.value?.system === 'query')
const queryOpen = ref(true)
function setQuery(query: QueryDef) {
  if (!object.value) return
  object.value.query = query
  changed()
}

/**
 * The object's own date (what the calendar shows for date objects and others that have one). A
 * daily note's day is what makes it that day's note, so it is not edited here. The row stays once
 * shown, so clearing the date does not make it vanish.
 */
const ownDateSeen = ref(false)
const showOwnDate = computed(() => {
  const system = type.value?.system
  if (!object.value || system === 'daily-note') return false
  return system === 'date' || !!object.value.date || ownDateSeen.value
})
watch(showOwnDate, (value) => value && (ownDateSeen.value = true))

function setOwnDate(value: DateValue | undefined) {
  if (!object.value) return
  if (value) object.value.date = value
  else delete object.value.date
  changed()
}

/** A habit's reminder time from the time field ("" clears it). */
const setRemindAt = (def: PropertyDef, time: string) => setProp(def, time ? { kind: 'text', value: time } : undefined)

/** Food and recipe pages edit their portions and ingredients, props without a definition. */
const isFoodOrRecipe = computed(() => type.value?.system === 'food' || type.value?.system === 'recipe')
function setRawProp(key: string, value: PropertyValue | undefined) {
  if (!object.value) return
  if (value) object.value.props[key] = value
  else delete object.value.props[key]
  changed()
}

function setProp(def: PropertyDef, value: PropertyValue | undefined) {
  if (!object.value) return
  if (value) object.value.props[def.id] = value
  else delete object.value.props[def.id]
  changed()
}

async function addOption(def: PropertyDef, option: SelectOption) {
  if (!type.value || def.kind !== 'select') return
  const next = clone(type.value)
  const target = next.properties.find((p) => p.id === def.id)
  if (target?.kind === 'select') target.options.push(option)
  replaceType(await api.saveType(next))
}

// Tags ---------------------------------------------------------------------
const tagAnchor = ref<HTMLElement | null>(null)
const tagOpen = ref(false)

function addTag(tag: ObjectSummary) {
  if (!object.value || object.value.tagIds.includes(tag.id)) return
  object.value.tagIds.push(tag.id)
  tagOpen.value = false
  changed()
}

/** "recipe/breakfast" finds or makes recipe, then breakfast under it (lib/tags.ts). */
async function createTag(title: string) {
  try {
    const tag = await tagFromPath(title)
    if (tag) addTag({ preview: '', ...tag })
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

// A tag's or a habit's own color, and a tag's parent tag ------------------
const isTagObject = computed(() => type.value?.system === 'tag')
const isHabit = computed(() => type.value?.system === 'habit')
/** The color shown in the Color row: a tag's own or inherited one, a habit's own or the default. */
const shownColor = computed(() => (isHabit.value ? habitColor(object.value ?? undefined) : tagColor(object.value ?? undefined)))
const colorAnchor = ref<HTMLElement | null>(null)
const colorOpen = ref(false)
const parentAnchor = ref<HTMLElement | null>(null)
const parentOpen = ref(false)

function setColor(color: ColorName | undefined) {
  if (!object.value) return
  if (color) object.value.color = color
  else delete object.value.color
  colorOpen.value = false
  changed()
}

function setParent(parent: Pick<ObjectSummary, 'id' | 'parentId'> | undefined) {
  if (!object.value) return
  parentOpen.value = false
  if (parent && (parent.id === object.value.id || tagAncestors(parent).some((t) => t.id === object.value!.id))) {
    lastError.value = 'That tag is under this one: it cannot be its parent too.'
    return
  }
  if (parent) object.value.parentId = parent.id
  else delete object.value.parentId
  changed()
}

async function createParent(title: string) {
  try {
    setParent(await tagFromPath(title))
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

function removeTag(id: string) {
  if (!object.value) return
  object.value.tagIds = object.value.tagIds.filter((t) => t !== id)
  changed()
}

// Icon ---------------------------------------------------------------------
const iconAnchor = ref<HTMLElement | null>(null)
const iconOpen = ref(false)

function setIcon(icon: Icon | undefined) {
  if (!object.value) return
  if (icon) object.value.icon = icon
  else delete object.value.icon
  iconOpen.value = false
  changed()
}

// Properties ---------------------------------------------------------------
const addAnchor = ref<HTMLElement | null>(null)
const addOpen = ref(false)
const newProperty = ref({ name: '', kind: 'text' as PropertyDef['kind'], formula: '' })
const KINDS = PROPERTY_KINDS

async function addProperty() {
  if (!type.value || !newProperty.value.name.trim()) return
  const next = clone(type.value)
  const def = newPropertyDef(newProperty.value.name.trim(), newProperty.value.kind)
  if (def.kind === 'formula') def.expression = formulaFromNames(newProperty.value.formula, next, workspace.types)
  next.properties.push(def)
  replaceType(await api.saveType(next))
  newProperty.value = { name: '', kind: 'text', formula: '' }
  addOpen.value = false
}

// Menu ---------------------------------------------------------------------
const menuAnchor = ref<HTMLElement | null>(null)
const menuOpen = ref(false)

/** The sections to pin the object in, beside the More menu's row. */
function pinFrom(event: MouseEvent) {
  if (!object.value) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  menuOpen.value = false
  openMenuAt(rect.left, rect.top, pinItems(object.value.id))
}

async function remove() {
  if (!object.value) return
  const id = object.value.id
  clearTimeout(timer)
  if (status.value === 'unsaved') await save()
  menuOpen.value = false
  await deleteObjectFlow(id)
}

// An object opened from the trash (or a link to one) says so and can come back or go for good.
async function restore() {
  if (!object.value) return
  const { object: restored } = await restoreObjectFlow(object.value.id)
  base = clone(restored)
  object.value = restored
  menuOpen.value = false
}

async function deleteForever() {
  if (!object.value) return
  menuOpen.value = false
  if (await deleteForeverFlow(object.value.id, displayTitle(object.value, type.value))) await router.push('/trash')
}

const article = ref<HTMLElement | null>(null)
const focusBody = () => article.value?.querySelector<HTMLElement>('.vasta-doc')?.focus()

// Daily notes: step to the previous or next day (created on first open, like Today).
const day = computed(() => (type.value?.system === 'daily-note' ? object.value?.date?.start.slice(0, 10) : undefined))
const isToday = computed(() => day.value === dayKey())
function stepDay(delta: number) {
  if (!day.value) return
  const date = new Date(`${day.value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  void openDay(date.toISOString().slice(0, 10))
}

const titlePlaceholder = computed(() => (object.value ? displayTitle({ ...object.value, title: '' }, type.value) : ''))
</script>

<template>
  <div v-if="missing" class="grid h-full place-items-center text-sm text-ink-soft">This object does not exist or was deleted for good.</div>

  <article v-else-if="object" ref="article" :class="embedded ? '' : 'pb-32'">
    <div v-if="object.deletedAt && !embedded" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
      <AppIcon fallback="ph:trash" class="shrink-0" />
      <span class="min-w-0 flex-1 max-sm:min-w-[80%]">In the trash since {{ formatDate({ start: object.deletedAt, resolution: 'time' }) }}. It goes for good 30 days later.</span>
      <button class="rounded-lg bg-surface px-2.5 py-1 font-medium text-ink shadow-sm ring-1 ring-line hover:bg-hover max-md:py-2" @click="restore">Restore</button>
      <button class="rounded-lg px-2.5 py-1 font-medium hover:bg-red-100 dark:hover:bg-red-900/40 max-md:py-2" @click="deleteForever">Delete forever</button>
    </div>
    <div v-if="object.coverUrl && !embedded" class="group/cover relative h-56 w-full overflow-hidden bg-hover max-md:h-40">
      <img :src="object.coverUrl" alt="" class="h-full w-full object-cover" />
      <button
        class="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg bg-surface/90 px-2.5 py-1 text-xs font-medium text-ink shadow-sm ring-1 ring-line backdrop-blur transition-opacity hover:bg-surface md:opacity-0 md:group-hover/cover:opacity-100 md:focus-visible:opacity-100 [@media(hover:none)]:opacity-100 max-md:py-1.5"
        @click="coverMenuFrom"
      >
        <AppIcon fallback="ph:image" :size="14" /> {{ coverUploading ? 'Uploading…' : 'Change cover' }}
      </button>
    </div>
    <input ref="coverInput" type="file" accept="image/*" class="hidden" @change="uploadCover" />

    <div class="relative" :class="embedded ? '' : ['mx-auto px-6 md:px-10', object.coverUrl ? (object.icon ? '-mt-10' : 'pt-6') : 'pt-8 md:pt-14', wide ? 'max-w-6xl' : 'max-w-3xl']">
      <template v-if="!embedded">
      <button
        v-if="object.icon"
        ref="iconAnchor"
        class="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-surface text-4xl shadow-sm ring-1 ring-line hover:bg-raised"
        title="Change icon"
        @click="iconOpen = !iconOpen"
      >
        <AppIcon :icon="object.icon" :size="40" :class="type?.color && object.icon.kind === 'icon' ? iconTextClasses[type.color] : ''" />
      </button>
      <PopoverMenu v-model:open="iconOpen" :anchor="iconAnchor" width="auto">
        <div class="p-2"><IconPicker :icon="object.icon" allow-remove @pick="setIcon" /></div>
      </PopoverMenu>

      <div class="group/header flex min-h-7 flex-wrap items-center gap-1.5">
        <RouterLink :to="`/t/${object.typeId}`" class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium hover:brightness-95" :class="chip(type?.color)">
          <AppIcon :icon="type?.icon" fallback="ph:cube" :size="13" />{{ type?.name }}
        </RouterLink>
        <div v-if="day" class="flex items-center gap-0.5 text-ink-faint">
          <button class="rounded-md p-1 hover:bg-hover hover:text-ink" title="Previous day" @click="stepDay(-1)"><AppIcon fallback="ph:caret-left" :size="14" /></button>
          <button v-if="!isToday" class="rounded-md px-1.5 py-0.5 text-xs hover:bg-hover hover:text-ink" @click="openDay(dayKey())">Today</button>
          <button class="rounded-md p-1 hover:bg-hover hover:text-ink" title="Next day" @click="stepDay(1)"><AppIcon fallback="ph:caret-right" :size="14" /></button>
        </div>
        <!-- Icon and cover: on hover, so an object without them shows nothing there (always on touch). -->
        <div v-if="!object.deletedAt" class="flex items-center gap-0.5 text-xs text-ink-faint opacity-0 transition-opacity group-hover/header:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <button v-if="!object.icon" ref="iconAnchor" class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-ink" @click="iconOpen = !iconOpen">
            <AppIcon fallback="ph:smiley" :size="14" /> <span class="max-sm:hidden">Icon</span>
          </button>
          <button v-if="!object.coverUrl" class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-ink" @click="coverMenuFrom">
            <AppIcon fallback="ph:image" :size="14" /> <span class="max-sm:hidden">{{ coverUploading ? 'Uploading…' : 'Cover' }}</span>
          </button>
        </div>
        <div class="ml-auto flex items-center gap-1 text-xs text-ink-faint">
          <span :class="status === 'unsaved' && offline ? 'text-amber-600' : status === 'saved' ? 'max-sm:hidden' : ''" :title="authorship.title || undefined">{{ status === 'saved' ? `Edited ${formatRelative(object.updatedAt)}${authorship.by}` : status === 'saving' ? 'Saving…' : offline ? 'Not saved (offline)' : 'Unsaved' }}</span>
          <button ref="menuAnchor" class="grid h-7 w-7 place-items-center rounded-md text-ink-soft ring-1 ring-line hover:bg-hover hover:text-ink max-md:h-9 max-md:w-9" title="More" @click="menuOpen = !menuOpen">
            <AppIcon fallback="ph:dots-three" :size="17" />
          </button>
          <PopoverMenu v-model:open="menuOpen" :anchor="menuAnchor" placement="bottom-end" width="12rem">
            <RouterLink :to="`/t/${object.typeId}`" class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink hover:bg-hover">
              <AppIcon fallback="ph:cube" /> Open type
            </RouterLink>
            <button v-if="!object.deletedAt" class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink hover:bg-hover" @click="pinFrom">
              <AppIcon fallback="ph:push-pin" /> {{ isInSidebar(object.id) ? 'Pinned in sidebar' : 'Pin to sidebar' }}
              <AppIcon fallback="ph:caret-right" :size="12" class="ml-auto text-ink-faint" />
            </button>
            <button v-if="!object.deletedAt" class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink hover:bg-hover" @click="coverMenuFrom">
              <AppIcon fallback="ph:image" /> {{ coverUploading ? 'Uploading cover…' : object.coverUrl ? 'Change cover…' : 'Add cover…' }}
            </button>
            <template v-if="object.deletedAt">
              <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink hover:bg-hover" @click="restore">
                <AppIcon fallback="ph:arrow-counter-clockwise" /> Restore
              </button>
              <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-red-600 hover:bg-hover" @click="deleteForever">
                <AppIcon fallback="ph:trash" /> Delete forever…
              </button>
            </template>
            <button v-else class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-red-600 hover:bg-hover" @click="remove">
              <AppIcon fallback="ph:trash" /> Move to trash
            </button>
          </PopoverMenu>
        </div>
      </div>

      <textarea
        ref="titleInput"
        v-model="object.title"
        data-large-text
        rows="1"
        class="mt-2 w-full resize-none overflow-hidden bg-transparent text-[1.8rem] font-bold md:text-[2.1rem] leading-tight tracking-tight outline-none placeholder:text-ink-faint/60"
        :placeholder="titlePlaceholder"
        @input="autosize(), changed()"
        @keydown.enter.prevent="focusBody"
      />

      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <AppIcon fallback="ph:tag" class="text-ink-faint" />
        <ObjectChip v-for="id in object.tagIds" :key="id" :id="id" tag removable @remove="removeTag(id)" />
        <button ref="tagAnchor" class="rounded-md px-1.5 py-0.5 text-sm text-ink-faint hover:bg-hover hover:text-ink" @click="tagOpen = !tagOpen">
          {{ object.tagIds.length ? '+' : 'Add tags' }}
        </button>
        <PopoverMenu v-model:open="tagOpen" :anchor="tagAnchor" width="16rem">
          <ObjectPicker :type-ids="tagType ? [tagType.id] : []" :exclude="object.tagIds" create-label="New tag" @pick="addTag" @create="createTag" />
        </PopoverMenu>
      </div>

      <div v-if="valueFields.length || type" class="mt-6">
        <div v-if="showOwnDate" class="vasta-prop-row">
          <div class="vasta-prop-name">
            <AppIcon fallback="ph:calendar-blank" class="text-ink-faint" />
            <span class="truncate">Date</span>
          </div>
          <div class="min-h-8 flex min-w-0 flex-1 items-center"><DateValueEditor :value="object.date" @update="setOwnDate" /></div>
        </div>
        <template v-if="isTagObject || isHabit">
          <div class="vasta-prop-row">
            <div class="vasta-prop-name"><AppIcon fallback="ph:palette" class="text-ink-faint" /><span>Color</span></div>
            <div class="flex min-h-8 flex-1 items-center">
              <button ref="colorAnchor" class="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-hover" @click="colorOpen = !colorOpen">
                <span class="h-3.5 w-3.5 rounded-full" :class="swatchClasses[shownColor]" />
                <span v-if="object.color" class="capitalize">{{ object.color }}</span>
                <span v-else class="text-ink-faint">{{ isTagObject && colorSource(object) ? `From ${colorSource(object)!.title}` : 'Default' }}</span>
              </button>
              <PopoverMenu v-model:open="colorOpen" :anchor="colorAnchor" width="auto">
                <div class="space-y-2 p-2">
                  <ColorPicker :color="object.color" @pick="setColor" />
                  <button v-if="object.color" class="w-full rounded-md px-2 py-1 text-left text-xs text-ink-soft hover:bg-hover" @click="setColor(undefined)">{{ object.parentId ? 'Take the parent tag’s color' : 'Use the default color' }}</button>
                </div>
              </PopoverMenu>
            </div>
          </div>
          <div v-if="isTagObject" class="vasta-prop-row">
            <div class="vasta-prop-name"><AppIcon fallback="ph:tree-structure" class="text-ink-faint" /><span>Parent tag</span></div>
            <div class="flex min-h-9 flex-1 flex-wrap items-center gap-1 py-1">
              <ObjectChip v-if="object.parentId" :id="object.parentId" tag removable @remove="setParent(undefined)" />
              <button ref="parentAnchor" class="rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-hover hover:text-ink" @click="parentOpen = !parentOpen">
                {{ object.parentId ? 'Change' : 'None' }}
              </button>
              <PopoverMenu v-model:open="parentOpen" :anchor="parentAnchor" width="16rem">
                <ObjectPicker :type-ids="tagType ? [tagType.id] : []" :exclude="[object.id]" create-label="New tag" @pick="setParent" @create="createParent" />
              </PopoverMenu>
            </div>
          </div>
        </template>
        <div v-for="def in visibleFields" :key="def.id" class="vasta-prop-row">
          <div class="vasta-prop-name">
            <!-- A food's nutrients wear their color, as everywhere else. -->
            <span v-if="isFoodOrRecipe && isNutrientKey(def.id)" class="grid w-4 shrink-0 place-items-center"><span class="h-2.5 w-2.5 rounded-full" :style="{ background: nutrientColor(def.id) }" /></span>
            <AppIcon v-else :icon="def.icon" :fallback="isHabit && def.id === HABIT_REMIND_PROPERTY_ID ? 'ph:alarm' : kindIcon(def.kind)" class="text-ink-faint" />
            <span class="truncate">{{ def.name }}</span>
          </div>
          <!-- A habit's "Remind at" is a time of day, kept as "HH:MM" text. -->
          <div v-if="isHabit && def.id === HABIT_REMIND_PROPERTY_ID" class="flex min-h-8 flex-1 items-center gap-1">
            <input
              type="time"
              :value="habitRemindAt(object) ?? ''"
              class="rounded-md bg-transparent px-2 py-1 tabular-nums outline-none hover:bg-hover focus:bg-hover"
              :class="habitRemindAt(object) ? '' : 'text-ink-faint'"
              @change="setRemindAt(def, ($event.target as HTMLInputElement).value)"
            />
            <button v-if="habitRemindAt(object)" class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="No reminder" @click="setRemindAt(def, '')">
              <AppIcon fallback="ph:x" :size="13" />
            </button>
            <span v-else class="text-xs text-ink-faint">No reminder</span>
          </div>
          <!-- A formula is computed: shown, not edited (its expression is in the type's settings). -->
          <div v-else-if="def.kind === 'formula'" class="flex min-h-8 min-w-0 flex-1 items-center py-1 pl-3.5 pr-2" :title="formulaToNames(def.expression, type!, workspace.types)">
            <PropertyDisplay :def="def" :value="undefined" :object="object" wrap />
          </div>
          <PropertyValueEditor v-else :def="def" :value="object.props[def.id]" @update="setProp(def, $event)" @add-option="addOption(def, $event)" />
        </div>
        <ReverseRelations :object-id="object.id" :type-id="object.typeId" :show-empty="showAllFields" />
        <div class="mt-1 flex gap-3 text-xs text-ink-faint">
          <button v-if="hiddenCount" class="rounded px-1 py-1 hover:text-ink" @click="showAllFields = true">Show {{ hiddenCount }} empty properties</button>
          <button ref="addAnchor" class="flex items-center gap-1 rounded px-1 py-1 hover:text-ink" @click="addOpen = !addOpen">
            <AppIcon fallback="ph:plus" :size="12" /> Add property to {{ type?.name }}
          </button>
        </div>
        <PopoverMenu v-model:open="addOpen" :anchor="addAnchor" width="15rem">
          <input
            v-model="newProperty.name"
            class="mb-1 w-full rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint"
            placeholder="Property name"
            @keydown.enter.prevent="addProperty"
          />
          <button
            v-for="k in KINDS"
            :key="k.kind"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
            :class="newProperty.kind === k.kind ? 'bg-hover' : ''"
            @click="newProperty.kind = k.kind"
          >
            <AppIcon :fallback="k.icon" class="text-ink-soft" /> {{ k.label }}
            <AppIcon v-if="newProperty.kind === k.kind" fallback="ph:check" class="ml-auto text-accent" />
          </button>
          <input
            v-if="newProperty.kind === 'formula'"
            v-model="newProperty.formula"
            class="mt-1 w-full rounded-lg bg-hover px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-ink-faint"
            placeholder="{Price} * {Quantity}"
            @keydown.enter.prevent="addProperty"
          />
          <button class="mt-1 w-full rounded-lg bg-ink px-2.5 py-1.5 text-sm text-surface disabled:opacity-40" :disabled="!newProperty.name.trim()" @click="addProperty">
            Add property
          </button>
        </PopoverMenu>
      </div>

      </template>

      <HabitStats v-if="isHabit && !embedded" :habit="object" />
      <SprintPanel v-if="type?.system === 'sprint' && !embedded && !object.deletedAt" :sprint="object" />
      <HabitChecklist v-if="day && !embedded" :day="day" variant="inline" class="mt-6" />
      <FoodDay v-if="day && !embedded" :key="day" :day="day" class="mt-6" />
      <FoodPanel v-if="isFoodOrRecipe && !embedded" :object="object" class="mt-6" @set="setRawProp" />

      <WeblinkPanel v-if="isWeblink" :object="object" :apply="applyServerChange" :autofocus="isNew" class="mt-6" />
      <MediaView v-else-if="object.media" :media="object.media" :type="type" class="mt-6" />

      <section v-if="isQuery" class="mt-8">
        <div class="rounded-xl border border-line">
          <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-ink-soft hover:text-ink" @click="queryOpen = !queryOpen">
            <AppIcon fallback="ph:sliders-horizontal" /> Query settings
            <AppIcon :fallback="queryOpen ? 'ph:caret-up' : 'ph:caret-down'" class="ml-auto" :size="14" />
          </button>
          <div v-if="queryOpen" class="border-t border-line px-3 py-3">
            <QueryEditor :query="object.query ?? { typeIds: [] }" @update="setQuery" />
          </div>
        </div>
        <QueryResults class="mt-4" :query="object.query ?? { typeIds: [] }" :parent-id="object.id" @table="setQuery({ ...(object.query ?? { typeIds: [] }), table: $event })" @board="setQuery({ ...(object.query ?? { typeIds: [] }), board: $event })" />
      </section>

      <div v-for="(field, index) in richFields" :key="field.id" :class="embedded && index === 0 ? '' : 'mt-8'">
        <h2 v-if="richFields.length > 1 || index > 0" class="mb-2 text-sm font-semibold text-ink-soft">{{ field.name }}</h2>
        <DocEditor
          v-if="editorsReady"
          :key="text ? 'yjs' : 'json'"
          :doc="object.content[field.id]"
          :text="textFields[field.id]"
          :object-id="object.id"
          :reveal="linkedBlock"
          @change="setContent(field.id, $event)"
        />
      </div>

      <ObjectComments v-if="!embedded && !day && !object.deletedAt && !isTagObject" :object="object" />

      <TagPanel v-if="isTagObject && !embedded" :tag-id="object.id" />

      <BacklinksPanel :object-id="object.id" :title="backlinksTitle" :hide-tagged="isTagObject" />
      <ObjectActivity v-if="!embedded && !day" :object-id="object.id" :type="type" />
    </div>
  </article>
</template>
