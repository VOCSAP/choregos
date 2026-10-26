import { describe, expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, RenderViewport, SessionVersion } from 'claude-code'

import { isRenderableText, NAMED_COLORS, resolveFrameConfiguration, SUPPORTED_THEME_KEYS } from '../hooks/layout'
import { register } from '../hooks/register'
import { computeRuns, MAX_RUN_NAMES, runSummary } from '../hooks/runs'

const PLUGIN = 'prosopon'
const CERTIFIED: SessionVersion = { version: '2.1.303', base: '2.1.303' }
const REPLY = 'The build passes on all three platforms. The release checks completed without warnings, and the report includes every relevant result so the operator can review the outcome before proceeding with the next deployment step.'
const PROMPT = 'Run the build and report.'
const VIEWPORT: RenderViewport = { columns: 80, rows: 24 }
const WIDTHS = [40, 80, 120]
const NATIVE_ASSISTANT_BULLET = `${String.fromCodePoint(0x25cf)} `

type Reply = Mounted<'terminal', 'AssistantMessage'>
type Prompt = Mounted<'terminal', 'UserMessage'>
type Turn = Mounted<'terminal', 'TurnDuration'>
type ToolUse = Mounted<'terminal', 'ToolUse'>
type ToolResult = Mounted<'terminal', 'ToolResult'>
type ToolGroup = Mounted<'terminal', 'ToolGroup'>
type Drawn = Reply | Prompt | Turn

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

const SESSION_CWD = 'C:\\work'

function engineBeneath(on: On, version: SessionVersion | 'reject' = CERTIFIED, cwd: string | 'reject' = SESSION_CWD): void {
  on('session.cwd', () => (cwd === 'reject' ? { deny: 'cwd unavailable' } : { value: cwd }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine: ${e.props.text}`}</Text>
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine-user: ${e.props.text}`}</Text>
  })
  on('ui.render', { component: 'TurnDuration' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine-turn: ${e.props.word}`}</Text>
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine-tool: ${e.props.tool}`}</Text>
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine-result: ${e.props.tool}`}</Text>
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine-group: ${e.props.calls.length}`}</Text>
  })
  on('session.version', () =>
    version === 'reject' ? { deny: 'version unavailable' } : { value: version },
  )
}

type RenderHook = (engine: Engine, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>

function recordRenderHooks(options: Record<string, unknown> = {}): Record<string, RenderHook> {
  const renders: Record<string, RenderHook> = {}
  const recordingOn = ((event: string, matcher: { component?: string }, handler: RenderHook) => {
    if (event === 'ui.render' && matcher.component) renders[matcher.component] = handler
  }) as unknown as On
  register(recordingOn, options as never)
  return renders
}

function toolResultHook(options: Record<string, unknown>): RenderHook {
  const hook = recordRenderHooks(options).ToolResult
  expect(hook, 'ToolResult render hook registered').toBeDefined()
  return hook!
}

const RECORDING_ENGINE = {
  session: { version: async () => CERTIFIED },
  ui: { resolve: () => ({ Box: 'Box', Markdown: 'Markdown', Text: 'Text' }), log: () => undefined },
} as unknown as Engine

// A hook that sits between Prosopon and the engine and rewrites the text, as Mitos does.
function linkifierBeneath(on: On): void {
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) =>
    next({ ...e, props: { ...e.props, text: String(e.props.text).replace('a.md', LINKED) } }),
  )
}

const LINKED = '[a.md](file:///C:/proj/a.md)'

function captureLogSinks(on: On): unknown[] {
  const sinks: unknown[] = []
  on('ui.log', (_$, e) => {
    sinks.push(e.to)
    return { value: undefined }
  })
  return sinks
}

function mountReply(
  $: Engine,
  text: unknown,
  extra: Record<string, unknown> = {},
  viewport: RenderViewport = VIEWPORT,
  surface: 'terminal' | 'desktop' = 'terminal',
): Promise<Reply> {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true, ...extra } as never,
    viewport,
  } as never) as Promise<Reply>
}

function mountPrompt(
  $: Engine,
  text: unknown,
  origin: unknown = { kind: 'composer' },
  viewport: RenderViewport = VIEWPORT,
  surface: 'terminal' | 'desktop' = 'terminal',
): Promise<Prompt> {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'UserMessage',
    props: { text, origin, isExpanded: false } as never,
    viewport,
  } as never) as Promise<Prompt>
}

function mountTurn(
  $: Engine,
  props: Record<string, unknown>,
  viewport: RenderViewport = VIEWPORT,
): Promise<Turn> {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'TurnDuration',
    props: props as never,
    viewport,
  })
}

function mountTool(
  $: Engine,
  props: Record<string, unknown>,
  viewport: RenderViewport = VIEWPORT,
): Promise<ToolUse> {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      tool_use_id: 'toolu_contract',
      tool: 'Bash',
      input: { command: 'echo contract' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...props,
    } as never,
    viewport,
  }) as Promise<ToolUse>
}

function mountToolResult(
  $: Engine,
  props: Record<string, unknown> = {},
  viewport: RenderViewport = VIEWPORT,
): Promise<ToolResult> {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_contract', tool: 'Bash', output: { stdout: 'native result' }, isErrored: false, isExpanded: false, ...props },
    viewport,
  } as never) as Promise<ToolResult>
}

function mountToolGroup($: Engine): Promise<ToolGroup> {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [], isActive: false, isExpanded: false, isCallsOnly: false },
    viewport: VIEWPORT,
  } as never) as Promise<ToolGroup>
}

function walk(tree: unknown, visit: (node: Node) => void): void {
  if (typeof tree !== 'object' || tree === null) return
  visit(tree as Node)
  for (const child of (tree as Node).children ?? []) walk(child, visit)
}

function strings(tree: unknown): string[] {
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string') found.push(node)
    else walk(node, n => n.children?.forEach(visit))
  }
  visit(tree)
  return found
}

function borderedBoxes(tree: unknown): Node[] {
  const boxes: Node[] = []
  walk(tree, node => {
    if (node.type === 'Box' && node.props?.borderStyle !== undefined) boxes.push(node)
  })
  return boxes
}

function nodesOfType(tree: unknown, type: string): Node[] {
  const nodes: Node[] = []
  walk(tree, node => {
    if (node.type === type) nodes.push(node)
  })
  return nodes
}

async function expectDimNote(ui: Reply, text: string): Promise<void> {
  const tree = await ui.drawn()
  expect(borderedBoxes(tree), 'short note has no frame').toHaveLength(0)
  expect(nodesOfType(tree, 'Markdown').map(node => node.props)).toEqual([{ text, dimColor: true }])
  const bullets = nodesOfType(tree, 'Text').filter(node => node.props?.dimColor === true).flatMap(strings)
  expect(bullets, 'short note uses the native assistant bullet (mutant: restore markdown bullet)').toContain(NATIVE_ASSISTANT_BULLET)
  expect(nodesOfType(tree, 'Box').some(node => node.props?.paddingLeft !== undefined), 'short note has no padding').toBe(false)
}

async function expectStock(ui: Drawn, why: string, marker = 'engine'): Promise<void> {
  expect(await ui.find({ type: 'Text', text: `${marker}` }), `${why}: engine render reached`).toBeDefined()
  expect(borderedBoxes(await ui.drawn()), `${why}: no frame`).toHaveLength(0)
}

async function expectFramed(ui: Drawn, inner: string, title: string): Promise<void> {
  const tree = await ui.drawn()
  const frames = borderedBoxes(tree)
  expect(frames.map(box => box.props?.borderStyle)).toEqual(['single'])
  expect(strings(frames[0]), `the frame holds what the engine drew`).toContain(inner)
  expect(strings(tree), 'the frame carries its title').toContain(` ${title} `)
}

const framedAssistant = (ui: Reply, text: string, title = 'Claude') => expectFramed(ui, `engine: ${text}`, title)

// Every string the plugin put around the engine's drawing: the body the engine returned is the only
// string left out, so a second ornament carrying a hostile glyph is still seen.
function ornaments(tree: unknown, body: string | undefined): { added: string[]; bodies: number } {
  const added: string[] = []
  let bodies = 0
  const take = (value: string): void => {
    if (body !== undefined && value === body) bodies += 1
    else added.push(value)
  }
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      take(node)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const element = node as Node
    for (const value of Object.values(element.props ?? {})) {
      if (typeof value === 'string') take(value)
    }
    for (const child of element.children ?? []) visit(child)
  }
  visit(tree)
  return { added: added.flatMap(value => value.split('\n')), bodies }
}

async function framedOrnaments($: Engine, columns: number): Promise<string[]> {
  const viewport = { columns, rows: 24 }
  const reply = await mountReply($, REPLY, {}, viewport)
  await framedAssistant(reply, REPLY)
  const assistant = ornaments(await reply.drawn(), `engine: ${REPLY}`)
  expect(assistant.bodies, `engine body count at ${columns}`).toBe(1)
  const prompt = await mountPrompt($, PROMPT, { kind: 'composer' }, viewport)
  await expectFramed(prompt, PROMPT, 'You')
  const user = ornaments(await prompt.drawn(), PROMPT)
  expect(user.bodies, `prompt body count at ${columns}`).toBe(1)
  const turn = await mountTurn($, { word: 'Baked', durationMs: 3000 }, viewport)
  const rule = ornaments(await turn.drawn(), undefined)
  return [...assistant.added, ...user.added, ...rule.added]
}

const FOOTER_HINT = /esc to interrupt/i
const SPINNER_CUE = /\((?:\d+m\s*)?\d+s\s*·|[↑↓]\s*\d[\d.,]*k?\s*tokens\b|·\s*thinking\)/i
const SPINNER_ROW_HEAD = [
  /^\s*(?:[✢✳✶✻✽]|[·*]\s*\p{L}+(?:…|\.\.\.))/u,
  /^\s*\p{Lu}\p{Ll}+(?:…|\.\.\.)/u,
  /^\s*\((?:\d+m\s*)?\d+s\s*·\s*thinking\)\s*$/i,
]

function isSpinnerRow(line: string): boolean {
  return SPINNER_CUE.test(line) && SPINNER_ROW_HEAD.some(head => head.test(line))
}

function readsAsBusy(line: string): boolean {
  return FOOTER_HINT.test(line) || isSpinnerRow(line)
}

describe('ornament extractor', () => {
  test('keeps every plugin string and excludes only the engine body', () => {
    const body = `engine: ❯ 1. Yes\n· Thinking… (3s · thinking)\n${'─'.repeat(80)}`
    const tree = {
      type: 'Box',
      props: { borderStyle: 'single', title: ' ❯ 1. Claude ' },
      children: [
        { type: 'Text', props: {}, children: ['* Thinking… ↓ 26 tokens'] },
        { type: 'Text', props: {}, children: ['────'] },
        { type: 'Text', props: {}, children: [body] },
      ],
    }
    expect(ornaments(tree, body)).toEqual({
      added: ['single', ' ❯ 1. Claude ', '* Thinking… ↓ 26 tokens', '────'],
      bodies: 1,
    })
  })

  test('recognises the ASCII spinner row and a glyph-headed one', () => {
    expect(isSpinnerRow('* Thinking… ↓ 26 tokens')).toBe(true)
    expect(isSpinnerRow('✻ Baking… (3s · thinking)')).toBe(true)
    expect(isSpinnerRow('* a markdown bullet')).toBe(false)
  })
})

describe('R1 frame glyphs', () => {
  test('the frames the plugin adds use square corners only', async ($, on) => {
    engineBeneath(on)
    for (const columns of WIDTHS) {
      const added = await framedOrnaments($, columns)
      expect(added.some(line => /[╭╮╰╯]/.test(line)), `round corner at ${columns}`).toBe(false)
    }
  })

  test('every frame the plugin draws is single', async ($, on) => {
    engineBeneath(on)
    const reply = await mountReply($, REPLY)
    const prompt = await mountPrompt($, PROMPT)
    expect(borderedBoxes(await reply.drawn()).map(box => box.props?.borderStyle)).toEqual(['single'])
    expect(borderedBoxes(await prompt.drawn()).map(box => box.props?.borderStyle)).toEqual(['single'])
  })
})

