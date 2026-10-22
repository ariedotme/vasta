// Rich text as Yjs: one Y.Doc per object, one Y.XmlFragment per rich-text field (named by the
// field's property id), in the layout TipTap's collaboration extension reads. Converting through
// the schema gives the JSON the editor itself would produce (every attribute, defaults included).
import { Node as PmNode, type Schema } from '@tiptap/pm/model'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { compactDoc, vastaSchema } from './index.ts'

/** ProseMirror JSON of a document (`ObjectRecord.content[field]` in @vasta/core). */
export interface JsonDoc {
  type: 'doc'
  content: JsonNode[]
}
export interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

const emptyMeta = () => ({ mapping: new Map(), isOMark: new Map() })

/** A document as the editor would save it (compactDoc). Throws on node or mark types the schema lacks. */
export function normalizeDoc(doc: JsonDoc, schema: Schema = vastaSchema()): JsonDoc {
  return compactDoc(PmNode.fromJSON(schema, doc).toJSON() as JsonDoc)
}

/** normalizeDoc that also checks the structure (a list item starting with a paragraph…); throws when it does not fit. */
export function checkDoc(doc: JsonDoc, schema: Schema = vastaSchema()): JsonDoc {
  const node = PmNode.fromJSON(schema, doc)
  node.check()
  return compactDoc(node.toJSON() as JsonDoc)
}

/** A map in each Y.Doc for Vasta's own bookkeeping, not a text field (see markDeletions). */
const META = 'vasta'

/** Names of the fields a Y.Doc holds text for (empty fragments count as absent). */
export function textFields(ydoc: Y.Doc): string[] {
  return [...ydoc.share.keys()].filter((name) => name !== META && ydoc.getXmlFragment(name).length > 0).sort()
}

/**
 * Record that a change only deleted (text, or a mark's formatting). Deletions do not advance a
 * Y.Doc's state vector, which is what devices compare to know they lack text; a counter in the
 * META map does, so they fetch the update, which carries the deletions too.
 */
export function markDeletions(ydoc: Y.Doc) {
  const meta = ydoc.getMap<number>(META)
  meta.set('deletions', (meta.get('deletions') ?? 0) + 1)
}

/** The rich-text fields of a Y.Doc as JSON. Elements the schema cannot hold are dropped from the Y.Doc too. */
export function readContent(ydoc: Y.Doc, schema: Schema = vastaSchema()): Record<string, JsonDoc> {
  const content: Record<string, JsonDoc> = {}
  for (const name of textFields(ydoc)) {
    const doc = compactDoc(yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(name), schema).toJSON() as JsonDoc)
    if (doc.content?.length) content[name] = doc
  }
  return content
}

/**
 * Make the Y.Doc's fields equal `content`, changing as little as possible (unchanged blocks and
 * text keep their Yjs items, so concurrent edits elsewhere still merge). Fields missing from
 * `content` are emptied. Only `fields` are touched when given.
 */
export function writeContent(ydoc: Y.Doc, content: Record<string, JsonDoc>, schema: Schema = vastaSchema(), fields?: Iterable<string>) {
  const names = new Set(fields ?? [...Object.keys(content), ...textFields(ydoc)])
  const nodes = new Map([...names].map((name) => [name, content[name] ? PmNode.fromJSON(schema, content[name]) : undefined]))
  ydoc.transact(() => {
    for (const [name, node] of nodes) {
      const fragment = ydoc.getXmlFragment(name)
      if (node?.childCount) updateYFragment(ydoc, fragment, node, emptyMeta())
      else if (fragment.length) fragment.delete(0, fragment.length)
    }
  })
}

/** A new Y.Doc holding `content`. */
export function contentToYDoc(content: Record<string, JsonDoc>, schema: Schema = vastaSchema()): Y.Doc {
  const ydoc = new Y.Doc()
  writeContent(ydoc, content, schema)
  return ydoc
}

export function loadYDoc(state: Uint8Array): Y.Doc {
  // A guid only names subdocuments, which Vasta has none of; Yjs's default draws a UUID from 31
  // random calls, a good part of loading thousands of documents.
  const ydoc = new Y.Doc({ guid: 'vasta' })
  Y.applyUpdate(ydoc, state)
  return ydoc
}

export { Y }
/** For code that has only this entry (the stores): a new block id. */
export { newBlockId } from './index.ts'
