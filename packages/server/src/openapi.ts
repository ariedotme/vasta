// The public HTTP API as an OpenAPI 3.1 document, served at /api/openapi.json: the capture API,
// which scripts, Shortcuts and other apps use with a token. The rest of /api is the web app's own
// and may change between versions; agents use the MCP endpoint instead (docs/agents.md).
// test/openapi.test.ts checks that every capture route is described here.

const error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] }

const base = {
  channel: { type: 'string', description: 'Shown on the daily-note block: api (default), shortcuts, email, raycast, browser…' },
  spaceId: { type: 'string', description: "One of the token owner's spaces; their capture space by default." },
}

const json = (schema: object) => ({ required: true, content: { 'application/json': { schema } } })

const captured = {
  201: {
    description: 'Captured into the daily note.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Captured' } } },
  },
  400: { description: 'Bad input.', content: { 'application/json': { schema: error } } },
  401: { description: 'Missing or wrong token.', content: { 'application/json': { schema: error } } },
}

const capture = (operationId: string, summary: string, description: string, body: object) => ({
  post: { operationId, tags: ['Capture'], summary, description, requestBody: body, responses: captured },
})

export const openApi = {
  openapi: '3.1.0',
  info: {
    title: 'Vasta capture API',
    version: '1',
    description:
      'Capture notes, links, tasks, objects, files and food into the daily note of a Vasta space. Every request needs `Authorization: Bearer <token>`, a token made in Settings › Capture tokens (scope capture or api).',
    license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
  },
  servers: [{ url: '/' }],
  security: [{ token: [] }],
  tags: [{ name: 'Capture' }],
  paths: {
    '/api/capture/today': {
      get: {
        operationId: 'today',
        tags: ['Capture'],
        summary: "Today's daily note",
        description: 'Creates the note when it does not exist yet.',
        parameters: [{ name: 'spaceId', in: 'query', schema: base.spaceId }],
        responses: {
          200: {
            description: "Today in the user's time zone, and the note's id.",
            content: { 'application/json': { schema: { type: 'object', properties: { day: { type: 'string', format: 'date' }, dailyNoteId: { type: 'string' } }, required: ['day', 'dailyNoteId'] } } },
          },
          400: captured[400],
          401: captured[401],
        },
      },
    },
    '/api/capture/note': capture('captureNote', 
      'A note',
      'A block of text in today’s note. URLs in it are linked and saved as weblinks.',
      json({
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' }, saveLinks: { type: 'boolean', default: true, description: 'Save each URL as a weblink object too.' }, ...base },
      })
    ),
    '/api/capture/weblink': capture('captureWeblink', 
      'A link',
      'A weblink object (reused when the URL was saved before), with its preview and a readable copy of the page fetched in the background.',
      json({
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string', format: 'uri' }, title: { type: 'string' }, note: { type: 'string', description: 'Written next to the link.' }, ...base },
      })
    ),
    '/api/capture/task': capture('captureTask', 
      'A task',
      'A task, from its fields or from a line read like the Telegram bot’s first line ("Buy coffee due:friday priority:high").',
      json({
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Required unless `line` gives one.' },
          line: { type: 'string' },
          note: { type: 'string' },
          due: { type: 'string', description: 'YYYY-MM-DD or an ISO date-time.' },
          priority: { enum: ['high', 'medium', 'low'] },
          ...base,
        },
      })
    ),
    '/api/capture/object': capture('captureObject', 
      'An object of any type',
      'An object of a type given by id, built-in key (page, task…) or name. `props`, by property id, win over what `line` sets.',
      json({
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          line: { type: 'string', description: 'A first line to read the title and properties from: Dune author:"Frank Herbert" rating:5' },
          text: { type: 'string', description: 'Body text.' },
          props: { type: 'object', additionalProperties: { $ref: '#/components/schemas/PropertyValue' } },
          ...base,
        },
      })
    ),
    '/api/capture/file': capture('captureFile', 'A file', 'An image, PDF, audio or other file, saved as a media object.', {
      required: true,
      content: {
        'multipart/form-data': {
          schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, caption: { type: 'string' }, ...base } },
        },
      },
    }),
    '/api/capture/food': {
      post: {
        operationId: 'captureFood',
        tags: ['Capture'],
        summary: 'Food eaten',
        description: 'What was eaten, in the words of /food in the Telegram bot: "2 slices of bread, coffee 200 ml at breakfast".',
        requestBody: json({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, spaceId: base.spaceId } }),
        responses: {
          201: {
            description: 'Logged on the daily note.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    dailyNoteId: { type: 'string' },
                    day: { type: 'string', format: 'date' },
                    entries: { type: 'array', items: { type: 'object' } },
                    created: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
                    problems: { type: 'array', items: { type: 'string' } },
                    summary: { type: 'string' },
                  },
                },
              },
            },
          },
          400: captured[400],
          401: captured[401],
        },
      },
    },
  },
  components: {
    securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Captured: {
        type: 'object',
        required: ['dailyNoteId', 'blockId', 'objects'],
        properties: {
          dailyNoteId: { type: 'string' },
          blockId: { type: 'string', description: 'The block added to the daily note.' },
          objects: {
            type: 'array',
            description: 'Objects the capture created or reused.',
            items: { type: 'object', properties: { id: { type: 'string' }, typeId: { type: 'string' }, title: { type: 'string' } } },
          },
          summary: { type: 'string', description: 'What a task or object capture understood: "Task “Buy coffee”, due Fri 24 Oct, priority High".' },
          unreadable: { type: 'array', items: { type: 'string' }, description: 'Properties in the line whose values could not be read.' },
        },
      },
      PropertyValue: {
        type: 'object',
        required: ['kind', 'value'],
        description: 'A property value: text, url (string), number, checkbox (boolean), date, relation and select (arrays of ids)…',
        properties: { kind: { type: 'string' }, value: {} },
      },
    },
  },
}