describe('R2 picker cue', () => {
  test('the plugin adds no numbered picker cue', async ($, on) => {
    engineBeneath(on)
    for (const columns of WIDTHS) {
      const added = await framedOrnaments($, columns)
      expect(added.some(line => /❯/.test(line)), `picker glyph at ${columns}`).toBe(false)
    }
  })
})

describe('R3 full-width rule', () => {
  test('the plugin adds no line of exactly columns rule glyphs', async ($, on) => {
    engineBeneath(on)
    for (const columns of WIDTHS) {
      const added = await framedOrnaments($, columns)
      const rule = added.find(
        line => [...line].length === columns && line.startsWith('─') && line.endsWith('─'),
      )
      expect(rule, `full-width rule at ${columns}`).toBeUndefined()
    }
  })
})

describe('R4 limit and quota messages', () => {
  const messages = [
    "You've hit your limit · resets 10:30pm (Europe/London)",
    "You've hit your session limit · resets 7:10pm (Europe/Paris) · progress saved",
    '5-hour limit reached ∙ resets 2pm',
    'weekly limit reached, resets in 2 hours',
    'Rate limited, retrying.',
    'Your quota is exhausted.',
    'API Error: Overloaded',
    'Usage will reset at 6pm.',
  ]
  for (const message of messages) {
    test(`stays stock: ${message} (mutant: classify limit vocabulary as dim)`, async ($, on) => {
      engineBeneath(on)
      await expectStock(await mountReply($, message), message)
    })
  }
})

describe('short assistant notes', () => {
  test('renders a 160-character one-line note as dim Markdown (mutant: remove dimColor)', async ($, on) => {
    engineBeneath(on)
    const text = 'a'.repeat(160)
    const reply = await mountReply($, text)
    await expectDimNote(reply, text)
    const added = ornaments(await reply.drawn(), undefined).added
    expect(added).toContain(NATIVE_ASSISTANT_BULLET)
    expect(added.some(line => line.startsWith('❯') || isSpinnerRow(line))).toBe(false)
  })

  test('frames a 161-character note (mutant: move the 160-character limit)', async ($, on) => {
    engineBeneath(on)
    const text = 'a'.repeat(161)
    await framedAssistant(await mountReply($, text), text)
  })

  test('frames a two-line note (mutant: allow more than one line)', async ($, on) => {
    engineBeneath(on)
    const text = 'First line.\nSecond line.'
    await framedAssistant(await mountReply($, text), text)
  })

  const adversarialNotes = [
    'Thinking… (12s · thinking)',
    'Thinking… ↓ 17 tokens',
    'Thinking… · thinking)',
    '**Thinking**… (12s · work)',
  ] as const
  for (const text of adversarialNotes) {
    test(`renders ${text} dim`, async ($, on) => {
      engineBeneath(on)
      await expectDimNote(await mountReply($, text), text)
    })
  }

  const refusedCharacters: Array<[string, string]> = [
    ['ESC', '\u001b[31m'],
    ['BEL', '\u0007'],
    ['BS', '\u0008'],
    ['VT', '\u000b'],
    ['FF', '\u000c'],
    ['DEL', '\u007f'],
    ['C1 NEL', '\u0085'],
    ['NUL', '\u0000'],
    ['isolated surrogate', '\ud800'],
    ['U+10EEEE', String.fromCodePoint(0x10eeee)],
    ['U+2800 with a combining mark', '⠀̅'],
  ]
  const keptCharacters: Array<[string, string]> = [
    ['TAB', '\t'],
    ['CR', '\r'],
    ['NBSP', ' '],
    ['ZWJ', '‍'],
    ['U+2028', ' '],
    ['emoji', '🙂'],
    ['bare U+2800', '⠀'],
  ]

  // Called directly: a mounted tree the harness refuses is skipped and redrawn by the engine, which
  // reads as a native render even when the plugin returned the refused tree.
  // trim() removes a leading or trailing VT or FF, so the edges are where a guard on trimmed text misses.
  const placed = (character: string): Array<[string, string]> => [
    ['inside', `Build ${character} done.`],
    ['first', `${character}Build done.`],
    ['last', `Build done.${character}`],
  ]

  test('a short note holding a refused character delegates to the native render (mutant: drop the renderable-text guard, or guard the trimmed text)', async () => {
    const renders = recordRenderHooks()
    for (const [label, character] of refusedCharacters) {
      for (const [where, text] of placed(character)) {
        const event = { surface: 'terminal', viewport: VIEWPORT, props: { text } }
        const delegated: unknown[] = []
        await renders.AssistantMessage!(RECORDING_ENGINE, event, async input => {
          delegated.push(input)
          return input
        })
        expect(delegated, `${label} ${where} reaches next unchanged`).toEqual([event])
      }
    }
  })

  for (const [label, character] of keptCharacters) {
    test(`a short note holding ${label} stays dim`, async ($, on) => {
      engineBeneath(on)
      const text = `Build ${character} done.`
      await expectDimNote(await mountReply($, text), text)
    })
  }

  test('isRenderableText follows the engine check on Text and Markdown strings', () => {
    for (const [label, character] of refusedCharacters) {
      expect(isRenderableText(`a${character}b`), `${label} refused`).toBe(false)
    }
    for (const [label, character] of [...keptCharacters, ['LF', '\n'] as [string, string]]) {
      expect(isRenderableText(`a${character}b`), `${label} kept`).toBe(true)
    }
  })

  test('normalizes edge whitespace before classifying and rendering (mutant: render untrimmed text)', async ($, on) => {
    engineBeneath(on)
    const text = `  ${'a'.repeat(160)} \n`
    await expectDimNote(await mountReply($, text), 'a'.repeat(160))
  })
})

describe('R5 spinner cue', () => {
  test('the plugin adds no spinner glyph and no spinner-row cue', async ($, on) => {
    engineBeneath(on)
    for (const columns of WIDTHS) {
      const added = await framedOrnaments($, columns)
      expect(added.some(line => /[✢✳✶✻✽·]/.test(line)), `spinner glyph at ${columns}`).toBe(false)
      expect(
        added.find(isSpinnerRow),
        `spinner-row cue at ${columns} (busy detector: SPINNER_CUE_RE and a spinner head)`,
      ).toBeUndefined()
    }
  })

  test('a summary keeps the stock render (mutant: classify isSummary as dim)', async ($, on) => {
    engineBeneath(on)
    await expectStock(await mountReply($, 'Reading the config.', { isSummary: true }), 'summary')
  })
})

describe('R6 version', () => {
  const release = (base: string): SessionVersion => ({ version: base, base })
  const supported = ['2.1.303', '2.1.304', '2.1.1000', '2.2.0', '2.10.0', '3.0.0']
  const unsupported: Array<[string, SessionVersion]> = [
    ['absent base', { version: '2.1.303' }],
    ['-dev build', { version: '2.1.304-dev.20261020.t101500.sha1a2b3c4', base: '2.1.304-dev' }],
    ['release below the minimum', release('2.1.302')],
    ['shorter patch below the minimum', release('2.1.40')],
    ['older major', release('1.99.999')],
    ['two components', release('2.1')],
    ['four components', release('2.1.303.1')],
    ['leading zero', release('02.1.303')],
    ['empty base', release('')],
  ]
  for (const base of supported) {
    test(`frames on ${base}`, async ($, on) => {
      engineBeneath(on, release(base))
      await framedAssistant(await mountReply($, REPLY), REPLY)
      await expectFramed(await mountPrompt($, PROMPT), PROMPT, 'You')
      const rule = strings(await (await mountTurn($, { word: 'Baked', durationMs: 3000 })).drawn())
      expect(rule.some(line => line.includes(' Baked for 3s '))).toBe(true)
    })
  }
  for (const [label, version] of unsupported) {
    test(`stays stock on ${label}`, async ($, on) => {
      engineBeneath(on, version)
      await expectStock(await mountReply($, REPLY), label)
      await expectStock(await mountReply($, 'Reading the config.'), `${label} short note`)
      await expectStock(await mountPrompt($, PROMPT), label, 'engine-user')
      await expectStock(await mountTurn($, { word: 'Baked', durationMs: 3000 }), label, 'engine-turn')
    })
  }

  test('stays stock and logs to debug when session.version rejects', async ($, on) => {
    engineBeneath(on, 'reject')
    const sinks = captureLogSinks(on)
    await expectStock(await mountReply($, REPLY), 'version rejected')
    expect(sinks).toEqual(['debug'])
  })
})

describe('R7 malformed input', () => {
  test('stays stock when isSummary is not a boolean', async ($, on) => {
    engineBeneath(on)
    await expectStock(await mountReply($, REPLY, { isSummary: 'true' }), 'string isSummary')
  })

  test('stays stock when text is not a string, refused before any error', async ($, on) => {
    engineBeneath(on)
    const sinks = captureLogSinks(on)
    await expectStock(await mountReply($, 7), 'numeric text')
    await expectStock(await mountPrompt($, 7), 'numeric prompt', 'engine-user')
    expect(sinks).toEqual([])
  })

  test('stays stock when the text is blank', async ($, on) => {
    engineBeneath(on)
    await expectStock(await mountReply($, '  \n '), 'blank reply')
    await expectStock(await mountPrompt($, '  '), 'blank prompt', 'engine-user')
  })

  test('stays stock and logs to debug when drawing the frame throws', async ($, on) => {
    engineBeneath(on)
    on('ui.resolve', async (_$, e, next) => ({
      ...(await next(e)),
      Box: function Box() {
        throw new Error('box unavailable')
      },
    }))
    const sinks = captureLogSinks(on)
    await expectStock(await mountReply($, REPLY), 'drawing threw')
    expect(sinks).toEqual(['debug'])
  })

  test('stays stock and logs to debug when drawing a short note throws (mutant: do not fall back to next)', async ($, on) => {
    engineBeneath(on)
    on('ui.resolve', async (_$, e, next) => ({
      ...(await next(e)),
      Markdown: function Markdown() {
        throw new Error('markdown unavailable')
      },
    }))
    const sinks = captureLogSinks(on)
    await expectStock(await mountReply($, 'Reading the config.'), 'short note drawing threw')
    expect(sinks).toEqual(['debug'])
  })

  test('stays stock below the minimum frame width', async ($, on) => {
    engineBeneath(on)
    const narrow = { columns: 39, rows: 24 }
    await expectStock(await mountReply($, REPLY, {}, narrow), '39 columns')
    await expectStock(await mountReply($, 'Reading the config.', {}, narrow), 'short note at 39 columns')
    await expectStock(await mountPrompt($, PROMPT, { kind: 'composer' }, narrow), '39 columns', 'engine-user')
    await expectStock(await mountTurn($, { word: 'Baked', durationMs: 3000 }, narrow), '39 columns', 'engine-turn')
  })

  test('stays stock on a surface other than the terminal', async ($, on) => {
    engineBeneath(on)
    await expectStock(await mountReply($, REPLY, {}, VIEWPORT, 'desktop'), 'desktop')
    await expectStock(await mountPrompt($, PROMPT, { kind: 'composer' }, VIEWPORT, 'desktop'), 'desktop', 'engine-user')
  })

  const badTurns: Array<[string, Record<string, unknown>]> = [
    ['an empty word', { word: ' ', durationMs: 3000 }],
    ['a word that is not a string', { word: 3, durationMs: 3000 }],
    ['a negative duration', { word: 'Baked', durationMs: -1 }],
    ['a duration that is not finite', { word: 'Baked', durationMs: Number.POSITIVE_INFINITY }],
    ['a duration that is not a number', { word: 'Baked', durationMs: '3000' }],
    ['a row that waits on agents', { word: 'Baked', durationMs: 3000, waitingFor: { agents: [], workflows: 1 } }],
    ['the expanded view', { word: 'Baked', durationMs: 3000, isExpanded: true }],
  ]
  for (const [label, props] of badTurns) {
    test(`a turn line with ${label} stays stock`, async ($, on) => {
      engineBeneath(on)
      await expectStock(await mountTurn($, props), label, 'engine-turn')
    })
  }
})

