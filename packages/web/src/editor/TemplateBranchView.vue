<script setup lang="ts">
// A branch of a template's conditional block: "If …", "Else if …" (CSS tells which by its place)
// or "Else", with its blocks. The header edits the condition and adds or removes branches.
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { computed } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import { openMenuAt, promptDialog } from '../lib/overlays.ts'

const props = defineProps(nodeViewProps)
const condition = computed(() => props.node.attrs.condition as string | null)

async function editCondition() {
  if (!props.editor.isEditable) return
  const next = await promptDialog({
    title: 'Condition',
    message: 'A formula, e.g. weekday(date) = 1, ask("Kind") = "Bug", has("Due").',
    value: condition.value ?? '',
    confirmLabel: 'Save',
  })
  if (next !== null) props.updateAttributes({ condition: next })
}

/** Where this branch's parent (the conditional block) is, and this branch's index in it. */
function place() {
  const pos = props.getPos()
  if (typeof pos !== 'number') return undefined
  const $pos = props.editor.state.doc.resolve(pos)
  return { parentPos: $pos.before(), index: $pos.index(), after: pos + props.node.nodeSize }
}

function addBranch(otherwise: boolean) {
  const at = place()
  if (!at) return
  const branch = { type: 'templateBranch', attrs: { condition: otherwise ? null : '' }, content: [{ type: 'paragraph' }] }
  // An Else goes last; an Else if right after this one.
  const parent = props.editor.state.doc.nodeAt(at.parentPos)
  const end = at.parentPos + (parent?.nodeSize ?? 0) - 1
  props.editor.chain().focus().insertContentAt(otherwise ? end : at.after, branch).run()
}

function remove() {
  const at = place()
  if (!at) return
  const parent = props.editor.state.doc.nodeAt(at.parentPos)
  if (!parent) return
  // The last branch takes the whole block with it.
  if (parent.childCount === 1) props.editor.chain().focus().deleteRange({ from: at.parentPos, to: at.parentPos + parent.nodeSize }).run()
  else props.deleteNode()
}

/** Keep the blocks, without the condition. */
function unwrap() {
  const at = place()
  if (!at) return
  const parent = props.editor.state.doc.nodeAt(at.parentPos)
  if (!parent) return
  props.editor.chain().focus().insertContentAt({ from: at.parentPos, to: at.parentPos + parent.nodeSize }, props.node.content.toJSON()).run()
}

function menu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const hasElse = (() => {
    const at = place()
    const parent = at ? props.editor.state.doc.nodeAt(at.parentPos) : null
    let found = false
    parent?.forEach((child) => (found ||= child.attrs.condition === null))
    return found
  })()
  openMenuAt(rect.left, rect.bottom + 4, [
    ...(condition.value !== null ? [{ label: 'Edit condition…', icon: 'ph:function', run: editCondition }] : []),
    { label: 'Add Else if', icon: 'ph:git-branch', run: () => addBranch(false) },
    ...(hasElse ? [] : [{ label: 'Add Else', icon: 'ph:arrow-elbow-down-right', run: () => addBranch(true) }]),
    { kind: 'separator' },
    { label: 'Keep these blocks, without the condition', icon: 'ph:arrow-square-out', run: unwrap },
    { label: 'Remove this branch', icon: 'ph:trash', danger: true, run: remove },
  ])
}
</script>

<template>
  <NodeViewWrapper class="vasta-template-branch">
    <div contenteditable="false" class="flex select-none items-center gap-1.5 text-xs font-medium text-violet-700 dark:text-violet-300">
      <AppIcon fallback="ph:git-branch" :size="13" />
      <template v-if="condition === null"><span>Else</span></template>
      <template v-else>
        <span class="vasta-branch-if">If</span><span class="vasta-branch-else-if">Else if</span>
        <button class="min-w-0 truncate rounded px-1 font-mono font-normal hover:bg-hover" :class="condition ? '' : 'text-ink-faint'" @click="editCondition">
          {{ condition || 'set a condition…' }}
        </button>
      </template>
      <button v-if="editor.isEditable" class="ml-auto rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink" title="Branch" @click="menu">
        <AppIcon fallback="ph:dots-three" :size="14" />
      </button>
    </div>
    <NodeViewContent class="min-w-0" />
  </NodeViewWrapper>
</template>
