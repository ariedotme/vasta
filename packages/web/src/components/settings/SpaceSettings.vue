<script setup lang="ts">
// A space's name and icon, its members, and creating new spaces. Owners manage members (the server
// enforces it); everyone may rename the space or leave it.
import { computed, ref, watch } from 'vue'
import type { Icon, Id, SpaceRole } from '@vasta/core'
import { api, type Member } from '../../lib/api.ts'
import { confirmDialog, promptDialog } from '../../lib/overlays.ts'
import { session } from '../../lib/session.ts'
import { loadWorkspace, workspace } from '../../lib/state.ts'
import { loadPeople } from '../../lib/people.ts'
import AppIcon from '../AppIcon.vue'
import PersonAvatar from '../PersonAvatar.vue'
import IconPicker from '../IconPicker.vue'
import PopoverMenu from '../PopoverMenu.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label, primary, secondary } from './styles.ts'

const spaceId = ref<Id>(workspace.space!.id)
const space = computed(() => workspace.spaces.find((s) => s.id === spaceId.value) ?? workspace.space!)

const name = ref('')
const icon = ref<Icon | undefined>()
const iconAnchor = ref<HTMLElement | null>(null)
const iconOpen = ref(false)
const busy = ref(false)
const error = ref('')

const members = ref<Member[]>([])
const membersError = ref('')
const newUsername = ref('')
const newRole = ref<SpaceRole>('editor')

const me = computed(() => session.user!.id)
const isOwner = computed(() => members.value.some((m) => m.userId === me.value && m.role === 'owner'))
const dirty = computed(() => name.value.trim() !== space.value.name || JSON.stringify(icon.value) !== JSON.stringify(space.value.icon))

// Activity: how long the space keeps who did what (core activity.ts); owners change it.
const retention = ref<number | null>(null)
const RETENTION_LABELS: Record<number, string> = { 30: '1 month', 90: '3 months', 180: '6 months', 365: '1 year', 0: 'Forever' }
const RETENTION_CHOICES = [30, 90, 180, 365, 0]
async function loadRetention() {
  try {
    retention.value = (await api.activitySettings(spaceId.value)).retentionDays
  } catch {
    retention.value = null
  }
}
async function setRetention(event: Event) {
  const days = Number((event.target as HTMLSelectElement).value)
  const keep = retention.value
  if (keep !== null && days && (keep === 0 || days < keep)) {
    const ok = await confirmDialog({
      title: `Keep activity for ${RETENTION_LABELS[days]}?`,
      message: 'What is older than that is deleted now, for every member. Flow metrics only reach back as far as the activity kept.',
      confirmLabel: 'Delete older activity',
      danger: true,
    })
    if (!ok) {
      ;(event.target as HTMLSelectElement).value = String(keep)
      return
    }
  }
  try {
    retention.value = (await api.setActivitySettings(spaceId.value, days)).retentionDays
  } catch (failure) {
    membersError.value = (failure as Error).message
  }
}

async function loadMembers() {
  try {
    members.value = await api.members(spaceId.value)
  } catch (failure) {
    membersError.value = (failure as Error).message
  }
}

watch(
  spaceId,
  () => {
    name.value = space.value.name
    icon.value = space.value.icon
    error.value = ''
    membersError.value = ''
    void loadMembers()
    void loadRetention()
  },
  { immediate: true }
)

function pickIcon(picked: Icon | undefined) {
  if (picked) icon.value = picked
  iconOpen.value = false
}