describe('R8 links', () => {
  test('the plugin creates no Link and passes the agent text through unchanged', async ($, on) => {
    engineBeneath(on)
    const text = `${'The build report retains its plain text references. '.repeat(4)}See [the docs](https://example.test/docs) and https://example.test/raw.`
    const ui = await mountReply($, text)
    await framedAssistant(ui, text)
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
  })
})

describe('R9 composition', () => {
  test('frames what the engine drew instead of redrawing the text', async ($, on) => {
    engineBeneath(on)
    const ui = await mountReply($, REPLY)
    await framedAssistant(ui, REPLY)
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  })

  test('keeps the rewrite of a hook beneath it', async ($, on) => {
    linkifierBeneath(on)
    engineBeneath(on)
    const text = `${'The documentation note is retained. '.repeat(6)}See a.md now.`
    const ui = await mountReply($, text)
    await framedAssistant(ui, text.replace('a.md', LINKED))
  })

  test('a short note draws its own dim Markdown without the lower rendering chain', async ($, on) => {
    linkifierBeneath(on)
    engineBeneath(on)
    const text = 'See a.md now.'
    await expectDimNote(await mountReply($, text), text)
  })

  test('asks the chain beneath for its drawing exactly once', async ($, on) => {
    let calls = 0
    on('ui.render', { component: 'AssistantMessage' }, (_$, e, next) => {
      calls += 1
      return next(e)
    })
    engineBeneath(on)
    await framedAssistant(await mountReply($, REPLY), REPLY)
    expect(calls).toBe(1)
  })

  test('keeps the rewrite of a hook above it, which reaches it in the props', async ($, on) => {
    engineBeneath(on)
    const text = `${'The documentation note is retained. '.repeat(6)}See ${LINKED} now.`
    const ui = await mountReply($, text)
    await framedAssistant(ui, text)
  })

  test('a summary reaches the hook beneath untouched', async ($, on) => {
    linkifierBeneath(on)
    engineBeneath(on)
    const ui = await mountReply($, 'See a.md', { isSummary: true })
    await expectStock(ui, 'summary')
    expect(await ui.find({ type: 'Text', text: LINKED })).toBeDefined()
  })
})

