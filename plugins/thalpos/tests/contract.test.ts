import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, ModelUsage, On, SessionVersion } from 'claude-code'

import { HOUR, MINUTE, PING_PROMPT, formatClock, statusLine } from '../hooks/schedule'

const SUPPORTED: SessionVersion = { version: '2.1.303', base: '2.1.303' }
const T0 = new Date(2026, 9, 26, 8, 0).getTime()

const usage = (read: number, wrote: number): ModelUsage => ({
  input_tokens: 5,
  output_tokens: 1,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: wrote,
})
const answered = (read: number, wrote: number): ModelForkResult => ({ isAnswered: true, text: 'ok', usage: usage(read, wrote) })
const WARM_REPLY = answered(190_000, 0)
const apiError = (status: number | null): ModelForkResult => ({
  isAnswered: false,
  reason: 'api-error',
  status,
  error: 'overloaded',
  usage: usage(0, 0),
})
const NOTHING: ModelForkResult = { isAnswered: false, reason: 'nothing-to-fork' }

type World = {
  clock: ReturnType<typeof mock.clock>
  forks: { atMinute: number; prompt: string }[]
  replies: ModelForkResult[]
  statuses: (string | undefined)[]
  toasts: string[]
  logs: string[]
  commands: string[]
  state: unknown
  lastRequest: unknown
  writes: unknown[]
  isStateDown: boolean
  /** While set, a fork stays in flight until the promise settles. */
  forkGate?: Promise<void>
}

function world(on: On, options: { version?: SessionVersion; state?: unknown } = {}): World {
  const clock = mock.clock(on, { now: T0 })
  const seen: World = {
    clock,
    forks: [],
    replies: [],
    statuses: [],
    toasts: [],
    logs: [],
    commands: [],
    state: options.state ?? null,
    lastRequest: null,
    writes: [],
    isStateDown: false,
  }
  on('state.get', (_$, e) => {
    if (seen.isStateDown) return { deny: 'state unavailable' }
    return { value: { value: e.key === 'lastRequest' ? seen.lastRequest : seen.state, version: 1 } }
  })
  on('state.set', (_$, e) => {
    if (e.key === 'lastRequest') {
      seen.lastRequest = e.value
    } else {
      seen.state = e.value
      seen.writes.push(e.value)
    }
    return { value: { isSet: true, version: 2 } }
  })
  on('session.version', () => ({ value: options.version ?? SUPPORTED }))
  on('command.register', (_$, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('model.fork', async (_$, e) => {
    seen.forks.push({ atMinute: (clock.now() - T0) / MINUTE, prompt: e.prompt })
    if (seen.forkGate !== undefined) await seen.forkGate
    return { value: seen.replies.shift() ?? WARM_REPLY }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.to)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: 'stock' }))
  on('command.run', () => ({ text: 'stock' }))
  return seen
}

const minutes = (n: number) => n * MINUTE
const forkMinutes = (seen: World) => seen.forks.map(fork => fork.atMinute)
const lastStatus = (seen: World) => seen.statuses[seen.statuses.length - 1]

async function boot($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

async function command($: Engine, args: string): Promise<string | undefined> {
  const input = { command: 'keep-warm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
  return (await $.command.run(input)).text
}

async function mainTurn($: Engine, agentId?: string): Promise<void> {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId === undefined ? {} : { agentId }) })
}

test('KW1 nothing runs before /keep-warm start', async ($, on) => {
  const seen = world(on)
  await boot($)
  await mainTurn($)
  await seen.clock.advance(12 * HOUR)

  expect(seen.commands).toEqual(['keep-warm'])
  expect(seen.forks).toEqual([])
  expect(seen.statuses).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.state).toBeNull()
})

test('KW2 start takes three hours by default and accepts 5, 5h and 1.5h', async ($, on) => {
  const seen = world(on)
  await boot($)

  await command($, 'start')
  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(50), T0 + 3 * HOUR))
  await command($, 'start 5')
  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(50), T0 + 5 * HOUR))
  await command($, 'start 5h')
  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(50), T0 + 5 * HOUR))
  await command($, 'start 1.5h')
  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(50), T0 + 1.5 * HOUR))
})

