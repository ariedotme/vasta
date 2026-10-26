// Mermaid diagrams: a code block whose language is "mermaid" shows the diagram (editor/CodeBlockView.vue,
// components/DocPreview.ts). Pele draws them (pele.run); each diagram type loads on first use, so
// spaces without diagrams never fetch it. Colors come from the theme (style.css, `.pele`).
//
// A diagram is someone's text in a shared space: no images (they would load from any server, as a
// tracking pixel would), and links open in a new tab without the page knowing where they came from.
import type { MountOptions, Mounted } from 'pele/lazy'

export const MERMAID = 'mermaid'

const OPTIONS: MountOptions = { images: false, linkRel: 'noopener noreferrer', zoom: 'auto' }

/** Draw `text` into `element`; `onError` gets Pele's message when the text is not a diagram it can draw. */
export async function mountDiagram(element: HTMLElement, text: string, onError: (message: string | null) => void): Promise<Mounted> {
  const { mountAsync } = await import('pele/lazy')
  const options: MountOptions = { ...OPTIONS, onRender: () => onError(null), onError: (error) => onError(errorText(error)) }
  return mountAsync(element, text, options)
}

/** Pele's message names the line and points at the spot in a snippet of it. */
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'This diagram could not be drawn.')