describe('R10 prompt frame', () => {
  test('frames a prompt typed at the composer under its label', async ($, on) => {
    engineBeneath(on)
    await expectFramed(await mountPrompt($, `  ${PROMPT}\n`), PROMPT, 'You')
  })

  test('a prompt holding a refused character delegates to the native render (mutant: drop the renderable-text guard, or guard the trimmed text)', async () => {
    const renders = recordRenderHooks()
    const edges = ['\u000b', '\u000c', '\u001b'].flatMap(character => [`${character}Run the build.`, `Run the build.${character}`])
    for (const prompt of ['Run \u001b[31m the build.', 'Run \u0007 the build.', 'Run \ud800 the build.', ...edges]) {
      const event = { surface: 'terminal', viewport: VIEWPORT, props: { text: prompt, origin: { kind: 'composer' } } }
      const delegated: unknown[] = []
      await renders.UserMessage!(RECORDING_ENGINE, event, async input => {
        delegated.push(input)
        return input
      })
      expect(delegated, `${JSON.stringify(prompt)} reaches next unchanged`).toEqual([event])
    }
  })

  test('a prompt holding a tab stays framed', async ($, on) => {
    engineBeneath(on)
    await expectFramed(await mountPrompt($, 'Run\tthe build.'), 'Run\tthe build.', 'You')
  })

  test('uses French labels when asked', { options: { labels: 'fr' } }, async ($, on) => {
    engineBeneath(on)
    await expectFramed(await mountPrompt($, PROMPT), PROMPT, 'Vous')
    await framedAssistant(await mountReply($, REPLY), REPLY, 'Claude')
  })

  test('an unknown labels value falls back to English', { options: { labels: 'xx' } }, async ($, on) => {
    engineBeneath(on)
    await expectFramed(await mountPrompt($, PROMPT), PROMPT, 'You')
  })

  test('uses configured frame labels and colors', {
    options: { user_label: 'Operator', user_color: 'success', assistant_color: '#1a2B3c' },
  }, async ($, on) => {
    engineBeneath(on)
    const prompt = await mountPrompt($, PROMPT)
    await expectFramed(prompt, PROMPT, 'Operator')
    expect(borderedBoxes(await prompt.drawn())[0]?.props?.borderColor).toBe('success')
    const reply = await mountReply($, REPLY)
    await framedAssistant(reply, REPLY)
    expect(borderedBoxes(await reply.drawn())[0]?.props?.borderColor).toBe('#1a2B3c')
  })

  test('sets 40-column title bounds and truncation props', {
    options: { user_label: '界'.repeat(20) },
  }, async ($, on) => {
    engineBeneath(on)
    const title = nodesOfType(await (await mountPrompt($, PROMPT, undefined, { columns: 40, rows: 24 })).drawn(), 'Box')
      .find(node => node.props?.position === 'absolute')
    expect(title?.props).toMatchObject({ top: 0, left: 2, right: 2 })
    expect(nodesOfType(title, 'Text')[0]?.props).toMatchObject({ wrap: 'truncate-end' })
  })

  test('validates configured labels and colors', () => {
    expect(resolveFrameConfiguration({
      labels: 'fr',
      user_label: '😀'.repeat(20),
      user_color: 'permission',
      assistant_color: '#1a2B3c',
    })).toEqual({
      userLabel: '😀'.repeat(20),
      assistantLabel: 'Claude',
      userColor: 'permission',
      assistantColor: '#1a2B3c',
      toolResults: 'summary',
    })
    expect(resolveFrameConfiguration({ labels: 'fr' })).toMatchObject({ userLabel: 'Vous' })
    expect(resolveFrameConfiguration({ labels: 'fr', user_label: '' })).toMatchObject({ userLabel: 'Vous' })
    expect(resolveFrameConfiguration({
      labels: 'fr',
      user_label: `${'x'.repeat(20)}x`,
      user_color: 'chartreuse',
      assistant_color: '#abc',
    })).toEqual({
      userLabel: 'Vous',
      assistantLabel: 'Claude',
      userColor: 'suggestion',
      assistantColor: 'claude',
      toolResults: 'summary',
    })
    for (const control of [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ]) {
      const userLabel = `abc${String.fromCodePoint(control)}txt`
      expect(resolveFrameConfiguration({ labels: 'fr', user_label: userLabel })).toMatchObject({ userLabel: 'Vous' })
    }
    for (const userLabel of [
      `Operator${String.fromCodePoint(0x001b)}[31m`,
      `abc${String.fromCodePoint(0xd800)}txt`,
    ]) {
      expect(resolveFrameConfiguration({ labels: 'fr', user_label: userLabel })).toMatchObject({ userLabel: 'Vous' })
    }
  })

  test('accepts every supported theme key and rejects other color forms', () => {
    for (const color of Object.keys(SUPPORTED_THEME_KEYS)) {
      expect(resolveFrameConfiguration({ user_color: color, assistant_color: color })).toMatchObject({
        userColor: color,
        assistantColor: color,
      })
    }
    for (const color of [
      '', 'chartreuse', ' red', 'red ', 'Success', 'constructor', '__proto__', 'toString',
      '#abc', '#12345g', '#1234567', ' #123456', '#123456 ',
    ]) {
      expect(resolveFrameConfiguration({ user_color: color, assistant_color: color })).toMatchObject({
        userColor: 'suggestion',
        assistantColor: 'claude',
      })
    }
  })

  const COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta', 'pink', 'gray', 'grey', 'white', 'black']

  test('resolves an English color name in any case to its hex value (mutant: drop the name table)', () => {
    expect(Object.keys(NAMED_COLORS).sort()).toEqual([...COLOR_NAMES].sort())
    for (const name of COLOR_NAMES) {
      const hex = NAMED_COLORS[name as keyof typeof NAMED_COLORS]
      expect(hex, `${name} is a #rrggbb`).toMatch(/^#[0-9a-f]{6}$/)
      for (const spelled of [name, name.toUpperCase(), `${name[0]!.toUpperCase()}${name.slice(1)}`]) {
        expect(resolveFrameConfiguration({ user_color: spelled, assistant_color: spelled }), spelled).toMatchObject({
          userColor: hex,
          assistantColor: hex,
        })
      }
    }
    expect(NAMED_COLORS.gray).toBe(NAMED_COLORS.grey)
  })

  test('draws a frame in a named color', { options: { user_color: 'Blue', assistant_color: 'orange' } }, async ($, on) => {
    engineBeneath(on)
    expect(borderedBoxes(await (await mountPrompt($, PROMPT)).drawn())[0]?.props?.borderColor).toBe(NAMED_COLORS.blue)
    expect(borderedBoxes(await (await mountReply($, REPLY)).drawn())[0]?.props?.borderColor).toBe(NAMED_COLORS.orange)
  })

  test('reads each configured option once while rendering multiple frames', async () => {
    const optionReads = { labels: 0, userLabel: 0, userColor: 0, assistantColor: 0, toolResults: 0 }
    const renders: Record<string, (engine: Engine, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>> = {}
    const countedOptions = {
      get labels() { optionReads.labels += 1; return 'fr' },
      get user_label() { optionReads.userLabel += 1; return 'Operator' },
      get user_color() { optionReads.userColor += 1; return 'success' },
      get assistant_color() { optionReads.assistantColor += 1; return 'permission' },
      get tool_results() { optionReads.toolResults += 1; return 'summary' },
    }
    const recordingOn = ((event: string, matcher: { component?: string }, handler: (engine: Engine, input: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>) => {
      if (event === 'ui.render' && matcher.component) renders[matcher.component] = handler
    }) as unknown as On
    register(recordingOn, countedOptions as never)
    expect(renders.UserMessage, 'user render hook registered').toBeDefined()
    expect(renders.AssistantMessage, 'assistant render hook registered').toBeDefined()
    const engine = {
      session: { version: async () => CERTIFIED },
      ui: { resolve: () => ({ Box: 'Box', Text: 'Text' }), log: () => undefined },
    } as unknown as Engine
    const next = async (event: unknown): Promise<unknown> => event
    const userEvent = { surface: 'terminal', viewport: VIEWPORT, props: { text: PROMPT, origin: { kind: 'composer' } } }
    const assistantEvent = { surface: 'terminal', viewport: VIEWPORT, props: { text: REPLY } }
    await renders.UserMessage!(engine, userEvent, next)
    await renders.UserMessage!(engine, userEvent, next)
    await renders.AssistantMessage!(engine, assistantEvent, next)
    await renders.AssistantMessage!(engine, assistantEvent, next)
    expect(optionReads).toEqual({ labels: 1, userLabel: 1, userColor: 1, assistantColor: 1, toolResults: 1 })
  })

  const origins: Array<[string, unknown]> = [
    ['a task notification', { kind: 'task-notification' }],
    ['a bridge client', { kind: 'bridge' }],
    ['an sdk host', { kind: 'sdk' }],
    ['an unclassified message', { kind: 'unclassified' }],
    ['a missing origin', null],
    ['an origin that is not an object', 'composer'],
  ]
  for (const [label, origin] of origins) {
    test(`a prompt from ${label} stays stock`, async ($, on) => {
      engineBeneath(on)
      await expectStock(await mountPrompt($, PROMPT, origin), label, 'engine-user')
    })
  }
})

describe('R12 tool headers', () => {
  test('redraws a closed Bash header with a native green bullet and dim detail', async ($, on) => {
    engineBeneath(on)
    const tree = await (await mountTool($, { input: { command: 'echo contract' } })).drawn()
    expect(strings(tree), 'Bash header').toContain('● ')
    const bullet = nodesOfType(tree, 'Text').find(node => strings(node).includes('● '))
    expect(bullet?.props, 'native green Bash bullet (mutant: gray bullet)').toMatchObject({ color: 'success' })
    expect(strings(tree).join(''), 'Bash detail').toContain('Bash(echo contract)')
    const detail = nodesOfType(tree, 'Text').find(node => node.props?.dimColor === true)
    expect(detail?.props, 'dim Bash detail').toMatchObject({ dimColor: true })
  })

  test('keeps the native blank row above a redrawn Bash header', async ($, on) => {
    engineBeneath(on)
    const header = nodesOfType(await (await mountTool($, { input: { command: 'echo contract' } })).drawn(), 'Box').find(
      node => node.props?.marginTop === 1,
    )
    expect(header?.props, 'native blank row for Bash').toMatchObject({ marginTop: 1 })
  })

  const fileHeader = async ($: Engine, tool: string, file_path: string, viewport = VIEWPORT): Promise<string[]> =>
    strings(await (await mountTool($, { tool, input: { file_path } }, viewport)).drawn())

  test('redraws a closed Edit or Write header with the path relative to the session directory', async ($, on) => {
    engineBeneath(on)
    const cases: Array<[string, string, string]> = [
      ['Edit', 'C:/work/root.txt', 'Update(root.txt)'],
      ['Write', 'C:/work/root.txt', 'Write(root.txt)'],
      ['Edit', 'C:/work/src/sub/foo.txt', 'Update(src\\sub\\foo.txt)'],
      ['Write', 'C:\\work\\back\\slash.txt', 'Write(back\\slash.txt)'],
      ['Write', `C:/work/${'b'.repeat(36)}.txt`, `Write(${'b'.repeat(36)}.txt)`],
    ]
    for (const [tool, filePath, header] of cases) {
      const tree = await (await mountTool($, { tool, input: { file_path: filePath } })).drawn()
      expect(strings(tree).join(''), `${tool} ${filePath} (mutant: map Edit to Edit, or drop the separator rewrite)`).toContain(header)
      const bullet = nodesOfType(tree, 'Text').find(node => strings(node).includes('● '))
      expect(bullet?.props, `${tool} green bullet`).toMatchObject({ color: 'success' })
      const detail = nodesOfType(tree, 'Text').find(node => strings(node).includes(header))
      expect(detail?.props, `${tool} dim detail`).toMatchObject({ dimColor: true })
      expect(nodesOfType(tree, 'Box').find(node => node.props?.marginTop === 1), `${tool} native blank row`).toBeDefined()
    }
  })

  test('keeps the forward slash of a POSIX session directory', async ($, on) => {
    engineBeneath(on, CERTIFIED, '/home/user/proj/')
    expect((await fileHeader($, 'Write', '/home/user/proj/src/a.txt')).join('')).toContain('Write(src/a.txt)')
  })

  test('delegates an Edit or Write header the native renderer shows another way', async ($, on) => {
    engineBeneath(on)
    const delegated: Array<[string, string, string]> = [
      ['outside the session directory', 'Edit', 'C:/other/a.txt'],
      ['in a sibling sharing its prefix', 'Write', 'C:/work2/a.txt'],
      ['the session directory itself', 'Write', 'C:/work'],
      ['a parent segment', 'Write', 'C:/work/src/../a.txt'],
      ['a current segment', 'Write', 'C:/work/./a.txt'],
      ['an empty segment', 'Write', 'C:/work//a.txt'],
      ['a drive letter cased differently', 'Write', 'c:/work/a.txt'],
      ['a 41-character relative path', 'Write', `C:/work/${'c'.repeat(37)}.txt`],
      ['a non-ASCII path', 'Write', 'C:/work/é.txt'],
      ['a control character', 'Write', 'C:/work/a\u001b.txt'],
      ['the Update tool name', 'Update', 'C:/work/a.txt'],
    ]
    for (const [label, tool, filePath] of delegated) {
      expect(await fileHeader($, tool, filePath), `${label} (mutant: drop the under-directory, segment or 40-character check)`).toContain(`engine-tool: ${tool}`)
    }
    const narrow = { columns: 40, rows: 24 }
    expect(await fileHeader($, 'Write', `C:/work/${'d'.repeat(27)}.txt`, narrow), 'one row at 40 columns').toContain(`Write(${'d'.repeat(27)}.txt)`)
    expect(await fileHeader($, 'Write', `C:/work/${'d'.repeat(28)}.txt`, narrow), 'two rows at 40 columns (mutant: drop the one-row check)').toContain('engine-tool: Write')
  })

  test('delegates a file tool header and logs to debug when session.cwd rejects', async ($, on) => {
    engineBeneath(on, CERTIFIED, 'reject')
    const sinks = captureLogSinks(on)
    expect(await fileHeader($, 'Edit', 'C:/work/a.txt')).toContain('engine-tool: Edit')
    expect(sinks).toEqual(['debug'])
  })

  test('indents Bash header continuations by six columns', async ($, on) => {
    engineBeneath(on)
    const ui = await mountTool($, { input: { command: 'echo one two three four five six seven eight nine ten' } }, { columns: 40, rows: 24 })
    const continuation = nodesOfType(await ui.drawn(), 'Box').find(node => node.props?.paddingLeft !== undefined)
    expect(continuation?.props, 'Bash continuation (mutant: indent at 2)').toMatchObject({ paddingLeft: 6 })
  })

  test('reserves the bullet width before wrapping Bash at 80 columns', async ($, on) => {
    engineBeneath(on)
    const command = 'echo alpha > tool-header-filename-that-wraps-natively-at-forty-columns.txt'
    const ui = await mountTool($, { input: { command } }, { columns: 80, rows: 24 })
    const continuation = nodesOfType(await ui.drawn(), 'Box').find(node => node.props?.paddingLeft !== undefined)
    expect(continuation?.props, 'Bash continuation after its bullet').toMatchObject({ paddingLeft: 6 })
  })

  test('keeps unsupported tools and non-closed states native', async ($, on) => {
    engineBeneath(on)
    for (const props of [
      { tool: 'Read', input: { file_path: 'C:/work/read.txt' } },
      { isRunning: true },
      { isErrored: true },
      { isInterrupted: true },
      { isExpanded: true },
      { isRunning: true, isErrored: true },
    ]) {
      expect(strings(await (await mountTool($, props)).drawn()), `native ToolUse ${JSON.stringify(props)}`).toContain(
        `engine-tool: ${props.tool ?? 'Bash'}`,
      )
    }
  })

  test('delegates an expanded tool before reading the viewport width', async () => {
    const renders: Record<string, (engine: Engine, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>> = {}
    const recordingOn = ((event: string, matcher: { component?: string }, handler: (engine: Engine, input: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>) => {
      if (event === 'ui.render' && matcher.component) renders[matcher.component] = handler
    }) as unknown as On
    register(recordingOn, {} as never)
    const engine = {
      session: { version: async () => CERTIFIED },
      ui: { resolve: () => ({ Box: 'Box', Text: 'Text' }), log: () => undefined },
    } as unknown as Engine
    const event = {
      surface: 'terminal',
      viewport: { get columns(): never { throw new Error('viewport read') }, rows: 24 },
      props: { tool: 'Bash', input: { command: 'echo contract' }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: true },
    }
    let nextCalls = 0
    await renders.ToolUse!(engine, event, async input => {
      nextCalls += 1
      return input
    })
    expect(nextCalls, 'expanded ToolUse reaches next before reading width').toBe(1)
  })

  test('keeps unsafe arguments and near-miss tool names native', async ($, on) => {
    engineBeneath(on)
    for (const tool of ['bash', 'BashExtra', 'mcp__Bash']) {
      expect(strings(await (await mountTool($, { tool })).drawn()), `native tool ${tool}`).toContain(`engine-tool: ${tool}`)
    }
    const unsafeArguments: Array<[string, string]> = [
      ['empty', ''],
      ['quota row', "\n⎿ You've hit your limit"],
      ['escape', '\u001b'],
      ['isolated surrogate', '\ud800'],
      ['bidi control', '\u202e'],
      ['CJK', '漢'],
      ['emoji', '🙂'],
    ]
    for (const [label, value] of unsafeArguments) {
      expect(strings(await (await mountTool($, { input: { command: value } })).drawn()), `native Bash ${label}`).toContain(
        'engine-tool: Bash',
      )
    }
  })

  test('delegates Bash words that need a mid-word wrap', async () => {
    const renders: Record<string, (engine: Engine, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>> = {}
    const recordingOn = ((event: string, matcher: { component?: string }, handler: (engine: Engine, input: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>) => {
      if (event === 'ui.render' && matcher.component) renders[matcher.component] = handler
    }) as unknown as On
    register(recordingOn, {} as never)
    const engine = {
      session: { version: async () => CERTIFIED },
      ui: { resolve: () => ({ Box: 'Box', Text: 'Text' }), log: () => undefined },
    } as unknown as Engine
    let nextCalls = 0
    for (const [columns, length] of [[80, 100], [120, 150]] as Array<[number, number]>) {
      const event = {
        surface: 'terminal',
        viewport: { columns, rows: 24 },
        props: { tool: 'Bash', input: { command: `echo ${'a'.repeat(length)}` }, isRunning: false, isErrored: false, isInterrupted: false },
      }
      await renders.ToolUse!(engine, event, async input => {
        nextCalls += 1
        return input
      })
    }
    expect(nextCalls, 'Bash words requiring a mid-word wrap reach next').toBe(2)
  })

  test('delegates Bash commands over 300 UTF-16 code units after a single command read', async () => {
    const renders: Record<string, (engine: Engine, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>> = {}
    const recordingOn = ((event: string, matcher: { component?: string }, handler: (engine: Engine, input: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>) => {
      if (event === 'ui.render' && matcher.component) renders[matcher.component] = handler
    }) as unknown as On
    register(recordingOn, {} as never)
    const engine = {
      session: { version: async () => CERTIFIED },
      ui: { resolve: () => ({ Box: 'Box', Text: 'Text' }), log: () => undefined },
    } as unknown as Engine
    let reads = 0
    const input = Object.defineProperty({}, 'command', {
      get(): string {
        reads += 1
        if (reads > 1) throw new Error('command read twice')
        return `echo ${'a'.repeat(301)}`
      },
    })
    let nextCalls = 0
    const event = {
      surface: 'terminal',
      viewport: { columns: 120, rows: 24 },
      props: { tool: 'Bash', input, isRunning: false, isErrored: false, isInterrupted: false },
    }
    await renders.ToolUse!(engine, event, async input => {
      nextCalls += 1
      return input
    })
    expect(nextCalls, 'Bash command over 300 UTF-16 code units reaches next once').toBe(1)
    expect(reads, 'Bash command was read once').toBe(1)
  })

  const nativeHeaders: Array<[string, Record<string, unknown>, string, string]> = [
    ['Skill', { skill: 'probe-skill', args: 'alpha beta' }, 'Skill(probe-skill)', 'show the skill args'],
    ['WebFetch', { url: 'https://example.com/page', prompt: 'Summarize the page' }, 'Fetch(https://example.com/page)', 'title it WebFetch'],
    ['WebSearch', { query: 'prosopon probe query', allowed_domains: ['example.com'] }, 'Web Search("prosopon probe query")', 'drop the quotes'],
    ['Agent', { description: 'Probe the agent row', prompt: 'say hi', subagent_type: 'general-purpose' }, 'Agent(Probe the agent row)', 'show the prompt'],
  ]
  for (const [tool, input, header, mutant] of nativeHeaders) {
    test(`redraws a closed ${tool} header as its native ${header}`, async ($, on) => {
      engineBeneath(on)
      const tree = await (await mountTool($, { tool, input })).drawn()
      expect([...new Set(strings(tree))], `${tool} header (mutant: drop ${tool} from the table, or ${mutant})`).toEqual(['● ', header])
      const bullet = nodesOfType(tree, 'Text').find(node => strings(node).includes('● '))
      expect(bullet?.props, `${tool} green bullet`).toMatchObject({ color: 'success' })
      const detail = nodesOfType(tree, 'Text').find(node => strings(node).includes(header))
      expect(detail?.props, `${tool} dim detail`).toMatchObject({ dimColor: true })
      expect(nodesOfType(tree, 'Box').find(node => node.props?.marginTop === 1), `${tool} native blank row`).toBeDefined()
    })
  }

  test('redraws an untyped Agent header as Agent(description)', async ($, on) => {
    engineBeneath(on)
    const drawn = strings(await (await mountTool($, { tool: 'Agent', input: { description: 'No type agent', prompt: 'say hi' } })).drawn())
    expect([...new Set(drawn)], 'untyped Agent (mutant: require subagent_type)').toEqual(['● ', 'Agent(No type agent)'])
  })

  test('keeps native the tools that draw no white header and a skill the native row renames', async ($, on) => {
    engineBeneath(on)
    const native: Array<[string, Record<string, unknown>]> = [
      ['TodoWrite', { todos: [{ content: 'Probe item', status: 'pending', activeForm: 'Probing item' }] }],
      ['ToolSearch', { query: 'select:mcp__probe__echo', max_results: 1 }],
      ['NotebookEdit', { notebook_path: 'C:/work/nb.ipynb', cell_id: 'c1', new_source: 'print(2)' }],
      ['mcp__probe__echo', { text: 'hello' }],
      ['Agent', { description: 'Explore the probe', prompt: 'say hi', subagent_type: 'Explore' }],
      ['Read', { file_path: 'C:/work/read.txt' }],
      ['Skill', { skill: '/probe-skill' }],
    ]
    for (const [tool, input] of native) {
      expect(strings(await (await mountTool($, { tool, input })).drawn()), `native ${tool} (mutant: add ${tool} to the table)`).toContain(`engine-tool: ${tool}`)
    }
  })

  test('wraps a Web Search header under its detail column as the native row does at 40 columns', async ($, on) => {
    engineBeneath(on)
    const query = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'
    const tree = await (await mountTool($, { tool: 'WebSearch', input: { query } }, { columns: 40, rows: 24 })).drawn()
    expect([...new Set(strings(tree))], 'native 40-column Web Search rows (mutant: wrap the title with the detail)').toEqual([
      '● ',
      'Web Search("one two three four five',
      'six seven eight nine ten\neleven twelve thirteen\nfourteen fifteen")',
    ])
    const continuation = nodesOfType(tree, 'Box').find(node => node.props?.paddingLeft !== undefined)
    expect(continuation?.props, 'Web Search continuation under its detail (mutant: indent at 6)').toMatchObject({ paddingLeft: 12 })
  })

  test('delegates a titled header whose detail needs a mid-word wrap', async ($, on) => {
    engineBeneath(on)
    const narrow = { columns: 40, rows: 24 }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Skill', { skill: 'probe-skill-with-a-rather-long-name-for-wrapping' }],
      ['WebSearch', { query: 'a'.repeat(40) }],
      ['WebFetch', { url: `https://example.com/${'p'.repeat(40)}` }],
    ]
    for (const [tool, input] of cases) {
      expect(strings(await (await mountTool($, { tool, input }, narrow)).drawn()), `${tool} mid-word wrap (mutant: hard-break the word)`).toContain(`engine-tool: ${tool}`)
    }
  })

  test('keeps unsafe, empty or overlong arguments of every titled tool native', async ($, on) => {
    engineBeneath(on)
    const fields: Array<[string, string]> = [['Skill', 'skill'], ['WebFetch', 'url'], ['WebSearch', 'query'], ['Agent', 'description']]
    for (const [tool, field] of fields) {
      for (const [label, value] of [['empty', ''], ['escape', 'a\u001bb'], ['CJK', '漢'], ['newline', 'a\nb'], ['301 code units', 'a '.repeat(150) + 'a'], ['number', 7]] as Array<[string, unknown]>) {
        expect(strings(await (await mountTool($, { tool, input: { [field]: value } })).drawn()), `${tool} ${label} (mutant: drop the R12 check)`).toContain(`engine-tool: ${tool}`)
      }
    }
  })

  test('keeps DEL and C1 controls native in Bash and titled tool arguments', async () => {
    const hook = recordRenderHooks().ToolUse!
    const controls: Array<[string, string]> = [['DEL', String.fromCharCode(0x7f)], ['C1 next line', String.fromCharCode(0x85)]]
    const fields: Array<[string, string]> = [['Bash', 'command'], ['Skill', 'skill'], ['WebSearch', 'query']]
    for (const [label, control] of controls) {
      for (const [tool, field] of fields) {
        const drawn = await hook(RECORDING_ENGINE, {
          surface: 'terminal',
          viewport: VIEWPORT,
          props: { tool, input: { [field]: `a${control}b` }, isRunning: false, isErrored: false, isInterrupted: false },
        }, async () => 'native')
        expect(drawn, `${tool} ${label} (mutant: widen the printable ASCII range)`).toBe('native')
      }
    }
  })

  test('redraws an argument of exactly 300 code units', async ($, on) => {
    engineBeneath(on)
    const wide = { columns: 120, rows: 24 }
    const words = `${'abcd '.repeat(60).slice(0, 299)}z`
    expect(words.length, 'fixture length').toBe(300)
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['Bash', { command: `echo ${words.slice(5)}` }, 'Bash(echo '],
      ['WebSearch', { query: words }, 'Web Search("abcd'],
    ]
    for (const [tool, input, head] of cases) {
      const drawn = strings(await (await mountTool($, { tool, input }, wide)).drawn())
      expect(drawn.join('\n'), `${tool} 300 code units custom (mutant: bound at 299)`).toContain(head)
      expect(drawn, `${tool} 300 code units not delegated`).not.toContain(`engine-tool: ${tool}`)
    }
  })

  const throwingEngine = (sinks: unknown[]): Engine => ({
    session: { version: async () => CERTIFIED },
    ui: { resolve: () => ({ Box: 'Box', Text: 'Text' }), log: (_message: string, options: { to?: unknown }) => sinks.push(options?.to) },
  }) as unknown as Engine

  test('falls back to native and logs to debug when a titled tool input getter throws', async () => {
    const hook = recordRenderHooks().ToolUse!
    const hostile: Array<[string, Record<string, unknown>, string]> = [
      ['Skill', {}, 'skill'],
      ['Agent', { description: 'Probe' }, 'subagent_type'],
    ]
    for (const [tool, base, field] of hostile) {
      const sinks: unknown[] = []
      const input = Object.defineProperty({ ...base }, field, { get(): never { throw new Error('hostile getter') } })
      const drawn = await hook(throwingEngine(sinks), {
        surface: 'terminal',
        viewport: VIEWPORT,
        props: { tool, input, isRunning: false, isErrored: false, isInterrupted: false },
      }, async () => 'native')
      expect(drawn, `${tool}.${field} getter that throws reaches next (mutant: read the input outside the try)`).toBe('native')
      expect(sinks, `${tool}.${field} getter error logged to debug`).toEqual(['debug'])
    }
  })

  test('reads the agent type once', async () => {
    const hook = recordRenderHooks().ToolUse!
    let reads = 0
    const input = Object.defineProperty({ description: 'Probe' }, 'subagent_type', {
      get(): string {
        reads += 1
        return reads === 1 ? 'Explore' : 'general-purpose'
      },
    })
    const drawn = await hook(RECORDING_ENGINE, {
      surface: 'terminal',
      viewport: VIEWPORT,
      props: { tool: 'Agent', input, isRunning: false, isErrored: false, isInterrupted: false },
    }, async () => 'native')
    expect(drawn, 'an agent typed Explore on its first read stays native (mutant: read subagent_type twice)').toBe('native')
    expect(reads, 'subagent_type read once').toBe(1)
  })

  test('reads the shown field of every titled tool once', async () => {
    const hook = recordRenderHooks().ToolUse!
    const fields: Array<[string, string]> = [['Skill', 'skill'], ['WebFetch', 'url'], ['WebSearch', 'query'], ['Agent', 'description']]
    for (const [tool, field] of fields) {
      let reads = 0
      const input = Object.defineProperty({}, field, {
        get(): string {
          reads += 1
          if (reads > 1) throw new Error(`${field} read twice`)
          return 'probe'
        },
      })
      const drawn = await hook(RECORDING_ENGINE, {
        surface: 'terminal',
        viewport: VIEWPORT,
        props: { tool, input, isRunning: false, isErrored: false, isInterrupted: false },
      }, async () => 'native')
      expect(drawn, `${tool} custom header`).not.toBe('native')
      expect(reads, `${tool} ${field} read once (mutant: re-read the field to interpolate it)`).toBe(1)
    }
  })

  test('keeps five Bash header rows custom and delegates six', async ($, on) => {
    engineBeneath(on)
    const fiveRows = `echo ${'aaaaaaaaaa '.repeat(13).trimEnd()}`
    expect(
      strings(await (await mountTool($, { input: { command: fiveRows } }, { columns: 40, rows: 24 })).drawn()).join('\n'),
      'five-row Bash header',
    ).toContain('Bash(echo')
    const sixRows = `echo ${'aaaaaaaaaa '.repeat(16).trimEnd()}`
    expect(
      strings(await (await mountTool($, { input: { command: sixRows } }, { columns: 40, rows: 24 })).drawn()),
      'six-row Bash header',
    ).toContain('engine-tool: Bash')
  })

  test('redraws a closed tool with isExpanded absent', async ($, on) => {
    engineBeneath(on)
    expect(strings(await (await mountTool($, { isExpanded: undefined })).drawn())).toContain('Bash(echo contract)')
  })

  test('keeps diffs and groups native while compacting a closed Bash result', async ($, on) => {
    engineBeneath(on)
    expect(strings(await (await mountToolResult($)).drawn()).join('')).toContain('native result')
    expect(strings(await (await mountToolGroup($)).drawn())).toContain('engine-group: 0')
  })
})

describe('Tool result compaction', () => {
  test('summarizes successful Bash, Write, Edit, and Update results at every supported width', async ($, on) => {
    engineBeneath(on)
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['Bash', { output: { stdout: 'first line\nlast line' } }, 'last line'],
      ['Write', { output: { content: 'first line\nsecond line' } }, 'Wrote 2 lines'],
      ['Edit', { output: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '-old line', '+new line', '+next line'] }] } }, '+2 -1'],
      ['Update', { output: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' first', '-old line', '+new line', '+next line'] }] } }, '+2 -1'],
    ]
    for (const columns of WIDTHS) {
      for (const [tool, props, expected] of cases) {
        const tree = await (await mountToolResult($, { tool, ...props }, { columns, rows: 24 })).drawn()
        expect(strings(tree).join(''), `${tool} summary at ${columns} columns (mutant: delegate every successful targeted result)`).toContain(expected)
      }
    }
  })

  test('keeps malformed or overlarge Edit patches native', async () => {
    const patches = [
      {},
      { structuredPatch: [{ lines: ['+line', 1] }] },
      { structuredPatch: [{ lines: Array.from({ length: 10_001 }, () => '+line') }] },
    ]
    for (const output of patches) {
      const result = await toolResultHook({})(RECORDING_ENGINE, {
        surface: 'terminal', viewport: VIEWPORT, props: { tool: 'Edit', output, isErrored: false, isExpanded: false },
      }, async () => 'native')
      expect(result, 'malformed or overlarge patches delegate natively (mutant: accept malformed or unbounded patches)').toBe('native')
    }
  })

  test('keeps non-array Edit patch hunks native', async () => {
    for (const output of [
      { structuredPatch: ['+line'] },
      { structuredPatch: [{ lines: '+line' }] },
    ]) {
      const result = await toolResultHook({})(RECORDING_ENGINE, {
        surface: 'terminal', viewport: VIEWPORT, props: { tool: 'Edit', output, isErrored: false, isExpanded: false },
      }, async () => 'native')
      expect(result, 'non-array hunk or lines delegate natively (mutant: weaken Array.isArray(lines))').toBe('native')
    }
  })

  test('reads each structuredPatch field once before summarizing Edit', async () => {
    let patchReads = 0
    let lineReads = 0
    const hunk = Object.defineProperty({}, 'lines', {
      get(): string[] {
        lineReads += 1
        if (lineReads > 1) throw new Error('lines read more than once')
        return [' first', '-old line', '+new line', '+next line']
      },
    })
    const output = Object.defineProperty({}, 'structuredPatch', {
      get(): object[] {
        patchReads += 1
        if (patchReads > 1) throw new Error('structuredPatch read more than once')
        return [hunk]
      },
    })
    const result = await toolResultHook({})(RECORDING_ENGINE, {
      surface: 'terminal', viewport: VIEWPORT, props: { tool: 'Edit', output, isErrored: false, isExpanded: false },
    }, async () => 'native')
    expect(strings(result).join(''), 'structuredPatch output renders one Edit summary (mutant: ignore structuredPatch)').toContain('+2 -1')
    expect(patchReads, 'structuredPatch getter is read once (mutant: read structuredPatch twice)').toBe(1)
    expect(lineReads, 'hunk lines getter is read once (mutant: read hunk lines twice)').toBe(1)
  })

  test('uses Bash returnCodeInterpretation without inventing an exit code', async () => {
    const result = await toolResultHook({})(RECORDING_ENGINE, {
      surface: 'terminal', viewport: VIEWPORT, props: {
        tool: 'Bash',
        output: { stdout: 'ignored stdout', returnCodeInterpretation: 'No matches found' },
        isErrored: false,
        isExpanded: false,
      },
    }, async () => 'native')
    expect(strings(result).join(''), 'returnCodeInterpretation replaces stdout when present (mutant: omit returnCodeInterpretation)').toContain('No matches found')
    expect(strings(result).join(''), 'Bash summary omits fabricated exit status (mutant: default an absent exitCode to zero)').not.toContain('exit')
  })

  test('summarizes Bash stdout when returnCodeInterpretation is an empty string', async () => {
    const result = await toolResultHook({})(RECORDING_ENGINE, {
      surface: 'terminal', viewport: VIEWPORT, props: {
        tool: 'Bash',
        output: { stdout: 'first line\nlast line', returnCodeInterpretation: '' },
        isErrored: false,
        isExpanded: false,
      },
    }, async () => 'native')
    expect(strings(result).join(''), 'an empty returnCodeInterpretation falls back to the last stdout line (mutant: treat an empty returnCodeInterpretation as present)').toContain('last line')
  })

  test('sanitizes and bounds a Bash returnCodeInterpretation before drawing it', async () => {
    let interpretationReads = 0
    const ansi = `${String.fromCharCode(0x1b)}[31m`
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
      .map(code => String.fromCodePoint(code))
      .join('')
    const output = Object.defineProperty({}, 'returnCodeInterpretation', {
      get(): string {
        interpretationReads += 1
        if (interpretationReads > 1) throw new Error('returnCodeInterpretation read more than once')
        return `first\n${'a'.repeat(300)}${ansi}${bidi}`
      },
    })
    const result = await toolResultHook({})(RECORDING_ENGINE, {
      surface: 'terminal', viewport: VIEWPORT, props: { tool: 'Bash', output, isErrored: false, isExpanded: false },
    }, async () => 'native')
    const [rendered] = strings(result)
    const detail = rendered!.slice(2)
    expect(interpretationReads, 'Bash returnCodeInterpretation read once (mutant: read raw output twice)').toBe(1)
    expect(detail, 'Bash returnCodeInterpretation removes ANSI and bidi controls in its retained tail (mutant: remove printable ASCII filter)').toBe(`${'a'.repeat(50)}[31m`)
    expect(detail.length, 'Bash summary is bounded (mutant: remove summary length bound)').toBeLessThanOrEqual(80)
  })

  test('truncates a long Bash summary instead of wrapping it', async () => {
    const result = await toolResultHook({})(RECORDING_ENGINE, {
      surface: 'terminal', viewport: { columns: 40, rows: 24 }, props: {
        tool: 'Bash', output: { stdout: 'a'.repeat(60) }, isErrored: false, isExpanded: false,
      },
    }, async () => 'native')
    expect(result, 'Bash result text truncates at narrow widths (mutant: remove truncate-end wrap)').toMatchObject({
      children: [{ props: { wrap: 'truncate-end' } }],
    })
  })

  test('falls back to native rendering when a Bash result getter throws', async () => {
    let logs = 0
    const output = Object.defineProperty({}, 'stdout', {
      get(): string {
        throw new Error('stdout getter failed')
      },
    })
    const engine = { ...RECORDING_ENGINE, ui: { ...RECORDING_ENGINE.ui, log: () => { logs += 1 } } }
    const result = await toolResultHook({})(engine, {
      surface: 'terminal', viewport: VIEWPORT, props: { tool: 'Bash', output, isErrored: false, isExpanded: false },
    }, async () => 'native')
    expect(result, 'throwing result data falls back to native rendering (mutant: build summary outside try)').toBe('native')
    expect(logs, 'throwing result data reaches debug logging (mutant: omit stockAfter)').toBe(1)
  })

  test('uses header or full tool_results modes without changing native fallback branches', async () => {
    const headerEvent = {
      surface: 'terminal', viewport: VIEWPORT, props: { tool: 'Bash', output: { stdout: 'native' }, isErrored: false, isExpanded: false },
    }
    const header = await toolResultHook({ tool_results: 'header' })(RECORDING_ENGINE, headerEvent, async () => 'native')
    expect(strings(header), 'header mode omits the result detail (mutant: render a summary in header mode)').toEqual([])

    for (const [label, options, surface, viewport, props] of [
      ['full mode', { tool_results: 'full' }, 'terminal', VIEWPORT, {}],
      ['expanded result', { tool_results: 'summary' }, 'terminal', VIEWPORT, { isExpanded: true }],
      ['unspecified expansion', { tool_results: 'summary' }, 'terminal', VIEWPORT, { isExpanded: undefined }],
      ['error result', { tool_results: 'summary' }, 'terminal', VIEWPORT, { isErrored: true }],
      ['remote surface', { tool_results: 'summary' }, 'desktop', VIEWPORT, {}],
      ['narrow terminal', { tool_results: 'summary' }, 'terminal', { columns: 39, rows: 24 }, {}],
      ['other header tool', { tool_results: 'header' }, 'terminal', VIEWPORT, { tool: 'Read' }],
    ] as Array<[string, Record<string, unknown>, string, RenderViewport, Record<string, unknown>]>) {
      const event = {
        surface, viewport, props: { tool: 'Bash', output: { stdout: 'native' }, isErrored: false, isExpanded: false, ...props },
      }
      const result = await toolResultHook(options)(RECORDING_ENGINE, event, async () => 'native')
      expect(result, `${label} delegates to native rendering (mutant: compact an excluded result)`).toBe('native')
    }
  })

  test('uses summary for absent or invalid tool_results values', async ($, on) => {
    engineBeneath(on)
    for (const tool_results of [undefined, 'unexpected']) {
      const result = await toolResultHook({ tool_results })(RECORDING_ENGINE, {
        surface: 'terminal', viewport: VIEWPORT, props: { tool: 'Bash', output: { stdout: 'last line' }, isErrored: false, isExpanded: false },
      }, async () => 'native')
      expect(strings(result).join(''), `${String(tool_results)} falls back to summary (mutant: use invalid configuration as full)`).toContain('last line')
    }
  })
})

