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
  parseAutostart,
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
const AUTO_OFF = { plugin: 'thalpos', key: 'autoOff' } as const
const COMMAND = 'keep-warm'

const timers: { ping?: Timer; end?: Timer } = {}
const flight = { isOut: false, hasTurned: false }
let transitionTail: Promise<void> = Promise.resolve()

function transition<T>(work: () => Promise<T>): Promise<T> {
  const result = transitionTail.then(work)
  transitionTail = result.then(() => undefined, () => undefined)
  return result
}

export const register: Register = (on, options) => {
  const maxHours = maxHoursOption(options.max_hours)
  const isAutostartAllowed = options.autostart === true

  on('session.start', async ($, e, next) => {
    try {
      await transition(() => resume($, maxHours, isAutostartAllowed))
    } catch (error) {
      $.ui.log(`thalpos: session start left to the stock after ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    try {
      return { text: await transition(() => runCommand($, e.args, maxHours)) }
    } catch (error) {
      $.ui.log(`thalpos: command left to the stock after ${String(error)}`, { to: 'debug' })
      return next(e)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      try {
        await transition(() => noteRequest($, maxHours, isAutostartAllowed))
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

async function resume($: EngineInterface, maxHours: number, isAutostartAllowed: boolean): Promise<void> {
  const version = await $.session.version()
  if (!isSupported(version.base, 'warm')) return
  await $.command.register({
    name: COMMAND,
    description: 'Keep the prompt cache warm for a bounded period',
    argumentHint: 'start [hours] | stop | status',
  })
  const held = await readWarm($)
  if (held === undefined) return autostart($, maxHours, isAutostartAllowed, true)
  const now = await $.clock.now()
  if (now >= held.deadline) await halt($)
  else await arm($, held, now)
}

// The variable, which a committed project settings.json can set, only chooses the duration; the user's `autostart` option is the consent.
// A value that cannot start a period is logged every time and toasted once, at session start, so a bad value does not toast at every turn.
async function autostart($: EngineInterface, maxHours: number, isAllowed: boolean, isSessionStart: boolean): Promise<void> {
  if ((await $.state.get(AUTO_OFF)).value === true) return
  const plan = parseAutostart(await $.env.get('THALPOS_AUTOSTART'), maxHours)
  if (plan.action === 'none') return
  if (!isAllowed) {
    if (isSessionStart) $.ui.log('thalpos: THALPOS_AUTOSTART ignored, the autostart option is off', { to: 'debug' })
    return
  }
  if (plan.action === 'invalid') {
    if (isSessionStart) $.ui.toast(`keep-warm: ${plan.reason}`)
    $.ui.log(`thalpos: ${plan.reason}`, { to: 'debug' })
    return
  }
  await beginPeriod($, plan.hours, true)
}

async function beginPeriod($: EngineInterface, hours: number, isAuto: boolean): Promise<number> {
  const now = await $.clock.now()
  const deadline = now + Math.round(hours * HOUR)
  // With no request seen since the plugin loaded, the current time stands in; KW7 stops a ping that finds the cache cold.
  const lastRequestAt = (await readLastRequest($)) ?? now
  // A ping still in flight from a stopped period adopts this one when it returns and re-arms it.
  const nextAt = flight.isOut ? null : lastRequestAt + PING_AFTER_MS
  const fresh: ThalposWarm = { deadline, lastRequestAt, nextAt, pings: 0, cacheRead: 0, cacheCreation: 0, retries: 0 }
  if (isAuto) fresh.autoHours = hours
  await arm($, fresh, now)
  return deadline
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
    void guarded($, () => transition(() => endPeriod($)))
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

async function noteRequest($: EngineInterface, maxHours: number, isAutostartAllowed: boolean): Promise<void> {
  if (flight.isOut) flight.hasTurned = true
  const now = await $.clock.now()
  await $.state.set(LAST_REQUEST, now)
  const held = await readWarm($)
  if (held === undefined) return autostart($, maxHours, isAutostartAllowed, false)
  const deadline = held.autoHours === undefined ? held.deadline : now + Math.round(held.autoHours * HOUR)
  await arm($, { ...held, deadline, lastRequestAt: now, nextAt: now + PING_AFTER_MS, retries: 0 }, now)
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
  const sentAt = await transition(async () => {
    const held = await readWarm($)
    if (held === undefined) return undefined
    const now = await $.clock.now()
    if (now >= held.deadline || isCold(now, held.lastRequestAt)) {
      await arm($, { ...held, nextAt: null }, now)
      return undefined
    }
    // While the fork is out no ping is due, so a start or a reload in that time schedules no second one.
    await $.state.set(WARM, { ...held, nextAt: null })
    flight.isOut = true
    flight.hasTurned = false
    return now
  })
  if (sentAt === undefined) return

  let result: Awaited<ReturnType<EngineInterface['model']['fork']>>
  try {
    result = await $.model.fork({ prompt: PING_PROMPT })
  } catch (error) {
    await transition(async () => { flight.isOut = false })
    throw error
  }

  await transition(async () => {
    try {
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
        if (!verdict.ok) {
          if (state.autoHours === undefined) return stopWithReason($, verdict.reason)
          await $.state.set(AUTO_OFF, true)
          return stopWithReason($, `${verdict.reason}; automatic start is off until /clear or restart`)
        }
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
    } finally {
      flight.isOut = false
    }
  })
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
      await $.state.set(AUTO_OFF, true)
      if (held === undefined) return 'keep-warm: nothing was active'
      await halt($)
      return 'keep-warm: stopped'
    case 'start': {
      if (held === undefined) return `keep-warm: started until ${formatClock(await beginPeriod($, command.hours, false))}`
      const now = await $.clock.now()
      const deadline = now + Math.round(command.hours * HOUR)
      // A null nextAt means either the old deadline cut the ping off, which a later deadline revives, or a wait for
      // the next turn after nothing-to-fork, which must hold; only the first has its due time at or past the old deadline.
      const due = held.lastRequestAt + PING_AFTER_MS
      const nextAt = held.nextAt ?? (due >= held.deadline ? due : null)
      const fixed: ThalposWarm = { ...held, deadline, nextAt }
      delete fixed.autoHours
      await arm($, fixed, now)
      return `keep-warm: started until ${formatClock(deadline)}`
    }
  }
}
