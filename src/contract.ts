/**
 * The tool contract.
 *
 * These schemas are frozen copies of the live `computer-use` driver contract
 * (verified with `tools/list` against open-computer-use 0.3.6 on win32-x64 and
 * documented for macOS/Linux). They are intentionally identical in *shape* to
 * Codex's computer-use surface: `list_apps`, `get_app_state`, `click`,
 * `perform_secondary_action`, `scroll`, `drag`, `type_text`, `press_key`,
 * `set_value`.
 *
 * `driver.ts` verifies at runtime that the connected driver still advertises
 * every tool and parameter below, so version drift fails loudly instead of
 * silently producing a tool the model cannot use.
 */

export interface JsonSchema {
  type?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: string[]
  items?: JsonSchema
  anyOf?: JsonSchema[]
  minimum?: number
  additionalProperties?: boolean
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: JsonSchema
  /** Mutating tools change the user's machine; read-only tools only observe. */
  mutating: boolean
  /** Actions worth a confirmation prompt when policy is strict. */
  risky?: boolean
}

const APP = {
  type: 'string',
  description: 'App name or bundle identifier, as reported by list_apps',
} as const

const ELEMENT_INDEX = {
  type: 'string',
  description:
    'Element index from the most recent get_app_state for this app. Indexes are only valid for the snapshot that produced them.',
} as const