describe('R11 turn rule', () => {
  const rulesAt = async ($: Engine, columns: number, props: Record<string, unknown>): Promise<string[]> => {
    const ui = await mountTurn($, props, { columns, rows: 24 })
    expect(borderedBoxes(await ui.drawn()), 'a rule has no frame').toHaveLength(0)
    return strings(await ui.drawn())
  }

  test('is shorter than the terminal at every width and carries no spinner cue', async ($, on) => {
    engineBeneath(on)
    for (const columns of [40, 41, 80, 120, 400]) {
      for (const durationMs of [0, 999, 3000, 65_000, 3_600_000]) {
        const lines = await rulesAt($, columns, { word: 'Baked', durationMs })
        const rule = lines.find(line => line.includes('Baked'))
        expect(rule, `rule at ${columns} for ${durationMs}`).toBeDefined()
        expect(rule!.startsWith('──'), `the plugin drew the rule at ${columns}`).toBe(true)
        expect([...rule!].length, `width at ${columns}`).toBeLessThan(columns)
        expect([...rule!].length, `width at ${columns}`).toBeLessThanOrEqual(columns - 2)
        expect(isSpinnerRow(rule!), `spinner cue at ${columns}`).toBe(false)
        expect(/^\s*[✢✳✶✻✽]/.test(rule!), `spinner head at ${columns}`).toBe(false)
      }
    }
  })

  test('names the word and the duration', async ($, on) => {
    engineBeneath(on)
    const seconds = (await rulesAt($, 80, { word: 'Baked', durationMs: 3000 })).join('')
    expect(seconds).toContain(' Baked for 3s ')
    const minutes = (await rulesAt($, 80, { word: 'Baked', durationMs: 65_000 })).join('')
    expect(minutes).toContain(' Baked for 1m 5s ')
    const instant = (await rulesAt($, 80, { word: 'Baked', durationMs: 0 })).join('')
    expect(instant).toContain(' Baked for 1s ')
  })

  test('bounds a long word and collapses its spaces', async ($, on) => {
    engineBeneath(on)
    const lines = await rulesAt($, 80, { word: `  Brewed   ${'x'.repeat(60)}`, durationMs: 3000 })
    const rule = lines.find(line => line.includes('Brewed'))!
    expect(rule).toContain(' Brewed xxxxxxxxxxxxxxxx')
    expect(rule).not.toContain('  Brewed')
    expect([...rule].length).toBeLessThanOrEqual(78)
  })
})

