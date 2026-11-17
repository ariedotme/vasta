// Agents (the MCP, docs/agents.md): what a space lets them see and do (AgentSettings), and the
// rules a type sets for its objects (TypeRules), which the server holds every agent and API write
// to while the app only warns, so nobody is stopped mid-edit.
import type { AgentSettings, Id, ObjectRecord, ObjectType, TypeRules } from './model.ts'

/** Longest instructions a space keeps for its agents. */
export const MAX_AGENT_INSTRUCTIONS = 8000

/** Settings as sent by a client, cleaned; undefined when they hold nothing. */
export function normalizeAgentSettings(input: unknown): AgentSettings | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  const ids = (value: unknown) => (Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id))] : [])
  const instructions = typeof raw.instructions === 'string' ? raw.instructions.trim().slice(0, MAX_AGENT_INSTRUCTIONS) : ''
  const hiddenTagIds = ids(raw.hiddenTagIds)
  const context = ids(raw.context)
  const settings: AgentSettings = {
    ...(instructions ? { instructions } : {}),
    ...(raw.hidden === true ? { hidden: true } : {}),
    ...(raw.readOnly === true ? { readOnly: true } : {}),
    ...(hiddenTagIds.length ? { hiddenTagIds } : {}),
    ...(context.length ? { context } : {}),
  }
  return Object.keys(settings).length ? settings : undefined
}

/** The hidden tags and every tag nested under one of them. */
export function hiddenTagSet(settings: AgentSettings | undefined, tags: Iterable<Pick<ObjectRecord, 'id' | 'parentId'>>): Set<Id> {
  const hidden = new Set(settings?.hiddenTagIds ?? [])
  if (!hidden.size) return hidden
  const all = [...tags]
  let grew = true
  while (grew) {
    grew = false
    for (const tag of all) {
      if (tag.parentId && hidden.has(tag.parentId) && !hidden.has(tag.id)) {
        hidden.add(tag.id)
        grew = true
      }
    }
  }
  return hidden
}

/** Whether agents must not see an object: it is a hidden tag, or carries one. */
export const hiddenByTags = (object: Pick<ObjectRecord, 'id' | 'tagIds'>, hidden: Set<Id>) => hidden.size > 0 && (hidden.has(object.id) || object.tagIds.some((id) => hidden.has(id)))

/** A type's rules as sent by a client, cleaned; undefined when there are none. */
export function normalizeTypeRules(rules: unknown): TypeRules | undefined {
  if (!rules || typeof rules !== 'object') return undefined
  const raw = rules as Record<string, unknown>
  const out: TypeRules = { ...(raw.cover === true ? { cover: true } : {}), ...(raw.tags === true ? { tags: true } : {}) }
  return Object.keys(out).length ? out : undefined
}

/**
 * What an object lacks of what its type requires (its required properties, a cover, a tag), in
 * words ("Author is required"); empty when it has it all. Formulas are computed, never required.
 */
export function typeRuleProblems(type: Pick<ObjectType, 'name' | 'properties' | 'rules'> | undefined, object: Pick<ObjectRecord, 'props' | 'content' | 'coverUrl' | 'tagIds' | 'template'>): string[] {
  if (!type || object.template) return []
  const problems: string[] = []
  for (const def of type.properties) {
    if (!def.required || def.kind === 'formula') continue
    const empty = def.kind === 'rich-text' ? !object.content[def.id]?.content?.some((node) => node.type !== 'paragraph' || node.content?.length) : isEmptyValue(object.props[def.id]?.value)
    if (empty) problems.push(`${def.name} is required`)
  }
  if (type.rules?.cover && !object.coverUrl) problems.push('a cover is required')
  if (type.rules?.tags && !object.tagIds.length) problems.push('at least one tag is required')
  return problems
}

const isEmptyValue = (value: unknown) => value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length)