test('KW2 a refused duration answers the usage line and changes nothing', async ($, on) => {
  const seen = world(on)
  await boot($)

  for (const args of ['start 0.5', 'start 0', 'start -1', 'start soon', 'start 13']) {
    expect(await command($, args)).toContain('usage: /keep-warm start')
  }
  expect(seen.statuses).toEqual([])
  expect(seen.state).toBeNull()

  await command($, 'start 2')
  const before = seen.statuses.length
  expect(await command($, 'start 20')).toContain('usage: /keep-warm start')
  expect(seen.statuses.length).toBe(before)
  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(50), T0 + 2 * HOUR))
})

test('KW2 the max_hours option sets the upper bound', { options: { max_hours: 6 } }, async ($, on) => {
  const seen = world(on)
  await boot($)
  expect(await command($, 'start 7')).toContain('usage: /keep-warm start')
  expect(seen.statuses).toEqual([])
})

test('KW3 start while active replaces the deadline and never stacks a second timer', async ($, on) => {
  const seen = world(on)
  await boot($)
  await command($, 'start 3')
  await seen.clock.advance(minutes(30))
  await command($, 'start 2')

  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(50), T0 + minutes(30) + 2 * HOUR))
  await seen.clock.advance(4 * HOUR)

  expect(forkMinutes(seen)).toEqual([50, 100])
  expect(seen.toasts).toHaveLength(1)
})

test('KW4 a ping goes out fifty minutes after the latest request and never sooner', async ($, on) => {
  const seen = world(on)
  await boot($)
  await command($, 'start 5')

  await seen.clock.advance(minutes(49))
  expect(seen.forks).toEqual([])
  await seen.clock.advance(minutes(1))
  expect(seen.forks).toEqual([{ atMinute: 50, prompt: PING_PROMPT }])
  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(100), T0 + 5 * HOUR))
})

test('KW4 start counts the fifty minutes from the latest main turn, not from the command', async ($, on) => {
  const seen = world(on)
  await boot($)
  await mainTurn($)
  await seen.clock.advance(minutes(30))
  await command($, 'start 5')

  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(50), T0 + minutes(30) + 5 * HOUR))
  await seen.clock.advance(minutes(20))
  expect(forkMinutes(seen)).toEqual([50])
})

test('KW4 start after a main turn older than the cache waits for the next turn', async ($, on) => {
  const seen = world(on)
  await boot($)
  await mainTurn($)
  await seen.clock.advance(minutes(70))
  await command($, 'start 5')

  expect(lastStatus(seen)).toBe(statusLine(null, T0 + minutes(70) + 5 * HOUR))
  await seen.clock.advance(HOUR)
  expect(seen.forks).toEqual([])
  await mainTurn($)
  await seen.clock.advance(minutes(50))
  expect(forkMinutes(seen)).toEqual([180])
})

test('KW4 each main turn re-arms the timer and a subagent turn does not', async ($, on) => {
  const seen = world(on)
  await boot($)
  await command($, 'start 5')

  await seen.clock.advance(minutes(30))
  await mainTurn($)
  await seen.clock.advance(minutes(49))
  expect(seen.forks).toEqual([])
  await seen.clock.advance(minutes(1))
  expect(forkMinutes(seen)).toEqual([80])

  await seen.clock.advance(minutes(20))
  await mainTurn($, 'agent-1')
  await seen.clock.advance(minutes(30))
  expect(forkMinutes(seen)).toEqual([80, 130])
})

test('KW5 no ping is sent at or after the deadline and one toast ends the period', async ($, on) => {
  const seen = world(on)
  await boot($)
  await command($, 'start 1')
  await seen.clock.advance(minutes(20))
  await mainTurn($)

  await seen.clock.advance(5 * HOUR)

  expect(seen.forks).toEqual([])
  expect(seen.toasts).toHaveLength(1)
  expect(lastStatus(seen)).toBeUndefined()
  expect(seen.state).toBeNull()
})

test('KW5 a ping due strictly before the deadline is sent, the next one is not', async ($, on) => {
  const seen = world(on)
  await boot($)
  await command($, 'start 1.5')
  await seen.clock.advance(3 * HOUR)

  expect(forkMinutes(seen)).toEqual([50])
  expect(seen.toasts).toHaveLength(1)
})

