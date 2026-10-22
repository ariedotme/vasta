// The CLI's commands: each calls the server's MCP tools (packages/server/src/mcp.ts) and prints
// the answer for a person or a script (--json prints the tools' answers as they are).
import { parseArgs } from 'node:util'

/** Calls one MCP tool and returns its parsed answer; throws with the tool's message on errors. */
export type Call = (tool: string, args?: Record<string, unknown>) => Promise<unknown>

export class UsageError extends Error {}

export const USAGE = `vasta — your Vasta notes from the terminal (for you, scripts and agents)

  vasta login <server> [token]      save the server and an api token (asked for when not given)
  vasta spaces                      your spaces
  vasta types                       the types of a space, with their properties
  vasta search <words…>             find objects
  vasta show <id|link>              an object, its text as Markdown
  vasta today [YYYY-MM-DD]          a day's note (today by default)
  vasta new <type> <title…>         create an object; its text with --text (--text - reads stdin)
  vasta append <id|today> [text…]   add Markdown to an object's text (or stdin)
  vasta set <id> name=value…        change properties (name= clears one); --title renames
  vasta capture <text…>             capture into today's note, like the quick capture
  vasta inbox [--days N]            what was captured lately
  vasta habits [YYYY-MM-DD]         your habits: done today (or that day), streaks
  vasta habit <name> [undo|N|+N]    mark a habit done today (--day YYYY-MM-DD); N sets, +N adds to a goal
  vasta food <what you ate…>        log food, as /food: "2 slices of bread, coffee 200 ml at breakfast"
  vasta nutrition [YYYY-MM-DD]      a day's food: meals, totals against the goal, the week's budget
  vasta query [--type T]… [--where "Field op value"]… [--any] [--sort field[:desc]]
  vasta tool <name> [json]          call any tool of the MCP endpoint

Options: --space <name|id> (default: your capture space), --json, --limit N, --prop name=value
(new), --field <text field>, --mode append|prepend|replace (append). Settings: $VASTA_URL and
$VASTA_TOKEN, else ~/.config/vasta/cli.json (vasta login). Tokens: Settings › Capture tokens, scope api.`

const OPERATORS = ['is', 'is-not', 'contains', 'not-contains', 'starts-with', 'is-empty', 'is-not-empty', 'is-checked', 'is-not-checked', 'gt', 'gte', 'lt', 'lte', 'before', 'after']

/** "Genre is Sci-fi" → { field: 'Genre', operator: 'is', value: 'Sci-fi' }; numbers stay numbers. */
export function parseWhere(text: string) {
  const words = text.trim().split(/\s+/)
  const at = words.findIndex((word, i) => i > 0 && OPERATORS.includes(word))
  if (at < 0) throw new UsageError(`--where needs "field operator value", operators: ${OPERATORS.join(', ')}`)
  const raw = words.slice(at + 1).join(' ')
  const value = raw === '' ? undefined : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
  return { field: words.slice(0, at).join(' '), operator: words[at]!, ...(value !== undefined ? { value } : {}) }
}

/** name=value pairs; a value with commas is a list (several options or related objects). */
export function parseProps(pairs: string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at <= 0) throw new UsageError(`properties are name=value, not "${pair}"`)
    const value = pair.slice(at + 1).trim()
    props[pair.slice(0, at).trim()] = value === '' ? null : value.includes(',') ? value.split(',').map((v) => v.trim()) : value
  }
  return props
}

