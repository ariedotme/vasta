import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

const api = process.env.VASTA_API ?? 'http://127.0.0.1:5174'
const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * `virtual:phosphor-subset`: the Phosphor icons named in the source (`ph:name`) of the web app and
 * of the packages whose data it shows (built-in type icons, capture channel icons). The full set
 * (4.6 MB) loads later, on demand (src/lib/icons.ts).
 */
function phosphorSubset(): Plugin {
  const id = 'virtual:phosphor-subset'
  const sources = ['src', '../core/src', '../server/src'].map((dir) => path.join(here, dir))
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.(ts|vue)$/.test(entry.name) ? [path.join(dir, entry.name)] : []
    )
  return {
    name: 'phosphor-subset',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return
      const full = createRequire(import.meta.url)('@iconify-json/ph/icons.json') as {
        prefix: string
        width?: number
        height?: number
        icons: Record<string, unknown>
        aliases?: Record<string, { parent: string }>
      }
      const names = new Set<string>()
      for (const file of sources.flatMap(files)) {
        this.addWatchFile(file)
        for (const match of readFileSync(file, 'utf8').matchAll(/ph:([a-z0-9]+(?:-[a-z0-9]+)*)/g)) names.add(match[1]!)
      }
      const icons: Record<string, unknown> = {}
      const aliases: Record<string, { parent: string }> = {}
      for (const name of names) {
        const alias = full.aliases?.[name]
        if (alias) aliases[name] = alias
        const target = alias?.parent ?? name
        if (full.icons[target]) icons[target] = full.icons[target]
      }
      return `export default ${JSON.stringify({ prefix: full.prefix, width: full.width, height: full.height, icons, aliases })}`
    },
  }
}

/** The commit this build is from: REVISION (written by setup/deploy.sh or the release workflow), else git, else "dev". */
function revision(): string {
  const file = path.join(here, '../../REVISION')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  try {
    return execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), phosphorSubset()],
  // Shown in Settings › This device, so one can tell which version of the web app runs.
  define: { __VASTA_REVISION__: JSON.stringify(revision()), __VASTA_BUILT__: JSON.stringify(new Date().toISOString()) },
  // sqlite-wasm finds its .wasm next to its own module; pre-bundling would move it.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  // The replica worker (src/replica/worker.ts) is a module worker with chunks of its own.
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': api, '/media': api, '/mcp': api },
  },
})
