// Players and previews for links from well-known sites, shown in an iframe from the provider.
// Only the provider's own embed page is loaded; no third-party script runs in the app itself.

export interface Embed {
  provider: string
  src: string
  /** CSS aspect ratio, for players that scale with the width. */
  aspect?: string
  /** Fixed height in pixels, for embeds that do not scale. */
  height?: number
}

type Provider = (url: URL) => Embed | undefined

const host = (url: URL) => url.hostname.replace(/^(www|m|mobile)\./, '')

/** "90", "1m30s" or "1h2m3s" → seconds. */
function seconds(value: string | null): number | undefined {
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value)
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)
  if (!match || !match[0]) return undefined
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
}

const youtube: Provider = (url) => {
  const name = host(url)
  let id: string | undefined
  if (name === 'youtu.be') id = url.pathname.slice(1)
  else if (name === 'youtube.com' || name === 'music.youtube.com' || name === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]+)/.exec(url.pathname)?.[1]
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return undefined
  const start = seconds(url.searchParams.get('t') ?? url.searchParams.get('start'))
  return { provider: 'YouTube', src: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`, aspect: '16 / 9' }
}

const vimeo: Provider = (url) => {
  const id = host(url) === 'vimeo.com' ? /^\/(?:video\/)?(\d+)/.exec(url.pathname)?.[1] : undefined
  return id ? { provider: 'Vimeo', src: `https://player.vimeo.com/video/${id}?dnt=1`, aspect: '16 / 9' } : undefined
}

const spotify: Provider = (url) => {
  if (host(url) !== 'open.spotify.com') return undefined
  const match = /^\/(?:intl-[\w-]+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/.exec(url.pathname)
  if (!match) return undefined
  const [, kind, id] = match
  return { provider: 'Spotify', src: `https://open.spotify.com/embed/${kind}/${id}`, height: kind === 'track' || kind === 'episode' ? 152 : 352 }
}

const twitter: Provider = (url) => {
  const name = host(url)
  if (name !== 'twitter.com' && name !== 'x.com') return undefined
  const id = /^\/\w+\/status(?:es)?\/(\d+)/.exec(url.pathname)?.[1]
  return id ? { provider: 'X', src: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true`, height: 560 } : undefined
}

const loom: Provider = (url) => {
  const id = host(url) === 'loom.com' ? /^\/(?:share|embed)\/(\w+)/.exec(url.pathname)?.[1] : undefined
  return id ? { provider: 'Loom', src: `https://www.loom.com/embed/${id}`, aspect: '16 / 9' } : undefined
}

/** Google Maps place, search and coordinate links (the keyless "output=embed" map). */
const googleMaps: Provider = (url) => {
  const name = host(url)
  const isMaps = (/^google\.[a-z.]+$/.test(name) && url.pathname.startsWith('/maps')) || /^maps\.google\.[a-z.]+$/.test(name)
  if (!isMaps) return undefined
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)z/.exec(url.pathname)
  const place = /\/maps\/(?:place|search)\/([^/]+)/.exec(url.pathname)?.[1]
  const query = url.searchParams.get('q') ?? url.searchParams.get('query') ?? (place ? decodeURIComponent(place.replace(/\+/g, ' ')) : at ? `${at[1]},${at[2]}` : undefined)
  if (!query) return undefined
  const zoom = at ? `&z=${Math.round(Number(at[3]))}` : ''
  return { provider: 'Google Maps', src: `https://maps.google.com/maps?q=${encodeURIComponent(query)}${zoom}&output=embed`, aspect: '4 / 3' }
}

const PROVIDERS: Provider[] = [youtube, vimeo, spotify, twitter, loom, googleMaps]

/** The embed for a link, if it comes from a site in the provider table. */
export function embedFor(link: string | undefined): Embed | undefined {
  if (!link) return undefined
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return undefined
  }
  for (const provider of PROVIDERS) {
    const embed = provider(url)
    if (embed) return embed
  }
  return undefined
}

/** The http(s) URL in a piece of text that is nothing but a URL (what someone pasted or typed). */
export function bareUrl(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return undefined
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : /^www\.[\w-]+(\.[\w-]+)+([/?#]|$)/i.test(trimmed) ? `https://${trimmed}` : undefined
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    return url.hostname.includes('.') || url.hostname === 'localhost' ? candidate : undefined
  } catch {
    return undefined
  }
}
