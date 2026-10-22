// The word for inbox items marked as dealt with ("Reviewed" unless the user picked another in
// Settings › Inbox), and whether those items fade in the inbox and the daily notes (off by default).
import { computed } from 'vue'
import { session } from './session.ts'

export const DEFAULT_REVIEWED_LABEL = 'Reviewed'

export const reviewed = computed(() => {
  const word = session.user?.inbox?.reviewedLabel || DEFAULT_REVIEWED_LABEL
  // "Reviewed" → "Mark reviewed"; an acronym stays as typed.
  const lower = word === word.toUpperCase() ? word : word.charAt(0).toLowerCase() + word.slice(1)
  return { word, lower, fade: !!session.user?.inbox?.fadeReviewed }
})
