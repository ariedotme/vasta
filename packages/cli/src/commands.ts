// The CLI's commands: each calls the server's MCP tools (packages/server/src/mcp.ts) and prints
// the answer for a person or a script (--json prints the tools' answers as they are).
import { parseArgs } from 'node:util'

/** Calls one MCP tool and returns its parsed answer; throws with the tool's message on errors. */
export type Call = (tool: string, args?: Record<string, unknown>) => Promise<unknown>

export class UsageError extends Error {}

/** The app's palette (core's COLOR_NAMES); the server checks colors and icons too. */
const COLOR_NAMES = ['gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose']
const COMMON_ICONS = ['ph:star', 'ph:heart', 'ph:bookmark', 'ph:book-open', 'ph:lightbulb', 'ph:flag', 'ph:folder', 'ph:rocket']

/** --icon and --color as tool arguments: "none" (or "default", "null") removes one. */
function looks(values: { icon?: string | undefined; color?: string | undefined }): Record<string, string | null> {
  const value = (text: string) => (['none', 'default', 'null'].includes(text.trim().toLowerCase()) ? null : text)
  return { ...(values.icon !== undefined ? { icon: value(values.icon) } : {}), ...(values.color !== undefined ? { color: value(values.color) } : {}) }
}

export const USAGE = `vasta — your Vasta notes from the terminal (for you, scripts and agents)

  vasta login <server> [token]      save the server and an api token (asked for when not given)
  vasta spaces                      your spaces
  vasta types                       the types of a space, with their properties
  vasta search <words…>             find objects
  vasta show <id|link>              an object, its text as Markdown
  vasta today [YYYY-MM-DD]          a day's note (today by default)
  vasta new <type> <title…>         create an object; --cover-url <url>; --text - reads Markdown from stdin;
                                    --template <name|blank> (the type's default otherwise); --tag, --icon, --color
  vasta templates                   the space's templates and snippets, with their questions
  vasta append <id|today> [text…]   add Markdown to an object's text (or stdin)
  vasta set <id> name=value…        change properties (name= clears one); --title renames; --cover-url <url> or --remove-cover;
                                    --tag <name> adds a tag, --remove-tag <name> takes one off, --set-tags a,b,c
                                    replaces them all; --icon, --color (none removes either)
  vasta pin <id|link>              pin an object in the sidebar
  vasta unpin <id|link>            remove an object from all sidebar sections
  vasta board <id|link>             a whiteboard's elements and arrows; --canvas prints it as a JSON Canvas;
                                    --mermaid adds a Mermaid flowchart read from stdin (or given after the id);
                                    --import adds a JSON Canvas read from stdin; --flowchart prints it as a Mermaid
                                    flowchart; --layout down|right|up|left|grid lays it out along its arrows
  vasta capture <text…>             capture into today's note, like the quick capture
  vasta inbox [--days N]            what was captured lately
  vasta habits [YYYY-MM-DD]         your habits: done today (or that day), streaks
  vasta habit <name> [undo|N|+N]    mark a habit done today (--day YYYY-MM-DD); N sets, +N adds to a goal
  vasta food <what you ate…>        log food, as /food: "2 slices of bread, coffee 200 ml at breakfast"
  vasta nutrition [YYYY-MM-DD]      a day's food: meals, totals against the goal, the week's budget
  vasta query [--type T]… [--where "Field op value"]… [--any] [--sort field[:desc]]
  vasta tool <name> [json]          call any tool of the MCP endpoint

Options: --space <name|id> (default: your capture space), --json, --limit N, --prop name=value
and --answer "Question=answer" (new), --field <text field>, --mode append|prepend|replace (append). Settings: $VASTA_URL and
$VASTA_TOKEN, else ~/.config/vasta/cli.json (vasta login). Tokens: Settings › Capture tokens, scope api.

Tags: --tag repeats (--tag books --tag recipe/breakfast: a path names a nested tag); tags the space
does not have yet are created. Icons: an emoji ("📚") or ph:<name>, a Phosphor icon (${COMMON_ICONS.join(', ')}…;
every name at https://phosphoricons.com). Colors: ${COLOR_NAMES.join(', ')}.`

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

