// The MCP endpoint (POST /mcp, Streamable HTTP without sessions): the AgentTools of the token's
// user as MCP tools. Each request gets its own server and transport, so nothing is kept between
// requests and any number of agents can call at once. See docs/agents.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { COLOR_NAMES } from '@vasta/core'
import { AgentError, type AgentTools } from './agent.ts'
import { ICON_HELP } from './icons.ts'

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
goal) and tasks a Sprint field: set it by the sprint's title, or "current" for the one under way.
Types may have templates (list_templates): create_object starts from a type's default template,
or the one named by "template", with its questions answered by "answers". Whiteboards (type
"Whiteboard") hold cards of objects, text, sticky notes, shapes, frames and arrows: read one with
get_board, change it with edit_board (a Mermaid flowchart becomes a board there too).`

const space = z.string().optional().describe('Space id or name; the default space when omitted')
const properties = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
  .optional()
  .describe('Values by property name: text, numbers, true/false, dates ("2026-10-25", "2026-10-25T15:00:00Z", "friday 15h"), option labels, related objects by title, people by username or name ("me": the user) (a list for several). null clears one.')

const tags = z.array(z.string()).optional().describe('Tag titles; a path like "recipe/breakfast" names a nested tag. Tags the space does not have yet are created.')
const icon = z.string().nullable().optional().describe(`Its icon: ${ICON_HELP}. null removes it.`)
const color = z.enum(COLOR_NAMES).nullable().optional().describe(`Its color (a tag's chips): ${COLOR_NAMES.join(', ')}. null goes back to the default.`)

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
    'list_templates',
    {
      title: 'List templates',
      description: "The space's templates (each of a type, the default marked) and snippets, with the questions they ask. create_object uses a type's default template unless told otherwise.",
      inputSchema: { space },
      annotations: READ,
    },
    ({ space }) => run(() => tools.templates(space))
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
      description: "An object: type, icon, color, properties, tags (nested ones as paths, \"recipe/breakfast\"), its text fields as Markdown, and what links to it (backlinks). The id is in vasta://o/<id> links and in other tools' results.",
      inputSchema: { id: z.string() },
      annotations: READ,
    },
    ({ id }) => run(() => tools.getObject(id))
  )

  server.registerTool(
    'get_daily_note',
    {
      title: 'Get daily note',
      description: "A day's note (today by default, in the user's time zone), with id null when the note has not been started.",
      inputSchema: { day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'), space },
      annotations: READ,
    },
    ({ day, space }) => run(() => tools.dailyNote({ ...(day ? { day } : {}), ...(space ? { space } : {}) }))
  )

  server.registerTool(
    'write_daily_note',
    {
      title: 'Write daily note',
      description: "Append Markdown to a day's note, creating it with that text if needed.",
      inputSchema: { markdown: z.string().min(1), day: z.string().optional(), space },
      annotations: WRITE,
    },
    ({ markdown, day, space }) => run(() => tools.writeDailyNote(markdown, space, day))
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
      description:
        'A new object of a type (name or id, e.g. "Page", "Task", "Book"), with a title, properties and text in Markdown. It starts from the type\'s default template, or the one "template" names ("blank" for none; list_templates lists them and their questions, answered by "answers"); what you give wins over the template (tags are added to the template\'s). Returns it like get_object.',
      inputSchema: {
        type: z.string(),
        coverUrl: z.string().optional().describe("HTTP(S) cover image URL"),
        title: z.string().optional(),
        space,
        properties,
        markdown: z.string().optional().describe('Its text, in Markdown (after the template\'s)'),
        template: z.string().optional().describe('A template of the type by name, or "blank"'),
        answers: z.record(z.string(), z.string()).optional().describe("Answers to the template's questions, by question"),
        tags,
        icon,
        color,
      },
      annotations: WRITE,
    },
    (input) => run(() => tools.createObject(strip(input)))
  )

  const boardColor = z.enum(COLOR_NAMES).optional()
  const arrowLook = {
    path: z.enum(['straight', 'curved', 'elbow']).optional().describe("An arrow's course"),
    heads: z.enum(['end', 'both', 'none']).optional().describe('Which ends have a head (none: a plain line)'),
    startTip: z.enum(['arrow', 'dot', 'none']).optional().describe('What the start has (wins over heads)'),
    endTip: z.enum(['arrow', 'dot', 'none']).optional().describe('What the end has (wins over heads)'),
    fromSide: z.enum(['auto', 'top', 'right', 'bottom', 'left']).optional().describe('The side the line leaves from (auto: the facing one)'),
    toSide: z.enum(['auto', 'top', 'right', 'bottom', 'left']).optional().describe('The side the line arrives at'),
    dash: z.enum(['solid', 'dashed', 'dotted']).optional(),
    dashed: z.boolean().optional(),
    width: z.number().optional().describe('Line width in board units (0: the usual)'),
  }
  const elementLook = {
    rotation: z.number().optional().describe('Degrees clockwise (0: upright); not frames'),
    fill: z.enum(['tint', 'none', 'white', 'solid']).optional().describe("A shape's inside (tint: the usual)"),
    border: z.number().optional().describe("A shape's outline width (0: the usual)"),
    dash: z.enum(['solid', 'dashed', 'dotted']).optional().describe("A shape's outline or a stroke"),
    fontSize: z.enum(['sm', 'md', 'lg', 'xl']).optional().describe("A sticky note's text size"),
  }
  server.registerTool(
    'get_board',
    {
      title: 'Get whiteboard',
      description:
        'A whiteboard\'s elements (cards of objects, text, sticky notes, shapes, frames, pen strokes without their ink) with their boxes in board coordinates (x right, y down), and its arrows. format "canvas" gives the board as a JSON Canvas (jsoncanvas.org, Obsidian\'s format) instead, "mermaid" as a Mermaid flowchart (frames as subgraphs).',
      inputSchema: { id: z.string(), format: z.enum(['elements', 'canvas', 'mermaid']).optional() },
      annotations: READ,
    },
    ({ id, format }) => run(() => tools.getBoard(id, format))
  )

  server.registerTool(
    'edit_board',
    {
      title: 'Edit whiteboard',
      description:
        'Change a whiteboard in one step (make one with create_object, type "Whiteboard"). "add": elements; a card shows an object ("object": its id or exact title), text, sticky and shape hold "text", a frame has a "title"; give x and y to place one, else new elements are laid out in a grid to the right of the board; "ref" names a new element so "arrows" can use it. "arrows": from and to are refs or ids from get_board. "update": move, resize, recolor, retext, retitle, reshape or restyle elements (rotation, fill, border, dash, fontSize), set a card\'s view and fields, make a frame the cover (default scene), or relabel and restyle arrows (tips, sides, dash, width). "remove": ids (an element\'s arrows and the strokes drawn on it go too). "mermaid": a Mermaid flowchart ("graph LR; A[Idea] --> B{Choose}"), laid out as shapes and arrows, nodes named like an object of the space becoming its card. "canvas": a JSON Canvas to add. Returns the board as get_board does, with the ids given to refs.',
      inputSchema: {
        id: z.string(),
        add: z
          .array(
            z.object({
              ref: z.string().optional(),
              kind: z.enum(['card', 'text', 'sticky', 'shape', 'frame']),
              object: z.string().optional(),
              text: z.string().optional(),
              shape: z.enum(['rectangle', 'ellipse', 'diamond', 'triangle', 'parallelogram', 'star', 'heart']).optional(),
              title: z.string().optional(),
              color: boardColor,
              x: z.number().optional(),
              y: z.number().optional(),
              w: z.number().optional(),
              h: z.number().optional(),
              ...elementLook,
            })
          )
          .optional(),
        arrows: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional(), color: boardColor, ...arrowLook })).optional(),
        update: z
          .array(
            z.object({
              id: z.string(),
              x: z.number().optional(),
              y: z.number().optional(),
              w: z.number().optional(),
              h: z.number().optional(),
              text: z.string().optional(),
              title: z.string().optional(),
              shape: z.enum(['rectangle', 'ellipse', 'diamond', 'triangle', 'parallelogram', 'star', 'heart']).optional(),
              label: z.string().optional(),
              color: z.enum(COLOR_NAMES).nullable().optional(),
              ...arrowLook,
              ...elementLook,
              view: z.enum(['card', 'compact', 'embed', 'properties']).optional().describe("A card's look: its card, one line, its contents (a query's live results, the text), or its title with the properties in fields"),
              fields: z.array(z.string()).optional().describe('A "properties" card: the property names to list, in order'),
              cover: z.boolean().optional().describe("A frame: make it the board's default scene (where it opens, what previews show)"),
            })
          )
          .optional(),
        remove: z.array(z.string()).optional(),
        mermaid: z.string().optional(),
        canvas: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('A JSON Canvas, as an object or its text'),
        layout: z.enum(['down', 'right', 'up', 'left', 'grid']).optional().describe('Lay the whole board out after the edit: in layers along its arrows (with fewer crossings), or in a grid; frames are refitted around what they hold'),
      },
      annotations: WRITE,
    },
    (input) => run(() => tools.editBoard(strip(input)))
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
      description:
        'Change an object: its title, icon, color, properties (null clears one), its tags (added by default; "tagsMode" "remove" takes them off, "replace" sets exactly these), and its text: Markdown appended (default), put before the text ("prepend"), or replacing it ("replace"). "field" picks a text field by name when the type has several.',
      inputSchema: {
        id: z.string(),
        coverUrl: z.string().nullable().optional().describe("HTTP(S) cover image URL, or null to remove it"),
        title: z.string().optional(),
        properties,
        markdown: z.string().optional(),
        mode: z.enum(['append', 'prepend', 'replace']).optional(),
        field: z.string().optional(),
        tags,
        tagsMode: z.enum(['add', 'remove', 'replace']).optional().describe('What "tags" does: add them (default), remove them, or replace all the tags with them'),
        icon,
        color,
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    (input) => run(() => tools.updateObject(strip(input)))
  )

  server.registerTool(
    'set_pinned',
    {
      title: 'Set pinned',
      description: 'Pin an object in the first sidebar section, or unpin it from all sections.',
      inputSchema: { id: z.string(), pinned: z.boolean() },
      annotations: WRITE,
    },
    ({ id, pinned }) => run(() => tools.setPinned(id, pinned))
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
