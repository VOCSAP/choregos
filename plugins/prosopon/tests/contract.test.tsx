import { describe, expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, RenderViewport, SessionVersion } from 'claude-code'

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
type Drawn = Reply | Prompt | Turn

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

function engineBeneath(on: On, version: SessionVersion | 'reject' = CERTIFIED): void {
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
  on('session.version', () =>
    version === 'reject' ? { deny: 'version unavailable' } : { value: version },
  )
}

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

// Spinner-row cue as Koryphaios detects it (SPINNER_CUE_RE with SPINNER_HEAD_RE,
// VERB_HEAD_RE or BARE_TIMER_RE in its busy detector), restated, not imported.
const SPINNER_CUE = /\((?:\d+m\s*)?\d+s\s*·|[↑↓]\s*\d[\d.,]*k?\s*tokens\b|·\s*thinking\)/i
const SPINNER_ROW_HEAD = [
  /^\s*(?:[✢✳✶✻✽]|[·*]\s*\p{L}+(?:…|\.\.\.))/u,
  /^\s*\p{Lu}\p{Ll}+(?:…|\.\.\.)/u,
  /^\s*\((?:\d+m\s*)?\d+s\s*·\s*thinking\)\s*$/i,
]

function isSpinnerRow(line: string): boolean {
  return SPINNER_CUE.test(line) && SPINNER_ROW_HEAD.some(head => head.test(line))
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

  test('uses French labels when asked', { options: { labels: 'fr' } }, async ($, on) => {
    engineBeneath(on)
    await expectFramed(await mountPrompt($, PROMPT), PROMPT, 'Vous')
    await framedAssistant(await mountReply($, REPLY), REPLY, 'Claude')
  })

  test('an unknown labels value falls back to English', { options: { labels: 'xx' } }, async ($, on) => {
    engineBeneath(on)
    await expectFramed(await mountPrompt($, PROMPT), PROMPT, 'You')
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
