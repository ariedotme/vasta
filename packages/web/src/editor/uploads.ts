// Images and files into documents: paste, drop, or "/image". Each file becomes an object of the
// space (POST /api/spaces/:id/files) embedded where it landed; images show as pictures (the
// `image` display of objectEmbed). While a file uploads, a placeholder lives in a decoration, not
// in the document, so a save meanwhile or a failed upload leaves nothing broken behind.
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { api, MAX_UPLOAD_BYTES } from '../lib/api.ts'
import { lastError, primeFromObject, refreshCounts, typesById, workspace } from '../lib/state.ts'

type Meta = { add: { id: string; pos: number; file: File; preview?: string } } | { remove: string }

const key = new PluginKey<DecorationSet>('vasta-uploads')

function placeholder(file: File, preview?: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'vasta-upload'
  box.contentEditable = 'false'
  if (preview) {
    const img = document.createElement('img')
    img.src = preview
    img.alt = ''
    box.appendChild(img)
  }
  const label = document.createElement('span')
  label.textContent = `Uploading ${file.name || 'file'}…`
  box.appendChild(label)
  return box
}

function findPlaceholder(state: EditorState, id: string): number | undefined {
  return key.getState(state)?.find(undefined, undefined, (spec) => spec.id === id)[0]?.from
}

const isImage = (file: File) => file.type.startsWith('image/')

/** Upload files and embed each where `pos` was (mapped through edits made meanwhile). */
export function uploadFiles(view: EditorView, files: File[], pos: number) {
  const spaceId = workspace.space?.id
  if (!spaceId) return
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      lastError.value = `${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`
      continue
    }
    const id = Math.random().toString(36).slice(2)
    const preview = isImage(file) ? URL.createObjectURL(file) : undefined
    view.dispatch(view.state.tr.setMeta(key, { add: { id, pos, file, preview } } satisfies Meta))
    api
      .uploadFile(spaceId, file)
      .then((object) => {
        primeFromObject(object)
        void refreshCounts()
        const at = findPlaceholder(view.state, id)
        if (at === undefined || view.isDestroyed) return
        const display = typesById.value.get(object.typeId)?.system === 'image' ? 'image' : 'inline'
        const node = view.state.schema.nodes.objectEmbed!.create({ objectId: object.id, display })
        const tr = view.state.tr.setMeta(key, { remove: id } satisfies Meta)
        const $at = tr.doc.resolve(at)
        // An empty line becomes the picture; otherwise the picture goes below the line.
        if ($at.parent.isTextblock && !$at.parent.content.size && $at.depth > 0) tr.replaceWith($at.before(), $at.after(), node)
        else tr.insert($at.depth > 0 ? $at.after() : at, node)
        view.dispatch(tr)
      })
      .catch((error: Error) => {
        lastError.value = `Could not upload ${file.name}: ${error.message}`
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { remove: id } satisfies Meta))
      })
      .finally(() => preview && setTimeout(() => URL.revokeObjectURL(preview), 5000))
  }
}

/** Open the file picker (photo library and camera on phones) and upload what was chosen. */
export function pickImages(editor: Editor) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])]
    if (files.length) uploadFiles(editor.view, files, editor.state.selection.from)
  })
  input.click()
}

const filesOf = (data: DataTransfer | null | undefined) => [...(data?.files ?? [])]

export const Uploads = Extension.create({
  name: 'vastaUploads',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc)
            const meta = tr.getMeta(key) as Meta | undefined
            if (meta && 'add' in meta) {
              const { id, pos, file, preview } = meta.add
              set = set.add(tr.doc, [Decoration.widget(pos, () => placeholder(file, preview), { id, side: 1 })])
            } else if (meta && 'remove' in meta) {
              set = set.remove(set.find(undefined, undefined, (spec) => spec.id === meta.remove))
            }
            return set
          },
        },
        props: {
          decorations: (state) => key.getState(state),
          handlePaste: (view, event) => {
            const files = filesOf(event.clipboardData)
            if (!files.length) return false
            uploadFiles(view, files, view.state.selection.from)
            return true
          },
          handleDrop: (view, event, _slice, moved) => {
            const files = filesOf(event.dataTransfer)
            if (moved || !files.length) return false
            const found = view.posAtCoords({ left: event.clientX, top: event.clientY })
            uploadFiles(view, files, found?.pos ?? view.state.selection.from)
            return true
          },
        },
      }),
    ]
  },
})
