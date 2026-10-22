<script setup lang="ts">
// The other side of relation properties: objects whose relation points here, one row per
// (type, property), shown with this object's properties. Adding from here writes the relation
// on the other object, so both sides always agree.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Backlink, Id, ObjectSummary, RelationPropertyDef } from '@vasta/core'
import { api } from '../lib/api.ts'
import { onChange } from '../lib/events.ts'
import { primeFromObject, primeSummaries, typesById, workspace } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import ObjectChip from './ObjectChip.vue'
import ObjectPicker from './ObjectPicker.vue'
import PopoverMenu from './PopoverMenu.vue'

const props = defineProps<{ objectId: Id; typeId: Id; showEmpty?: boolean }>()

const links = ref<Backlink[]>([])
async function load() {
  links.value = (await api.backlinks(props.objectId)).filter((l) => l.kind === 'relation')
  primeSummaries(links.value.map((l) => l.object))
}
watch(() => props.objectId, () => void load(), { immediate: true })
let timer: ReturnType<typeof setTimeout> | undefined
const stop = onChange((event) => {
  if (event.kind !== 'object' || event.id === props.objectId) return
  clearTimeout(timer)
  timer = setTimeout(() => void load(), 400)
})
onBeforeUnmount(() => (stop(), clearTimeout(timer)))

interface Row {
  key: string
  typeId: Id
  def: RelationPropertyDef
  objects: ObjectSummary[]
}

const rows = computed<Row[]>(() => {
  const byKey = new Map<string, Row>()
  // Relation properties of other types that explicitly allow this type: shown even when empty.
  for (const type of workspace.types) {
    for (const def of type.properties) {
      if (def.kind === 'relation' && def.targetTypeIds.includes(props.typeId)) byKey.set(`${type.id}/${def.id}`, { key: `${type.id}/${def.id}`, typeId: type.id, def, objects: [] })
    }
  }
  for (const link of links.value) {
    const def = typesById.value.get(link.object.typeId)?.properties.find((p) => p.id === link.via)
    if (def?.kind !== 'relation') continue
    const key = `${link.object.typeId}/${def.id}`
    const row = byKey.get(key) ?? { key, typeId: link.object.typeId, def, objects: [] }
    if (!row.objects.some((o) => o.id === link.object.id)) row.objects.push(link.object)
    byKey.set(key, row)
  }
  return [...byKey.values()].filter((row) => row.objects.length || props.showEmpty)
})

const anchors = ref<Record<string, HTMLElement | null>>({})
const openKey = ref<string | null>(null)

/** Point another object's relation at this one. Single relations are replaced. */
async function link(row: Row, other: ObjectSummary) {
  openKey.value = null
  const object = await api.object(other.id)
  const current = object.props[row.def.id]
  const ids = current?.kind === 'relation' ? current.value : []
  if (ids.includes(props.objectId)) return
  object.props[row.def.id] = { kind: 'relation', value: row.def.multiple ? [...ids, props.objectId] : [props.objectId] }
  primeFromObject(await api.saveObject(object))
  await load()
}

async function unlink(row: Row, other: ObjectSummary) {
  const object = await api.object(other.id)
  const current = object.props[row.def.id]
  if (current?.kind !== 'relation') return
  const value = current.value.filter((id) => id !== props.objectId)
  if (value.length) object.props[row.def.id] = { kind: 'relation', value }
  else delete object.props[row.def.id]
  primeFromObject(await api.saveObject(object))
  await load()
}
</script>

<template>
  <div v-for="row in rows" :key="row.key" class="vasta-prop-row">
    <div class="vasta-prop-name" :title="`${typesById.get(row.typeId)?.pluralName} whose “${row.def.name}” is this object`">
      <AppIcon :icon="typesById.get(row.typeId)?.icon" fallback="ph:arrows-left-right" class="text-ink-faint" />
      <span class="truncate">{{ typesById.get(row.typeId)?.pluralName }}</span>
      <span class="shrink-0 truncate text-xs text-ink-faint">· {{ row.def.name }}</span>
    </div>
    <div class="flex min-h-9 flex-1 flex-wrap items-center gap-1 py-1.5">
      <ObjectChip v-for="o in row.objects" :key="o.id" :id="o.id" removable @remove="unlink(row, o)" />
      <button
        :ref="(el) => (anchors[row.key] = el as HTMLElement | null)"
        class="rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-hover hover:text-ink"
        @click="openKey = openKey === row.key ? null : row.key"
      >
        {{ row.objects.length ? '+' : 'Add' }}
      </button>
      <PopoverMenu :open="openKey === row.key" :anchor="anchors[row.key]" width="16rem" @update:open="(v) => (openKey = v ? row.key : null)">
        <ObjectPicker :type-ids="[row.typeId]" :exclude="row.objects.map((o) => o.id)" @pick="link(row, $event)" />
      </PopoverMenu>
    </div>
  </div>
</template>
