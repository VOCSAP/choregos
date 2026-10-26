import { describe, expect, test } from 'claude-code/testing'

import {
  COLD_AFTER_MS,
  DEFAULT_MAX_HOURS,
  MINUTE,
  PING_AFTER_MS,
  formatClock,
  isWarm,
  judgeReadback,
  maxHoursOption,
  parseCommand,
  pingDelay,
  planRetry,
  statusLine,
  statusReport,
  usageLine,
} from '../hooks/schedule'

const HOUR = 60 * MINUTE

describe('parseCommand', () => {
  test('start without a duration means three hours', async () => {
    expect(parseCommand('start', 12)).toEqual({ action: 'start', hours: 3 })
  })

  test('start takes whole and fractional hours with or without the h suffix', async () => {
    expect(parseCommand('start 5', 12)).toEqual({ action: 'start', hours: 5 })
    expect(parseCommand('start 5h', 12)).toEqual({ action: 'start', hours: 5 })
    expect(parseCommand('  start   1.5h ', 12)).toEqual({ action: 'start', hours: 1.5 })
  })

  test('start accepts exactly one hour and exactly the maximum', async () => {
    expect(parseCommand('start 1', 12)).toEqual({ action: 'start', hours: 1 })
    expect(parseCommand('start 12', 12)).toEqual({ action: 'start', hours: 12 })
  })

  test('a duration under one hour, non-positive, unreadable or above the maximum is a usage answer', async () => {
    for (const args of ['start 0.5', 'start 0', 'start -2', 'start abc', 'start 12.5', 'start 5 6', 'start 5hours', 'start .5', 'start 1e1']) {
      expect(parseCommand(args, 12)).toEqual({ action: 'usage' })
    }
  })

  test('the maximum is the option, not a constant', async () => {
    expect(parseCommand('start 13', 24)).toEqual({ action: 'start', hours: 13 })
    expect(parseCommand('start 7', 6)).toEqual({ action: 'usage' })
  })

  test('stop and status are recognised, anything else is a usage answer', async () => {
    expect(parseCommand('stop', 12)).toEqual({ action: 'stop' })
    expect(parseCommand('status', 12)).toEqual({ action: 'status' })
    expect(parseCommand('', 12)).toEqual({ action: 'usage' })
    expect(parseCommand('restart', 12)).toEqual({ action: 'usage' })
    expect(parseCommand('stop now', 12)).toEqual({ action: 'usage' })
  })
})

describe('maxHoursOption', () => {
  test('a positive number is kept, anything else falls back to the default', async () => {
    expect(maxHoursOption(6)).toBe(6)
    expect(maxHoursOption(undefined)).toBe(DEFAULT_MAX_HOURS)
    expect(maxHoursOption(0)).toBe(DEFAULT_MAX_HOURS)
    expect(maxHoursOption(-3)).toBe(DEFAULT_MAX_HOURS)
    expect(maxHoursOption(Number.NaN)).toBe(DEFAULT_MAX_HOURS)
    expect(maxHoursOption('8')).toBe(DEFAULT_MAX_HOURS)
  })
})

describe('usageLine', () => {
  test('names the three actions and the allowed range', async () => {
    const line = usageLine(12)
    expect(line).toContain('/keep-warm start [hours]')
    expect(line).toContain('stop')
    expect(line).toContain('status')
    expect(line).toContain('12')
  })
})

describe('pingDelay', () => {
  const last = 1_000_000_000
  const deadline = last + 5 * HOUR

  test('waits until fifty minutes after the latest request', async () => {
    expect(pingDelay(last + 10 * MINUTE, last + PING_AFTER_MS, last, deadline)).toBe(40 * MINUTE)
  })

  test('an overdue ping inside the warm window goes at once', async () => {
    expect(pingDelay(last + 55 * MINUTE, last + PING_AFTER_MS, last, deadline)).toBe(0)
  })

  test('never pings a cache known to be cold', async () => {
    expect(pingDelay(last + COLD_AFTER_MS, last + PING_AFTER_MS, last, deadline)).toBeUndefined()
    expect(pingDelay(last + COLD_AFTER_MS - 1, last + PING_AFTER_MS, last, deadline)).toBe(0)
  })

  test('never schedules a ping that lands at or after the deadline', async () => {
    expect(pingDelay(last, last + PING_AFTER_MS, last, last + PING_AFTER_MS)).toBeUndefined()
    expect(pingDelay(last, last + PING_AFTER_MS, last, last + PING_AFTER_MS + 1)).toBe(PING_AFTER_MS)
  })

  test('never schedules a ping that lands once the cache is cold', async () => {
    expect(pingDelay(last, last + COLD_AFTER_MS, last, deadline)).toBeUndefined()
  })
})