const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input })
const said = (text: string) => ({ type: 'text', text })
const answer = (id: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError })
const assistant = (...content: unknown[]) => ({ role: 'assistant', content })
const user = (...content: unknown[]) => ({ role: 'user', content })
const CHANNEL_NOTE = '<channel source="claude-peers" from_peer_id="lead">Status?</channel>'

const runIds = (messages: unknown[], live?: string[]): string[][] => {
  const ids = live ?? messages.flatMap(message =>
    (message as { content: Array<{ type: string; id?: string }> }).content.flatMap(block => (block.type === 'tool_use' ? [block.id!] : [])),
  )
  const seen = new Set<unknown>()
  const runs: string[][] = []
  for (const run of computeRuns(messages, new Set(ids)).values()) {
    if (seen.has(run)) continue
    seen.add(run)
    runs.push(run.ids)
  }
  return runs
}

describe('R13 tool runs: computeRuns', () => {
  test('cuts a run at non-empty assistant text and at a prompt', () => {
    const messages = [
      user(said('Check the build.')),
      assistant(said('Looking.'), use('a1', 'Bash')),
      user(answer('a1')),
      assistant(use('a2', 'Read')),
      user(answer('a2')),
      assistant(said('Now the tests.'), use('b1', 'Bash')),
      user(answer('b1')),
      assistant(said('  '), use('b2', 'Grep')),
      user(answer('b2')),
      user(said('And the docs?')),
      assistant(use('c1', 'Read')),
      user(answer('c1')),
      assistant(use('c2', 'Read')),
    ]
    expect(runIds(messages), 'assistant text and a prompt cut, blank text does not (mutant: drop the text cut)').toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
      ['c1', 'c2'],
    ])
  })

  test('keeps parallel calls of one message and the thinking between calls in one run', () => {
    const messages = [
      assistant({ type: 'thinking', thinking: 'plan' }, use('p1', 'Read'), use('p2', 'Grep'), use('p3', 'Bash')),
      user(answer('p1'), answer('p2'), answer('p3')),
      assistant({ type: 'redacted_thinking', data: 'x' }, use('p4', 'Read')),
    ]
    expect(runIds(messages)).toEqual([['p1', 'p2', 'p3', 'p4']])
  })

  test('does not cut at a reminder or a peer message carried beside tool results', () => {
    const messages = [
      assistant(use('r1', 'Bash')),
      user(answer('r1'), said(CHANNEL_NOTE), said('<system-reminder>Todo list is empty.</system-reminder>')),
      assistant(use('r2', 'mcp__claude-peers__send_message')),
    ]
    expect(runIds(messages), 'a peer message does not cut a run (mutant: cut at any user text)').toEqual([['r1', 'r2']])
  })

  for (const subagent of ['Agent', 'Task']) {
    test(`cuts at a ${subagent} call, which never joins a run`, () => {
      const messages = [
        assistant(use('s1', 'Bash'), use('s2', 'Read')),
        user(answer('s1'), answer('s2')),
        assistant(use('agent', subagent, { description: 'Explore', prompt: 'go' })),
        user(answer('agent')),
        assistant(use('s3', 'Bash')),
        user(answer('s3')),
        assistant(use('s4', 'Edit')),
      ]
      expect(runIds(messages), `the ${subagent} call cuts and stays out (mutant: let ${subagent} join a run)`).toEqual([
        ['s1', 's2'],
        ['s3', 's4'],
      ])
    })
  }

  test('leaves out a call this process never saw appended, as a resumed history', () => {
    const messages = [
      assistant(use('h1', 'Bash')),
      user(answer('h1')),
      assistant(use('h2', 'Read')),
      user(answer('h2')),
      user(said('Continue.')),
      assistant(use('n1', 'Bash')),
      user(answer('n1')),
      assistant(use('n2', 'Bash')),
    ]
    expect(runIds(messages, ['n1', 'n2']), 'history stays out of every run (mutant: ignore the live set)').toEqual([['n1', 'n2']])
  })

  test('counts errored calls and names the first call without a result as running', () => {
    const messages = [
      assistant(use('e1', 'Bash'), use('e2', 'Read')),
      user(answer('e1', true), answer('e2')),
      assistant(use('e3', 'Bash'), use('e4', 'Grep')),
      user(answer('e4', true)),
    ]
    const run = computeRuns(messages, new Set(['e1', 'e2', 'e3', 'e4'])).get('e1')
    expect(run).toMatchObject({ ids: ['e1', 'e2', 'e3', 'e4'], errors: 2, running: 'Bash' })
  })

  test('drops a run holding a name that is not short printable ASCII, and reads nothing from a non-array', () => {
    for (const name of ['Bash\u0007', 'Ba\u00efsh', 'esc to interrupt', 'x'.repeat(65), '', 42]) {
      const messages = [assistant(use('u1', 'Bash'), { type: 'tool_use', id: 'u2', name, input: {} })]
      expect(computeRuns(messages, new Set(['u1', 'u2'])).size, `name ${String(name)} (mutant: admit a space, or 65 characters)`).toBe(0)
    }
    const longest = 'x'.repeat(64)
    const kept = computeRuns([assistant(use('u1', 'Bash'), use('u2', longest))], new Set(['u1', 'u2'])).get('u1')
    expect(kept?.names, 'a 64-character name joins its run (mutant: refuse 64 characters)').toEqual(['Bash', longest])
    expect(computeRuns({ messages: [] }, new Set()).size).toBe(0)
    expect(computeRuns(undefined, new Set()).size).toBe(0)
  })
})

