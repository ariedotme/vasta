// Maps Capacities components to Vasta spaces, types and objects.
import {
  BODY_PROPERTY_ID,
  builtinTypeId,
  CAPACITIES_TASK_STATUS,
  createBuiltinTypes,
  type DateValue,
  type Doc,
  type Filter,
  type FilterGroup,
  type FilterOperator,
  type FilterValue,
  type Id,
  type MediaInfo,
  type ObjectRecord,
  type ObjectType,
  type PropertyDef,
  type PropertyValue,
  type QueryDef,
  type SelectOption,
  type SidebarSection,
  type Space,
  type SystemTypeKey,
  type ViewLayout,
} from '@vasta/core'
import { blocksToDoc, type BlockContext } from './blocks.ts'
import { toColor, toIcon, Warnings } from './common.ts'
import type { CapBlock, CapComponent, ComponentRow } from './source.ts'

/** Capacities built-in structures and the Vasta system type they become. */
const SYSTEM_STRUCTURES: Record<string, SystemTypeKey> = {
  RootPage: 'page',
  RootDailyNote: 'daily-note',
  RootTag: 'tag',
  RootDatabase: 'collection',
  RootQuery: 'query',
  RootTask: 'task',
  MediaWebResource: 'weblink',
  UtilDate: 'date',
  MediaImage: 'image',
  MediaPDF: 'pdf',
  MediaAudio: 'audio',
  MediaVideo: 'video',
  MediaFile: 'file',
}

/** Components that are not user objects. */
const SKIPPED_STRUCTURES = new Set(['RootStructure', 'RootSpace', 'User', 'UserPersonal'])

/** Property ids Capacities uses for fields Vasta models as built-in object fields. */
const BUILTIN_FIELDS: Record<string, string> = {
  title: 'title',
  tags: 'tags',
  description: 'description',
  aliases: 'aliases',
  icon: 'icon',
  createdAt: 'createdAt',
  lastUpdated: 'updatedAt',
  collections: 'collections',
}

const LAYOUTS = new Set<ViewLayout>(['list', 'grid', 'wall', 'table', 'kanban', 'gallery', 'embed'])

const FILTER_OPERATORS: Record<string, FilterOperator> = {
  is: 'is',
  isNot: 'is-not',
  contains: 'contains',
  notContains: 'not-contains',
  startsWith: 'starts-with',
  isEmpty: 'is-empty',
  isNotEmpty: 'is-not-empty',
  isChecked: 'is-checked',
  isNotChecked: 'is-not-checked',
  greaterThan: 'gt',
  greaterThanOrEqual: 'gte',
  lessThan: 'lt',
  lessThanOrEqual: 'lte',
  before: 'before',
  after: 'after',
}

export interface ImportResult {
  spaces: Space[]
  types: ObjectType[]
  objects: ObjectRecord[]
  /** Original component of every imported object or type, keyed by Vasta id. */
  sources: Map<Id, CapComponent>
  report: ImportReport
}

export interface ImportReport {
  spaces: number
  types: { builtin: number; custom: number }
  objectsByType: Record<string, number>
  skipped: Record<string, number>
  danglingReferences: number
  warnings: Record<string, number>
}

interface CapPropertyDef {
  id: string
  type?: string
  dataType?: string
  name?: { val?: string }
  description?: { val?: string }
  icon?: unknown
  isArray?: boolean
  allowedStructures?: string[]
  set?: { id: string; text?: string; color?: string; category?: string }[]
  mode?: string
  numberFormat?: unknown
  pageViewSettings?: { visibility?: string }
}

const isDeleted = (row: ComponentRow) =>
  row.deleteRequested === 1 || row.component.deleteRequested === true || row.component.local?.loadingError === 'deleted'

const val = (component: CapComponent, propertyId: string): unknown => component.properties?.[propertyId]?.val

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length ? value : undefined)

const linkIds = (value: unknown): Id[] =>
  Array.isArray(value) ? value.map((v) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined)).filter((id): id is Id => typeof id === 'string') : []

