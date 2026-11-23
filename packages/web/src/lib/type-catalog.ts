// Catalog of ready-made object type templates, with recursive relation dependency resolution.
// Adding a new template later is a single entry in TYPE_CATALOG: set `listed: true` to show it
// in the picker, or keep `listed: false` when it only appears as a chained dependency of another.
import { newId, type ColorName, type Icon, type Id, type ObjectType, type PropertyDef, type SelectOption, type SystemTypeKey } from '@vasta/core'
import { en } from '../locales/en.ts'
import { t, type MessageKey } from './i18n.ts'

export type CatalogCategory = 'general' | 'media' | 'research' | 'planning'

export const CATALOG_CATEGORIES: { id: CatalogCategory; labelKey: MessageKey }[] = [
  { id: 'general', labelKey: 'typeCatalog.category.general' },
  { id: 'media', labelKey: 'typeCatalog.category.media' },
  { id: 'research', labelKey: 'typeCatalog.category.research' },
  { id: 'planning', labelKey: 'typeCatalog.category.planning' },
]

export interface CatalogSelectOption {
  labelKey: MessageKey
  color?: ColorName
  status?: 'todo' | 'doing' | 'done'
}

export type CatalogPropertyDef =
  | { id: string; kind: 'text' | 'number' | 'checkbox' | 'url'; nameKey: MessageKey }
  | { id: string; kind: 'person'; nameKey: MessageKey; multiple: boolean }
  | { id: string; kind: 'date'; nameKey: MessageKey; withTime?: boolean }
  | { id: string; kind: 'select'; nameKey: MessageKey; multiple: boolean; options: CatalogSelectOption[] }
  | {
      id: string
      kind: 'relation'
      nameKey: MessageKey
      multiple: boolean
      /** Another template in TYPE_CATALOG that this relation points to (chains on import). */
      targetTemplateKey?: string
      /** Built-in system type target (e.g. 'task'). */
      targetSystem?: SystemTypeKey
      reverseNameKey?: MessageKey
    }

export interface TypeTemplate {
  key: string
  category: CatalogCategory
  nameKey: MessageKey
  pluralNameKey: MessageKey
  descriptionKey: MessageKey
  icon: Icon
  color: ColorName
  /** Shown directly in the catalog picker. Unlisted entries still resolve as chained dependencies. */
  listed: boolean
  properties: CatalogPropertyDef[]
}

export const TYPE_CATALOG: TypeTemplate[] = [
  {
    key: 'book',
    category: 'media',
    nameKey: 'typeCatalog.book.name',
    pluralNameKey: 'typeCatalog.book.plural',
    descriptionKey: 'typeCatalog.book.description',
    icon: { kind: 'icon', value: 'ph:book-open' },
    color: 'violet',
    listed: true,
    properties: [
      {
        id: 'author',
        kind: 'relation',
        nameKey: 'typeCatalog.prop.author',
        multiple: true,
        targetTemplateKey: 'person',
        reverseNameKey: 'typeCatalog.book.plural',
      },
      {
        id: 'status',
        kind: 'select',
        nameKey: 'typeCatalog.prop.status',
        multiple: false,
        options: [
          { labelKey: 'typeCatalog.book.status.toRead', color: 'gray', status: 'todo' },
          { labelKey: 'typeCatalog.book.status.reading', color: 'blue', status: 'doing' },
          { labelKey: 'typeCatalog.book.status.finished', color: 'green', status: 'done' },
        ],
      },
      { id: 'rating', kind: 'number', nameKey: 'typeCatalog.prop.rating' },
      { id: 'finished', kind: 'date', nameKey: 'typeCatalog.prop.finishedOn' },
      { id: 'link', kind: 'url', nameKey: 'typeCatalog.prop.link' },
    ],
  },
  {
    key: 'person',
    category: 'general',
    nameKey: 'typeCatalog.person.name',
    pluralNameKey: 'typeCatalog.person.plural',
    descriptionKey: 'typeCatalog.person.description',
    icon: { kind: 'icon', value: 'ph:user' },
    color: 'sky',
    listed: false,
    properties: [
      {
        id: 'organization',
        kind: 'relation',
        nameKey: 'typeCatalog.prop.organization',
        multiple: false,
        targetTemplateKey: 'organization',
        reverseNameKey: 'typeCatalog.person.plural',
      },
      { id: 'role', kind: 'text', nameKey: 'typeCatalog.prop.role' },
      { id: 'email', kind: 'text', nameKey: 'typeCatalog.prop.email' },
      { id: 'website', kind: 'url', nameKey: 'typeCatalog.prop.website' },
    ],
  },
  {
    key: 'organization',
    category: 'planning',
    nameKey: 'typeCatalog.organization.name',
    pluralNameKey: 'typeCatalog.organization.plural',
    descriptionKey: 'typeCatalog.organization.description',
    icon: { kind: 'icon', value: 'ph:buildings' },
    color: 'indigo',
    listed: false,
    properties: [
      { id: 'website', kind: 'url', nameKey: 'typeCatalog.prop.website' },
      { id: 'location', kind: 'text', nameKey: 'typeCatalog.prop.location' },
    ],
  },
]

export const listedCatalogTemplates = (catalog: TypeTemplate[] = TYPE_CATALOG): TypeTemplate[] => catalog.filter((tpl) => tpl.listed)

export const templateByKey = (key: string, catalog: TypeTemplate[] = TYPE_CATALOG): TypeTemplate | undefined => catalog.find((tpl) => tpl.key === key)

