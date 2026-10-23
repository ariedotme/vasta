// The README's downloads badge, as a shields.io endpoint file (printed to stdout): every release
// file people downloaded, except latest.json (the desktop app fetches it every few hours to look
// for updates, so it counts running apps, not downloads), plus the server image's pulls from
// ghcr.io. These are downloads, not people: updates count again. GitHub's API has no pull count
// for container images, so it is read from the package's public page. Run by
// .github/workflows/downloads-badge.yml; GH_TOKEN is optional (without it, GitHub's limit for
// anonymous API calls applies).
//   node scripts/downloads-badge.mjs [owner/repo]
const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY ?? 'ariedotme/vasta'
const headers = { accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) }

async function releaseDownloads() {
  let total = 0
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers })
    if (!response.ok) throw new Error(`releases: HTTP ${response.status}`)
    const releases = await response.json()
    for (const release of releases) for (const asset of release.assets) if (asset.name !== 'latest.json') total += asset.download_count
    if (releases.length < 100) return total
  }
}

/** "Total downloads" on the package page: "5", "1,234", or rounded as "1.2K". */
async function imagePulls() {
  const response = await fetch(`https://github.com/${repo}/pkgs/container/${repo.split('/')[1]}`)
  if (!response.ok) throw new Error(`package page: HTTP ${response.status}`)
  const text = (await response.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  const match = /Total downloads ([\d.,]+)\s*([KMB])?\b/i.exec(text)
  if (!match) throw new Error('package page: no "Total downloads"')
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase() ?? ''] ?? 1
  return Math.round(Number(match[1].replace(/,/g, '')) * scale)
}

const [releases, image] = await Promise.all([releaseDownloads(), imagePulls()])
const total = releases + image
console.error(`release files (without latest.json): ${releases}, server image pulls: ${image}, total: ${total}`)
const message = Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(total).toLowerCase()
console.log(JSON.stringify({ schemaVersion: 1, label: 'downloads', message, labelColor: '222222', color: 'A371F7' }))
