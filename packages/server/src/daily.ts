// Daily notes: one object of the built-in "daily-note" type per day, created the first time
// the day is opened or something is captured into it (shared with the client store, in core).
export { dayIn as localDay, findOrCreateDailyNote, isValidDay } from '@vasta/core'