describe('R13 tool runs: head summary', () => {
  const summaryOf = (names: string[], errors = 0, running?: string): string =>
    runSummary({ ids: names.map((_, index) => `id${index}`), names, errors, running })

  test('counts every call and names the most frequent tools first, MCP tools by server', () => {
    const names = ['Read', 'Bash', 'claude-peers', 'Bash', 'claude-peers', 'Bash']
    expect(summaryOf(names)).toBe('6 calls: Bash x3, claude-peers x2, Read')
    const run = computeRuns([assistant(use('m1', 'mcp__claude-peers__send_message'), use('m2', 'mcp__kleos__memory_search')), user(answer('m1'), answer('m2'))], new Set(['m1', 'm2'])).get('m1')!
    expect(runSummary(run), 'MCP names reduced to the server (mutant: keep the full name)').toBe('2 calls: claude-peers, kleos')
  })

  test(`shows at most ${MAX_RUN_NAMES} distinct names, then how many more`, () => {
    const names = ['Bash', 'Bash', 'Read', 'Grep', 'Edit', 'Write', 'Glob']
    expect(summaryOf(names), 'cap on distinct names (mutant: no cap)').toBe('7 calls: Bash x2, Read, Grep, Edit, +2 more')
  })

  test('never hides an error and names the running call', () => {
    expect(summaryOf(['Bash', 'Read'], 1)).toBe('2 calls: Bash, Read, 1 error')
    expect(summaryOf(['Bash', 'Read', 'Bash'], 2, 'Bash')).toBe('3 calls: Bash x2, Read, 2 errors · running Bash')
  })

  test('draws no spinner-row cue and no limit row a Koryphaios screen guard reads', () => {
    for (const line of [
      summaryOf(['Bash', 'Read'], 0, 'Bash'),
      summaryOf(['thinking)', 'Bash'], 1, 'thinking)'),
      summaryOf(['Thinking...', 'Read'], 0, 'Thinking...'),
    ]) {
      expect(readsAsBusy(line), line).toBe(false)
      expect(readsAsBusy(`● ${line}`), line).toBe(false)
      expect(line.startsWith('\u23bf'), line).toBe(false)
    }
  })
})

const RUNS_VERSION: SessionVersion = { version: '2.1.310', base: '2.1.310' }
const RUN_SESSION = [
  user(said('Run the checks.')),
  assistant(said('Looking.'), use('t1', 'Bash', { command: 'echo one' })),
  user(answer('t1')),
  assistant(use('t2', 'Read', { file_path: 'C:/work/a.txt' })),
  user(answer('t2', true)),
  assistant(use('t3', 'Bash', { command: 'echo three' })),
  user(answer('t3'), said(CHANNEL_NOTE)),
  assistant(said('One more.'), use('t4', 'Bash', { command: 'echo contract' })),
  user(answer('t4')),
  assistant(said('Done.')),
]

type RunHarness = { invalidated: Promise<void>; sinks: unknown[]; fetches: () => number }

function runSession(on: On, messages: unknown = RUN_SESSION, version: SessionVersion = RUNS_VERSION): RunHarness {
  engineBeneath(on, version)
  let fetches = 0
  on('session.messages', () => {
    fetches += 1
    return { value: messages as never }
  })
  let fire: () => void = () => undefined
  const invalidated = new Promise<void>(resolve => {
    fire = resolve
  })
  on('ui.invalidate', () => {
    fire()
    return { value: undefined }
  })
  return { invalidated, sinks: captureLogSinks(on), fetches: () => fetches }
}

async function appendResponses($: Engine, messages: unknown[]): Promise<void> {
  for (const [index, message] of messages.entries()) {
    const { role, content } = message as { role: string; content: unknown[] }
    if (role !== 'assistant') continue
    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content },
      door: 'response',
      origin: { kind: 'model', model: 'claude-test' },
      uuid: `row-${index}`,
    } as never)
  }
}

async function indexedRuns($: Engine, harness: RunHarness, appended: unknown[] = RUN_SESSION): Promise<void> {
  await appendResponses($, appended)
  await mountTool($, { tool_use_id: 'toolu_unrelated' })
  await harness.invalidated
}

const runTool = (id: string, tool: string, extra: Record<string, unknown> = {}) => ({
  tool_use_id: id,
  tool,
  input: tool === 'Bash' ? { command: `echo ${id}` } : { file_path: 'C:/work/a.txt' },
  ...extra,
})

