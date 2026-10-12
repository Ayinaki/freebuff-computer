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
  description: 'Exact app/window selector returned by list_apps. On Windows use the name@window:pid:handle:creation selector to bind one window; a bare app name or PID is refused when ambiguous.',
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
      'List running apps and their windows. On Windows each window has its own exact app selector, process ID and title, including multiple windows of the same browser process. Inspect all candidate windows before declaring a tab absent. Pass the selected app identifier unchanged to observations and actions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    mutating: false,
  },
  {
    name: 'get_app_state',
    description:
      'Read the accessibility tree of an app as an indented outline. Every actionable node carries an element_index that click/set_value/scroll/perform_secondary_action accept. Prefer this over coordinates. Take a fresh snapshot every turn you intend to act, and after any action that changes the UI. This read is also the baseline the result of your next action is verified against, so read the target window immediately before acting on it rather than once at the start of a task.',
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
      'Click an element by element_index, or by x/y coordinates when the target has no accessibility node (canvas, WebGL, custom-drawn surfaces). Coordinates are in screenshot pixels and must come from the most recent snapshot. An accessibility click is a synchronous call that reports its own failure; a coordinate or app_post click is posted as window messages, so it means the messages were delivered, not that the app acted. The result ends with a [verification: ...] line describing what was observed afterwards.',
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
      'Set the value of an editable control directly through the accessibility API. The call is atomic and needs no focus, which is why it beats typing when the target exposes SetValue. It is not a promise that the control kept the value, so the element is read back afterwards: the result ends with [verification: confirmed] or [verification: differs]. A differ means the control clamped or rejected the value, and repeating the same call will not change that.',
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
      'Type literal text into the app with the current keyboard focus. Use set_value when the target exposes it. Never type passwords or secrets. Windows value-based typing appends through the accessibility client and does not generate per-key events, so an app that reacts to individual keystrokes can ignore this entirely. There is no element value to read back, so the result is verified from the accessibility tree alone; [verification: unchanged] means the text may not have arrived.',
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
      'Press a key or key combination, for example "Return", "Escape", or "ctrl+s". Plain keys and navigation keys are the reliable case. Modifier chords such as ctrl+t are delivered as window messages that some apps ignore, and they can report success without producing any effect, so prefer a labelled control when one exists and never treat a chord as having worked on the strength of the call alone. The result ends with a [verification: ...] line: unchanged or unverified means the app may have ignored the key.',
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
    description:
      'Scroll a container element by pages in a direction. Pages is approximate: the driver repeats large increments until it reaches the requested count, and when the element exposes no scroll pattern it posts wheel messages instead, which an app can ignore. Check the [verification: ...] line in the result.',
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
      'Drag from one coordinate to another. Coordinates are in screenshot pixels. On Windows this drives a window-server drag and may move the real pointer. Message-based input may arrive without held-button state in some apps, so a successful dispatch does not prove a drop was accepted; this is a known limitation against standard Windows Forms controls. Read the [verification: ...] line and a fresh snapshot before concluding the drag landed.',
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
export const EXTRA_TOOL_NAMES = ['computer_doctor', 'computer_policy', 'exec_cua_subset', 'computer_session'] as const

export const EXTRA_TOOLS: ToolSpec[] = [
  {
    name: 'computer_session',
    description: 'Control the visible computer-use session, not app permissions. Use action="begin" before a multi-step desktop task; the first approved desktop call also begins automatically. The blue monitor border and agent cursor stay visible between calls while you think. Always call action="end" when finished, cancelled, blocked, or handing control back to the user. Do not end between steps. action="status" reads overlay state without starting it. Ending hides the overlay and clears its cached target; it does not undo app actions or change policy. A later approved desktop call begins a new session. Disconnecting the MCP server also removes the overlay.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['begin', 'end', 'status'] } }, required: ['action'], additionalProperties: false },
    mutating: false,
  },
  {
    name: 'exec_cua_subset',
    description:
      'Execute a restricted, statically enumerable cua JavaScript subset, not general JavaScript. Every action is checked against policy before anything runs. Supports awaited cua.getApp("App"), cua.listApps(), cua.getState(), and app.getAXState(), click(), setValue(), typeText(), pressKey(), scroll(), drag(), performSecondaryAction(), with literal arguments only. Bind apps or observation results using var/let/const; nodeRepl.write(result) emits a result. Example: var app = await cua.getApp("Notepad"); var state = await app.getAXState({emit:false,maxTreeNodes:40}); nodeRepl.write(state); Bindings are local to this call; the native driver session is shared with the nine structured tools. No loops, branches, imports, computed properties, functions, assignments or dynamic expressions. Element indexes must be strings. No screenshot helpers or rewriteDocumentation. Reads emit driver content by default; emit:false suppresses output, and result variables contain the returned text. Limits: 32768 source characters, 128 statements. Policy refusals run nothing; runtime failures stop the batch without undoing completed actions. A silently ignored action is not a runtime failure, so the batch result ends with a per-action verification summary: a batch that changed nothing on screen must not read as a successful one. Windows drag may move the real pointer; sky_click/global clicks are unsupported on Windows.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Restricted cua subset source. All action arguments must be literals; use nodeRepl.write only with literals or previously bound observation results.' } },
      required: ['code'],
      additionalProperties: false,
    },
    // The policy classifies each enumerated native action, not the batch as a whole.
    mutating: true,
  },
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
