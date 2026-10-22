<script setup lang="ts">
// /day/YYYY-MM-DD (or /day/today, vasta://day/…): that day in the calendar's day view, with its daily note.
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { isValidDay } from '@vasta/core'
import { dayKey, todayRoute } from '../lib/actions.ts'

const props = defineProps<{ day: string }>()
const router = useRouter()

onMounted(() => void router.replace(todayRoute(props.day === 'today' || !isValidDay(props.day) ? dayKey() : props.day)))
</script>

<template>
  <div class="grid h-full place-items-center text-sm text-ink-soft">Opening…</div>
</template>
