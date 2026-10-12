import { parse, type Node } from 'acorn'
import { findTool, type JsonSchema } from './contract.js'
import type { DriverCallResult, DriverContentBlock } from './driver.js'
import { parseVerification, verificationLine, type VerificationState } from './overlay.js'

// Acorn owns parsing; this visitor only accepts explicitly listed AST forms.
// Nothing in the submitted source is ever evaluated as JavaScript.
type Ast = Node & Record<string, unknown>
type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal }

export interface CuaAction {
  kind: 'action'
  tool: string
  args: Record<string, unknown>
  emit: boolean
  statement: number
}

export type CuaStep = CuaAction | {
  kind: 'write'
  value?: Literal
  resultOf?: number
  statement: number
}

export interface CuaPlan { steps: CuaStep[]; actions: CuaAction[] }

function fail(message: string): never { throw new Error(message) }
function ast(value: unknown): Ast { return value as Ast }

function literal(node: Ast): Literal {
  if (node.type === 'Literal') {
    const value = node['value']
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  if (node.type === 'UnaryExpression' && node['operator'] === '-') {
    const value = literal(ast(node['argument']))
    if (typeof value === 'number') return -value
  }
  if (node.type === 'ArrayExpression') {
    return (node['elements'] as (Ast | null)[]).map((item) => item ? literal(item) : fail('Array holes are not supported'))
  }
  if (node.type === 'ObjectExpression') {
    const result: Record<string, Literal> = Object.create(null)
    for (const property of node['properties'] as Ast[]) {
      if (property.type !== 'Property' || property['computed'] || property['method'] || property['shorthand'] || property['kind'] !== 'init') {
        fail('Only literal object properties are supported')
      }
      const keyNode = ast(property['key'])
      const key = keyNode.type === 'Identifier' ? keyNode['name'] : literal(keyNode)
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || Object.hasOwn(result, key)) {
        fail('Object keys must be unique, plain string names')
      }
      result[key] = literal(ast(property['value']))
    }
    return result
  }
  return fail(`Expected a literal argument, received ${node.type}`)
}

function object(value: Literal | undefined): Record<string, Literal> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Options must be a literal object')
  return value
}

function options(value: Literal | undefined, mapping: Record<string, string>, allowEmit = false): { args: Record<string, unknown>; emit: boolean } {
  const args: Record<string, unknown> = {}
  let emit = true
  for (const [key, entry] of Object.entries(object(value))) {
    if (key === 'emit' && allowEmit) {
      if (typeof entry !== 'boolean') fail('emit must be a boolean')
      emit = entry as boolean
    } else if (Object.hasOwn(mapping, key)) args[mapping[key]!] = entry
    else fail(`Unsupported option: ${key}`)
  }
  return { args, emit }
}

function validates(value: unknown, schema: JsonSchema): boolean {
  if (schema.anyOf) return schema.anyOf.some((part) => validates(value, part))
  if (schema.enum && !schema.enum.includes(value as string)) return false
  if (schema.type === 'string') return typeof value === 'string'
  if (schema.type === 'number' || schema.type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value)) && (schema.minimum === undefined || value >= schema.minimum)
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const entries = value as Record<string, unknown>
    return (schema.required ?? []).every((key) => Object.hasOwn(entries, key)) &&
      Object.entries(entries).every(([key, entry]) => {
        const property = schema.properties?.[key]
        return property ? validates(entry, property) : schema.additionalProperties !== false
      })
  }
  return false
}

function point(value: Literal | undefined): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return fail('Coordinates must be a literal [x, y] number pair')
  }
  return value as [number, number]
}