test('KW6 stop cancels the timers, clears the status line and keeps no deadline', async ($, on) => {
  const seen = world(on)
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(10))

  expect(await command($, 'stop')).toContain('stopped')
  expect(lastStatus(seen)).toBeUndefined()
  expect(seen.state).toBeNull()
  await seen.clock.advance(6 * HOUR)

  expect(seen.forks).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('KW6 stop while inactive answers that nothing was active', async ($, on) => {
  const seen = world(on)
  await boot($)

  expect(await command($, 'stop')).toContain('nothing was active')
  expect(seen.statuses).toEqual([])
})

test('KW3 extending a period whose next ping fell past the old deadline schedules that ping again', async ($, on) => {
  const seen = world(on)
  await boot($)
  await mainTurn($)
  await command($, 'start 1')
  await seen.clock.advance(minutes(55))
  await command($, 'start 3')
  await seen.clock.advance(minutes(50))

  expect(forkMinutes(seen)).toEqual([50, 100])
})

test('KW7 start while waiting after nothing-to-fork sends nothing until the next turn', async ($, on) => {
  const seen = world(on)
  seen.replies.push(NOTHING)
  await boot($)
  await mainTurn($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(52))
  await command($, 'start 4')
  await seen.clock.advance(HOUR)

  expect(forkMinutes(seen)).toEqual([50])
})

test('KW3 start while a ping is in flight sends no second ping', async ($, on) => {
  const seen = world(on)
  let release = () => {}
  seen.forkGate = new Promise<void>(resolve => { release = resolve })
  await boot($)
  await mainTurn($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(50))
  await command($, 'start 4')
  await seen.clock.advance(0)
  expect(forkMinutes(seen)).toEqual([50])

  seen.forkGate = undefined
  release()
  await seen.clock.advance(minutes(50))
  expect(forkMinutes(seen)).toEqual([50, 100])
})

const IN_FLIGHT_OUTCOMES: [string, ModelForkResult][] = [
  ['a 529', apiError(529)],
  ['nothing-to-fork', NOTHING],
  ['a cold readback', answered(0, 150_000)],
]

for (const [name, reply] of IN_FLIGHT_OUTCOMES) {
  test(`KW4 a main turn while a ping is in flight keeps the turn's schedule when the ping returns ${name}`, async ($, on) => {
    const seen = world(on)
    let release = () => {}
    seen.forkGate = new Promise<void>(resolve => { release = resolve })
    seen.replies.push(reply)
    await boot($)
    await mainTurn($)
    await command($, 'start 5')
    await seen.clock.advance(minutes(50))
    await seen.clock.advance(minutes(2))
    await mainTurn($)
    seen.forkGate = undefined
    release()
    await seen.clock.advance(minutes(50))

    expect(forkMinutes(seen)).toEqual([50, 102])
    expect(seen.toasts).toEqual([])
  })
}

test('KW4 stop then start while a ping is in flight sends no second ping and the returning ping re-arms', async ($, on) => {
  const seen = world(on)
  let release = () => {}
  seen.forkGate = new Promise<void>(resolve => { release = resolve })
  await boot($)
  await mainTurn($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(50))
  await command($, 'stop')
  await command($, 'start 5')
  await seen.clock.advance(0)
  expect(forkMinutes(seen)).toEqual([50])

  seen.forkGate = undefined
  release()
  await seen.clock.advance(minutes(50))
  expect(forkMinutes(seen)).toEqual([50, 100])
})

test('KW4 stop then start while a ping is in flight re-arms even with no turn seen since load', async ($, on) => {
  const seen = world(on)
  let release = () => {}
  seen.forkGate = new Promise<void>(resolve => { release = resolve })
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(50))
  await command($, 'stop')
  await command($, 'start 5')
  seen.forkGate = undefined
  release()
  await seen.clock.advance(minutes(50))

  expect(forkMinutes(seen)).toEqual([50, 100])
})

test('KW4 start after stop counts from the latest ping, not only from the latest turn', async ($, on) => {
  const seen = world(on)
  await boot($)
  await mainTurn($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(55))
  await command($, 'stop')
  await seen.clock.advance(minutes(1))
  await command($, 'start 5')
  await seen.clock.advance(minutes(60))

  expect(forkMinutes(seen)).toEqual([50, 100])
})

