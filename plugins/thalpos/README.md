# Thalpos

Thalpos keeps the prompt cache of your conversation warm while you are away, for a period you choose. Claude Code's cache for the main conversation expires after one hour without a request; a long session resumed after that pays for a full cache write. Thalpos sends a cheap forked ping before the hour runs out. The ping is a one-line question over the conversation as the main thread last sent it; its reply is discarded and the conversation gains no turn.

## Install

```text
/plugin install thalpos@choregos
```

Thalpos runs on Claude Code `2.1.303` or any later release. A development build or an unreadable version registers nothing. It does nothing until you start it, by hand or with `THALPOS_AUTOSTART` (see Automatic start).

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

## Automatic start

Thalpos can start by itself when the session starts, with no command. Two things must be set, by two different people:

1. **You consent once**, with the `autostart` plugin option (boolean, off by default). Turn it on from the `/config` menu, or add this exact object to your user `settings.json`. Claude Code reads plugin options from your user settings only, never from a project file.

   ```json
   {"pluginConfigs":{"thalpos@choregos":{"options":{"autostart":true}}}}
   ```

2. **The project chooses** where and for how long, with the `THALPOS_AUTOSTART` variable, set in the shell or in the `env` block of a `.claude/settings.json` or `.claude/settings.local.json`.

The variable alone starts nothing. The reason is that a project's `.claude/settings.json` is usually committed: without the option, any repository you open could make Claude Code send pings on your account just by carrying that file. With the option off and the variable set, thalpos does nothing, shows no toast, and writes one line to the debug log (`claude --debug`).

Once both are set, the period runs from your last activity: each finished turn of the main conversation moves the deadline to now plus the duration, so the cache stays warm for as long as the conversation is quiet for less than that duration. A ping still goes out 50 minutes after the latest request. When a full duration passes with no turn the period ends with its toast, and the next finished turn starts a new one. `/keep-warm start` keeps its fixed deadline, also when it replaces an automatic period. `/keep-warm status` says `(automatic)` for an automatic period.

| Value | Period |
| --- | --- |
| `1` or `true` | 3 hours |
| `3`, `5h`, `1.5h` | that many hours, from 1 up to `max_hours` |
| unset, blank, `0`, `false`, `off`, `no` (any case) | no automatic start, silently |
| anything else | no start, and one toast at session start names the variable |

Claude Code gives thalpos the variable whether it comes from the shell or from the `env` block of a `settings.json`, so one project can choose a duration without touching the others, provided you consented. In `.claude/settings.json` of the project (or `.claude/settings.local.json`, or the user `settings.json`):

```json
{
  "env": {
    "THALPOS_AUTOSTART": "2h"
  }
}
```

A narrower file can switch a value set higher up off: `"THALPOS_AUTOSTART": "off"` in `.claude/settings.local.json` silences a project value, with no toast.

- `/keep-warm stop` also turns automatic start off, whether or not a period was active, until the session ends. A reload of the plugin keeps it off.
- `/clear` ends the session and empties the state thalpos keeps, without starting the session again: the first turn after a `/clear` starts the automatic period, and a stop made before it no longer applies.
- When a ping finds the cache cold and stops an automatic period, automatic start is off until `/clear` or a restart of Claude Code, and the toast says so. This is what a five minute cache without `promptCacheTtl` does. Any other stop of an automatic period (a failed ping, the end of the period) is followed by a new period at the next finished turn.
- A turn that finishes while a deadline or ping callback is completing keeps the turn's later deadline and ping schedule.
- A development build or an unsupported release starts nothing.

## Stop rules

A ping that reads nothing from the cache, or that writes a tenth or more of what it reads, means the cache was already cold: thalpos stops and says why in a toast. An API error 429, 529 or 5xx is retried after 1, 2 then 4 minutes, as long as the retry lands before the deadline and before the hour since the latest request runs out; any other failure stops thalpos with a toast. A ping is never sent to a cache known to be cold. If there is nothing to ping yet (no turn since the start or since `/clear`), thalpos waits for the next turn.

## Cost

Each ping reads the whole conversation from the cache and writes almost nothing, which is billed at the cache read rate. Over a 3 hour period that is about three pings. With automatic start, each stretch of inactivity costs up to `floor(hours * 60 / 50)` pings (3 for 3 hours), and a new period starts at every return, so a conversation you leave and come back to several times a day pays those pings again each time. Thalpos assumes a one-hour cache lifetime and has no option for it.

## API key sessions

With an API key the cache lifetime is five minutes unless you set `promptCacheTtl` to `"1h"`. Without it the first ping reads nothing and thalpos stops. Set it before starting.

## Option

`max_hours` (number, default 12) is the longest period `start` accepts.

`autostart` (boolean, default off) lets the `THALPOS_AUTOSTART` variable start a period by itself (see Automatic start). It changes nothing for `/keep-warm`.

## Credit

The warming rules (50 minute period, retry after 1, 2 and 4 minutes, stop when a ping reads nothing or writes a tenth of what it reads) come from [cache-tax](https://github.com/karanb192/cache-tax) by karanb192, MIT licensed.