/** Compile the entire program into concrete native calls before policy or execution. */
export function parseCuaSubset(code: unknown): CuaPlan {
  if (typeof code !== 'string' || !code.trim() || code.length > 32768) fail('code must contain 1–32768 characters')
  const program = parse(code as string, { ecmaVersion: 2022, sourceType: 'module' })
  const body = ast(program)['body'] as Ast[]
  if (body.length > 128) fail('At most 128 statements are supported')
  const apps = new Map<string, string>()
  const results = new Map<string, number>()
  const steps: CuaStep[] = []
  const actions: CuaAction[] = []

  for (const [offset, statement] of body.entries()) {
    const position = offset + 1
    try {
      let expression: Ast
      let binding: string | undefined
      if (statement.type === 'VariableDeclaration') {
        const declarations = statement['declarations'] as Ast[]
        if (declarations.length !== 1) fail('Declare one variable per statement')
        const declaration = declarations[0]!
        const id = ast(declaration['id'])
        if (id.type !== 'Identifier' || !declaration['init']) fail('Use a simple variable initialized by an awaited cua call')
        binding = id['name'] as string
        if (['cua', 'nodeRepl'].includes(binding) || apps.has(binding) || results.has(binding)) fail('Bindings must have unique, non-reserved names within the batch')
        expression = ast(declaration['init'])
      } else if (statement.type === 'ExpressionStatement') expression = ast(statement['expression'])
      else fail(`Unsupported statement: ${statement.type}`)

      const awaited = expression.type === 'AwaitExpression'
      const call = awaited ? ast(expression['argument']) : expression
      if (call.type !== 'CallExpression' || call['optional']) fail('Only direct method calls are supported')
      const member = ast(call['callee'])
      if (member.type !== 'MemberExpression' || member['computed'] || member['optional']) fail('Only named, non-computed methods are supported')
      const receiverNode = ast(member['object'])
      const methodNode = ast(member['property'])
      if (receiverNode.type !== 'Identifier' || methodNode.type !== 'Identifier') fail('Use cua or a locally bound app as the receiver')
      const receiver = receiverNode['name'] as string
      const method = methodNode['name'] as string
      const argumentNodes = call['arguments'] as Ast[]

      if (receiver === 'nodeRepl' && method === 'write') {
        if (binding || argumentNodes.length !== 1) fail('nodeRepl.write takes one literal or result variable')
        const value = argumentNodes[0]!
        if (value.type === 'Identifier') {
          const resultOf = results.get(value['name'] as string)
          if (resultOf === undefined) fail('Only previously bound observation results can be written')
          steps.push({ kind: 'write', resultOf, statement: position })
        } else steps.push({ kind: 'write', value: literal(value), statement: position })
        continue
      }
      if (!awaited) fail('Every cua or app call must be awaited')
      const args = argumentNodes.map(literal)
      let tool: string
      let nativeArgs: Record<string, unknown> = {}
      let emit = true
      let appBinding = false
      const arity = (min: number, max = min) => {
        if (args.length < min || args.length > max) fail(`${method} expects ${min === max ? min : `${min}–${max}`} arguments`)
      }

      if (receiver === 'cua') {
        if (method === 'getApp') {
          arity(1)
          if (typeof args[0] !== 'string' || !args[0].trim()) fail('getApp requires a non-empty literal app name')
          tool = 'get_app_state'
          nativeArgs = { app: args[0] }
          if (binding) apps.set(binding, args[0])
          appBinding = true
        } else if (method === 'listApps' || method === 'getState') {
          arity(0, 1)
          tool = 'list_apps'
          emit = options(args[0], {}, true).emit
        } else fail(`Unsupported cua method: ${method}`)
      } else {
        const app = apps.get(receiver)
        if (app === undefined) fail(`Unknown app binding: ${receiver}; bind it with await cua.getApp("App") in this batch`)
        nativeArgs = { app }
        switch (method) {
          case 'getAXState': {
            arity(0, 1)
            tool = 'get_app_state'
            const parsed = options(args[0], { textLimit: 'text_limit', maxTreeNodes: 'max_tree_nodes', maxTreeDepth: 'max_tree_depth' }, true)
            Object.assign(nativeArgs, parsed.args)
            emit = parsed.emit
            break
          }
          case 'click': {
            arity(1, 2)
            tool = 'click'
            if (Array.isArray(args[0])) {
              const [x, y] = point(args[0])
              Object.assign(nativeArgs, { x, y })
            } else nativeArgs['element_index'] = args[0]
            Object.assign(nativeArgs, options(args[1], { mouseButton: 'mouse_button', clickCount: 'click_count', clickMethod: 'click_method' }).args)
            break
          }
          case 'typeText': arity(1); tool = 'type_text'; nativeArgs['text'] = args[0]; break
          case 'pressKey': arity(1); tool = 'press_key'; nativeArgs['key'] = args[0]; break
          case 'setValue': arity(2); tool = 'set_value'; Object.assign(nativeArgs, { element_index: args[0], value: args[1] }); break
          case 'performSecondaryAction': arity(2); tool = 'perform_secondary_action'; Object.assign(nativeArgs, { element_index: args[0], action: args[1] }); break
          case 'scroll': arity(2, 3); tool = 'scroll'; Object.assign(nativeArgs, { element_index: args[0], direction: args[1], pages: args[2] ?? 1 }); break
          case 'drag': {
            arity(2)
            tool = 'drag'
            const [from_x, from_y] = point(args[0])
            const [to_x, to_y] = point(args[1])
            Object.assign(nativeArgs, { from_x, from_y, to_x, to_y })
            break
          }
          default: fail(`Unsupported app method: ${method}`)
        }
      }
      const spec = findTool(tool)
      if (!spec || !validates(nativeArgs, spec.inputSchema)) fail(`Arguments do not match the frozen ${tool} contract`)
      if (binding && !appBinding) {
        if (spec.mutating) fail('Only observation results can be bound to variables')
        results.set(binding, steps.length)
      }
      const action: CuaAction = { kind: 'action', tool, args: nativeArgs, emit: emit && !spec.mutating, statement: position }
      steps.push(action)
      actions.push(action)
    } catch (error) {
      fail(`Statement ${position}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { steps, actions }
}

interface ActionVerification {
  actionNumber: number
  tool: string
  statement: number
  state: VerificationState
}

/**
 * One line for the whole batch.
 *
 * A mutating step's own result is never echoed to the model, so a verification
 * line inside one would be invisible: the batch would report success while an
 * action in the middle silently did nothing. Collecting them here is what keeps
 * a batch honest, and the same reason a partial success must never read as a
 * clean one.
 */
function summarizeVerifications(entries: ActionVerification[]): string | undefined {
  if (entries.length === 0) return undefined
  const confirmed = entries.filter((entry) => entry.state === 'changed' || entry.state === 'confirmed')
  const parts = [`${confirmed.length} of ${entries.length} dispatched actions showed an observable change`]
  const unconfirmed = entries.filter((entry) => entry.state !== 'changed' && entry.state !== 'confirmed')
  if (unconfirmed.length > 0) {
    parts.push(
      'without confirmation: ' +
        unconfirmed.map((entry) => `action ${entry.actionNumber} (${entry.tool}, statement ${entry.statement}) reported ${entry.state}`).join('; '),
    )
  }
  return verificationLine(
    'batch',
    `${parts.join('. ')}. An action reported without a change may have been ignored by the app; confirm what the batch accomplished with a fresh get_app_state before relying on it.`,
  )
}

/** Only preflighted data reaches this executor; it has no JavaScript evaluator. */
export async function executeCuaPlan(
  plan: CuaPlan,
  call: (tool: string, args: Record<string, unknown>) => Promise<DriverCallResult>,
): Promise<DriverCallResult> {
  const content: DriverContentBlock[] = []
  const results = new Map<number, string>()
  const verifications: ActionVerification[] = []
  let actionNumber = 0
  for (const [index, step] of plan.steps.entries()) {
    if (step.kind === 'write') {
      const value = step.resultOf === undefined ? step.value : results.get(step.resultOf)
      content.push({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined' })
      continue
    }
    actionNumber++
    let result: DriverCallResult
    try { result = await call(step.tool, step.args) }
    catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } }
    if (result.isError) {
      content.push(...result.content, { type: 'text', text: `Batch stopped at action ${actionNumber} (${step.tool}, statement ${step.statement}). Earlier actions may have completed; they were not rolled back.` })
      return { content, isError: true }
    }
    const text = result.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
    results.set(index, text)
    const state = parseVerification(text)
    if (state !== undefined && state !== 'batch') {
      verifications.push({ actionNumber, tool: step.tool, statement: step.statement, state })
    }
    if (step.emit) content.push(...result.content)
  }
  const summary = summarizeVerifications(verifications)
  if (summary) content.push({ type: 'text', text: summary })
  return { content: content.length ? content : [{ type: 'text', text: '(no output)' }], isError: false }
}