describe('judgeReadback', () => {
  test('a ping that reads the prefix and writes next to nothing is warm', async () => {
    expect(judgeReadback({ cache_read_input_tokens: 192_746, cache_creation_input_tokens: 0 })).toEqual({ ok: true })
    expect(judgeReadback({ cache_read_input_tokens: 1000, cache_creation_input_tokens: 99 })).toEqual({ ok: true })
  })

  test('a ping that reads nothing means the cache was cold', async () => {
    const verdict = judgeReadback({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150_000 })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('read 0')
  })

  test('a ping that writes a tenth of what it reads or more means the cache was cold', async () => {
    const verdict = judgeReadback({ cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('wrote 100')
  })
})

describe('planRetry', () => {
  const last = 1_000_000_000
  const deadline = last + 5 * HOUR
  const now = last + 50 * MINUTE

  test('retries 429, 529 and 5xx after one, two then four minutes', async () => {
    for (const status of [429, 529, 500, 503]) {
      expect(planRetry({ reason: 'api-error', status }, 0, now, last, deadline)).toEqual({ retry: true, delayMs: 1 * MINUTE })
    }
    expect(planRetry({ reason: 'api-error', status: 529 }, 1, now, last, deadline)).toEqual({ retry: true, delayMs: 2 * MINUTE })
    expect(planRetry({ reason: 'api-error', status: 529 }, 2, now, last, deadline)).toEqual({ retry: true, delayMs: 4 * MINUTE })
  })

  test('stops after the third retry', async () => {
    expect(planRetry({ reason: 'api-error', status: 529 }, 3, now, last, deadline)).toMatchObject({ retry: false })
  })

  test('stops on any other status, on a dropped connection and on any other reason', async () => {
    expect(planRetry({ reason: 'api-error', status: 400 }, 0, now, last, deadline)).toMatchObject({ retry: false })
    expect(planRetry({ reason: 'api-error', status: 401 }, 0, now, last, deadline)).toMatchObject({ retry: false })
    expect(planRetry({ reason: 'api-error', status: null }, 0, now, last, deadline)).toMatchObject({ retry: false })
    expect(planRetry({ reason: 'empty-reply' }, 0, now, last, deadline)).toMatchObject({ retry: false })
    expect(planRetry({ reason: 'aborted' }, 0, now, last, deadline)).toMatchObject({ retry: false })
  })

  test('stops when the retry would land at or after the deadline', async () => {
    expect(planRetry({ reason: 'api-error', status: 529 }, 0, now, last, now + 1 * MINUTE)).toMatchObject({ retry: false })
    expect(planRetry({ reason: 'api-error', status: 529 }, 0, now, last, now + 1 * MINUTE + 1)).toMatchObject({ retry: true })
  })

  test('stops when the retry would land a minute or less before the hour runs out', async () => {
    const lateNow = last + 55 * MINUTE
    expect(planRetry({ reason: 'api-error', status: 529 }, 2, lateNow, last, deadline)).toMatchObject({ retry: false })
    expect(planRetry({ reason: 'api-error', status: 529 }, 1, lateNow, last, deadline)).toEqual({ retry: true, delayMs: 2 * MINUTE })
    expect(planRetry({ reason: 'api-error', status: 529 }, 0, lateNow, last, deadline)).toEqual({ retry: true, delayMs: 1 * MINUTE })
  })
})

describe('statusReport and isWarm', () => {
  const warm = { deadline: 1, lastRequestAt: 0, nextAt: null, pings: 1, cacheRead: 7, cacheCreation: 3, retries: 0 }

  test('statusReport says when nothing is active and counts pings in the singular', async () => {
    expect(statusReport(undefined)).toBe('keep-warm: not active')
    expect(statusReport(warm)).toContain('1 ping,')
    expect(statusReport({ ...warm, pings: 0 })).toContain('0 pings,')
  })

  test('isWarm accepts a complete state and refuses anything else', async () => {
    expect(isWarm(warm)).toBe(true)
    expect(isWarm({ ...warm, nextAt: 5 })).toBe(true)
    expect(isWarm(null)).toBe(false)
    expect(isWarm('state')).toBe(false)
    expect(isWarm({ ...warm, deadline: 'soon' })).toBe(false)
    expect(isWarm({ ...warm, nextAt: undefined })).toBe(false)
    expect(isWarm({ deadline: 1 })).toBe(false)
  })
})

describe('formatClock and statusLine', () => {
  test('formatClock is the local hours and minutes, zero padded', async () => {
    expect(formatClock(new Date(2026, 9, 26, 9, 5).getTime())).toBe('09:05')
    expect(formatClock(new Date(2026, 9, 26, 23, 59).getTime())).toBe('23:59')
  })

  test('statusLine names the next ping and the end, or the wait for a turn', async () => {
    const next = new Date(2026, 9, 26, 10, 0).getTime()
    const end = new Date(2026, 9, 26, 13, 0).getTime()
    expect(statusLine(next, end)).toBe('keep-warm: next 10:00, until 13:00')
    expect(statusLine(null, end)).toBe('keep-warm: waiting for a turn, until 13:00')
  })
})
