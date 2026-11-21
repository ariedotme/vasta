<script setup lang="ts">
// The desktop app (shown only inside it): its version, where updates come from, and the quick
// capture shortcut, recorded here and handed to the app (set_shortcut), which registers it; and
// whether quick capture asks a template's questions before it saves (this device's choice).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../../lib/i18n.ts'
import { desktop, formatShortcut, recordShortcut, recording, setShortcut } from '../../lib/platform.ts'
import { ui } from '../../lib/state.ts'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label, secondary } from './styles.ts'

const DEFAULT = 'CommandOrControl+Shift+Space'
const isMac = navigator.platform.startsWith('Mac')

/** What the field shows: the shortcut, or the modifiers held while recording. */
const shown = ref('')
type HintState = 'default' | 'saved' | 'modifier' | 'current'
const hintState = ref<HintState>('default')
const hint = computed(() =>
  hintState.value === 'saved'
    ? t('settings.savedDot')
    : hintState.value === 'modifier'
      ? isMac
        ? t('settings.desktop.addModifierMac')
        : t('settings.desktop.addModifierOther')
      : hintState.value === 'current'
        ? t('settings.desktop.currentShortcut', { keys: formatShortcut(desktop.value?.shortcut ?? DEFAULT) })
        : t('settings.desktop.shortcutHint')
)
const error = ref('')
const saving = ref(false)
const reset = () => (shown.value = desktop.value ? formatShortcut(desktop.value.shortcut) : '')
watch(desktop, reset, { immediate: true })

async function save(accelerator: string) {
  saving.value = true
  error.value = ''
  try {
    await setShortcut(accelerator)
    hintState.value = 'saved'
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
    hintState.value = 'modifier'
    return
  }
  hintState.value = 'default'
  void save(keys.accelerator)
}

// While the field has focus, the current shortcut (which the OS gives the app, not the page) only
// says it is the current one instead of opening quick capture.
const onCurrent = () => (hintState.value = 'current')
const recordFrom = (focused: boolean) => (recording.onCurrentShortcut = focused ? onCurrent : null)
onBeforeUnmount(() => recordFrom(false))
</script>

<template>
  <SettingsSection id="desktop" :title="t('settings.section.desktop')">
    <div class="space-y-3 text-sm">
      <p>
        {{ t('settings.desktop.version', { version: desktop?.version ?? '' }) }}
        <span v-if="desktop?.updates" class="text-ink-soft">{{ t('settings.desktop.updatesFrom', { source: desktop.updates }) }}</span>
        <span class="mt-1 block text-xs text-ink-faint">{{ t('settings.desktop.versionHint') }}</span>
      </p>
      <template v-if="desktop?.setShortcut">
        <label :class="label">
          {{ t('settings.desktop.quickCaptureShortcut') }}
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
          <span class="mt-1 block">{{ t('settings.desktop.shortcutWorksAnywhere', { hint }) }}</span>
        </label>
        <p v-if="error" :class="errorText">{{ error }}</p>
        <button v-if="desktop.shortcut !== DEFAULT" :class="secondary" :disabled="saving" @click="save('')">{{ t('settings.desktop.useDefault', { keys: formatShortcut(DEFAULT) }) }}</button>
      </template>
      <p v-else class="text-ink-soft">
        <template v-if="desktop">{{ t('settings.desktop.quickCaptureCurrent', { keys: formatShortcut(desktop.shortcut) }) }}</template>{{ t('settings.desktop.updateToChange') }}
      </p>
      <label class="flex items-center gap-2">
        <input v-model="ui.captureDaily" type="checkbox" class="accent-[var(--color-accent)]" />
        {{ t('settings.desktop.captureDaily') }}
      </label>
      <label class="flex items-center gap-2">
        <input v-model="ui.captureInbox" type="checkbox" class="accent-[var(--color-accent)]" />
        {{ t('settings.desktop.captureInbox') }}
      </label>
      <label class="flex items-start gap-2">
        <input v-model="ui.captureAsks" type="checkbox" class="mt-0.5 accent-[var(--color-accent)]" />
        <span>
          {{ t('settings.desktop.captureAsks') }}
          <span class="mt-0.5 block text-xs text-ink-faint">{{ t('settings.desktop.captureAsksHint') }}</span>
        </span>
      </label>
    </div>
  </SettingsSection>
</template>
