<script setup lang="ts">
// Nutrients in a row, each after a dot of its color: "● 150 kcal ● 5.4 g protein ● 29 g carbs ● 1.8 g fat".
import { computed } from 'vue'
import type { Nutrients } from '@vasta/core'
import { t } from '../../lib/i18n.ts'
import { formatGrams, formatKcal, nutrientColor } from '../../lib/nutrition.ts'

defineProps<{ nutrients: Nutrients }>()
const parts = computed(() => [['protein', t('nutrition.nutrient.proteinLower')], ['carbs', t('nutrition.nutrient.carbsLower')], ['fat', t('nutrition.nutrient.fatLower')]] as const)
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-x-2.5 gap-y-0.5 tabular-nums">
    <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full" :style="{ background: nutrientColor('kcal') }" />{{ formatKcal(nutrients.kcal) }} kcal</span>
    <span v-for="[key, label] in parts" :key="key" class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full" :style="{ background: nutrientColor(key) }" />{{ formatGrams(nutrients[key]) }} g {{ label }}</span>
    <span v-if="nutrients.fiber !== undefined" class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full" :style="{ background: nutrientColor('fiber') }" />{{ formatGrams(nutrients.fiber) }} g {{ t('nutrition.nutrient.fiberLower') }}</span>
  </span>
</template>
