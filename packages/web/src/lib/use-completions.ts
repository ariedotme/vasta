// The list a typed line offers at the cursor (lib/typed-line.ts), for a text field: what to show,
// which one is highlighted, and Esc to put it away until the next keystroke.
import { computed, ref, watch, type Ref } from 'vue'
import { complete, type Completion, type CompletionSource } from './typed-line.ts'

export function useCompletions(text: Ref<string>, cursor: Ref<number>, source: () => CompletionSource | undefined) {
  const items = ref<Completion[]>([])
  const active = ref(0)
  const dismissed = ref(false)
  let seq = 0
  watch([text, cursor, source], async () => {
    const mine = ++seq
    dismissed.value = false
    const from = source()
    const found = from ? await complete(text.value, cursor.value, from).catch(() => []) : []
    if (mine !== seq) return
    items.value = found
    active.value = 0
  })
  const shown = computed(() => (dismissed.value ? [] : items.value))
  return {
    shown,
    active,
    dismiss: () => (dismissed.value = true),
    move: (step: number) => (active.value = (active.value + step + shown.value.length) % shown.value.length),
    current: () => shown.value[active.value],
  }
}
