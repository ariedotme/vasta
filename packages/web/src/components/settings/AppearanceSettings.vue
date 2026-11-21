<script setup lang="ts">
// Language, theme, block spacing, page width and how type icons look, on this device; and the keyboard shortcuts.
import { computed } from 'vue'
import { AVAILABLE_LOCALES, detectedLocale, language, LOCALE_NAMES, t, type MessageKey } from '../../lib/i18n.ts'
import { pageWidth, PAGE_WIDTH_OPTIONS, type PageWidth } from '../../lib/page-width.ts'
import { keysOf } from '../../lib/shortcuts.ts'
import { ui } from '../../lib/state.ts'
import { blockSpacing, iconStyle, theme, THEME_ICONS, type IconStyle, type Theme } from '../../lib/theme.ts'
import TypeIcon from '../TypeIcon.vue'
import { iconBoxClasses, iconTextClasses } from '../../lib/colors.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { label, secondary } from './styles.ts'

const ICON_STYLES = computed<{ value: IconStyle; label: string }[]>(() => [
  { value: 'boxed', label: t('settings.appearance.iconBoxed') },
  { value: 'plain', label: t('settings.appearance.iconPlain') },
])
const SAMPLE = [
  { icon: 'ph:bookmark-simple', color: 'pink' },
  { icon: 'ph:user', color: 'orange' },
  { icon: 'ph:globe-hemisphere-west', color: 'sky' },
] as const

const OPTIONS = computed<{ value: Theme; label: string }[]>(() => [
  { value: 'system', label: t('settings.appearance.themeSystem') },
  { value: 'light', label: t('settings.appearance.themeLight') },
  { value: 'dark', label: t('settings.appearance.themeDark') },
])

const WIDTH_KEYS: Record<PageWidth, MessageKey> = {
  standard: 'settings.appearance.widthStandard',
  wide: 'settings.appearance.widthWide',
  full: 'settings.appearance.widthFull',
}
</script>

<template>
  <SettingsSection id="appearance" :title="t('settings.appearance.title')">
    <div class="space-y-5">
      <label class="block">
        <span :class="label">{{ t('settings.appearance.language') }}</span>
        <select v-model="language" class="mt-1.5 block rounded-md border border-line bg-surface px-2 py-1.5 text-sm" :aria-label="t('settings.appearance.language')">
          <option value="auto">{{ t('settings.appearance.languageAuto', { detected: LOCALE_NAMES[detectedLocale] }) }}</option>
          <option v-for="code in AVAILABLE_LOCALES" :key="code" :value="code">{{ LOCALE_NAMES[code] }}</option>
        </select>
      </label>
      <div>
        <span :class="label">{{ t('settings.appearance.theme') }}</span>
        <div class="mt-1.5 inline-flex rounded-lg bg-hover p-0.5" role="radiogroup" :aria-label="t('settings.appearance.theme')">
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
      <label class="block">
        <span :class="label">{{ t('settings.appearance.blockSpacing') }}</span>
        <select v-model="blockSpacing" class="mt-1.5 block rounded-md border border-line bg-surface px-2 py-1.5 text-sm">
          <option value="compact">{{ t('settings.appearance.spacingCompact') }}</option>
          <option value="comfortable">{{ t('settings.appearance.spacingComfortable') }}</option>
          <option value="spacious">{{ t('settings.appearance.spacingSpacious') }}</option>
        </select>
      </label>
      <div>
        <span :class="label">{{ t('settings.appearance.pageWidth') }}</span>
        <div class="mt-1.5 inline-flex max-w-full flex-wrap rounded-lg bg-hover p-0.5" role="radiogroup" :aria-label="t('settings.appearance.pageWidth')">
          <button
            v-for="option in PAGE_WIDTH_OPTIONS"
            :key="option.value"
            role="radio"
            :aria-checked="pageWidth === option.value"
            class="rounded-md px-3 py-1.5 text-sm max-md:py-2"
            :class="pageWidth === option.value ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'"
            @click="pageWidth = option.value"
          >
            {{ t(WIDTH_KEYS[option.value]) }}
          </button>
        </div>
      </div>
      <div>
        <span :class="label">{{ t('settings.appearance.typeIcons') }}</span>
        <div class="mt-1.5 grid gap-2 sm:grid-cols-2" role="radiogroup" :aria-label="t('settings.appearance.typeIcons')">
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
          <AppIcon fallback="ph:keyboard" :size="15" /> {{ t('nav.keyboardShortcuts') }}
        </button>
        <span class="text-xs text-ink-faint">{{ t('settings.appearance.shortcutsHint', { keys: keysOf('shortcuts') }) }}</span>
      </div>
    </div>
  </SettingsSection>
</template>
