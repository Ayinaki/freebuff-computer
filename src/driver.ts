import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { COMPUTER_TOOLS } from './contract.js'
import { driverCommand, platformLabel } from './config.js'

export interface DriverContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface DriverCallResult {
  content: DriverContentBlock[]
  isError: boolean
}

export interface ContractMismatch {
  missingTools: string[]
  missingParams: string[]
  extraTools: string[]
  ok: boolean
}

export interface DriverStatus {
  inputMode?: string
  connected: boolean
  command: string
  serverName?: string
  serverVersion?: string
  protocolVersion?: string
  pid?: number | null
  stderr: string[]
  lastError?: string
}

/**
 * A single, long-lived connection to the computer-use driver.
 *
 * The connection MUST be long-lived, and that is a correctness requirement, not
 * a performance one: `element_index` values are scoped to the driver session
 * that produced them. Starting a fresh driver per action would silently
 * invalidate every index the model is holding, so every call in a turn is
 * routed through one session.
 */
export class ComputerDriver {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private starting: Promise<void> | null = null
  private tools: Tool[] = []
  private stderrLines: string[] = []
  private lastError: string | undefined

  constructor(private readonly connectTimeoutMs = 30_000) {}

  get isConnected(): boolean {
    return this.client !== null
  }

  status(): DriverStatus {
    const { command, args } = driverCommand()
    return {
      inputMode: process.platform === 'win32' && !process.env.FBC_DRIVER_CMD ? (process.env.FBC_INPUT_MODE ?? 'background') : 'external-driver',
      connected: this.isConnected,
      command: [command, ...args].join(' '),
      serverName: this.client?.getServerVersion()?.name,
      serverVersion: this.client?.getServerVersion()?.version,
      protocolVersion: this.client?.getServerCapabilities() ? 'negotiated' : undefined,
      pid: this.transport?.pid ?? null,
      stderr: this.stderrLines.slice(-20),
      lastError: this.lastError,
    }
  }

  async start(): Promise<void> {
    if (this.client) return
    if (this.starting) return this.starting
    this.starting = this.doStart()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async doStart(): Promise<void> {
    const { command, args } = driverCommand()
    const transport = new StdioClientTransport({
      command,
      args,
      stderr: 'pipe',
      env: backgroundTypingEnvironment(),
      // A single accessibility snapshot can be many megabytes. The SDK default
      // is 10 MB, which would drop the connection mid-session on a large app.
      maxBufferSize: 64 * 1024 * 1024,
    })

    const stderrStream = transport.stderr
    if (stderrStream) {
      stderrStream.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString().trimEnd()
        if (!text) return
        this.stderrLines.push(text)
        if (this.stderrLines.length > 200) this.stderrLines.shift()
      })
    }

    const client = new Client({ name: 'freebuff-computer', version: '0.1.0' })

    const timer = new Promise<never>((_, reject) => {
      const handle = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${this.connectTimeoutMs}ms starting the computer-use driver (${command}).`,
          ),
        )
      }, this.connectTimeoutMs)
      handle.unref?.()
    })

    try {
      await Promise.race([client.connect(transport), timer])
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      await transport.close().catch(() => {})
      throw this.decorateStartError(error)
    }

    this.transport = transport
    this.client = client
    this.lastError = undefined
  }

  private decorateStartError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    const hint =
      '\n\nFreebuff Computer could not start its configured driver.\n' +
      (process.platform === 'win32' && !process.env.FBC_DRIVER_CMD
        ? '  Reinstall the package, or rebuild a source checkout: npm run build (Go 1.22+).\n'
        : process.env.FBC_DRIVER_CMD ? '  Check the FBC_DRIVER_CMD override and its executable path. External ocu installations use: npm install -g open-computer-use. Clear the override to use the bundled Windows driver.\n'
        : '  Install it once:  npm install -g open-computer-use\n') +
      '  Then verify:      fbc doctor\n' +
      `  Platform detected: ${platformLabel()}`
    return new Error(`${message}${hint}`)
  }

  async listDriverTools(): Promise<Tool[]> {
    await this.start()
    if (this.tools.length === 0) {
      const listed = await this.client!.listTools()
      this.tools = listed.tools
    }
    return this.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<DriverCallResult> {
    await this.start()
    try {
      const result = await this.client!.callTool({ name, arguments: args })
      const content = Array.isArray(result.content)
        ? (result.content as unknown as DriverContentBlock[])
        : []
      return { content, isError: result.isError === true }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /**
   * Compare what the driver actually advertises against the contract we expose.
   * Wrapping a third-party driver means it can change under us; this turns that
   * from a silent broken tool into a reported mismatch.
   */
  async verifyContract(): Promise<ContractMismatch> {
    let advertised: Tool[]
    try {
      advertised = await this.listDriverTools()
    } catch {
      return { missingTools: COMPUTER_TOOLS.map((t) => t.name), missingParams: [], extraTools: [], ok: false }
    }

    const byName = new Map(advertised.map((t) => [t.name, t]))
    const missingTools: string[] = []
    const missingParams: string[] = []

    for (const spec of COMPUTER_TOOLS) {
      const actual = byName.get(spec.name)
      if (!actual) {
        missingTools.push(spec.name)
        continue
      }
      const actualProps = (actual.inputSchema?.properties ?? {}) as Record<string, unknown>
      for (const param of Object.keys(spec.inputSchema.properties ?? {})) {
        if (!(param in actualProps)) missingParams.push(`${spec.name}.${param}`)
      }
    }

    const contractNames = new Set(COMPUTER_TOOLS.map((t) => t.name))
    const extraTools = advertised.map((t) => t.name).filter((n) => !contractNames.has(n))

    return {
      missingTools,
      missingParams,
      extraTools,
      ok: missingTools.length === 0 && missingParams.length === 0,
    }
  }

  async close(): Promise<void> {
    const transport = this.transport
    this.client = null
    this.transport = null
    this.tools = []
    if (transport) await transport.close().catch(() => {})
  }
}

/** Only our bundled driver guarantees AutoSetFocus=false for value mutations. */
export function backgroundTypingEnvironment(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (platform !== 'win32' || env.FBC_DRIVER_CMD) return undefined
  if (env.FBC_INPUT_MODE && !['background', 'foreground'].includes(env.FBC_INPUT_MODE))
    throw new Error('FBC_INPUT_MODE must be background or foreground')
  return { ...getDefaultEnvironment(),
    FBC_INPUT_MODE: env.FBC_INPUT_MODE ?? 'background',
    OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK:
      env.OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK ?? '1',
  }
}