/** "a, b,c" → ["a", "b", "c"]; nothing when not given. */
const splitTags = (text: string | undefined) => (text ?? '').split(',').map((t) => t.trim()).filter(Boolean)

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
  coverUrl?: string | null
  icon?: string | null
  color?: string | null
  pinned?: boolean
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
  if (object.id === null && object.day) return `No daily note for ${object.day}.`
  const lines = [`# ${object.title || 'Untitled'}`, `${object.type} · ${object.space} · ${object.url}`]
  if (object.coverUrl) lines.push(`Cover: ${object.coverUrl}`)
  if (object.icon) lines.push(`Icon: ${object.icon}`)
  if (object.color) lines.push(`Color: ${object.color}`)
  if (object.pinned !== undefined) lines.push(`Pinned: ${object.pinned ? 'yes' : 'no'}`)
  if (object.date) lines.push(`Date: ${object.date}`)
  if (object.link) lines.push(`Link: ${object.link}`)
  for (const [name, value] of Object.entries(object.properties ?? {})) lines.push(`${name}: ${valueText(value)}`)
  if (object.tags?.length) lines.push(`Tags: ${object.tags.join(', ')}`)
  const fields = Object.entries(object.text)
  for (const [name, markdown] of fields) lines.push('', ...(fields.length > 1 ? [`## ${name}`, ''] : []), markdown)
  if (object.backlinks?.length) lines.push('', `Linked from: ${object.backlinks.map((b) => `${b.title || 'Untitled'} (${b.id})`).join(', ')}`)
  return lines.join('\n')
}

interface BoardShown {
  title: string
  url: string
  elements: { id: string; kind: string; x: number; y: number; w: number; h: number; text?: string; title?: string; shape?: string; object?: { title: string } }[]
  arrows: { from: string; to: string; label?: string }[]
}

