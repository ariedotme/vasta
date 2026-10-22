// Renders a Vue list component next to the caret for TipTap suggestions (/ commands, @ mentions).
import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import { VueRenderer } from '@tiptap/vue-3'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import type { Component } from 'vue'

export interface SuggestionListExpose {
  onKeyDown: (event: KeyboardEvent) => boolean
}

export function suggestionPopup<T>(component: Component) {
  return () => {
    let renderer: VueRenderer | undefined
    let element: HTMLElement | undefined

    const place = async (props: SuggestionProps<T>) => {
      const rect = props.clientRect?.()
      if (!rect || !element) return
      const reference = { getBoundingClientRect: () => rect }
      const { x, y } = await computePosition(reference, element, {
        placement: 'bottom-start',
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      })
      Object.assign(element.style, { left: `${x}px`, top: `${y}px` })
    }

    return {
      onStart(props: SuggestionProps<T>) {
        renderer = new VueRenderer(component, { props, editor: props.editor })
        element = document.createElement('div')
        element.className = 'fixed left-0 top-0 z-50'
        if (renderer.element) element.appendChild(renderer.element)
        document.body.appendChild(element)
        void place(props)
      },
      onUpdate(props: SuggestionProps<T>) {
        renderer?.updateProps(props)
        if (element && renderer?.element && !element.contains(renderer.element)) element.replaceChildren(renderer.element)
        void place(props)
      },
      onKeyDown(props: SuggestionKeyDownProps) {
        if (props.event.key === 'Escape') {
          element?.remove()
          return true
        }
        return (renderer?.ref as SuggestionListExpose | undefined)?.onKeyDown(props.event) ?? false
      },
      onExit() {
        renderer?.destroy()
        element?.remove()
        renderer = undefined
        element = undefined
      },
    }
  }
}