async function save() {
  busy.value = true
  error.value = ''
  try {
    const saved = await api.updateSpace(spaceId.value, { name: name.value, ...(icon.value ? { icon: icon.value } : {}) })
    const index = workspace.spaces.findIndex((s) => s.id === saved.id)
    if (index >= 0) workspace.spaces[index] = saved
    if (workspace.space?.id === saved.id) workspace.space = { ...workspace.space, name: saved.name, ...(saved.icon ? { icon: saved.icon } : {}) }
    name.value = saved.name
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

async function newSpace() {
  const title = await promptDialog({ title: 'New space', message: 'A space of its own, with the built-in types. Share it from here afterwards.', placeholder: 'Home', confirmLabel: 'Create space' })
  if (!title) return
  try {
    const created = await api.createSpace({ name: title })
    await loadWorkspace(created.id)
    spaceId.value = created.id
  } catch (failure) {
    error.value = (failure as Error).message
  }
}

/** Run a member change and show the server's reason when it refuses. */
async function change(run: () => Promise<unknown>) {
  membersError.value = ''
  try {
    await run()
    await loadMembers()
    void loadPeople()
  } catch (failure) {
    membersError.value = (failure as Error).message
    await loadMembers()
  }
}

function setRole(member: Member, event: Event) {
  const role = (event.target as HTMLSelectElement).value as SpaceRole
  return change(() => api.setMemberRole(spaceId.value, member.userId, role))
}

async function addMember() {
  const username = newUsername.value.trim()
  if (!username) return
  await change(() => api.addMember(spaceId.value, username, newRole.value))
  if (!membersError.value) newUsername.value = ''
}

async function deleteSpace() {
  const target = space.value
  const ok = await confirmDialog({
    title: `Delete ${target.name}?`,
    message: `Everything in it disappears for all ${members.value.length > 1 ? `${members.value.length} members` : 'its members'}. For 30 days the server's admin can still bring it back with vasta space restore; then it is gone. Type the space's name to confirm.`,
    confirmLabel: 'Delete space',
    danger: true,
    requireText: target.name,
  })
  if (!ok) return
  error.value = ''
  try {
    await api.deleteSpace(target.id, target.name)
    const next = workspace.spaces.find((s) => s.id !== target.id)!
    await loadWorkspace(workspace.space?.id === target.id ? next.id : workspace.space!.id)
    spaceId.value = workspace.space!.id
  } catch (failure) {
    error.value = (failure as Error).message
  }
}

async function remove(member: Member) {
  const leaving = member.userId === me.value
  const ok = await confirmDialog({
    title: leaving ? `Leave ${space.value.name}?` : `Remove ${member.name} from ${space.value.name}?`,
    message: leaving ? 'You will no longer see this space. An owner can add you back.' : 'They will no longer see this space. Nothing in it is deleted.',
    confirmLabel: leaving ? 'Leave space' : 'Remove',
    danger: true,
  })
  if (!ok) return
  if (!leaving) return change(() => api.removeMember(spaceId.value, member.userId))
  try {
    await api.removeMember(spaceId.value, member.userId)
    const next = workspace.spaces.find((s) => s.id !== spaceId.value)!
    await loadWorkspace(workspace.space?.id === spaceId.value ? next.id : workspace.space!.id)
    spaceId.value = workspace.space!.id
  } catch (failure) {
    membersError.value = (failure as Error).message
  }
}
</script>

<template>
  <SettingsSection id="space" title="Space">
    <template #actions>
      <select v-if="workspace.spaces.length > 1" v-model="spaceId" class="rounded-md bg-hover px-2 py-0.5 text-sm outline-none" title="Space to change">
        <option v-for="option in workspace.spaces" :key="option.id" :value="option.id">{{ option.name }}</option>
      </select>
      <button class="ml-auto flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink" @click="newSpace"><AppIcon fallback="ph:plus" :size="14" /> New space</button>
    </template>

    <form class="flex items-end gap-3" @submit.prevent="save">
      <button
        ref="iconAnchor"
        type="button"
        class="grid h-[2.375rem] w-[2.375rem] shrink-0 place-items-center rounded-lg border border-line hover:bg-hover"
        title="Change icon"
        @click="iconOpen = !iconOpen"
      >
        <AppIcon :icon="icon" fallback="ph:planet" :size="20" class="text-ink-soft" />
      </button>
      <PopoverMenu v-model:open="iconOpen" :anchor="iconAnchor" width="auto">
        <div class="p-2"><IconPicker :icon="icon" @pick="pickIcon" /></div>
      </PopoverMenu>
      <label :class="label" class="flex-1">
        Name
        <input v-model="name" :class="field" />
      </label>
      <button type="submit" :class="primary" class="mb-0.5" :disabled="!dirty || !name.trim() || busy">Save</button>
    </form>
    <p v-if="error" :class="errorText" class="mt-2">{{ error }}</p>

    <h3 class="mt-6 mb-2 text-sm font-medium">Members</h3>
    <ul class="divide-y divide-line rounded-xl border border-line">
      <li v-for="member in members" :key="member.userId" class="flex items-center gap-3 px-3 py-2 text-sm">
        <PersonAvatar :id="member.userId" :name="member.name" :size="22" />
        <div class="min-w-0 flex-1">
          <div class="truncate">{{ member.name }}<span v-if="member.userId === me" class="text-ink-faint"> (you)</span></div>
          <div class="truncate text-xs text-ink-faint">{{ member.username }}</div>
        </div>
        <select
          v-if="isOwner"
          :value="member.role"
          class="rounded-md bg-hover px-2 py-1 text-sm outline-none"
          :aria-label="`Role of ${member.name}`"
          @change="setRole(member, $event)"
        >
          <option value="owner">Owner</option>
          <option value="editor">Editor</option>
        </select>
        <span v-else class="text-xs text-ink-soft">{{ member.role === 'owner' ? 'Owner' : 'Editor' }}</span>
        <button
          v-if="isOwner || member.userId === me"
          class="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-30"
          :title="member.userId === me ? (workspace.spaces.length > 1 ? 'Leave this space' : 'Your only space') : 'Remove from this space'"
          :disabled="member.userId === me && workspace.spaces.length <= 1"
          @click="remove(member)"
        >
          <AppIcon :fallback="member.userId === me ? 'ph:sign-out' : 'ph:x'" :size="14" />
        </button>
      </li>
    </ul>
    <form v-if="isOwner" class="mt-3 flex flex-wrap items-center gap-2" @submit.prevent="addMember">
      <input v-model="newUsername" class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-line-strong" placeholder="Username to add" autocapitalize="off" autocomplete="off" spellcheck="false" />
      <select v-model="newRole" class="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none">
        <option value="editor">Editor</option>
        <option value="owner">Owner</option>
      </select>
      <button type="submit" :class="secondary" :disabled="!newUsername.trim()">Add</button>
    </form>
    <p class="mt-2 text-xs text-ink-faint">
      Members see and change everything in the space. Owners also add and remove members. Add someone by their exact username; they need an account on this server.
    </p>
    <p v-if="membersError" :class="errorText" class="mt-2">{{ membersError }}</p>

    <div v-if="retention !== null" class="mt-6 flex flex-wrap items-center gap-3">
      <div class="min-w-0 flex-1 text-sm">
        <div class="font-medium">Activity history</div>
        <div class="text-xs text-ink-faint">Who changed what on each object (status, assignee, title…), shown at the bottom of its page. Older activity is deleted automatically.</div>
      </div>
      <select v-if="isOwner" :value="retention" class="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none" aria-label="Keep activity for" @change="setRetention">
        <option v-for="days in RETENTION_CHOICES" :key="days" :value="days">Keep {{ RETENTION_LABELS[days]!.toLowerCase() }}</option>
      </select>
      <span v-else class="text-sm text-ink-soft">Kept {{ RETENTION_LABELS[retention]?.toLowerCase() ?? `${retention} days` }}</span>
    </div>

    <div v-if="isOwner" class="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 px-3 py-2.5 dark:border-red-900/60">
      <div class="min-w-0 flex-1 text-sm">
        <div class="font-medium">Delete this space</div>
        <div class="text-xs text-ink-faint">{{ workspace.spaces.length > 1 ? 'For every member. Kept 30 days in case it was a mistake.' : 'Your only space cannot be deleted; create another one first.' }}</div>
      </div>
      <button class="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:hover:bg-red-950" :disabled="workspace.spaces.length <= 1" @click="deleteSpace">
        Delete space…
      </button>
    </div>
  </SettingsSection>
</template>
