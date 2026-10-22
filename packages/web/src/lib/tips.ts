// "Getting started" tips for people new to Vasta (TipsCard): shown on Today and on empty type
// pages until hidden. Hidden per device (localStorage), like the theme.
import { ref } from 'vue'
import { authApi } from './api.ts'

const HIDDEN_KEY = 'vasta.tips.hidden'

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export const tipsHidden = ref(readHidden())

export function hideTips() {
  tipsHidden.value = true
  try {
    localStorage.setItem(HIDDEN_KEY, '1')
  } catch {}
}

/** Whether the user is the server's first account, who invites people; asked once. */
export const serverAdmin = ref(false)
let asked = false
export function askServerAdmin() {
  if (asked) return
  asked = true
  authApi
    .accounts()
    .then((accounts) => (serverAdmin.value = accounts.admin))
    .catch(() => {})
}
