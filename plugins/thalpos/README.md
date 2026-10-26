# Thalpos

Thalpos keeps the prompt cache of your conversation warm while you are away, for a period you choose. Claude Code's cache for the main conversation expires after one hour without a request; a long session resumed after that pays for a full cache write. Thalpos sends a cheap forked ping before the hour runs out. The ping is a one-line question over the conversation as the main thread last sent it; its reply is discarded and the conversation gains no turn.

## Install

```text
/plugin install thalpos@choregos
```

Thalpos runs on Claude Code `2.1.303` or any later release. A development build or an unreadable version registers nothing. It does nothing until you start it.

## Use

```text
/keep-warm start [hours]
/keep-warm stop
/keep-warm status
```

- `start` alone keeps the cache warm for 3 hours. `start 5`, `start 5h` and `start 1.5h` are accepted. A duration under 1 hour, or above `max_hours` (default 12), is refused. `start` while active replaces the deadline.
- A ping goes out 50 minutes after the latest request of the main conversation (a finished turn, or a ping). A subagent's turn does not count. A conversation in active use never pings.
- The status line shows `keep-warm: next HH:MM, until HH:MM` (local time) while active.
- At the deadline thalpos stops and shows one toast. `stop` stops it at once. `status` prints the deadline, the next ping, the ping count and the cache tokens the pings read and wrote.
- The period survives a reload of the plugin; it does not survive a restart of Claude Code.

## Stop rules

A ping that reads nothing from the cache, or that writes a tenth or more of what it reads, means the cache was already cold: thalpos stops and says why in a toast. An API error 429, 529 or 5xx is retried after 1, 2 then 4 minutes, as long as the retry lands before the deadline and before the hour since the latest request runs out; any other failure stops thalpos with a toast. A ping is never sent to a cache known to be cold. If there is nothing to ping yet (no turn since the start or since `/clear`), thalpos waits for the next turn.

## Cost

Each ping reads the whole conversation from the cache and writes almost nothing, which is billed at the cache read rate. Over a 3 hour period that is about three pings. Thalpos assumes a one-hour cache lifetime and has no option for it.

## API key sessions

With an API key the cache lifetime is five minutes unless you set `promptCacheTtl` to `"1h"`. Without it the first ping reads nothing and thalpos stops. Set it before starting.

## Option

`max_hours` (number, default 12) is the longest period `start` accepts.

## Credit

The warming rules (50 minute period, retry after 1, 2 and 4 minutes, stop when a ping reads nothing or writes a tenth of what it reads) come from [cache-tax](https://github.com/karanb192/cache-tax) by karanb192, MIT licensed.
