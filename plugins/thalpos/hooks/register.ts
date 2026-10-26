import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

import type { ThalposWarm } from '../types'
import {
  HOUR,
  PING_AFTER_MS,
  PING_PROMPT,
  formatClock,
  isCold,
  isWarm,
  judgeReadback,
  maxHoursOption,
  parseCommand,
  pingDelay,
  planRetry,
  statusLine,
  statusReport,
  usageLine,
} from './schedule'
import { isSupported } from './versions'

const WARM = { plugin: 'thalpos', key: 'warm' } as const
const LAST_REQUEST = { plugin: 'thalpos', key: 'lastRequest' } as const
const COMMAND = 'keep-warm'

const timers: { ping?: Timer; end?: Timer } = {}
const flight = { isOut: false, hasTurned: false }

export const register: Register = (on, options) => {
  const maxHours = maxHoursOption(options.max_hours)

  on('session.start', async ($, e, next) => {
    try {
      await resume($)
    } catch (error) {
      $.ui.log(`thalpos: session start left to the stock after ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    try {
      return { text: await runCommand($, e.args, maxHours) }
    } catch (error) {
      $.ui.log(`thalpos: command left to the stock after ${String(error)}`, { to: 'debug' })
      return next(e)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      try {
        await noteRequest($)
      } catch (error) {
        $.ui.log(`thalpos: turn not counted after ${String(error)}`, { to: 'debug' })
      }
    }
    return result
  })
}

async function readWarm($: EngineInterface): Promise<ThalposWarm | undefined> {
  const { value } = await $.state.get(WARM)
  return isWarm(value) ? value : undefined
}

async function readLastRequest($: EngineInterface): Promise<number | undefined> {
  const { value } = await $.state.get(LAST_REQUEST)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function resume($: EngineInterface): Promise<void> {
  const version = await $.session.version()
  if (!isSupported(version.base, 'warm')) return
  await $.command.register({
    name: COMMAND,
    description: 'Keep the prompt cache warm for a bounded period',
    argumentHint: 'start [hours] | stop | status',
  })
  const held = await readWarm($)
  if (held === undefined) return
  const now = await $.clock.now()
  if (now >= held.deadline) await halt($)
  else await arm($, held, now)
}

function cancelTimers(): void {
  timers.ping?.cancel()
  timers.end?.cancel()
  timers.ping = undefined
  timers.end = undefined
}

async function halt($: EngineInterface): Promise<void> {
  cancelTimers()
  await $.state.set(WARM, null)
  $.ui.status(undefined)
}

async function stopWithReason($: EngineInterface, reason: string): Promise<void> {
  await halt($)
  $.ui.toast(`keep-warm stopped: ${reason}`)
}

async function guarded($: EngineInterface, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    $.ui.log(`thalpos: timer work dropped after ${String(error)}`, { to: 'debug' })
  }
}

// Replaces both timers and persists the plan: a ping time that may not be used is stored as null.
async function arm($: EngineInterface, state: ThalposWarm, now: number): Promise<void> {
  cancelTimers()
  const delay = state.nextAt === null ? undefined : pingDelay(now, state.nextAt, state.lastRequestAt, state.deadline)
  const nextAt = delay === undefined ? null : now + delay
  timers.end = $.clock.after(Math.max(0, state.deadline - now), () => {
    void guarded($, () => endPeriod($))
  })
  if (delay !== undefined) {
    timers.ping = $.clock.after(delay, () => {
      void guarded($, () => ping($))
    })
  }
  await $.state.set(WARM, { ...state, nextAt })
  $.ui.status(statusLine(nextAt, state.deadline))
}

async function endPeriod($: EngineInterface): Promise<void> {
  if ((await readWarm($)) === undefined) return
  await halt($)
  $.ui.toast('keep-warm: the period ended')
}

async function noteRequest($: EngineInterface): Promise<void> {
  if (flight.isOut) flight.hasTurned = true
  const now = await $.clock.now()
  await $.state.set(LAST_REQUEST, now)
  const held = await readWarm($)
  if (held === undefined) return
  await arm($, { ...held, lastRequestAt: now, nextAt: now + PING_AFTER_MS, retries: 0 }, now)
}

function countPing(state: ThalposWarm, usage: ModelUsage): ThalposWarm {
  return {
    ...state,
    pings: state.pings + 1,
    cacheRead: state.cacheRead + usage.cache_read_input_tokens,
    cacheCreation: state.cacheCreation + usage.cache_creation_input_tokens,
  }
}

async function ping($: EngineInterface): Promise<void> {
  const held = await readWarm($)
  if (held === undefined) return
  const sentAt = await $.clock.now()
  if (sentAt >= held.deadline || isCold(sentAt, held.lastRequestAt)) {
    await arm($, { ...held, nextAt: null }, sentAt)
    return
  }
  // While the fork is out no ping is due, so a start or a reload in that time schedules no second one.
  await $.state.set(WARM, { ...held, nextAt: null })
  flight.isOut = true
  flight.hasTurned = false
  let result: Awaited<ReturnType<EngineInterface['model']['fork']>>
  try {
    result = await $.model.fork({ prompt: PING_PROMPT })
  } finally {
    flight.isOut = false
  }
  const state = await readWarm($)
  if (state === undefined) return
  const now = await $.clock.now()
  if (flight.hasTurned) {
    // A main turn landed while the fork was out: that turn re-armed the timer and is what warmed the cache,
    // so the fork's outcome neither stops nor reschedules anything.
    if (result.isAnswered) await $.state.set(WARM, countPing(state, result.usage))
    return
  }
  if (result.isAnswered) {
    const verdict = judgeReadback(result.usage)
    if (!verdict.ok) return stopWithReason($, verdict.reason)
    const lastRequestAt = Math.max(state.lastRequestAt, sentAt)
    await $.state.set(LAST_REQUEST, lastRequestAt)
    await arm($, { ...countPing(state, result.usage), lastRequestAt, nextAt: lastRequestAt + PING_AFTER_MS, retries: 0 }, now)
  } else if (result.reason === 'nothing-to-fork') {
    await arm($, { ...state, nextAt: null }, now)
  } else {
    const plan = planRetry(result, state.retries, now, state.lastRequestAt, state.deadline)
    if (!plan.retry) return stopWithReason($, plan.reason)
    await arm($, { ...state, retries: state.retries + 1, nextAt: now + plan.delayMs }, now)
  }
}

async function runCommand($: EngineInterface, args: string, maxHours: number): Promise<string> {
  const command = parseCommand(args, maxHours)
  const held = await readWarm($)
  switch (command.action) {
    case 'usage':
      return usageLine(maxHours)
    case 'status':
      return statusReport(held)
    case 'stop':
      if (held === undefined) return 'keep-warm: nothing was active'
      await halt($)
      return 'keep-warm: stopped'
    case 'start': {
      const now = await $.clock.now()
      const deadline = now + Math.round(command.hours * HOUR)
      if (held !== undefined) {
        // A null nextAt means either the old deadline cut the ping off, which a later deadline revives, or a wait for
        // the next turn after nothing-to-fork, which must hold; only the first has its due time at or past the old deadline.
        const due = held.lastRequestAt + PING_AFTER_MS
        const nextAt = held.nextAt ?? (due >= held.deadline ? due : null)
        await arm($, { ...held, deadline, nextAt }, now)
        return `keep-warm: started until ${formatClock(deadline)}`
      }
      // With no request seen since the plugin loaded, the command's own time stands in; KW7 stops a ping that finds the cache cold.
      const lastRequestAt = (await readLastRequest($)) ?? now
      // A ping still in flight from a stopped period adopts this one when it returns and re-arms it.
      const nextAt = flight.isOut ? null : lastRequestAt + PING_AFTER_MS
      const fresh: ThalposWarm = { deadline, lastRequestAt, nextAt, pings: 0, cacheRead: 0, cacheCreation: 0, retries: 0 }
      await arm($, fresh, now)
      return `keep-warm: started until ${formatClock(deadline)}`
    }
  }
}
