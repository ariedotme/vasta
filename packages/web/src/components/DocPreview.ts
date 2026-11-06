// Read-only rendering of rich text outside the editor (the inbox), without loading TipTap.
// Covers what captures contain: paragraphs with marks and links, lists, quotes, code (Mermaid
// diagrams drawn), mentions and embedded objects; other containers show their children.
import { defineComponent, h, type PropType, type VNode } from 'vue'
import type { DocMark, DocNode } from '@vasta/core'
import { displayTitle } from '../lib/format.ts'
import { imageOf } from '../lib/media.ts'
import { iconTextClasses } from '../lib/colors.ts'
import { summaryOf, typesById } from '../lib/state.ts'
import { MERMAID } from '../lib/mermaid.ts'
import AppIcon from './AppIcon.vue'
import MermaidDiagram from './MermaidDiagram.vue'
import ObjectChip from './ObjectChip.vue'
import ObjectLink from './ObjectLink.vue'

const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href) ? href : undefined)

function withMark(child: VNode | string, mark: DocMark): VNode | string {
  switch (mark.type) {
    case 'bold':
      return h('strong', child)
    case 'italic':
      return h('em', child)
    case 'strike':
      return h('s', child)
    case 'code':
      return h('code', { class: 'rounded bg-hover px-1 text-[0.9em]' }, child)
    case 'link': {
      const href = safeHref(mark.attrs.href)
      return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'text-accent underline underline-offset-2' }, child) : child
    }
    default:
      return child
  }
}

/** An embedded object: its picture when it is one, otherwise a one-line link with its icon. */
function embed(objectId: string): VNode {
  const summary = summaryOf(objectId)
  const type = typesById.value.get(summary?.typeId ?? '')
  const image = summary && (type?.system === 'image' || type?.system === 'weblink') ? imageOf(summary) : undefined
  const title = displayTitle(summary, type)
  if (image && type?.system === 'image') {
    return h(ObjectLink, { id: objectId, class: 'my-1 block w-fit' }, () =>
      h('img', { src: image, alt: '', loading: 'lazy', class: 'max-h-56 max-w-full rounded-lg', width: summary?.media?.width, height: summary?.media?.height })
    )
  }
  return h(ObjectLink, { id: objectId, class: 'my-1 flex max-w-full items-center gap-2.5 rounded-lg border border-line bg-surface p-1.5 pr-3 hover:bg-hover' }, () => [
    image
      ? h('img', { src: image, alt: '', loading: 'lazy', class: 'h-10 w-14 shrink-0 rounded object-cover' })
      : h('span', { class: 'grid h-8 w-8 shrink-0 place-items-center rounded bg-hover' }, [
          h(AppIcon, { icon: summary?.icon ?? type?.icon, fallback: 'ph:file-text', class: type?.color ? iconTextClasses[type.color] : 'text-ink-soft' }),
        ]),
    h('span', { class: 'min-w-0' }, [
      h('span', { class: 'block truncate text-sm font-medium' }, title),
      summary?.media?.host || type ? h('span', { class: 'block truncate text-xs text-ink-faint' }, summary?.media?.host ?? type?.name) : null,
    ]),
  ])
}

function inline(nodes: DocNode[] | undefined): (VNode | string)[] {
  return (nodes ?? []).map((node) => {
    if (node.type === 'text') return (node.marks ?? []).reduce<VNode | string>(withMark, node.text ?? '')
    if (node.type === 'hardBreak') return h('br')
    if (node.type === 'mention' && typeof node.attrs?.objectId === 'string') return h(ObjectChip, { id: node.attrs.objectId, class: 'align-baseline' })
    return h('span', inline(node.content))
  })
}

function block(node: DocNode): VNode | null {
  const children = () => (node.content ?? []).map(block)
  switch (node.type) {
    case 'paragraph':
      return node.content?.length ? h('p', { class: 'my-0.5 whitespace-pre-wrap break-words' }, inline(node.content)) : null
    case 'heading':
      return h('p', { class: 'my-1 font-semibold' }, inline(node.content))
    case 'bulletList':
    case 'taskList':
      return h('ul', { class: 'my-0.5 list-disc pl-5' }, children())
    case 'orderedList':
      return h('ol', { class: 'my-0.5 list-decimal pl-5' }, children())
    case 'listItem':
    case 'taskItem':
      return h('li', children())
    case 'blockquote':
      return h('blockquote', { class: 'my-1 border-l-2 border-line-strong pl-3 text-ink-soft' }, children())
    case 'codeBlock':
      if (node.attrs?.language === MERMAID) return h(MermaidDiagram, { text: (node.content ?? []).map((n) => n.text ?? '').join('') })
      return h('pre', { class: 'my-1 overflow-x-auto rounded-lg bg-hover p-2 text-xs' }, inline(node.content))
    case 'objectEmbed':
      return typeof node.attrs?.objectId === 'string' ? embed(node.attrs.objectId) : null
    default:
      return node.content ? h('div', children()) : null
  }
}

export default defineComponent({
  name: 'DocPreview',
  props: { content: { type: Array as PropType<DocNode[]>, required: true } },
  setup: (props) => () => h('div', { class: 'min-w-0 text-[15px] leading-relaxed' }, props.content.map(block)),
})
