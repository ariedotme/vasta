// Whiteboard work that reaches past the canvas: Mermaid flowcharts and JSON Canvas files turned into
// elements (naming objects of the space by their titles), and a new board made from a flowchart.
import {
  addBoardElements,
  graphToElements,
  jsonCanvasToElements,
  newId,
  parseMermaidFlowchart,
  type Id,
  type NewBoardElement,
} from '@vasta/core'
import { api } from './api.ts'
import { openText, useReplica } from './replica.ts'
import { openRemoteText } from './remote-text.ts'
import { primeSummaries, systemType, workspace } from './state.ts'

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/** Whether text looks like a Mermaid flowchart (to paste as a board). */
export const isMermaidFlowchart = (text: string) => /^\s*(graph|flowchart)\b/i.test(text)

/** Objects of the space whose title is exactly one of these (case and accents aside), by label. */
export async function objectsByTitle(labels: string[], exclude?: Id): Promise<Map<string, Id>> {
  const found = new Map<string, Id>()
  const space = workspace.space?.id
  if (!space) return found
  const unique = [...new Set(labels.map((l) => l.trim()).filter(Boolean))].slice(0, 60)
  await Promise.all(
    unique.map(async (label) => {
      const results = await api.search(space, label, 10).catch(() => [])
      const match = results.find((o) => o.id !== exclude && fold(o.title) === fold(label))
      if (match) {
        primeSummaries([match])
        found.set(fold(label), match.id)
      }
    })
  )
  return found
}

/** A flowchart as elements from a corner: nodes named like objects become their cards. */
export async function mermaidElements(source: string, at: { x: number; y: number }, exclude?: Id): Promise<(NewBoardElement & { id: Id })[]> {
  const graph = parseMermaidFlowchart(source)
  const titles = await objectsByTitle(graph.nodes.map((n) => n.label), exclude)
  return graphToElements(graph, at, newId, (label) => titles.get(fold(label)))
}

/** The object a link of this app points at (…/o/<id>, or a Markdown link to one). */
const linkedId = (text: string) => /^(?:\[[^\]]*\]\()?(?:https?:\/\/[^/\s]+)?\/o\/([^/?#\s)]+)\)?$/.exec(text.trim())?.[1]

/** A JSON Canvas file's elements, from a corner; links to this app's objects become their cards. */
export function canvasElements(canvas: unknown, at: { x: number; y: number }): (NewBoardElement & { id: Id })[] {
  const nodes = (canvas as { nodes?: { x?: number; y?: number }[] })?.nodes
  const minX = Array.isArray(nodes) && nodes.length ? Math.min(...nodes.map((n) => n.x ?? 0)) : 0
  const minY = Array.isArray(nodes) && nodes.length ? Math.min(...nodes.map((n) => n.y ?? 0)) : 0
  return jsonCanvasToElements(canvas, newId, (text) => linkedId(text), { x: at.x - minX, y: at.y - minY })
}

/** A new whiteboard holding a flowchart; returns its id (to open it). */
export async function boardFromMermaid(source: string, title: string): Promise<Id> {
  const type = systemType('whiteboard')
  if (!type) throw new Error('This space has no Whiteboard type.')
  const elements = await mermaidElements(source, { x: 0, y: 0 })
  const board = await api.createObject({ typeId: type.id, title })
  const session = useReplica() ? await openText(board.id) : await openRemoteText(board.id)
  addBoardElements(session.doc, elements)
  session.release()
  return board.id
}
