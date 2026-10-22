import type { MediaInfo, ObjectSummary } from '@vasta/core'
import { mediaUrl } from './api.ts'

const isImage = (media: MediaInfo) => (media.file?.mimeType ?? media.mimeType ?? '').startsWith('image/')

/** Best image to show for an object: stored image file, remote image URL, cover, or link preview. */
export function imageOf(object: Pick<ObjectSummary, 'media' | 'coverUrl' | 'typeId'>): string | undefined {
  const media = object.media
  if (media?.file && isImage(media)) return mediaUrl(media.file.key)
  if (media?.url && (isImage(media) || object.typeId.startsWith('image:'))) return media.url
  if (object.coverUrl) return object.coverUrl
  return media?.previewImageFile ? mediaUrl(media.previewImageFile.key) : media?.previewImageUrl
}