const toDateValue = (raw: unknown): DateValue | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const { startTime, endTime, dateResolution } = raw as { startTime?: string; endTime?: string; dateResolution?: string }
  if (!startTime) return undefined
  return { start: startTime, ...(endTime ? { end: endTime } : {}), resolution: dateResolution === 'time' ? 'time' : 'day' }
}

export function mapCapacities(rows: ComponentRow[], now = new Date().toISOString()): ImportResult {
  const warnings = new Warnings()
  const skipped: Record<string, number> = {}
  const live = rows.filter((row) => {
    if (!isDeleted(row)) return true
    skipped['deleted'] = (skipped['deleted'] ?? 0) + 1
    return false
  })
  const byId = new Map(live.map((row) => [row.id, row]))

  // -------------------------------------------------------------------------
  // Spaces
  const spaceRows = live.filter((row) => row.component.type === 'RootSpace')
  const spaceIds = new Set(spaceRows.map((row) => row.id))
  const customStructureIds = new Set(live.filter((row) => row.component.type === 'RootStructure').map((row) => row.id))

  const typeIdFor = (spaceId: Id, structureId: string): Id | undefined => {
    const system = SYSTEM_STRUCTURES[structureId]
    if (system) return builtinTypeId(spaceId, system)
    return customStructureIds.has(structureId) ? structureId : undefined
  }

  const spaces: Space[] = spaceRows.map((row) => {
    const c = row.component
    const workspace = (c.data?.workspace ?? {}) as Record<string, { ids?: string[]; name?: string; icon?: unknown }>
    const order = (c.data?.workspaceOrder as string[] | undefined) ?? Object.keys(workspace)
    const sidebar: SidebarSection[] = []
    for (const key of order) {
      const section = workspace[key]
      if (!section?.ids) continue
      const icon = toIcon(section.icon)
      sidebar.push({
        id: key,
        name: key === 'pinned' ? 'Pinned' : section.name ?? 'Section',
        ...(icon ? { icon } : {}),
        items: section.ids.map((id) => typeIdFor(row.id, id) ?? id),
      })
    }
    const icon = toIcon(val(c, 'icon'))
    return { id: row.id, name: str(val(c, 'title')) ?? 'Imported space', ...(icon ? { icon } : {}), sidebar, createdAt: row.createdAt }
  })

  // -------------------------------------------------------------------------
  // Types
  const types: ObjectType[] = spaces.flatMap((space) => createBuiltinTypes(space.id, now))
  const sources = new Map<Id, CapComponent>()

  const mapPropertyDef = (spaceId: Id, def: CapPropertyDef): PropertyDef | undefined => {
    if (BUILTIN_FIELDS[def.id] || def.type?.startsWith('entity_')) return undefined
    const base = {
      id: def.id,
      name: def.name?.val || 'Untitled',
      ...(def.description?.val ? { description: def.description.val } : {}),
      ...(toIcon(def.icon) ? { icon: toIcon(def.icon)! } : {}),
      ...(def.pageViewSettings?.visibility === 'hideWhenEmpty' ? { hideWhenEmpty: true } : {}),
    }
    switch (def.type) {
      case 'blocks':
      case 'textBlock':
        return { ...base, kind: 'rich-text' }
      case 'entity':
        return {
          ...base,
          kind: 'relation',
          multiple: def.isArray !== false,
          targetTypeIds: (def.allowedStructures ?? []).map((s) => typeIdFor(spaceId, s)).filter((id): id is Id => !!id),
        }
      case 'label':
        return {
          ...base,
          kind: 'select',
          multiple: !!def.isArray,
          options: (def.set ?? []).map((option): SelectOption => {
            const color = toColor(option.color)
            const status = option.category === 'done' ? 'done' : option.category === 'in-progress' ? 'doing' : option.category === 'not-started' ? 'todo' : undefined
            return { id: option.id, label: option.text ?? '', ...(color ? { color } : {}), ...(status ? { status } : {}) }
          }),
        }
      case 'datetime':
      case 'datetime_simple':
        return { ...base, kind: 'date', withTime: def.mode !== 'date' }
      case 'boolean':
        return { ...base, kind: 'checkbox' }
      case 'number':
        return { ...base, kind: 'number', ...(def.numberFormat ? { format: JSON.stringify(def.numberFormat) } : {}) }
      case 'url':
        return { ...base, kind: 'url' }
      case 'string':
      case 'text':
        return { ...base, kind: 'text' }
    }
    warnings.add(`property type "${def.type}" imported as text`)
    return { ...base, kind: 'text' }
  }

  for (const row of live) {
    const c = row.component
    if (c.type !== 'RootStructure') continue
    const spaceId = row.spaceId && spaceIds.has(row.spaceId) ? row.spaceId : spaces[0]?.id
    if (!spaceId) continue
    const defs = ((c.data?.propertyDefinitions as CapPropertyDef[] | undefined) ?? [])
      .map((def) => mapPropertyDef(spaceId, def))
      .filter((def): def is PropertyDef => !!def)
    if (!defs.some((def) => def.kind === 'rich-text')) defs.unshift({ id: BODY_PROPERTY_ID, kind: 'rich-text', name: 'Notes' })
    const name = str(val(c, 'title')) ?? 'Untitled type'
    const icon = toIcon(val(c, 'icon'))
    const color = toColor(c.data?.labelColor)
    const description = str(val(c, 'description'))
    types.push({
      id: row.id,
      spaceId,
      name,
      pluralName: str(val(c, 'pluralName')) ?? name,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      ...(color ? { color } : {}),
      properties: defs,
      views: [{ id: `${row.id}:all`, name: 'All', layout: 'list' }],
      createdAt: row.createdAt,
      updatedAt: row.lastUpdated,
    })
    sources.set(row.id, c)
  }
  const typesById = new Map(types.map((type) => [type.id, type]))

  // -------------------------------------------------------------------------
  // Objects
  const defaultCollections = new Set(
    live.filter((row) => row.component.type === 'RootDatabase' && val(row.component, 'isDefaultDatabase') === true).map((row) => row.id)
  )
  const importable = live.filter((row) => {
    const type = row.component.type
    if (SKIPPED_STRUCTURES.has(type) || defaultCollections.has(row.id)) {
      const reason = defaultCollections.has(row.id) ? 'internal default collection' : type
      skipped[reason] = (skipped[reason] ?? 0) + 1
      return false
    }
    if (!row.spaceId || !spaceIds.has(row.spaceId)) {
      skipped['outside imported spaces'] = (skipped['outside imported spaces'] ?? 0) + 1
      return false
    }
    return true
  })
  const importedIds = new Set(importable.map((row) => row.id))
  const titleOf = (id: string) => byId.get(id)?.title ?? undefined
  let danglingReferences = 0
  const blockContext: BlockContext = {
    warnings,
    titleOf: (id) => {
      if (!importedIds.has(id)) danglingReferences++
      return titleOf(id)
    },
  }

  const docFor = (c: CapComponent, key: unknown): Doc | undefined => {
    const blocks = typeof key === 'string' ? c.data?.blocks?.[key] : undefined
    return Array.isArray(blocks) ? blocksToDoc(blocks as CapBlock[], blockContext) : undefined
  }

  const convertFilterGroup = (group: { operator?: string; elements?: unknown[] }): FilterGroup => ({
    kind: 'group',
    operator: group.operator === 'or' ? 'or' : 'and',
    items: (group.elements ?? []).flatMap((raw): (Filter | FilterGroup)[] => {
      const element = raw as { type?: string; propertyId?: string; option?: string; referenceValue?: { type?: string; val?: unknown } }
      if (element.type === 'filterGroup') return [convertFilterGroup(element as { operator?: string; elements?: unknown[] })]
      if (element.type !== 'filter' || !element.propertyId) return []
      const operator = FILTER_OPERATORS[element.option ?? '']
      if (!operator) {
        warnings.add(`query filter operator "${element.option}" dropped`)
        return []
      }
      const reference = element.referenceValue
      let value: FilterValue | undefined
      if (reference?.type === 'queryVariable') {
        const variable = reference.val as { type?: string; property?: { propertyId?: string } }
        const field = variable.property?.propertyId
        value = { kind: 'variable', name: variable.type === 'today' ? 'today' : 'parent', ...(field ? { field: BUILTIN_FIELDS[field] ?? field } : {}) }
      } else if (Array.isArray(reference?.val)) {
        // Label and relation filters hold [{ id }] references.
        const ids = reference.val.map((v) => (v && typeof v === 'object' ? (v as { id: Id }).id : v) as Id)
        value = { kind: 'literal', value: element.propertyId === 'status' ? ids.map((id) => CAPACITIES_TASK_STATUS[id] ?? id) : ids }
      } else if (reference && reference.val !== undefined && reference.val !== null) {
        value = { kind: 'literal', value: reference.val as string | number | boolean }
      }
      return [{ kind: 'filter', field: BUILTIN_FIELDS[element.propertyId] ?? element.propertyId, operator, ...(value ? { value } : {}) }]
    }),
  })

  const queryFor = (spaceId: Id, c: CapComponent): QueryDef | undefined => {
    const definition = c.data?.definition as
      | { structures?: { id: string }[]; filterGroup?: { operator?: string; elements?: unknown[] }; groupBy?: { groups?: { propertyId?: string }[] } }
      | undefined
    if (!definition) return undefined
    const layout = (c.data?.viewDefinition as { dataViewLayout?: string } | undefined)?.dataViewLayout
    const groupBy = (definition.groupBy?.groups ?? []).flatMap((g) => (g.propertyId ? [{ field: BUILTIN_FIELDS[g.propertyId] ?? g.propertyId }] : []))
    // A query over a type that no longer exists keeps the stale id, so it matches nothing
    // instead of silently widening to every type.
    const typeIds = (definition.structures ?? []).map((s) => {
      const id = typeIdFor(spaceId, s.id)
      if (!id) warnings.add('query references a type that no longer exists')
      return id ?? s.id
    })
    return {
      typeIds,
      ...(definition.filterGroup ? { filter: convertFilterGroup(definition.filterGroup) } : {}),
      ...(groupBy.length ? { groupBy } : {}),
      ...(layout && LAYOUTS.has(layout as ViewLayout) ? { layout: layout as ViewLayout } : {}),
    }
  }

  const mediaFor = (c: CapComponent): MediaInfo | undefined => {
    const p = (id: string) => val(c, id)
    const meta = (c.data?.urlMetadata ?? {}) as Record<string, unknown>
    const media: MediaInfo = {}
    const url = str(p('media_URLReference')) ?? str(meta.url)
    if (url) media.url = url
    const mime = str(p('media_MIMEType'))
    if (mime) media.mimeType = mime
    if (typeof p('media_fileSize') === 'number') media.sizeBytes = p('media_fileSize') as number
    if (typeof p('media_imageWidth') === 'number') media.width = p('media_imageWidth') as number
    if (typeof p('media_imageHeight') === 'number') media.height = p('media_imageHeight') as number
    const host = str(p('media_host')) ?? str(meta.host)
    if (host) media.host = host
    const embedUrl = str(p('media_iframeReference'))
    if (embedUrl) media.embedUrl = embedUrl
    const preview = str(meta.image)
    if (preview) media.previewImageUrl = preview
    const kept: Record<string, string | number | boolean | null> = {}
    for (const key of ['title', 'description', 'author', 'publisher', 'date', 'lang', 'logo', 'contentType']) {
      const value = meta[key]
      if (value !== undefined && value !== null && typeof value !== 'object') kept[key] = value as string | number | boolean
    }
    if (Object.keys(kept).length) media.meta = kept
    return Object.keys(media).length ? media : undefined
  }

  const objects: ObjectRecord[] = []
  const objectsByType: Record<string, number> = {}

  for (const row of importable) {
    const c = row.component
    const spaceId = row.spaceId!
    let typeId = typeIdFor(spaceId, row.structureId ?? c.structureId)
    if (!typeId) {
      warnings.add(`object of unknown type "${c.structureId}" imported as page`)
      typeId = builtinTypeId(spaceId, 'page')
    }
    const type = typesById.get(typeId)!
    const defsById = new Map(type.properties.map((def) => [def.id, def]))

    // Rich text: every property whose value points into data.blocks. Fields that are not
    // custom properties of the type (built-in notes fields) are merged into the body.
    const content: Record<Id, Doc> = {}
    for (const [propertyId, property] of Object.entries(c.properties ?? {})) {
      const doc = docFor(c, property?.val)
      if (!doc) continue
      const target = defsById.get(propertyId)?.kind === 'rich-text' ? propertyId : BODY_PROPERTY_ID
      const existing = content[target]
      content[target] = existing ? { type: 'doc', content: [...existing.content, ...doc.content] } : doc
    }
    const bodyId = defsById.has(BODY_PROPERTY_ID) ? BODY_PROPERTY_ID : type.properties.find((def) => def.kind === 'rich-text')?.id
    if (content[BODY_PROPERTY_ID] && bodyId && bodyId !== BODY_PROPERTY_ID) {
      content[bodyId] = content[BODY_PROPERTY_ID]
      delete content[BODY_PROPERTY_ID]
    }

    const props: Record<Id, PropertyValue> = {}
    for (const def of type.properties) {
      const raw = val(c, def.id)
      if (raw === undefined || raw === null) continue
      switch (def.kind) {
        case 'text':
          if (typeof raw === 'string' && raw) props[def.id] = { kind: 'text', value: raw }
          break
        case 'url':
          if (typeof raw === 'string' && raw) props[def.id] = { kind: 'url', value: raw }
          break
        case 'number':
          if (typeof raw === 'number') props[def.id] = { kind: 'number', value: raw }
          break
        case 'checkbox':
          if (typeof raw === 'boolean') props[def.id] = { kind: 'checkbox', value: raw }
          break
        case 'relation': {
          const ids = linkIds(raw)
          if (ids.length) props[def.id] = { kind: 'relation', value: ids }
          break
        }
        case 'select':
          if (Array.isArray(raw) && raw.length) {
            const ids = raw.filter((v): v is string => typeof v === 'string')
            props[def.id] = { kind: 'select', value: type.system === 'task' && def.id === 'status' ? ids.map((id) => CAPACITIES_TASK_STATUS[id] ?? id) : ids }
          }
          break
        case 'date': {
          // Capacities stores date properties as links to date objects.
          const target = linkIds(raw)[0]
          const date = target ? toDateValue(val(byId.get(target)?.component ?? ({} as CapComponent), 'date')) : toDateValue(raw)
          if (date) props[def.id] = { kind: 'date', value: date }
          break
        }
      }
    }

    let date: DateValue | undefined
    if (c.type === 'RootDailyNote') date = { start: c.createdAt ?? row.createdAt, resolution: 'day' }
    else if (row.startTime) date = { start: row.startTime, ...(row.endTime ? { end: row.endTime } : {}), resolution: row.dateResolution === 'time' ? 'time' : 'day' }
    else date = toDateValue(val(c, 'date'))

    const icon = toIcon(val(c, 'icon'))
    const description = str(val(c, 'description'))
    const query = c.type === 'RootQuery' ? queryFor(spaceId, c) : undefined
    const media = c.type.startsWith('Media') ? mediaFor(c) : undefined
    const aliases = Array.isArray(val(c, 'aliases'))
      ? (val(c, 'aliases') as { name?: string }[]).map((a) => a.name).filter((n): n is string => !!n)
      : []

    objects.push({
      id: row.id,
      spaceId,
      typeId,
      title: str(val(c, 'title')) ?? row.title ?? '',
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      aliases,
      tagIds: linkIds(val(c, 'tags')),
      collectionIds: (c.databases ?? []).map((d) => d.id).filter((id) => !defaultCollections.has(id)),
      props,
      content,
      ...(date ? { date } : {}),
      ...(query ? { query } : {}),
      ...(media ? { media } : {}),
      createdAt: row.createdAt,
      updatedAt: row.lastUpdated,
    })
    sources.set(row.id, c)
    objectsByType[type.name] = (objectsByType[type.name] ?? 0) + 1
  }

  return {
    spaces,
    types,
    objects,
    sources,
    report: {
      spaces: spaces.length,
      types: { builtin: types.filter((t) => t.system).length, custom: types.filter((t) => !t.system).length },
      objectsByType,
      skipped,
      danglingReferences,
      warnings: warnings.toJSON(),
    },
  }
}
