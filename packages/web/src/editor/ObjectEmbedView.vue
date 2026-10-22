<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { computed, inject, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../components/AppIcon.vue'
import EmbedFrame from '../components/EmbedFrame.vue'
import QueryEmbed from '../components/QueryEmbed.vue'
import BlockEmbed from './BlockEmbed.vue'
import { chip, iconTextClasses } from '../lib/colors.ts'
import { embedFor } from '../lib/embeds.ts'
import { displayTitle } from '../lib/format.ts'
import { imageOf } from '../lib/media.ts'
import { PAGE_OBJECT_ID } from '../lib/page.ts'
import { summaryOf, typesById } from '../lib/state.ts'

const props = defineProps(nodeViewProps)
const router = useRouter()
const objectId = computed(() => props.node.attrs.objectId as string)
const display = computed(() => props.node.attrs.display as string)
const blockId = computed(() => props.node.attrs.blockId as string | null)
const summary = computed(() => summaryOf(objectId.value))
const type = computed(() => typesById.value.get(summary.value?.typeId ?? ''))
const title = computed(() => displayTitle(summary.value, type.value))
const image = computed(() => (summary.value ? imageOf(summary.value) : undefined))
const open = () => router.push(`/o/${objectId.value}`)
/** The picture would not load (e.g. a HEIC photo outside Safari): show the card instead. */
const broken = ref(false)
const asImage = computed(() => display.value === 'image' && !!image.value && !broken.value)
const pageId = inject(PAGE_OBJECT_ID, undefined)
const isQuery = computed(() => type.value?.system === 'query')
/** "Embed" display of a weblink from a known site: the provider's player instead of a card. */
const player = computed(() => (display.value === 'embed' && type.value?.system === 'weblink' ? embedFor(summary.value?.media?.url) : undefined))
</script>

<template>
  <!-- Queries put the drag handle on their header, so their controls stay usable. -->
  <NodeViewWrapper class="my-1" contenteditable="false" :data-drag-handle="isQuery ? undefined : ''">
    <!-- One block of the object: a read-only copy that follows it -->
    <BlockEmbed v-if="blockId" :object-id="objectId" :block-id="blockId" />

    <!-- Inline: one line, like a link that takes a whole row -->
    <button v-else-if="display === 'inline'" class="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left hover:bg-hover" @click="open">
      <AppIcon :icon="summary?.icon ?? type?.icon" fallback="ph:file-text" :class="type?.color ? iconTextClasses[type.color] : 'text-ink-soft'" />
      <span class="truncate font-medium underline decoration-line-strong underline-offset-[3px]">{{ title }}</span>
    </button>

    <!-- Image: the picture at full width; its size is known up front so the page does not jump -->
    <figure v-else-if="asImage" class="max-w-full">
      <button class="block max-w-full" :title="title" @click="open">
        <img
          :src="image"
          :width="summary?.media?.width"
          :height="summary?.media?.height"
          alt=""
          class="block h-auto max-h-[36rem] w-auto max-w-full rounded-lg"
          loading="lazy"
          @error="broken = true"
        />
      </button>
      <figcaption v-if="summary?.preview" class="mt-1 text-sm text-ink-faint">{{ summary.preview }}</figcaption>
    </figure>

    <!-- Queries show their live results -->
    <QueryEmbed v-else-if="isQuery" :object-id="objectId" :parent-id="pageId" />

    <!-- Weblink player, with a line that opens the weblink -->
    <div v-else-if="player" class="max-w-2xl">
      <EmbedFrame :embed="player" />
      <button class="mt-1 flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs text-ink-faint hover:bg-hover hover:text-ink" @click="open">
        <AppIcon :icon="summary?.icon ?? type?.icon" fallback="ph:globe-hemisphere-west" :size="13" />
        <span class="truncate">{{ title }}</span>
      </button>
    </div>

    <!-- Card / wide card / embed -->
    <button
      v-else
      class="flex w-full overflow-hidden rounded-xl border border-line bg-surface text-left shadow-sm transition hover:border-line-strong"
      :class="display === 'card' ? 'max-w-sm flex-col' : 'flex-row'"
      @click="open"
    >
      <img
        v-if="image && !broken"
        :src="image"
        alt=""
        class="object-cover"
        :class="display === 'card' ? 'h-36 w-full' : 'h-auto max-h-40 w-48 shrink-0'"
        loading="lazy"
        @error="broken = true"
      />
      <div class="min-w-0 flex-1 p-3">
        <span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium" :class="chip(type?.color)">
          <AppIcon :icon="type?.icon" fallback="ph:cube" :size="12" />{{ type?.name }}
        </span>
        <div class="mt-1.5 truncate font-semibold">{{ title }}</div>
        <p v-if="summary?.preview" class="mt-1 line-clamp-3 text-sm text-ink-soft">{{ summary.preview }}</p>
      </div>
    </button>
  </NodeViewWrapper>
</template>