describe('R13 tool runs: rendering', () => {
  test('draws the head call as one dim row with the native green bullet, and the followers as nothing', async ($, on) => {
    const harness = runSession(on)
    await indexedRuns($, harness)
    const head = await (await mountTool($, runTool('t1', 'Bash'))).drawn()
    expect([...new Set(strings(head))], 'head row').toEqual(['● ', '3 calls: Bash x2, Read, 1 error'])
    expect(nodesOfType(head, 'Text').find(node => strings(node).includes('● '))?.props).toMatchObject({ color: 'success' })
    expect(nodesOfType(head, 'Text').find(node => node.props?.dimColor === true)?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
    expect(nodesOfType(head, 'Box').find(node => node.props?.marginTop === 1), 'native blank row').toBeDefined()
    expect(strings(await (await mountTool($, runTool('t3', 'Bash'))).drawn()), 'follower row').toEqual([])
    expect(strings(await (await mountToolResult($, { tool_use_id: 't3', tool: 'Bash' })).drawn()), 'follower result').toEqual([])
    expect(strings(await (await mountToolResult($, { tool_use_id: 't1', tool: 'Bash' })).drawn()), 'head result').toEqual([])
  })

  test('keeps a lone call native', async ($, on) => {
    const harness = runSession(on)
    await indexedRuns($, harness)
    const lone = await (await mountTool($, { tool_use_id: 't4', tool: 'Bash', input: { command: 'echo contract' } })).drawn()
    expect(strings(lone).join(''), 'a run of one keeps the R12 header').toContain('Bash(echo contract)')
  })

  test('keeps the native rows of an errored or interrupted call, under the head when it is the head', async ($, on) => {
    const harness = runSession(on)
    await indexedRuns($, harness)
    const failed = await mountTool($, runTool('t2', 'Read', { isErrored: true }))
    await expectStock(failed as unknown as Drawn, 'errored follower (mutant: hide a failed follower)', 'engine-tool: Read')
    const cut = await mountTool($, runTool('t3', 'Bash', { isInterrupted: true }))
    await expectStock(cut as unknown as Drawn, 'interrupted follower', 'engine-tool: Bash')
    const result = await mountToolResult($, { tool_use_id: 't2', tool: 'Read', isErrored: true })
    await expectStock(result as unknown as Drawn, 'errored result (mutant: hide an errored result)', 'engine-result: Read')
    const head = strings(await (await mountTool($, runTool('t1', 'Bash', { isErrored: true }))).drawn())
    expect(head, 'failed head keeps its native row').toContain('engine-tool: Bash')
    expect(head, 'failed head still draws the summary').toContain('3 calls: Bash x2, Read, 1 error')
  })

  test('passes every expanded row to the engine', async ($, on) => {
    const harness = runSession(on)
    await indexedRuns($, harness)
    await expectStock((await mountTool($, runTool('t1', 'Bash', { isExpanded: true }))) as unknown as Drawn, 'expanded head (mutant: drop the isExpanded passthrough)', 'engine-tool: Bash')
    await expectStock((await mountTool($, runTool('t3', 'Bash', { isExpanded: true }))) as unknown as Drawn, 'expanded follower', 'engine-tool: Bash')
    await expectStock((await mountToolResult($, { tool_use_id: 't3', isExpanded: true })) as unknown as Drawn, 'expanded result', 'engine-result: Bash')
    const group = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolGroup',
      props: { calls: [{ tool_use_id: 't1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false }], isActive: false, isExpanded: true, isCallsOnly: true },
      viewport: VIEWPORT,
    } as never)
    await expectStock(group as unknown as Drawn, 'expanded group', 'engine-group: 1')
  })

  test('draws a calls-only group as the head or as nothing, and keeps any other group line', async ($, on) => {
    const harness = runSession(on)
    await indexedRuns($, harness)
    const group = (first: string, isCallsOnly: boolean) =>
      $.ui.mount({
        plugin: PLUGIN,
        surface: 'terminal',
        component: 'ToolGroup',
        props: { calls: [{ tool_use_id: first, tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false }], isActive: false, isExpanded: false, isCallsOnly },
        viewport: VIEWPORT,
      } as never)
    expect([...new Set(strings(await (await group('t1', true)).drawn()))], 'calls-only head group').toEqual(['● ', '3 calls: Bash x2, Read, 1 error'])
    expect(strings(await (await group('t2', true)).drawn()), 'calls-only follower group').toEqual([])
    await expectStock((await group('t2', false)) as unknown as Drawn, 'a group holding more than calls (mutant: drop the isCallsOnly guard)', 'engine-group: 1')
    const head = strings(await (await group('t1', false)).drawn())
    expect(head, 'a head group holding more than calls keeps its line').toContain('engine-group: 1')
    expect(head, 'and draws the head above it').toContain('3 calls: Bash x2, Read, 1 error')
  })

  test('draws a call native until the index holds it, then asks for one redraw per change', async ($, on) => {
    const harness = runSession(on)
    await appendResponses($, RUN_SESSION)
    const [before] = await Promise.all([mountTool($, runTool('t3', 'Bash')), mountTool($, runTool('t1', 'Bash'))])
    expect(strings(await before.drawn()).join(''), 'no index yet: the R12 header').toContain('Bash(echo t3)')
    await harness.invalidated
    expect(strings(await (await mountTool($, runTool('t3', 'Bash'))).drawn()), 'indexed follower').toEqual([])
    await mountTool($, runTool('t1', 'Bash'))
    expect(harness.fetches(), 'one fetch per generation, none while one is pending (mutant: fetch on every render)').toBe(1)
  })

  test('keeps a resumed history native: only calls appended in this process are grouped', async ($, on) => {
    const resumed = [
      ...RUN_SESSION,
      user(said('Continue.')),
      assistant(use('n1', 'Bash', { command: 'echo n1' })),
      user(answer('n1')),
      assistant(use('n2', 'Read')),
      user(answer('n2')),
    ]
    const harness = runSession(on, resumed)
    await indexedRuns($, harness, resumed.slice(RUN_SESSION.length))
    const history = await mountTool($, runTool('t3', 'Bash'))
    expect(strings(await history.drawn()).join(''), 'history follower (mutant: group calls never appended)').toContain('Bash(echo t3)')
    expect([...new Set(strings(await (await mountTool($, runTool('n1', 'Bash'))).drawn()))], 'a call after the resume').toEqual(['● ', '2 calls: Bash, Read'])
  })

  test('stays native below 2.1.310 and when the index cannot be read', async ($, on) => {
    const harness = runSession(on, RUN_SESSION, { version: '2.1.309', base: '2.1.309' })
    await appendResponses($, RUN_SESSION)
    await mountTool($, { tool_use_id: 'toolu_unrelated' })
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    expect(strings(await (await mountTool($, runTool('t3', 'Bash'))).drawn()).join(''), '2.1.309 (mutant: runs at 2.1.303)').toContain('Bash(echo t3)')
    expect(harness.fetches(), 'no transcript read on an unsupported version').toBe(0)
  })

  test('falls back to native and logs to debug when the transcript cannot be read', async ($, on) => {
    engineBeneath(on, RUNS_VERSION)
    on('session.messages', () => {
      throw new Error('transcript unavailable')
    })
    const harness = { sinks: captureLogSinks(on) }
    await appendResponses($, RUN_SESSION)
    await mountTool($, { tool_use_id: 'toolu_unrelated' })
    for (let turn = 0; turn < 50 && !harness.sinks.includes('debug'); turn += 1) await Promise.resolve()
    expect(harness.sinks, 'the failure is traced in debug').toContain('debug')
    expect(strings(await (await mountTool($, runTool('t3', 'Bash'))).drawn()).join('')).toContain('Bash(echo t3)')
  })
})

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void }

function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => undefined
  const promise = new Promise<unknown>(done => {
    resolve = done
  })
  return { promise, resolve }
}

// A stub engine, because the testing kit's ui.resolve never throws and the order in which two
// transcript reads resolve has to be chosen by the test.
function directRuns() {
  const hooks: Record<string, RenderHook> = {}
  const recordingOn = ((event: string, matcher: unknown, handler?: unknown) => {
    const component = (matcher as { component?: string } | undefined)?.component
    hooks[event === 'ui.render' && component ? component : event] = (typeof matcher === 'function' ? matcher : handler) as RenderHook
  }) as unknown as On
  register(recordingOn, {} as never)
  const stub = {
    messages: [] as unknown[],
    pending: [] as Deferred[],
    fetches: 0,
    invalidations: 0,
    invalidateThrows: false,
    resolveThrows: false,
    resolveCalls: 0,
    resolveFailsOn: 0,
    sinks: [] as unknown[],
  }
  const engine = {
    session: {
      version: async () => RUNS_VERSION,
      cwd: async () => SESSION_CWD,
      messages: async () => {
        stub.fetches += 1
        const waiting = stub.pending.shift()
        return waiting === undefined ? stub.messages : waiting.promise
      },
    },
    ui: {
      resolve: () => {
        stub.resolveCalls += 1
        if (stub.resolveThrows || stub.resolveCalls === stub.resolveFailsOn) throw new Error('resolver unavailable')
        return { Box: 'Box', Markdown: 'Markdown', Text: 'Text' }
      },
      log: (_text: string, options: { to?: unknown }) => {
        stub.sinks.push(options.to)
      },
      invalidate: () => {
        if (stub.invalidateThrows) throw new Error('invalidate refused')
        stub.invalidations += 1
      },
    },
  } as unknown as Engine
  const native = async () => 'native'
  const append = async (content: unknown[], agentId?: string): Promise<void> => {
    await hooks['session.append']!(engine, { message: { type: 'assistant', role: 'assistant', content }, door: 'response', agentId }, async e => e)
  }
  const appendAll = async (messages: unknown[]): Promise<void> => {
    for (const message of messages) {
      const { role, content } = message as { role: string; content: unknown[] }
      if (role === 'assistant') await append(content)
    }
  }
  const render = (component: 'ToolUse' | 'ToolResult' | 'ToolGroup', props: Record<string, unknown>) =>
    hooks[component]!(
      engine,
      {
        surface: 'terminal',
        viewport: VIEWPORT,
        props: { isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false, output: { stdout: 'ok' }, ...props },
      },
      native,
    )
  const until = async (done: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 200 && !done(); turn += 1) await Promise.resolve()
    expect(done(), 'the stubbed engine settled').toBe(true)
  }
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
  }
  return { stub, append, appendAll, render, until, settle }
}

const AFTER_COMPACTION = [user(said('Summary of the earlier conversation.')), assistant(said('Compacted.'))]

describe('R13 tool runs: run index', () => {
  test('drops from the live set the calls a compaction removed from the transcript', async () => {
    const run = directRuns()
    run.stub.messages = RUN_SESSION
    await run.appendAll(RUN_SESSION)
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.invalidations === 1)
    expect(strings(await run.render('ToolUse', runTool('t1', 'Bash'))).join(''), 'indexed head').toContain('3 calls')

    run.stub.messages = AFTER_COMPACTION
    await run.append([said('Compacted.')])
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.invalidations === 2)

    const later = [user(said('Again.')), assistant(use('n1', 'Bash')), user(answer('n1')), assistant(use('n2', 'Bash')), user(answer('n2'))]
    run.stub.messages = [...RUN_SESSION, ...later]
    await run.appendAll(later)
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.invalidations === 3)
    const head = strings(await run.render('ToolUse', runTool('t1', 'Bash'))).join('')
    expect(head, 'a call compacted away is no longer live (mutant: never prune the live set)').not.toContain('3 calls')
    expect(head, 'it draws its R12 header').toContain('Bash(echo t1)')
    expect(strings(await run.render('ToolUse', runTool('n1', 'Bash'))).join(''), 'a call still present stays live').toContain('2 calls: Bash x2')
  })

  test('keeps the newer index when an older transcript read resolves last', async () => {
    const run = directRuns()
    const older = deferred()
    const newer = deferred()
    await run.appendAll(RUN_SESSION)
    run.stub.pending.push(older)
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.fetches === 1)
    await run.append([said('More.')])
    run.stub.pending.push(newer)
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.fetches === 2)
    newer.resolve(RUN_SESSION)
    await run.until(() => run.stub.invalidations === 1)
    older.resolve(RUN_SESSION.slice(0, 5))
    await run.settle()
    const head = strings(await run.render('ToolUse', runTool('t1', 'Bash'))).join('')
    expect(head, 'the newer generation stays drawn (mutant: let an older read overwrite the index)').toContain('3 calls: Bash x2, Read, 1 error')
  })

  test('ignores a subagent append: no new generation and no transcript read', async () => {
    const run = directRuns()
    run.stub.messages = RUN_SESSION
    await run.appendAll(RUN_SESSION)
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.invalidations === 1)
    await run.append([use('sub1', 'Bash')], 'agent-1')
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.settle()
    expect(run.stub.fetches, 'a subagent row is not the main conversation (mutant: count every append)').toBe(1)
  })

  test('falls back to native and logs to debug when drawing a head or a follower throws', async () => {
    const run = directRuns()
    run.stub.messages = RUN_SESSION
    await run.appendAll(RUN_SESSION)
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.invalidations === 1)
    run.stub.resolveThrows = true
    for (const [component, id] of [['ToolUse', 't1'], ['ToolUse', 't3'], ['ToolResult', 't3']] as const) {
      run.stub.sinks.length = 0
      expect(await run.render(component, runTool(id, 'Bash')), `${component} ${id} (mutant: rethrow from the run branch)`).toBe('native')
      expect(run.stub.sinks, `${component} ${id} traced`).toEqual(['debug'])
    }
    const group = (first: string) => ({
      calls: [{ tool_use_id: first, tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false }],
      isActive: false,
      isCallsOnly: true,
    })
    for (const id of ['t1', 't2']) {
      run.stub.sinks.length = 0
      expect(await run.render('ToolGroup', group(id)), `ToolGroup holding ${id} (mutant: rethrow from the ToolGroup run branch)`).toBe('native')
      expect(run.stub.sinks, `ToolGroup holding ${id} traced`).toEqual(['debug'])
    }
  })

  test('keeps the native row of a failed head when composing it under the head row throws', async () => {
    const run = directRuns()
    run.stub.messages = RUN_SESSION
    await run.appendAll(RUN_SESSION)
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.invalidations === 1)
    run.stub.sinks.length = 0
    run.stub.resolveCalls = 0
    run.stub.resolveFailsOn = 2
    const drawn = await run.render('ToolUse', runTool('t1', 'Bash', { isErrored: true }))
    expect(run.stub.resolveCalls, 'the head row resolved, the composition threw').toBe(2)
    expect(drawn, 'the native row survives (mutant: rethrow from composeBelow)').toBe('native')
    expect(run.stub.sinks, 'the composition failure is traced').toEqual(['debug'])
  })

  test('keeps the index and logs to debug when asking for a redraw throws', async () => {
    const run = directRuns()
    run.stub.messages = RUN_SESSION
    run.stub.invalidateThrows = true
    await run.appendAll(RUN_SESSION)
    await run.render('ToolUse', runTool('t1', 'Bash'))
    await run.until(() => run.stub.fetches === 1)
    await run.settle()
    expect(run.stub.sinks, 'the refused redraw is traced (mutant: rethrow from the invalidate catch)').toEqual(['debug'])
    expect(strings(await run.render('ToolUse', runTool('t1', 'Bash'))).join(''), 'the index stands').toContain('3 calls')
  })
})
