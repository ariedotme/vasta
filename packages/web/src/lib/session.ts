// Who is logged in. The server keeps the session in an HttpOnly cookie; the app only learns the
// user from /api/auth/me and shows the login screen when there is none.
import { reactive } from 'vue'
import type { User } from '@vasta/core'
import { authApi, setUnauthorizedHandler } from './api.ts'
import { connectEvents, disconnectEvents } from './events.ts'
import { forgetNotifyToken, provideNotifyToken } from './platform.ts'
import { replicaRefusedByServer, startReplica, stopReplica } from './replica.ts'
import { people } from './people.ts'
import { loadWorkspace, resetWorkspace } from './state.ts'

export const session = reactive({
  user: null as User | null,
  /** False until the first /api/auth/me answered. */
  checked: false,
  /** No account exists on the server yet. */
  noUsers: false,
  error: '',
})

/** Whether the server lets apps use their local replica (see authApi.me). */
let replicaAllowed = true

async function start(user: User) {
  session.user = user
  people.me = user.id
  // The local replica answers the app when it can run here; otherwise the server does.
  if (replicaAllowed) await startReplica(user.id)
  else replicaRefusedByServer()
  await loadWorkspace()
  connectEvents()
  void provideNotifyToken()
}

// The desktop app forgets its notification token when the server refuses it: make another.
if (typeof window !== 'undefined') window.addEventListener('vasta:desktop', () => session.user && void provideNotifyToken())

/** Offline copies of the user's data kept by the service worker (public/sw.js). */
async function forgetOfflineData() {
  try {
    await Promise.all(['vasta-api', 'vasta-media'].map((name) => caches.delete(name)))
  } catch {}
}

function stop() {
  session.user = null
  Object.assign(people, { me: '', list: [], known: {} })
  forgetNotifyToken()
  void forgetOfflineData()
  void stopReplica({ wipe: true })
  disconnectEvents()
  resetWorkspace()
}

export async function checkSession() {
  setUnauthorizedHandler(stop)
  try {
    const { user, noUsers, replica } = await authApi.me()
    session.noUsers = !!noUsers
    replicaAllowed = replica
    if (user) await start(user)
  } catch (error) {
    session.error = `Could not reach the Vasta server (${(error as Error).message}).`
  } finally {
    session.checked = true
  }
}

export async function logIn(username: string, password: string) {
  await afterLogin(await authApi.login(username, password))
}

/** Create the server's first account and log into it. */
export async function setUp(data: { code: string; username: string; name: string; password: string }) {
  await afterLogin(await authApi.setup({ ...data, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }))
  session.noUsers = false
}

/** Make an account with an invite link's code and log into it. */
export async function join(data: { code: string; username: string; name: string; password: string }) {
  await afterLogin(await authApi.join({ ...data, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }))
}

async function afterLogin(user: User) {
  // Ask who is logged in once: the service worker keeps that answer, and the next start needs it
  // offline (otherwise the app only starts offline after one start online).
  await authApi
    .me()
    .then(({ replica }) => (replicaAllowed = replica))
    .catch(() => {})
  await start(user)
}

export async function logOut() {
  await authApi.logout().catch(() => {})
  stop()
}
