<script setup lang="ts">
// Vasta's mark (design/logo): a soft tile with a V cut from its top, in the text colour. Below 32 px
// it draws the small cut, whose wider V stays open with few pixels.
const props = withDefaults(defineProps<{ size?: number }>(), { size: 24 })
const SMALL = 'M64,26 L64.2,26 A14,14 0 0 1 77.35,35.21 L107.33,117.56 A22,22 0 0 0 148.67,117.56 L178.65,35.21 A14,14 0 0 1 191.8,26 L192,26 A36,36 0 0 1 228,62 L228,190 A36,36 0 0 1 192,226 L64,226 A36,36 0 0 1 28,190 L28,62 A36,36 0 0 1 64,26 Z'
const MASTER = 'M68,26 L74.79,26 A12,12 0 0 1 86.38,34.89 L114.48,139.74 A14,14 0 0 0 141.52,139.74 L169.62,34.89 A12,12 0 0 1 181.21,26 L188,26 A40,40 0 0 1 228,66 L228,186 A40,40 0 0 1 188,226 L68,226 A40,40 0 0 1 28,186 L28,66 A40,40 0 0 1 68,26 Z'
</script>

<template>
  <svg :width="props.size" :height="props.size" viewBox="28 26 200 200" fill="currentColor" role="img" aria-label="Vasta">
    <path :d="props.size < 32 ? SMALL : MASTER" />
  </svg>
</template>