export type RelationDecision =
  | { mode: 'import' }
  | { mode: 'existing'; typeId: Id }
  | { mode: 'ignore' }

export const relationDecisionKey = (templateKey: string, propertyId: string) => `${templateKey}:${propertyId}`

const norm = (value: string) => value.trim().toLowerCase()

/** Find an existing non-deleted type in the space matching a template's localized or English name. */
export function findMatchingExistingType(template: TypeTemplate, existingTypes: ObjectType[]): ObjectType | undefined {
  const candidates = new Set([
    norm(t(template.nameKey)),
    norm(t(template.pluralNameKey)),
    norm(en[template.nameKey]),
    norm(en[template.pluralNameKey]),
  ])
  return existingTypes.find((item) => !item.deletedAt && (candidates.has(norm(item.name)) || candidates.has(norm(item.pluralName))))
}

/** Default resolution for a relation property pointing to another catalog template. */
export function defaultRelationDecision(
  targetTemplate: TypeTemplate,
  existingTypes: ObjectType[]
): RelationDecision {
  const match = findMatchingExistingType(targetTemplate, existingTypes)
  return match ? { mode: 'existing', typeId: match.id } : { mode: 'import' }
}

export interface ChainNode {
  template: TypeTemplate
  depth: number
  /** The parent template and relation property that pulled this template into the chain. */
  requiredBy?: { templateKey: string; propertyId: string }
}

/**
 * Resolve the ordered list of catalog templates to create starting from `rootKey`, following
 * any relation properties whose decision is `{ mode: 'import' }`. Cycles and diamond
 * dependencies are deduplicated so each template is imported at most once.
 */
export function resolveImportChain(
  rootKey: string,
  decisions: Record<string, RelationDecision>,
  existingTypes: ObjectType[],
  catalog: TypeTemplate[] = TYPE_CATALOG
): ChainNode[] {
  const root = templateByKey(rootKey, catalog)
  if (!root) return []
  const visited = new Set<string>([root.key])
  const queue: ChainNode[] = [{ template: root, depth: 0 }]
  const result: ChainNode[] = []

  while (queue.length) {
    const node = queue.shift()!
    result.push(node)
    for (const prop of node.template.properties) {
      if (prop.kind !== 'relation' || !prop.targetTemplateKey) continue
      const target = templateByKey(prop.targetTemplateKey, catalog)
      if (!target || visited.has(target.key)) continue
      const key = relationDecisionKey(node.template.key, prop.id)
      const decision = decisions[key] ?? defaultRelationDecision(target, existingTypes)
      if (decision.mode === 'import') {
        visited.add(target.key)
        queue.push({
          template: target,
          depth: node.depth + 1,
          requiredBy: { templateKey: node.template.key, propertyId: prop.id },
        })
      }
    }
  }
  return result
}

/** Build the concrete `PropertyDef[]` for a template once every imported template has its type id. */
export function buildTemplateProperties(
  template: TypeTemplate,
  baseProperties: PropertyDef[],
  decisions: Record<string, RelationDecision>,
  createdIdsByTemplateKey: Map<string, Id>,
  existingTypes: ObjectType[],
  catalog: TypeTemplate[] = TYPE_CATALOG
): PropertyDef[] {
  const out: PropertyDef[] = [...baseProperties]

  for (const prop of template.properties) {
    const name = t(prop.nameKey)
    if (prop.kind === 'select') {
      const options: SelectOption[] = prop.options.map((opt) => ({
        id: newId(),
        label: t(opt.labelKey),
        ...(opt.color ? { color: opt.color } : {}),
        ...(opt.status ? { status: opt.status } : {}),
      }))
      out.push({ id: newId(), kind: 'select', name, multiple: prop.multiple, options })
    } else if (prop.kind === 'date') {
      out.push({ id: newId(), kind: 'date', name, ...(prop.withTime ? { withTime: true } : {}) })
    } else if (prop.kind === 'person') {
      out.push({ id: newId(), kind: 'person', name, multiple: prop.multiple })
    } else if (prop.kind === 'relation') {
      if (prop.targetTemplateKey) {
        const target = templateByKey(prop.targetTemplateKey, catalog)
        if (!target) continue
        const key = relationDecisionKey(template.key, prop.id)
        const decision = decisions[key] ?? defaultRelationDecision(target, existingTypes)
        if (decision.mode === 'ignore') continue
        const targetId = decision.mode === 'existing' ? decision.typeId : createdIdsByTemplateKey.get(target.key)
        if (!targetId) continue
        out.push({
          id: newId(),
          kind: 'relation',
          name,
          multiple: prop.multiple,
          targetTypeIds: [targetId],
          ...(prop.reverseNameKey ? { reverseName: t(prop.reverseNameKey) } : {}),
        })
      } else if (prop.targetSystem) {
        const sys = existingTypes.find((item) => !item.deletedAt && item.system === prop.targetSystem)
        if (!sys) continue
        out.push({
          id: newId(),
          kind: 'relation',
          name,
          multiple: prop.multiple,
          targetTypeIds: [sys.id],
          ...(prop.reverseNameKey ? { reverseName: t(prop.reverseNameKey) } : {}),
        })
      } else {
        out.push({
          id: newId(),
          kind: 'relation',
          name,
          multiple: prop.multiple,
          targetTypeIds: [],
          ...(prop.reverseNameKey ? { reverseName: t(prop.reverseNameKey) } : {}),
        })
      }
    } else {
      out.push({ id: newId(), kind: prop.kind, name })
    }
  }

  return out
}
