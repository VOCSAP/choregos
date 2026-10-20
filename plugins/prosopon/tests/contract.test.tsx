import { describe, expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, RenderViewport, SessionVersion } from 'claude-code'

const PLUGIN = 'prosopon'
const CERTIFIED: SessionVersion = { version: '2.1.303', base: '2.1.303' }
const REPLY = 'The build passes on all three platforms.'
const VIEWPORT: RenderViewport = { columns: 80, rows: 24 }
const WIDTHS = [40, 80, 120]

type Reply = Mounted<'terminal', 'AssistantMessage'>

function engineBeneath(on: On, version: SessionVersion | 'reject' = CERTIFIED): void {
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine: {e.props.text}</Text>
  })
  on('session.version', () =>
    version === 'reject' ? { deny: 'version unavailable' } : { value: version },
  )
}

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
): Promise<Reply> {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true, ...extra } as never,
    viewport,
  })
}

async function expectStock(ui: Reply, why: string): Promise<void> {
  expect(await ui.find({ type: 'Text', text: 'engine:' }), `${why}: engine render reached`).toBeDefined()
  expect(await ui.find({ type: 'Markdown' }), `${why}: no prosopon Markdown`).toBeUndefined()
}

async function expectFramed(ui: Reply, text: string): Promise<void> {
  const bordered = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle !== undefined)
  expect(bordered.map(box => box.props.borderStyle)).toEqual(['single'])
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe(text)
  expect(await ui.find({ type: 'Text', text: 'engine:' })).toBeUndefined()
}

function ornaments(tree: unknown, agentText: string): { added: string[]; bodies: number } {
  const added: string[] = []
  let bodies = 0
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      added.push(node)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
    for (const [key, value] of Object.entries(element.props ?? {})) {
      if (typeof value !== 'string') continue
      if (element.type === 'Markdown' && key === 'text' && value === agentText) bodies += 1
      else added.push(value)
    }
    for (const child of element.children ?? []) visit(child)
  }
  visit(tree)
  return { added: added.flatMap(value => value.split('\n')), bodies }
}

async function framedOrnaments($: Engine, columns: number): Promise<string[]> {
  const ui = await mountReply($, REPLY, {}, { columns, rows: 24 })
  await expectFramed(ui, REPLY)
  const { added, bodies } = ornaments(await ui.drawn(), REPLY)
  expect(bodies, `agent body Markdown count at ${columns}`).toBe(1)
  return added
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
  test('keeps every plugin string and excludes only the agent body', () => {
    const agentText = `❯ 1. Yes\n· Thinking… (3s · thinking)\n${'─'.repeat(80)}`
    const tree = {
      type: 'Box',
      props: { borderStyle: 'single', title: ' ❯ 1. Claude ' },
      children: [
        { type: 'Text', props: {}, children: ['* Thinking… ↓ 26 tokens'] },
        { type: 'Markdown', props: { text: '────' } },
        { type: 'Markdown', props: { text: agentText } },
      ],
    }
    expect(ornaments(tree, agentText)).toEqual({
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
  test('the frame the plugin adds uses square corners only', async ($, on) => {
    engineBeneath(on)
    for (const columns of WIDTHS) {
      const added = await framedOrnaments($, columns)
      expect(added.some(line => /[╭╮╰╯]/.test(line)), `round corner at ${columns}`).toBe(false)
    }
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
    '5-hour limit reached ∙ resets 2pm',
    'weekly limit reached, resets in 2 hours',
    'Rate limited, retrying.',
    'Your quota is exhausted.',
    'API Error: Overloaded',
    'Usage will reset at 6pm.',
  ]
  for (const message of messages) {
    test(`stays stock: ${message}`, async ($, on) => {
      engineBeneath(on)
      await expectStock(await mountReply($, message), message)
    })
  }
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

  test('a summary keeps the stock render', async ($, on) => {
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
      await expectFramed(await mountReply($, REPLY), REPLY)
    })
  }
  for (const [label, version] of unsupported) {
    test(`stays stock on ${label}`, async ($, on) => {
      engineBeneath(on, version)
      await expectStock(await mountReply($, REPLY), label)
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
    expect(sinks).toEqual([])
  })

  test('stays stock and logs to debug when drawing the tree throws', async ($, on) => {
    engineBeneath(on)
    on('ui.resolve', async (_$, e, next) => ({
      ...(await next(e)),
      Markdown: function Markdown() {
        throw new Error('markdown unavailable')
      },
    }))
    const sinks = captureLogSinks(on)
    await expectStock(await mountReply($, REPLY), 'drawing threw')
    expect(sinks).toEqual(['debug'])
  })

  test('stays stock below the minimum frame width', async ($, on) => {
    engineBeneath(on)
    await expectStock(await mountReply($, REPLY, {}, { columns: 39, rows: 24 }), '39 columns')
  })
})

describe('R8 links', () => {
  test('the plugin creates no Link and passes the agent text through unchanged', async ($, on) => {
    engineBeneath(on)
    const text = 'See [the docs](https://example.test/docs) and https://example.test/raw.'
    const ui = await mountReply($, text)
    await expectFramed(ui, text)
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
  })
})
