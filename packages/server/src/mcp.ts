// The MCP endpoint (POST /mcp, Streamable HTTP without sessions): the AgentTools of the token's
// user as MCP tools. Each request gets its own server and transport, so nothing is kept between
// requests and any number of agents can call at once. See docs/agents.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { AgentError, type AgentTools } from './agent.ts'

const INSTRUCTIONS = `Vasta is a notes app: everything is an object (a page, a daily note, a task, a book…) of a type,
with properties and rich text, in spaces. Text comes and goes as Markdown; [@Title](vasta://o/<id>)
mentions an object, ![Title](vasta://o/<id>) embeds one. Without "space", tools use the user's
default space. Find objects with search or query, read them with get_object, and prefer
update_object with mode "append" over "replace" (replacing rewrites the whole text, and loses what
Markdown cannot hold: captured items' details, toggles, colors). Formula properties (kind
"formula") are computed from other fields: get_object shows their values and query can filter
and sort by them, but they can't be set. A space that tracks food has Foods and Recipes: log what
was eaten with log_food (a line like "2 slices of bread, coffee 200 ml at breakfast"), read a day
with nutrition_day, and fill in a food (from its label: nutrients per its base amount, portions)
with save_food. Person properties (kind "person", e.g. a task's Assignee) hold members of the
space: set them by username or name, "me" for the user; get_object shows who made an object
and who changed it last (createdBy, updatedBy). A space with sprints has a Sprint type (dates,
goal) and tasks a Sprint field: set it by the sprint's title, or "current" for the one under way.`

const space = z.string().optional().describe('Space id or name; the default space when omitted')
const properties = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
  .optional()
  .describe('Values by property name: text, numbers, true/false, dates ("2026-10-25", "2026-10-25T15:00:00Z", "friday 15h"), option labels, related objects by title, people by username or name ("me": the user) (a list for several). null clears one.')

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

async function run(work: () => unknown): Promise<Result> {
  try {
    const value = await work()
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
  } catch (error) {
    if (error instanceof AgentError) return { content: [{ type: 'text', text: error.message }], isError: true }
    throw error
  }
}