export const COMPUTER_TOOLS: ToolSpec[] = [
  {
    name: 'list_apps',
    description:
      'List running and recently used apps that Computer Use can drive, with pid and window title. Start here when you do not know the exact app name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    mutating: false,
  },
  {
    name: 'get_app_state',
    description:
      'Read the accessibility tree of an app as an indented outline. Every actionable node carries an element_index that click/set_value/scroll/perform_secondary_action accept. Prefer this over coordinates. Take a fresh snapshot every turn you intend to act, and after any action that changes the UI.',
    inputSchema: {
      type: 'object',
      properties: {
        app: APP,
        max_tree_depth: {
          type: 'integer',
          minimum: 1,
          description:
            'Maximum accessibility tree depth to render. Defaults to 32 (the driver default is 64).',
        },
        max_tree_nodes: {
          type: 'integer',
          minimum: 1,
          description:
            'Maximum accessibility tree nodes to render. Defaults to 200 (the driver default is 1200). Raise this when a long list or page looks incomplete.',
        },
        text_limit: {
          anyOf: [{ type: 'integer', minimum: 1 }, { enum: ['max'], type: 'string' }],
          description:
            'Maximum text characters to return per node. Use "max" for full text. Defaults to 500.',
        },
      },
      required: ['app'],
      additionalProperties: false,
    },
    mutating: false,
  },
  {
    name: 'click',
    description:
      'Click an element by element_index, or by x/y coordinates when the target has no accessibility node (canvas, WebGL, custom-drawn surfaces). Coordinates are in screenshot pixels and must come from the most recent snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        app: APP,
        element_index: ELEMENT_INDEX,
        x: { type: 'number', description: 'X coordinate in screenshot pixel coordinates' },
        y: { type: 'number', description: 'Y coordinate in screenshot pixel coordinates' },
        click_count: { type: 'integer', description: 'Number of clicks. Defaults to 1' },
        mouse_button: { enum: ['left', 'right', 'middle'], type: 'string', description: 'Mouse button to click. Defaults to left.' },
        click_method: {
          enum: ['auto', 'accessibility', 'app_post', 'sky_click', 'global'],
          type: 'string',
          description:
            'Click implementation: auto (default), accessibility, app_post, sky_click, or global. Accessibility requires element_index. Windows supports app_post through HWND messages and does not currently support sky_click or global.',
        },
      },
      required: ['app'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'set_value',
    description:
      'Set the value of an editable control directly through the accessibility API. Preferred over typing when the target exposes SetValue — it is exact, atomic, and does not need focus.',
    inputSchema: {
      type: 'object',
      properties: { app: APP, element_index: ELEMENT_INDEX, value: { type: 'string', description: 'Value to assign' } },
      required: ['app', 'element_index', 'value'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'type_text',
    description:
      'Type literal text into the app with the current keyboard focus. Use set_value when the target exposes it. Never type passwords or secrets.',
    inputSchema: {
      type: 'object',
      properties: { app: APP, text: { type: 'string', description: 'Literal text to type' } },
      required: ['app', 'text'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'press_key',
    description:
      'Press a key or key combination, for example "Return", "Escape", or "ctrl+s". Prefer keyboard shortcuts over hunting for buttons.',
    inputSchema: {
      type: 'object',
      properties: { app: APP, key: { type: 'string', description: 'Key or key-combination to press' } },
      required: ['app', 'key'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'scroll',
    description: 'Scroll a container element by pages in a direction.',
    inputSchema: {
      type: 'object',
      properties: {
        app: APP,
        element_index: ELEMENT_INDEX,
        direction: { type: 'string', description: 'Scroll direction: up, down, left, or right' },
        pages: { type: 'number', description: 'Number of pages to scroll. Fractional values are supported. Defaults to 1' },
      },
      required: ['app', 'element_index', 'direction'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'drag',
    description:
      'Drag from one coordinate to another. Coordinates are in screenshot pixels. On Windows this drives a window-server drag and may move the real pointer.',
    inputSchema: {
      type: 'object',
      properties: {
        app: APP,
        from_x: { type: 'number', description: 'Start X coordinate' },
        from_y: { type: 'number', description: 'Start Y coordinate' },
        to_x: { type: 'number', description: 'End X coordinate' },
        to_y: { type: 'number', description: 'End Y coordinate' },
      },
      required: ['app', 'from_x', 'from_y', 'to_x', 'to_y'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'perform_secondary_action',
    description:
      'Invoke a named secondary accessibility action on an element, such as SetValue, ScrollIntoView, or ExpandCollapse. The node\'s snapshot line lists its available actions.',
    inputSchema: {
      type: 'object',
      properties: {
        app: APP,
        element_index: ELEMENT_INDEX,
        action: { type: 'string', description: 'Secondary accessibility action name' },
      },
      required: ['app', 'element_index', 'action'],
      additionalProperties: false,
    },
    mutating: true,
  },
]

/** Tools this server adds on top of the computer-use contract. */
export const EXTRA_TOOL_NAMES = ['computer_doctor', 'computer_policy'] as const

export const EXTRA_TOOLS: ToolSpec[] = [
  {
    name: 'computer_doctor',
    description:
      'Report the health of the Computer Use setup: driver availability, platform support, and any contract mismatch. Use this first when a Computer Use action fails unexpectedly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    mutating: false,
  },
  {
    name: 'computer_policy',
    description:
      'Read the active Computer Use safety policy: mode, permitted apps, and blocked key combinations. Call with no arguments to read; pass `allowedApps` to replace the permitted app list.',
    inputSchema: {
      type: 'object',
      properties: {
        allowedApps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement allowlist of app names. Only used when policy mode is allowlist.',
        },
        policyMode: { enum: ['open', 'allowlist', 'audit'], type: 'string', description: 'Replace the policy mode.' },
      },
      additionalProperties: false,
    },
    mutating: true,
  },
]

export const ALL_TOOLS: ToolSpec[] = [...COMPUTER_TOOLS, ...EXTRA_TOOLS]

export function findTool(name: string): ToolSpec | undefined {
  return ALL_TOOLS.find((t) => t.name === name)
}

/**
 * Keys and payloads that are never safe to send from an agent, regardless of
 * user intent. These mirror the hard blocks other computer-use harnesses ship.
 */
export const ALWAYS_BLOCKED_KEYS = [
  'ctrl+alt+delete',
  'cmd+ctrl+q',
  'cmd+shift+q',
  'ctrl+shift+escape',
  'win+l',
]

export const BLOCKED_TEXT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // A trailing \b would never match here: `/` is a non-word character, so there
  // is no word boundary between it and the end of the line.
  { pattern: /\brm\s+-rf?\s+\/(\s|$)/i, reason: 'recursive delete of the filesystem root' },
  { pattern: /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i, reason: 'piping a download straight into a shell' },
  { pattern: /\bwget\b[^\n]*\|\s*(ba)?sh\b/i, reason: 'piping a download straight into a shell' },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: 'fork bomb' },
]
