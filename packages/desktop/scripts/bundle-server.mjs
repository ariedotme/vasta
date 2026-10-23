// The server the desktop app runs on its user's own computer ("On this computer", docs/desktop.md):
// the server in one file (esbuild) and the built web app in src-tauri/server/, bundled as resources,
// and Node.js for the target in src-tauri/binaries/, bundled as a sidecar. Tauri runs this before
// every build (tauri.conf.json, beforeBuildCommand and beforeDevCommand).
//   node scripts/bundle-server.mjs [--skip-web]   (--skip-web keeps packages/web/dist as it is)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** The Node.js the app runs its server on; the same major version as the Docker image. */
const NODE_VERSION = 'v24.21.0'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '../..')
const tauri = path.join(desktop, 'src-tauri')
const out = path.join(tauri, 'server')
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

// Tauri names the target in TAURI_ENV_TARGET_TRIPLE; a plain run builds for this machine.
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1]
const nodeTarget = (() => {
  const arch = triple.startsWith('aarch64') ? 'arm64' : triple.startsWith('x86_64') ? 'x64' : undefined
  const os = triple.includes('apple-darwin') ? 'darwin' : triple.includes('windows') ? 'win' : triple.includes('linux') ? 'linux' : undefined
  if (!arch || !os) throw new Error(`No Node.js build for ${triple}`)
  const folder = `node-${NODE_VERSION}-${os}-${arch}`
  return { os, folder, archive: `${folder}.${os === 'win' ? 'zip' : 'tar.gz'}` }
})()

// 1. The web app, built (it is served by the bundled server, as by the Docker image).
if (!process.argv.includes('--skip-web') || !existsSync(path.join(root, 'packages/web/dist/index.html'))) {
  run('pnpm', ['--filter', '@vasta/web', 'build'])
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(path.join(root, 'packages/web/dist'), path.join(out, 'web'), { recursive: true })

// 2. The server in one file. Some dependencies are CommonJS and require Node's own modules.
await build({
  entryPoints: [path.join(root, 'packages/server/src/main.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __vastaRequire } from 'node:module'; const require = __vastaRequire(import.meta.url);" },
})

// 3. Node.js for the target, checked against the release's checksums, cached between builds.
const binaries = path.join(tauri, 'binaries')
const sidecar = path.join(binaries, `node-${triple}${nodeTarget.os === 'win' ? '.exe' : ''}`)
const stamp = `${sidecar}.version`
if (!existsSync(sidecar) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== NODE_VERSION) {
  const base = `https://nodejs.org/dist/${NODE_VERSION}`
  const fetchOk = async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url}: ${response.status}`)
    return response
  }
  const sums = await (await fetchOk(`${base}/SHASUMS256.txt`)).text()
  const expected = sums.split('\n').find((line) => line.endsWith(`  ${nodeTarget.archive}`))?.split(' ')[0]
  if (!expected) throw new Error(`${nodeTarget.archive} is not in ${base}/SHASUMS256.txt`)
  console.info(`Downloading ${base}/${nodeTarget.archive}`)
  const archive = Buffer.from(await (await fetchOk(`${base}/${nodeTarget.archive}`)).arrayBuffer())
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error(`${nodeTarget.archive} does not match its checksum`)
  const work = mkdtempSync(path.join(tmpdir(), 'vasta-node-'))
  try {
    const file = path.join(work, nodeTarget.archive)
    writeFileSync(file, archive)
    if (nodeTarget.os === 'win') run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${work}'`], work)
    else run('tar', ['-xf', file, '-C', work], work)
    const folder = path.join(work, nodeTarget.folder)
    const binary = nodeTarget.os === 'win' ? path.join(folder, 'node.exe') : path.join(folder, 'bin', 'node')
    mkdirSync(binaries, { recursive: true })
    copyFileSync(binary, sidecar)
    chmodSync(sidecar, 0o755)
    writeFileSync(stamp, NODE_VERSION)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
console.info(`Bundled the server for ${triple} (Node.js ${NODE_VERSION})`)
