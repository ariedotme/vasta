#!/usr/bin/env node
// The Vasta CLI (`vasta`, packages/cli/bin/vasta): the server's MCP tools from a terminal, for
// people, scripts and agents that prefer a command to an MCP connection. See docs/agents.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runCommand, UsageError, USAGE, type Call } from './commands.ts'

const CONFIG = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'vasta', 'cli.json')

interface Settings {
  server: string
  token: string
}

function settings(): Settings | undefined {
  if (process.env.VASTA_URL && process.env.VASTA_TOKEN) return { server: process.env.VASTA_URL, token: process.env.VASTA_TOKEN }
  try {
    const saved = JSON.parse(readFileSync(CONFIG, 'utf8')) as Partial<Settings>
    return saved.server && saved.token ? { server: process.env.VASTA_URL ?? saved.server, token: process.env.VASTA_TOKEN ?? saved.token } : undefined
  } catch {
    return undefined
  }
}

/** A function calling the tools of <server>/mcp with the token; tool errors become thrown Errors. */
async function connect({ server, token }: Settings): Promise<{ call: Call; close: () => Promise<void> }> {
  const client = new Client({ name: 'vasta-cli', version: '1.0.0' })
  const url = new URL('mcp', server.endsWith('/') ? server : `${server}/`)
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const call: Call = async (name, args = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
    const text = result.content.find((c) => c.type === 'text')?.text ?? ''
    if (result.isError) throw new Error(text)
    return JSON.parse(text)
  }
  return { call, close: () => client.close() }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function login(args: string[]) {
  const [server, given] = args
  if (!server) throw new UsageError('vasta login <server> [token]')
  let token = given ?? ''
  if (!token) {
    if (process.stdin.isTTY) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      token = await prompt.question('Token (Settings › Capture tokens, scope api): ')
      prompt.close()
    } else token = (await readStdin()).split('\n')[0] ?? ''
  }
  const address = /^https?:\/\//.test(server) ? server : `https://${server}`
  const { call, close } = await connect({ server: address, token: token.trim() })
  const spaces = (await call('list_spaces')) as { name: string }[]
  await close()
  mkdirSync(path.dirname(CONFIG), { recursive: true })
  writeFileSync(CONFIG, `${JSON.stringify({ server: address, token: token.trim() }, null, 2)}\n`, { mode: 0o600 })
  return `Saved in ${CONFIG}. Spaces: ${spaces.map((s) => s.name).join(', ')}`
}

async function main(argv: string[]) {
  if (argv[0] === 'login') return console.log(await login(argv.slice(1)))
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return console.log(USAGE)
  const saved = settings()
  if (!saved) throw new UsageError('not logged in: run `vasta login <server> [token]`, or set VASTA_URL and VASTA_TOKEN')
  const { call, close } = await connect(saved)
  try {
    console.log(await runCommand(argv, call, readStdin))
  } finally {
    await close()
  }
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error instanceof UsageError ? error.message : `vasta: ${error.message}`)
  process.exit(error instanceof UsageError ? 2 : 1)
})
