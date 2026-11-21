<script setup lang="ts">
// The web page a weblink stands for: an address field while it has none, then the provider's
// embed (when there is one), a preview card and actions (change address, refresh, readable text).
import { computed, onMounted, ref, watch } from 'vue'
import { ARTICLE_PROPERTY_ID, type ObjectRecord } from '@vasta/core'
import { api, mediaUrl } from '../lib/api.ts'
import { embedFor } from '../lib/embeds.ts'
import { t, tc } from '../lib/i18n.ts'
import { promptDialog } from '../lib/overlays.ts'
import { notice } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import EmbedFrame from './EmbedFrame.vue'

const props = defineProps<{
  object: ObjectRecord
  /** Runs a server change after the page's pending edits are saved, then shows the result. */
  apply: (run: () => Promise<ObjectRecord>) => Promise<void>
  autofocus?: boolean
}>()

const media = computed(() => props.object.media ?? {})
const meta = computed(() => media.value.meta ?? {})
const embed = computed(() => embedFor(media.value.url))
const brokenImage = ref(false)
const image = computed(() => {
  if (brokenImage.value) return undefined
  return media.value.previewImageFile ? mediaUrl(media.value.previewImageFile.key) : media.value.previewImageUrl
})
watch(image, () => (brokenImage.value = false))
const hasArticle = computed(() => !!props.object.content[ARTICLE_PROPERTY_ID]?.content.length)

const address = ref('')
const input = ref<HTMLInputElement | null>(null)
const busy = ref<string | null>(null)
const error = ref('')
const copied = ref(false)

onMounted(() => {
  if (props.autofocus && !media.value.url) input.value?.focus()
})

async function run(label: string, call: () => Promise<ObjectRecord>) {
  if (busy.value) return
  busy.value = label
  error.value = ''
  try {
    await props.apply(call)
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = null
  }
}

function saveAddress() {
  const url = address.value.trim()
  if (url) void run(t('weblink.loadingPage'), () => api.setWeblinkUrl(props.object.id, url)).then(() => !error.value && (address.value = ''))
}

async function changeAddress() {
  const url = await promptDialog({ title: t('weblink.changeAddress'), value: media.value.url ?? '', placeholder: 'https://…', confirmLabel: t('common.save') })
  if (url && url !== media.value.url) await run(t('weblink.loadingPage'), () => api.setWeblinkUrl(props.object.id, url))
}

const refresh = () => run(t('weblink.refreshing'), () => api.refreshWeblink(props.object.id))
const saveReadable = () =>
  run(t('weblink.savingReadable'), async () => {
    const { lostHighlights, ...object } = await api.saveReadable(props.object.id)
    // Highlights of quotes are found again by their text; the page may have dropped some passages.
    if (lostHighlights?.length) {
      notice.value = {
        message: tc(lostHighlights.length, 'weblink.lostHighlights.one', 'weblink.lostHighlights.other', {
          sample: lostHighlights[0]!.slice(0, 60),
        }),
      }
    }
    return object
  })

async function copy() {
  if (!media.value.url) return
  await navigator.clipboard.writeText(media.value.url)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <section class="mb-6">
    <form v-if="!media.url" class="flex items-center gap-2 rounded-xl border border-dashed border-line p-2" @submit.prevent="saveAddress">
      <AppIcon fallback="ph:link" class="ml-1.5 text-ink-faint" />
      <input
        ref="input"
        v-model="address"
        class="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-ink-faint"
        :placeholder="t('weblink.pastePlaceholder')"
        :disabled="!!busy"
      />
      <button class="rounded-lg bg-ink px-3 py-1.5 text-sm text-surface disabled:opacity-40" :disabled="!address.trim() || !!busy">{{ t('common.save') }}</button>
    </form>

    <template v-else>
      <EmbedFrame v-if="embed" :embed="embed" class="mb-3" />
      <a :href="media.url" target="_blank" rel="noopener noreferrer" class="flex overflow-hidden rounded-xl border border-line bg-raised hover:border-line-strong">
        <img v-if="image && !embed" :src="image" alt="" class="h-32 w-48 shrink-0 object-cover" loading="lazy" @error="brokenImage = true" />
        <div class="min-w-0 p-3">
          <div class="flex items-center gap-1.5 text-xs text-ink-faint">
            <AppIcon fallback="ph:globe-hemisphere-west" :size="13" />{{ media.host ?? meta.publisher }}
          </div>
          <div class="mt-1 truncate font-medium">{{ meta.title ?? media.url }}</div>
          <p v-if="meta.description" class="mt-1 line-clamp-2 text-sm text-ink-soft">{{ meta.description }}</p>
        </div>
      </a>
      <div class="mt-2 flex flex-wrap items-center gap-1 text-xs text-ink-faint">
        <button class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-ink" @click="copy">
          <AppIcon :fallback="copied ? 'ph:check' : 'ph:copy'" :size="13" /> {{ copied ? t('weblink.copied') : t('weblink.copyLink') }}
        </button>
        <button class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-ink disabled:opacity-40" :disabled="!!busy" @click="changeAddress">
          <AppIcon fallback="ph:pencil-simple" :size="13" /> {{ t('weblink.changeAddress') }}
        </button>
        <button class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-ink disabled:opacity-40" :disabled="!!busy" :title="t('weblink.refreshTitle')" @click="refresh">
          <AppIcon fallback="ph:arrow-clockwise" :size="13" /> {{ t('weblink.refresh') }}
        </button>
        <button class="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-ink disabled:opacity-40" :disabled="!!busy" :title="t('weblink.readableTitle')" @click="saveReadable">
          <AppIcon fallback="ph:article" :size="13" /> {{ hasArticle ? t('weblink.updateReadable') : t('weblink.saveReadable') }}
        </button>
      </div>
    </template>

    <p v-if="busy" class="mt-2 text-xs text-ink-faint">{{ busy }}</p>
    <p v-else-if="error" class="mt-2 text-xs text-red-600">{{ error }}</p>
  </section>
</template>
