<script setup lang="ts">
// The desktop app (shown only inside it): its version, where updates come from, and the quick
// capture shortcut, recorded here and handed to the app (set_shortcut), which registers it.
import { onBeforeUnmount, ref, watch } from 'vue'
import { desktop, formatShortcut, recordShortcut, recording, setShortcut } from '../../lib/platform.ts'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label, secondary } from './styles.ts'

const DEFAULT = 'CommandOrControl+Shift+Space'
const HINT = 'Click the field and press the new keys.'
const isMac = navigator.platform.startsWith('Mac')

/** What the field shows: the shortcut, or the modifiers held while recording. */
const shown = ref('')
const hint = ref(HINT)
const error = ref('')
const saving = ref(false)
const reset = () => (shown.value = desktop.value ? formatShortcut(desktop.value.shortcut) : '')
watch(desktop, reset, { immediate: true })

async function save(accelerator: string) {
  saving.value = true
  error.value = ''
  try {
    await setShortcut(accelerator)
    hint.value = 'Saved.'
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    saving.value = false
    reset()
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Tab') return
  event.preventDefault()
  const noModifiers = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
  if (event.key === 'Escape' && noModifiers) return (event.target as HTMLElement).blur()
  const keys = recordShortcut(event)
  error.value = ''
  if (!keys.complete) return (shown.value = formatShortcut(keys.accelerator))
  // A key alone (or with Shift) would fire while typing anywhere; function keys may go alone.
  if (!keys.modifiers.some((m) => m !== 'Shift') && !/^F\d+$/.test(event.code)) {
    hint.value = isMac ? 'Add ⌘, ⌃ or ⌥ to the key.' : 'Add Ctrl, Alt or Super to the key.'
    return
  }
  hint.value = HINT
  void save(keys.accelerator)
}

// While the field has focus, the current shortcut (which the OS gives the app, not the page) only
// says it is the current one instead of opening quick capture.
const onCurrent = () => (hint.value = `${formatShortcut(desktop.value?.shortcut ?? DEFAULT)} is the shortcut now.`)
const recordFrom = (focused: boolean) => (recording.onCurrentShortcut = focused ? onCurrent : null)
onBeforeUnmount(() => recordFrom(false))
</script>

<template>
  <SettingsSection id="desktop" title="Desktop app">
    <div class="space-y-3 text-sm">
      <p>
        Vasta for desktop {{ desktop?.version }}
        <span v-if="desktop?.updates" class="text-ink-soft"> · updates from {{ desktop.updates }}</span>
        <span class="mt-1 block text-xs text-ink-faint">The window, the shortcut and the menu-bar icon: Check for Updates… looks for a new version of these. The notes inside are the web app, which updates with the server (This device shows its version).</span>
      </p>
      <template v-if="desktop?.setShortcut">
        <label :class="label">
          Quick capture shortcut
          <input
            :value="shown"
            readonly
            :class="[field, 'block max-w-60 cursor-pointer text-center caret-transparent']"
            :disabled="saving"
            @keydown="onKey"
            @keyup="!saving && reset()"
            @focus="recordFrom(true)"
            @blur="reset(), recordFrom(false)"
          />
          <span class="mt-1 block">{{ hint }} Works from any app; the menu-bar icon shows it too.</span>
        </label>
        <p v-if="error" :class="errorText">{{ error }}</p>
        <button v-if="desktop.shortcut !== DEFAULT" :class="secondary" :disabled="saving" @click="save('')">Use {{ formatShortcut(DEFAULT) }}</button>
      </template>
      <p v-else class="text-ink-soft">
        <template v-if="desktop">Quick capture: {{ formatShortcut(desktop.shortcut) }}. </template>Update the app (Check for Updates… in the Vasta icon’s menu) to change the shortcut here.
      </p>
    </div>
  </SettingsSection>
</template>