test('KW7 start during a pending retry keeps the retry time and replaces only the deadline', async ($, on) => {
  const seen = world(on)
  seen.replies.push(apiError(529))
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(50.5))
  await command($, 'start 4')
  await seen.clock.advance(minutes(1))

  expect(forkMinutes(seen)).toEqual([50, 51])
})

test('KW7 a ping that reads nothing stops the plugin with one toast saying why', async ($, on) => {
  const seen = world(on)
  seen.replies.push(answered(0, 150_000))
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(5 * HOUR)

  expect(forkMinutes(seen)).toEqual([50])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('read 0')
  expect(lastStatus(seen)).toBeUndefined()
  expect(seen.state).toBeNull()
})

test('KW7 a ping that writes a tenth of what it reads or more stops the plugin', async ($, on) => {
  const seen = world(on)
  seen.replies.push(answered(1000, 100))
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(5 * HOUR)

  expect(forkMinutes(seen)).toEqual([50])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('wrote 100')
})

test('KW7 a 429, 529 or 5xx is retried after one, two then four minutes', async ($, on) => {
  const seen = world(on)
  seen.replies.push(apiError(429), apiError(529), apiError(503))
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(60))

  expect(forkMinutes(seen)).toEqual([50, 51, 53, 57])
  expect(seen.toasts).toEqual([])
  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(107), T0 + 5 * HOUR))
})

test('KW7 the retries stop after the third and say why', async ($, on) => {
  const seen = world(on)
  seen.replies.push(apiError(529), apiError(529), apiError(529), apiError(529))
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(5 * HOUR)

  expect(forkMinutes(seen)).toEqual([50, 51, 53, 57])
  expect(seen.toasts).toHaveLength(1)
  expect(lastStatus(seen)).toBeUndefined()
})

test('KW7 a retry that would land at or after the deadline stops the plugin', async ($, on) => {
  const seen = world(on)
  seen.replies.push(apiError(529), apiError(529), apiError(529))
  await boot($)
  await command($, 'start 1.4')
  await seen.clock.advance(minutes(30))
  await mainTurn($)
  await seen.clock.advance(3 * HOUR)

  expect(forkMinutes(seen)).toEqual([80, 81, 83])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('end of the period')
})

const OTHER_FAILURES: [string, ModelForkResult][] = [
  ['an API status that is not transient', apiError(400)],
  ['a dropped connection', apiError(null)],
  ['an empty reply', { isAnswered: false, reason: 'empty-reply', usage: usage(0, 0) }],
  ['an aborted call', { isAnswered: false, reason: 'aborted', usage: usage(0, 0) }],
]

for (const [name, failure] of OTHER_FAILURES) {
  test(`KW7 ${name} stops the plugin with one toast`, async ($, on) => {
    const seen = world(on)
    seen.replies.push(failure)
    await boot($)
    await command($, 'start 5')
    await seen.clock.advance(5 * HOUR)

    expect(forkMinutes(seen)).toEqual([50])
    expect(seen.toasts).toHaveLength(1)
    expect(lastStatus(seen)).toBeUndefined()
  })
}

test('KW7 nothing-to-fork sends nothing more, stops nothing and waits for the next turn', async ($, on) => {
  const seen = world(on)
  seen.replies.push(NOTHING)
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(55))

  expect(forkMinutes(seen)).toEqual([50])
  expect(seen.toasts).toEqual([])
  expect(lastStatus(seen)).toBe(statusLine(null, T0 + 5 * HOUR))

  await seen.clock.advance(minutes(5))
  await mainTurn($)
  await seen.clock.advance(minutes(50))

  expect(forkMinutes(seen)).toEqual([50, 110])
  expect(seen.toasts).toEqual([])
})

test('KW7 a reload with a cache known to be cold waits for the next turn instead of pinging', async ($, on) => {
  const seen = world(on, { state: { ...SEED, lastRequestAt: T0 - minutes(70), nextAt: T0 - minutes(20) } })
  await boot($)
  await seen.clock.advance(HOUR)

  expect(seen.forks).toEqual([])
  expect(lastStatus(seen)).toBe(statusLine(null, T0 + 2 * HOUR))
})