const READ = { readOnlyHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

export function mcpServer(tools: AgentTools, version: string): McpServer {
  const server = new McpServer({ name: 'vasta', version }, { instructions: INSTRUCTIONS })

  server.registerTool('list_spaces', { title: 'List spaces', description: "The user's spaces; the default one is marked.", annotations: READ }, () => run(() => tools.spaces()))

  server.registerTool(
    'list_types',
    { title: 'List types', description: 'The types of objects in a space, with their properties (and select options) and how many objects each has.', inputSchema: { space }, annotations: READ },
    ({ space }) => run(() => tools.types(space))
  )

  server.registerTool(
    'list_habits',
    {
      title: 'List habits',
      description:
        "The space's habits: whether each is done on a day (today by default; for habits with a daily goal, the amount), the weekdays it repeats on, streaks, this week's and the last 30 days' rates, and the last days (recent, 7 by default).",
      inputSchema: { space, day: z.string().optional().describe('YYYY-MM-DD; today by default'), recent: z.number().int().min(0).max(60).optional().describe('How many past days to list (0–60)') },
      annotations: READ,
    },
    ({ space, day, recent }) => run(() => tools.habits({ ...(space ? { space } : {}), ...(day ? { day } : {}), ...(recent !== undefined ? { recent } : {}) }))
  )

  server.registerTool(
    'log_habit',
    {
      title: 'Log a habit',
      description:
        'Mark a habit done (or not) on a day, today by default. For a habit with a daily goal ("8 glasses"), set the amount reached, or add to it ("add": 1 for one more glass); reaching the goal makes the day done.',
      inputSchema: {
        habit: z.string().describe('The habit, by id or title'),
        space,
        day: z.string().optional().describe('YYYY-MM-DD; today by default'),
        done: z.boolean().optional().describe('false to undo the day; true by default'),
        amount: z.number().min(0).optional().describe("The day's amount, for habits with a daily goal"),
        add: z.number().optional().describe("Added to the day's amount (negative takes away)"),
      },
      annotations: WRITE,
    },
    (input) => run(() => tools.logHabit(input))
  )

  server.registerTool(
    'log_food',
    {
      title: 'Log food',
      description:
        'Log what was eaten on a day (today by default), in a space that tracks food. Either "text", a line as after /food: items separated by commas, each a food or recipe with an amount before or after it ("2 slices of bread", "rice 150g", "2 eggs", "1 serving of lasagna"), a meal at the end ("at lunch") and "yesterday" for yesterday; foods it does not know are made without nutrition data. An item with kcal is logged by its numbers alone, without a food ("muffin ~350 kcal", "lunch plate 650 kcal 35 g protein 70 g carbs 20 g fat"): use it for an estimate, e.g. from a photo of a plate. Or one "food" (id or title) with an "amount" ("150 g", "2 slices") and an optional "meal".',
      inputSchema: {
        text: z.string().optional().describe('What was eaten, as after /food'),
        food: z.string().optional().describe('A food or recipe, by id or title (instead of text)'),
        amount: z.string().optional().describe('With food: "150 g", "2 slices", "1 serving"'),
        meal: z.string().optional().describe('With food: a meal by name'),
        day: z.string().optional().describe('YYYY-MM-DD; today by default'),
        space,
      },
      annotations: WRITE,
    },
    (input) => run(() => tools.logFood(input))
  )

  server.registerTool(
    'nutrition_day',
    {
      title: 'Nutrition of a day',
      description: "A day's food (today by default): each meal's entries (with ids) and totals, the day's kcal, protein, carbs and fat against its goal, whether the day counts, and the week's budget when the goal shares its week.",
      inputSchema: { day: z.string().optional().describe('YYYY-MM-DD; today by default'), space },
      annotations: READ,
    },
    ({ day, space }) => run(() => tools.nutritionDay({ ...(day ? { day } : {}), ...(space ? { space } : {}) }))
  )

  server.registerTool(
    'delete_food_entry',
    {
      title: 'Delete a food entry',
      description: 'Take something logged off a day (the entry id from nutrition_day).',
      inputSchema: { entry: z.string(), day: z.string().optional().describe('YYYY-MM-DD; today by default'), space },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => run(() => tools.deleteFoodEntry(input))
  )

  server.registerTool(
    'save_food',
    {
      title: 'Save a food',
      description:
        'Make a food or fill one in (by id or title), e.g. from a photo of its label: nutrients per "per" grams as the label gives them (kept per 100 g), its brand, and its portions ("slice" = 25 g), which replace the ones it had.',
      inputSchema: {
        food: z.string().describe('Id or title; a new food when no food has it'),
        per: z.number().positive().optional().describe('The grams the nutrients are for; 100 by default'),
        nutrients: z.object({ kcal: z.number().min(0).optional(), protein: z.number().min(0).optional(), carbs: z.number().min(0).optional(), fat: z.number().min(0).optional(), fiber: z.number().min(0).optional() }).optional(),
        brand: z.string().optional(),
        portions: z.array(z.object({ name: z.string(), grams: z.number().positive() })).optional(),
        space,
      },
      annotations: WRITE,
    },
    (input) => run(() => tools.saveFood(input))
  )

  server.registerTool(
    'search',
    {
      title: 'Search',
      description: 'Full-text search over titles and text in a space; newest matches first.',
      inputSchema: { query: z.string().describe('Words to find'), space, limit: z.number().int().min(1).max(100).optional() },
      annotations: READ,
    },
    ({ query, space, limit }) => run(() => tools.search(query, { ...(space ? { space } : {}), ...(limit ? { limit } : {}) }))
  )

  server.registerTool(
    'get_object',
    {
      title: 'Get object',
      description: "An object: type, properties, tags, its text fields as Markdown, and what links to it (backlinks). The id is in vasta://o/<id> links and in other tools' results.",
      inputSchema: { id: z.string() },
      annotations: READ,
    },
    ({ id }) => run(() => tools.getObject(id))
  )

  server.registerTool(
    'get_daily_note',
    {
      title: 'Get daily note',
      description: "A day's note (today by default, in the user's time zone), created if it does not exist yet. Captured items are in its text.",
      inputSchema: { day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'), space },
      annotations: { ...READ, readOnlyHint: false },
    },
    ({ day, space }) => run(() => tools.dailyNote({ ...(day ? { day } : {}), ...(space ? { space } : {}) }))
  )

  server.registerTool(
    'query',
    {
      title: 'Query objects',
      description:
        'Objects of some types, filtered and sorted, like a query in the app. Fields are property names, "Relation.Field" through a relation, or title, tags, createdAt, updatedAt, createdBy, updatedBy, date, type. People by username or name, "me" for the user ("Assignee contains me"). Operators: is, is-not, contains, not-contains, starts-with, is-empty, is-not-empty, is-checked, is-not-checked, gt, gte, lt, lte, before, after. Dates as YYYY-MM-DD.',
      inputSchema: {
        space,
        types: z.array(z.string()).optional().describe('Type names or ids; all types when omitted'),
        where: z
          .array(
            z.object({
              field: z.string(),
              operator: z.enum(['is', 'is-not', 'contains', 'not-contains', 'starts-with', 'is-empty', 'is-not-empty', 'is-checked', 'is-not-checked', 'gt', 'gte', 'lt', 'lte', 'before', 'after']),
              value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
            })
          )
          .optional(),
        match: z.enum(['all', 'any']).optional().describe('Whether every condition must hold (default) or any'),
        sort: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']).optional() })).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: READ,
    },
    (input) => run(() => tools.query(strip(input)))
  )

  server.registerTool(
    'list_inbox',
    {
      title: 'List inbox',
      description: 'Items captured in the last days (Telegram, quick capture, agents…), newest first, with the objects in each; done items only when asked.',
      inputSchema: { space, days: z.number().int().min(1).max(365).optional().describe('Default 7'), include_done: z.boolean().optional() },
      annotations: READ,
    },
    ({ space, days, include_done }) => run(() => tools.inbox({ ...(space ? { space } : {}), ...(days ? { days } : {}), ...(include_done ? { includeDone: true } : {}) }))
  )

  server.registerTool(
    'create_object',
    {
      title: 'Create object',
      description: 'A new object of a type (name or id, e.g. "Page", "Task", "Book"), with a title, properties and text in Markdown. Returns it like get_object.',
      inputSchema: { type: z.string(), title: z.string().optional(), space, properties, markdown: z.string().optional().describe('Its text, in Markdown') },
      annotations: WRITE,
    },
    (input) => run(() => tools.createObject(strip(input)))
  )

  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description: 'A comment on an object, written as the user, under its text in the app (get_object lists the comments). @username mentions a member of the space.',
      inputSchema: { id: z.string(), text: z.string() },
      annotations: WRITE,
    },
    (input) => run(() => tools.addComment(input))
  )

  server.registerTool(
    'update_object',
    {
      title: 'Update object',
      description: 'Change an object: its title, properties (null clears one), and its text: Markdown appended (default), put before the text ("prepend"), or replacing it ("replace"). "field" picks a text field by name when the type has several.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        properties,
        markdown: z.string().optional(),
        mode: z.enum(['append', 'prepend', 'replace']).optional(),
        field: z.string().optional(),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    (input) => run(() => tools.updateObject(strip(input)))
  )

  server.registerTool(
    'capture',
    {
      title: 'Capture',
      description: "A note into today's daily note as a captured item, like the quick capture or Telegram; links in it are saved as weblinks.",
      inputSchema: { text: z.string().min(1), space },
      annotations: WRITE,
    },
    ({ text, space }) => run(() => tools.capture({ text, ...(space ? { space } : {}) }))
  )

  return server
}

/** Optional fields left out rather than undefined (the tools' options use exactOptionalPropertyTypes). */
function strip<T extends object>(input: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as never
}

/** Answer one MCP request (POST; GET and DELETE get 405, there are no sessions). */
export async function handleMcp(request: Request, tools: AgentTools, version: string): Promise<Response> {
  // Without sessions there is nothing to stream to a GET or to end with a DELETE.
  if (request.method !== 'POST') return Response.json({ error: 'POST MCP requests here' }, { status: 405, headers: { allow: 'POST' } })
  const server = mcpServer(tools, version)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    void server.close()
  }
}
