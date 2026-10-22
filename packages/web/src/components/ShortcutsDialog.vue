<script setup lang="ts">
// ⌘/: the keyboard shortcuts (lib/shortcuts.ts).
import { SHORTCUTS } from '../lib/shortcuts.ts'
import { ui } from '../lib/state.ts'
import ModalDialog from './ModalDialog.vue'

const kbd = 'inline-grid min-w-6 place-items-center rounded-md border border-line bg-raised px-1.5 py-0.5 font-sans text-xs text-ink-soft shadow-[0_1px_0_var(--color-line)]'
</script>

<template>
  <ModalDialog title="Keyboard shortcuts" width="34rem" @close="ui.shortcutsOpen = false">
    <div class="space-y-6">
      <section v-for="group in SHORTCUTS" :key="group.group">
        <h3 class="mb-1.5 text-xs font-medium text-ink-faint">{{ group.group }}</h3>
        <ul class="divide-y divide-line/70">
          <li v-for="shortcut in group.items" :key="shortcut.id" class="flex items-center gap-3 py-2 text-sm">
            <span class="flex-1">{{ shortcut.label }}</span>
            <span class="flex items-center gap-1">
              <kbd v-for="key in shortcut.keys" :key="key" :class="kbd">{{ key }}</kbd>
              <template v-if="shortcut.alt">
                <span class="px-1 text-xs text-ink-faint">or</span>
                <template v-for="(key, i) in shortcut.alt" :key="key">
                  <span v-if="i" class="text-xs text-ink-faint">then</span>
                  <kbd :class="kbd">{{ key }}</kbd>
                </template>
              </template>
            </span>
          </li>
        </ul>
      </section>
    </div>
  </ModalDialog>
</template>