/** A board as lines: each element with what it shows and where, then the arrows between them. */
function board(shown: BoardShown): string {
  const names = new Map<string, string>()
  const lines = [`# ${shown.title || 'Untitled'}`, shown.url, '']
  for (const e of shown.elements) {
    const what = e.object ? e.object.title : e.kind === 'frame' ? e.title ?? '' : (e.text ?? '').replace(/\s+/g, ' ')
    names.set(e.id, what || e.kind)
    if (e.kind === 'stroke') continue
    lines.push(`${(e.shape ?? e.kind).padEnd(9)} ${what ? `"${what.length > 60 ? `${what.slice(0, 59)}…` : what}"  ` : ''}at ${e.x},${e.y} ${e.w}×${e.h}  ${e.id}`)
  }
  const strokes = shown.elements.filter((e) => e.kind === 'stroke').length
  if (strokes) lines.push(`${strokes} pen stroke${strokes === 1 ? '' : 's'}`)
  if (!shown.elements.length) lines.push('Empty.')
  for (const a of shown.arrows) lines.push(`${names.get(a.from) ?? a.from} → ${names.get(a.to) ?? a.to}${a.label ? `  (${a.label})` : ''}`)
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
      template: { type: 'string' },
      answer: { type: 'string', multiple: true },
      title: { type: 'string' },
      'cover-url': { type: 'string' },
      'remove-cover': { type: 'boolean' },
      tag: { type: 'string', multiple: true },
      'remove-tag': { type: 'string', multiple: true },
      'set-tags': { type: 'string' },
      icon: { type: 'string' },
      color: { type: 'string' },
      field: { type: 'string' },
      mode: { type: 'string' },
      type: { type: 'string', multiple: true },
      where: { type: 'string', multiple: true },
      any: { type: 'boolean', default: false },
      sort: { type: 'string', multiple: true },
      done: { type: 'boolean', default: false },
      canvas: { type: 'boolean', default: false },
      mermaid: { type: 'boolean', default: false },
      import: { type: 'boolean', default: false },
      flowchart: { type: 'boolean', default: false },
      layout: { type: 'string' },
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
    case 'board': {
      if (!rest[0]) throw new UsageError('vasta board <id|link> [--canvas | --flowchart | --mermaid | --import | --layout <direction>]')
      const id = idOf(rest[0])
      if (values.canvas) return json(await call('get_board', { id, format: 'canvas' }))
      if (values.flowchart) return ((await call('get_board', { id, format: 'mermaid' })) as { mermaid: string }).mermaid
      if (values.layout) return out(await call('edit_board', { id, layout: values.layout }), board)
      if (values.mermaid || values.import) {
        const input = await text()
        if (!input.trim()) throw new UsageError(values.mermaid ? 'pipe in a Mermaid flowchart, or give it after the id' : 'pipe in a JSON Canvas file')
        const changed = await call('edit_board', { id, ...(values.mermaid ? { mermaid: input } : { canvas: input }) })
        return out(changed, board)
      }
      return out(await call('get_board', { id }), board)
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
        ...(values['cover-url'] !== undefined ? { coverUrl: values['cover-url'] } : {}),
        ...space,
        ...(values.prop?.length ? { properties: parseProps(values.prop) } : {}),
        ...(markdown.trim() ? { markdown } : {}),
        ...(values.template ? { template: values.template } : {}),
        ...(values.answer?.length ? { answers: Object.fromEntries(values.answer.map((a) => [a.slice(0, a.indexOf('=')).trim(), a.slice(a.indexOf('=') + 1).trim()])) } : {}),
        ...(values.tag?.length || values['set-tags'] ? { tags: [...(values.tag ?? []), ...splitTags(values['set-tags'])] } : {}),
        ...looks(values),
      })
      return out(created, (o: Shown) => `Created ${o.title || o.type}: ${o.url}`)
    }
    case 'templates': {
      type Listed = { name: string; kind: string; type?: string; default?: boolean; trigger?: string; asks: { label: string }[] }
      return out(await call('list_templates', space), (list: Listed[]) =>
        list.length
          ? list
              .map((t) => `${t.kind === 'snippet' ? 'snippet ' : `${t.type}: `}${t.name}${t.default ? ' (default)' : ''}${t.trigger ? ` /${t.trigger}` : ''}${t.asks.length ? ` — asks ${t.asks.map((a) => `“${a.label}”`).join(', ')}` : ''}`)
              .join('\n')
          : 'No templates.'
      )
    }
    case 'append': {
      if (!rest[0]) throw new UsageError('vasta append <id|today> [text…]')
      const markdown = await text()
      if (!markdown.trim()) throw new UsageError('nothing to append: give the text or pipe it in')
      const mode = values.mode ?? 'append'
      if (!['append', 'prepend', 'replace'].includes(mode)) throw new UsageError('--mode is append, prepend or replace')
      const today = rest[0] === 'today'
      const note = today && mode !== 'append' ? await call('get_daily_note', space) as { id: string | null } : undefined
      if (today && !note?.id) return out(await call('write_daily_note', { markdown, ...space }), show)
      const changed = await call('update_object', { id: note?.id ?? idOf(rest[0]), markdown, mode, ...(values.field ? { field: values.field } : {}) })
      return out(changed, (o: Shown) => `Updated ${o.title || o.type}: ${o.url}`)
    }
    case 'set': {
      if (values['remove-cover'] && values['cover-url'] !== undefined) throw new UsageError('use one of --cover-url and --remove-cover')
      const coverUrl = values['remove-cover'] ? null : values['cover-url']
      const setTags = values['set-tags']
      if (setTags !== undefined && (values.tag?.length || values['remove-tag']?.length)) throw new UsageError('--set-tags replaces all the tags: use it without --tag and --remove-tag')
      const tagChanges: Record<string, unknown>[] = [
        ...(setTags !== undefined ? [{ tags: splitTags(setTags), tagsMode: 'replace' }] : []),
        ...(values.tag?.length ? [{ tags: values.tag, tagsMode: 'add' }] : []),
        ...(values['remove-tag']?.length ? [{ tags: values['remove-tag'], tagsMode: 'remove' }] : []),
      ]
      const changes = { ...(coverUrl !== undefined ? { coverUrl } : {}), ...(values.title !== undefined ? { title: values.title } : {}), ...looks(values), ...(rest.length > 1 ? { properties: parseProps(rest.slice(1)) } : {}) }
      if (!rest[0] || (!Object.keys(changes).length && !tagChanges.length)) throw new UsageError('vasta set <id> name=value… [--title new title] [--tag name] [--remove-tag name] [--set-tags a,b] [--icon i] [--color c]')
      const id = idOf(rest[0])
      // Adding and removing tags are two calls (update_object takes one tagsMode).
      let changed = await call('update_object', { id, ...changes, ...tagChanges[0] })
      for (const more of tagChanges.slice(1)) changed = await call('update_object', { id, ...more })
      return out(changed, show)
    }
    case 'pin':
    case 'unpin': {
      if (!rest[0]) throw new UsageError(`vasta ${command} <id|link>`)
      return out(await call('set_pinned', { id: idOf(rest[0]), pinned: command === 'pin' }), show)
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
