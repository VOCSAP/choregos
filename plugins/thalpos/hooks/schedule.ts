import type { ThalposWarm } from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export const PING_PROMPT = 'Reply with the single word: ok'
export const PING_AFTER_MS = 50 * MINUTE
export const COLD_AFTER_MS = 59 * MINUTE
export const DEFAULT_HOURS = 3
export const MIN_HOURS = 1
export const DEFAULT_MAX_HOURS = 12
export const MAX_RETRIES = 3

export type Command =
  | { action: 'start'; hours: number }
  | { action: 'stop' }
  | { action: 'status' }
  | { action: 'usage' }

export function maxHoursOption(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_HOURS
}

export function usageLine(maxHours: number): string {
  return `usage: /keep-warm start [hours] | stop | status (hours: ${MIN_HOURS} to ${maxHours}, default ${DEFAULT_HOURS})`
}

const START = /^start(?:\s+(\d+(?:\.\d+)?)h?)?$/

export function parseCommand(args: string, maxHours: number): Command {
  const text = args.trim().toLowerCase()
  if (text === 'stop') return { action: 'stop' }
  if (text === 'status') return { action: 'status' }
  const match = START.exec(text)
  if (!match) return { action: 'usage' }
  const hours = match[1] === undefined ? DEFAULT_HOURS : Number(match[1])
  return hours >= MIN_HOURS && hours <= maxHours ? { action: 'start', hours } : { action: 'usage' }
}

export function isCold(now: number, lastRequestAt: number): boolean {
  return now >= lastRequestAt + COLD_AFTER_MS
}

// Milliseconds to wait before the ping due at `at`, or undefined when no ping may be sent:
// the cache is already cold, or the ping would land at or after the deadline or the cold mark.
export function pingDelay(now: number, at: number, lastRequestAt: number, deadline: number): number | undefined {
  if (isCold(now, lastRequestAt) || at >= deadline || at >= lastRequestAt + COLD_AFTER_MS) return undefined
  return Math.max(0, at - now)
}

export type Verdict = { ok: true } | { ok: false; reason: string }

export function judgeReadback(usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number }): Verdict {
  const read = usage.cache_read_input_tokens
  const wrote = usage.cache_creation_input_tokens
  if (read === 0) return { ok: false, reason: `the ping read 0 tokens from the cache (wrote ${wrote})` }
  if (wrote * 10 >= read) return { ok: false, reason: `the ping wrote ${wrote} tokens against ${read} read` }
  return { ok: true }
}

export type Failure = { reason: string; status?: number | null }
export type RetryPlan = { retry: true; delayMs: number } | { retry: false; reason: string }

function isTransient(status: number | null | undefined): boolean {
  return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599)
}

export function planRetry(failure: Failure, attempts: number, now: number, lastRequestAt: number, deadline: number): RetryPlan {
  if (failure.reason !== 'api-error') return { retry: false, reason: `the ping failed (${failure.reason})` }
  if (!isTransient(failure.status)) return { retry: false, reason: `the ping failed (API status ${failure.status ?? 'none'})` }
  if (attempts >= MAX_RETRIES) return { retry: false, reason: `the ping failed ${MAX_RETRIES + 1} times (API status ${failure.status})` }
  const delayMs = MINUTE * 2 ** attempts
  const at = now + delayMs
  if (at >= deadline) return { retry: false, reason: 'a retry would land after the end of the period' }
  if (at >= lastRequestAt + COLD_AFTER_MS) return { retry: false, reason: 'a retry would land too late to save the cache' }
  return { retry: true, delayMs }
}

export function formatClock(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function statusLine(nextAt: number | null, deadline: number): string {
  return nextAt === null
    ? `keep-warm: waiting for a turn, until ${formatClock(deadline)}`
    : `keep-warm: next ${formatClock(nextAt)}, until ${formatClock(deadline)}`
}

export function statusReport(state: ThalposWarm | undefined): string {
  if (state === undefined) return 'keep-warm: not active'
  const next = state.nextAt === null ? 'next ping after the next turn' : `next ping ${formatClock(state.nextAt)}`
  const pings = `${state.pings} ping${state.pings === 1 ? '' : 's'}`
  return `keep-warm: active until ${formatClock(state.deadline)}, ${next}, ${pings}, cache_read_input_tokens ${state.cacheRead}, cache_creation_input_tokens ${state.cacheCreation}`
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function isWarm(value: unknown): value is ThalposWarm {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    isCount(state.deadline) &&
    isCount(state.lastRequestAt) &&
    (state.nextAt === null || isCount(state.nextAt)) &&
    isCount(state.pings) &&
    isCount(state.cacheRead) &&
    isCount(state.cacheCreation) &&
    isCount(state.retries)
  )
}