/** The id in a link to an object (https://…/o/<id>, vasta://o/<id>) or the id itself. */
export const idOf = (text: string) => /\/o\/([^/?#\s]+)/.exec(text)?.[1] ?? text

interface Summary {
  id: string
  title: string
  type: string
  date?: string
  preview?: string
}

const list = (objects: Summary[]) =>
  objects.length ? objects.map((o) => `${o.title || 'Untitled'}  · ${o.type}${o.date ? ` · ${o.date}` : ''}  ${o.id}`).join('\n') : 'Nothing found.'

interface Shown {
  id: string
  title: string
  type: string
  space: string
  url: string
  day?: string
  date?: string
  tags?: string[]
  link?: string
  properties?: Record<string, unknown>
  text: Record<string, string>
  backlinks?: { id: string; title: string }[]
}

const valueText = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(valueText).join(', ')
    : value && typeof value === 'object' && 'title' in value
      ? String((value as { title: string }).title)
      : value && typeof value === 'object' && 'error' in value
        ? `error: ${String((value as { error: string }).error)}`
        : String(value)

function show(object: Shown): string {
  const lines = [`# ${object.title || 'Untitled'}`, `${object.type} · ${object.space} · ${object.url}`]
  if (object.date) lines.push(`Date: ${object.date}`)
  if (object.link) lines.push(`Link: ${object.link}`)
  for (const [name, value] of Object.entries(object.properties ?? {})) lines.push(`${name}: ${valueText(value)}`)
  if (object.tags?.length) lines.push(`Tags: ${object.tags.join(', ')}`)
  const fields = Object.entries(object.text)
  for (const [name, markdown] of fields) lines.push('', ...(fields.length > 1 ? [`## ${name}`, ''] : []), markdown)
  if (object.backlinks?.length) lines.push('', `Linked from: ${object.backlinks.map((b) => `${b.title || 'Untitled'} (${b.id})`).join(', ')}`)
  return lines.join('\n')
}

/** Run a command line (without "vasta"); returns what to print. `stdin` is read only when a command takes text from it. */
export async function runCommand(argv: string[], call: Call, stdin: () => Promise<string> = async () => ''): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: 'string' },
      json: { type: 'boolean', default: false },
      limit: { type: 'string' },
      days: { type: 'string' },
      day: { type: 'string' },
      text: { type: 'string' },
      prop: { type: 'string', multiple: true },
      title: { type: 'string' },
      field: { type: 'string' },
      mode: { type: 'string' },
      type: { type: 'string', multiple: true },
      where: { type: 'string', multiple: true },
      any: { type: 'boolean', default: false },
      sort: { type: 'string', multiple: true },
      done: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, ...rest] = positionals
  if (!command || values.help) return USAGE
  const space = values.space ? { space: values.space } : {}
  const limit = values.limit ? { limit: Number(values.limit) } : {}
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  const out = (value: unknown, human: (value: never) => string) => (values.json ? json(value) : human(value as never))
  const text = async () => (rest.length > 1 ? rest.slice(1).join(' ') : values.text ?? (await stdin()))

  switch (command) {
    case 'spaces':
      return out(await call('list_spaces'), (spaces: { id: string; name: string; default?: boolean }[]) => spaces.map((s) => `${s.name}${s.default ? ' (default)' : ''}  ${s.id}`).join('\n'))
    case 'types':
      return out(await call('list_types', space), (types: { name: string; objects: number; properties: { name: string; kind: string; options?: string[]; formula?: string }[] }[]) =>
        types.map((t) => `${t.name} (${t.objects})${t.properties.length ? `: ${t.properties.map((p) => `${p.name} [${p.kind}${p.options ? `: ${p.options.join(', ')}` : p.formula ? `: ${p.formula}` : ''}]`).join(', ')}` : ''}`).join('\n')
      )
    case 'search': {
      if (!rest.length) throw new UsageError('vasta search <words…>')
      return out(await call('search', { query: rest.join(' '), ...space, ...limit }), list)
    }
    case 'show': {
      if (!rest[0]) throw new UsageError('vasta show <id|link>')
      return out(await call('get_object', { id: idOf(rest[0]) }), show)
    }
    case 'today':
      return out(await call('get_daily_note', { ...(rest[0] ? { day: rest[0] } : {}), ...space }), show)
    case 'new': {
      const [type, ...title] = rest
      if (!type) throw new UsageError('vasta new <type> <title…> [--prop name=value]… [--text markdown]')
      const markdown = values.text === '-' ? await stdin() : (values.text ?? '')
      const created = await call('create_object', {
        type,
        title: title.join(' '),
        ...space,
        ...(values.prop?.length ? { properties: parseProps(values.prop) } : {}),
        ...(markdown.trim() ? { markdown } : {}),
      })
      return out(created, (o: Shown) => `Created ${o.title || o.type}: ${o.url}`)
    }
    case 'append': {
      if (!rest[0]) throw new UsageError('vasta append <id|today> [text…]')
      const markdown = await text()
      if (!markdown.trim()) throw new UsageError('nothing to append: give the text or pipe it in')
      const id = rest[0] === 'today' ? ((await call('get_daily_note', space)) as Shown).id : idOf(rest[0])
      const mode = values.mode ?? 'append'
      if (!['append', 'prepend', 'replace'].includes(mode)) throw new UsageError('--mode is append, prepend or replace')
      const changed = await call('update_object', { id, markdown, mode, ...(values.field ? { field: values.field } : {}) })
      return out(changed, (o: Shown) => `Updated ${o.title || o.type}: ${o.url}`)
    }
    case 'set': {
      if (!rest[0] || (rest.length < 2 && values.title === undefined)) throw new UsageError('vasta set <id> name=value… [--title new title]')
      const changed = await call('update_object', {
        id: idOf(rest[0]),
        ...(values.title !== undefined ? { title: values.title } : {}),
        ...(rest.length > 1 ? { properties: parseProps(rest.slice(1)) } : {}),
      })
      return out(changed, show)
    }
    case 'capture': {
      const captured = rest.length ? rest.join(' ') : (values.text ?? (await stdin()))
      if (!captured.trim()) throw new UsageError('vasta capture <text…>')
      return out(await call('capture', { text: captured, ...space }), (r: { url: string }) => `Captured into today's note: ${r.url}`)
    }
    case 'inbox':
      return out(await call('list_inbox', { ...space, ...(values.days ? { days: Number(values.days) } : {}), ...(values.done ? { include_done: true } : {}) }), (items: { at: string; channel: string; done: boolean; text: string }[]) =>
        items.length ? items.map((i) => `${i.at.slice(0, 16).replace('T', ' ')} · ${i.channel}${i.done ? ' · done' : ''}\n${i.text}`).join('\n\n') : 'Nothing captured lately.'
      )
    case 'habits': {
      type Habit = { title: string; day: { done: boolean; scheduled: boolean; amount?: number }; dailyGoal?: number; unit?: string; paused?: boolean; stats: { currentStreak: number; last30Days: string } }
      const line = (h: Habit) =>
        `${h.day.done ? '✓' : h.day.scheduled ? '○' : '–'} ${h.title}${h.dailyGoal ? `  ${h.day.amount ?? 0}/${h.dailyGoal}${h.unit ? ` ${h.unit}` : ''}` : ''}${h.paused ? '  (paused)' : ''}  · streak ${h.stats.currentStreak} · 30 days ${h.stats.last30Days}`
      return out(await call('list_habits', { ...space, recent: 0, ...(rest[0] ? { day: rest[0] } : {}) }), (habits: Habit[]) => (habits.length ? habits.map(line).join('\n') : 'No habits yet.'))
    }
    case 'habit': {
      const words = [...rest]
      const last = words.at(-1) ?? ''
      const change = /^(undo|[+-]?\d+(\.\d+)?)$/.test(last) && words.length > 1 ? words.pop()! : ''
      if (!words.length) throw new UsageError('vasta habit <name> [undo|N|+N] [--day YYYY-MM-DD]')
      const args: Record<string, unknown> = { habit: words.join(' '), ...space, ...(values.day ? { day: values.day } : {}) }
      if (change === 'undo') args.done = false
      else if (/^[+-]/.test(change)) args.add = Number(change)
      else if (change) args.amount = Number(change)
      return out(await call('log_habit', args), (h: { title: string; day: { day: string; done: boolean; amount?: number }; dailyGoal?: number; unit?: string; stats: { currentStreak: number } }) =>
        `${h.title} on ${h.day.day}: ${h.dailyGoal ? `${h.day.amount ?? 0}/${h.dailyGoal}${h.unit ? ` ${h.unit}` : ''}${h.day.done ? ', done' : ''}` : h.day.done ? 'done' : 'not done'} · streak ${h.stats.currentStreak}`
      )
    }
    case 'food': {
      const eaten = rest.length ? rest.join(' ') : (values.text ?? (await stdin()))
      if (!eaten.trim()) throw new UsageError('vasta food <what you ate…>, e.g. vasta food 2 slices of bread at breakfast')
      return out(await call('log_food', { text: eaten, ...space, ...(values.day ? { day: values.day } : {}) }), (r: { summary: string }) => r.summary)
    }
    case 'nutrition': {
      type Kcal = { kcal: number; protein: number; carbs: number; fat: number }
      type Day = {
        day: string
        counted: boolean
        totals: Kcal
        goal?: { kcal: number; protein?: number; carbs?: number; fat?: number }
        week?: { eaten: number; target: number; remaining: number; allowance: number }
        meals: { meal: string; totals: Kcal; entries: { name: string; amount: string; nutrients?: Kcal; needsData?: boolean }[] }[]
      }
      const n = (value: number) => String(Math.round(value))
      const show = (d: Day) =>
        [
          `${d.day}${d.counted ? '' : ' (not counted)'}: ${n(d.totals.kcal)}${d.goal ? `/${n(d.goal.kcal)}` : ''} kcal · protein ${n(d.totals.protein)}${d.goal?.protein ? `/${n(d.goal.protein)}` : ''} g · carbs ${n(d.totals.carbs)}${d.goal?.carbs ? `/${n(d.goal.carbs)}` : ''} g · fat ${n(d.totals.fat)}${d.goal?.fat ? `/${n(d.goal.fat)}` : ''} g`,
          ...(d.week ? [`Week: ${n(d.week.eaten)} of ${n(d.week.target)} kcal, ${d.week.remaining < 0 ? `${n(-d.week.remaining)} over` : `${n(d.week.remaining)} left`}`] : []),
          ...d.meals
            .filter((m) => m.entries.length)
            .map((m) => `\n${m.meal} · ${n(m.totals.kcal)} kcal\n${m.entries.map((e) => `  ${e.name} ${e.amount}  ${e.nutrients ? `${n(e.nutrients.kcal)} kcal` : 'needs nutrition data'}`).join('\n')}`),
        ].join('\n')
      return out(await call('nutrition_day', { ...space, ...(rest[0] ? { day: rest[0] } : {}) }), show)
    }
    case 'query': {
      const result = await call('query', {
        ...space,
        ...limit,
        ...(values.type?.length ? { types: values.type } : {}),
        ...(values.where?.length ? { where: values.where.map(parseWhere) } : {}),
        ...(values.any ? { match: 'any' } : {}),
        ...(values.sort?.length ? { sort: values.sort.map((s) => ({ field: s.replace(/:(asc|desc)$/, ''), direction: s.endsWith(':desc') ? 'desc' : 'asc' })) } : {}),
      })
      return out(result, (r: { total: number; objects: Summary[] }) => `${list(r.objects)}${r.total > r.objects.length ? `\n… ${r.total - r.objects.length} more (--limit)` : ''}`)
    }
    case 'tool': {
      if (!rest[0]) throw new UsageError('vasta tool <name> [json arguments]')
      let args: Record<string, unknown> = {}
      try {
        args = rest[1] ? JSON.parse(rest.slice(1).join(' ')) : {}
      } catch {
        throw new UsageError('the arguments must be a JSON object')
      }
      return json(await call(rest[0], args))
    }
    default:
      throw new UsageError(`unknown command "${command}"\n\n${USAGE}`)
  }
}