test('KW8 status gives the deadline, the next ping, the ping count and the summed cache tokens', async ($, on) => {
  const seen = world(on)
  seen.replies.push(answered(100_000, 500), answered(120_000, 700))
  await boot($)

  expect(await command($, 'status')).toContain('not active')

  await command($, 'start 5')
  await seen.clock.advance(minutes(100))
  const text = await command($, 'status')

  expect(text).toContain(formatClock(T0 + 5 * HOUR))
  expect(text).toContain(formatClock(T0 + minutes(150)))
  expect(text).toContain('2 pings')
  expect(text).toContain('cache_read_input_tokens 220000')
  expect(text).toContain('cache_creation_input_tokens 1200')
})

const SEED = {
  deadline: T0 + 2 * HOUR,
  lastRequestAt: T0 - minutes(10),
  nextAt: T0 + minutes(40),
  pings: 2,
  cacheRead: 300_000,
  cacheCreation: 900,
  retries: 0,
}

test('KW9 a reload during an active period re-arms the timer from the stored state', async ($, on) => {
  const seen = world(on, { state: SEED })
  await boot($)

  expect(lastStatus(seen)).toBe(statusLine(T0 + minutes(40), T0 + 2 * HOUR))
  await seen.clock.advance(minutes(40))
  expect(forkMinutes(seen)).toEqual([40])
  await seen.clock.advance(2 * HOUR)
  expect(forkMinutes(seen)).toEqual([40, 90])
  expect(seen.toasts).toHaveLength(1)
})

test('KW9 a reload after the deadline starts nothing', async ($, on) => {
  const seen = world(on, { state: { ...SEED, deadline: T0 - minutes(1) } })
  await boot($)
  await seen.clock.advance(6 * HOUR)

  expect(seen.forks).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.statuses.filter(text => text !== undefined)).toEqual([])
  expect(seen.writes).toEqual([null])
})

test('KW9 a stored value of an unknown shape is ignored', async ($, on) => {
  const seen = world(on, { state: { deadline: 'soon' } })
  await boot($)
  await seen.clock.advance(6 * HOUR)

  expect(seen.forks).toEqual([])
  expect(seen.statuses).toEqual([])
})

test('KW9 a second session.start does not stack a timer on the first', async ($, on) => {
  const seen = world(on)
  await boot($)
  await command($, 'start 5')
  await seen.clock.advance(minutes(20))
  await boot($)
  await seen.clock.advance(minutes(60))

  expect(forkMinutes(seen)).toEqual([50])
})

test('KW10 the plugin reaches the engine only through the capabilities it declares', async ($, on) => {
  const operations = new Set<string>()
  on('*', (_$, e, next) => {
    operations.add(next.event)
    return next(e as never)
  })
  const seen = world(on)
  const session = mock.session(on)
  await boot($)
  await command($, 'start 5')
  await mainTurn($)
  await seen.clock.advance(minutes(60))
  await command($, 'status')
  await command($, 'stop')
  await command($, 'start 1')
  await seen.clock.advance(2 * HOUR)

  // Raised by the test or the engine itself, not by a call of the plugin.
  const raisedByTheTest = new Set(['session.start', 'command.run', 'turn.complete', 'engine.create', 'plugin.register', 'ui.resolve'])
  const used = [...operations].filter(name => !raisedByTheTest.has(name)).sort()
  expect(used).toEqual(
    [
      'clock.after',
      'clock.now',
      'command.register',
      'model.fork',
      'session.version',
      'state.get',
      'state.set',
      'ui.status',
      'ui.toast',
    ].sort(),
  )
  expect(session.appended()).toEqual([])
})

test('fail to stock: an exception in a hook leaves the event to the stock and logs to debug', async ($, on) => {
  const seen = world(on)
  await boot($)
  await command($, 'start 5')
  seen.isStateDown = true

  expect((await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })).text).toBe('stock')
  expect(await command($, 'status')).toBe('stock')
  expect(seen.logs).toContain('debug')
  expect(seen.logs.every(to => to === 'debug')).toBe(true)
})

const UNSUPPORTED: [string, SessionVersion][] = [
  ['an older release', { version: '2.1.302', base: '2.1.302' }],
  ['a development build', { version: '2.1.310-dev.1', base: '2.1.310-dev' }],
]

for (const [name, version] of UNSUPPORTED) {
  test(`fail to stock: ${name} registers nothing`, async ($, on) => {
    const seen = world(on, { version })
    await boot($)

    expect(seen.commands).toEqual([])
    expect(seen.statuses).toEqual([])
  })
}
