<script setup lang="ts">
// Light, dark or the system's, and how type icons look, on this device; and the keyboard shortcuts.
import { keysOf } from '../../lib/shortcuts.ts'
import { ui } from '../../lib/state.ts'
import { iconStyle, theme, THEME_ICONS, type IconStyle, type Theme } from '../../lib/theme.ts'
import TypeIcon from '../TypeIcon.vue'
import { iconBoxClasses, iconTextClasses } from '../../lib/colors.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { label, secondary } from './styles.ts'

const ICON_STYLES: { value: IconStyle; label: string }[] = [
  { value: 'boxed', label: 'In a colored square' },
  { value: 'plain', label: 'Icon only' },
]
const SAMPLE = [
  { icon: 'ph:bookmark-simple', color: 'pink' },
  { icon: 'ph:user', color: 'orange' },
  { icon: 'ph:globe-hemisphere-west', color: 'sky' },
] as const

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]
</script>

<template>
  <SettingsSection id="appearance" title="Appearance">
    <div class="space-y-5">
      <div>
        <span :class="label">Theme, on this device</span>
        <div class="mt-1.5 inline-flex rounded-lg bg-hover p-0.5" role="radiogroup" aria-label="Theme">
          <button
            v-for="option in OPTIONS"
            :key="option.value"
            role="radio"
            :aria-checked="theme === option.value"
            class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm max-md:py-2"
            :class="theme === option.value ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'"
            @click="theme = option.value"
          >
            <AppIcon :fallback="THEME_ICONS[option.value]" :size="15" /> {{ option.label }}
          </button>
        </div>
      </div>
      <div>
        <span :class="label">Type icons</span>
        <div class="mt-1.5 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Type icons">
          <button
            v-for="option in ICON_STYLES"
            :key="option.value"
            role="radio"
            :aria-checked="iconStyle === option.value"
            class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm ring-1"
            :class="iconStyle === option.value ? 'bg-raised font-medium ring-2 ring-accent' : 'ring-line hover:bg-hover'"
            @click="iconStyle = option.value"
          >
            <span class="flex items-center gap-1.5">
              <template v-for="sample in SAMPLE" :key="sample.icon">
                <TypeIcon v-if="option.value === iconStyle" :icon="{ kind: 'icon', value: sample.icon }" :color="sample.color" :size="18" />
                <span v-else-if="option.value === 'boxed'" class="inline-grid h-5 w-5 place-items-center rounded-[5px]" :class="iconBoxClasses[sample.color]"><AppIcon :fallback="sample.icon" :size="13" /></span>
                <AppIcon v-else :fallback="sample.icon" :size="18" :class="iconTextClasses[sample.color]" />
              </template>
            </span>
            {{ option.label }}
          </button>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3 max-md:hidden">
        <button :class="secondary" class="flex items-center gap-2" @click="ui.shortcutsOpen = true">
          <AppIcon fallback="ph:keyboard" :size="15" /> Keyboard shortcuts
        </button>
        <span class="text-xs text-ink-faint">{{ keysOf('shortcuts') }} anywhere in the app.</span>
      </div>
    </div>
  </SettingsSection>
</template>
