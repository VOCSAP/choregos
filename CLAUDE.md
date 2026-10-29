# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Choregos is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). Each plugin under `plugins/<name>/` is a **mod**: a TypeScript hooks module (`hooks/hooks.json` lists `register.ts(x)`) that runs inside Claude Code's engine and hooks its render chain. There is no `package.json`, no bundler and no `node_modules`: the `claude` binary is the runtime, the type source (`import ... from 'claude-code'`) and the test runner.

- `prosopon` -- frames prompts and assistant blocks, dims short notes, draws a turn rule, redraws closed `Bash`/`Edit`/`Write`/`Skill`/`WebFetch`/`WebSearch`/untyped `Agent` tool headers, draws each run of two or more tool calls as one `N calls: ...` row.
- `mitos` -- rewrites bare file paths in assistant text into `[path](file:///...)` links, after checking them on disk.

## Commands

Run from the repo root; CI runs both on Ubuntu and Windows with Claude Code pinned to `2.1.303`.

```bash
claude plugin validate plugins/prosopon   # manifest, hooks file, README
claude plugin test plugins/prosopon       # every *.test.ts(x) under the folder
```

`claude plugin test` takes a plugin folder only: passing a test file fails with `no such plugin folder`, and it has no name filter, so the smallest run is one plugin's whole suite.

CI also checks that every plugin name matches `^[a-z0-9][a-z0-9-]{0,63}$`, that its `source` is `./plugins/<name>`, that the marketplace list equals the `plugins/` folders, and that `hooks/versions.ts` is byte-identical across plugins. A new plugin needs all four, and a `versions.ts` change must be copied to every plugin.

`plugins/*/.claude-plugin/types/` and `plugins/*/tsconfig.json` are written by Claude Code and gitignored.

## Architecture

**Render chain.** A plugin registers `on('ui.render', { component }, ($, e, next) => ...)`. Plugins run in load order, first loaded outermost; `next(e)` hands the event to the next plugin and finally to the stock renderer. Mitos rewrites `e.props.text` and calls `next`; Prosopon frames whatever `next(e)` returns and never redraws the agent's text itself (R9). That is why Mitos must load before Prosopon, and why neither plugin may assume it is the last one in the chain.

**Fail to stock.** Every hook guards its own preconditions (surface is `terminal`, version supported, input well formed) and on any doubt, error or exception returns `next(e)` unchanged, logging only to `$.ui.log(..., { to: 'debug' })`. Version support goes through `isSupported(version.base, capability)` in `hooks/versions.ts`: a release `MAJOR.MINOR.PATCH` at or above `MIN_SUPPORTED`; a `-dev` build stays stock.

**Engine access is capability-based.** Disk, cwd and version come from `$.fs.stat`, `$.session.cwd()`, `$.session.version()`; there is no direct Node `fs` or process access (R7). Mitos stats with `{ resolve: false }` and walks a path component by component, stopping at the first link, because traversing a Windows link to a UNC share opens an SMB connection (MT1).

**Pure logic is split from the hook.** `prosopon/hooks/layout.ts` and `mitos/hooks/linkify.ts` + `guard.ts` hold testable functions; `register.ts(x)` only wires them to engine events.

## Contract and tests

`CONTRACT.md` is the source of truth for behaviour. Requirements carry stable identifiers (`R1`..`R12` for Prosopon, `MT1`..`MT6` for Mitos), each with a matching case in `plugins/<name>/tests/contract.test.tsx`. A behaviour change updates the requirement, its test and the plugin README together.

Tests import from `claude-code/testing` and build a fake engine with `on(...)` handlers for the events the plugin consumes (`session.version`, `session.cwd`, `fs.stat`, a terminal `ui.render` that prints `engine: ...`). Fixtures must hold on both a Windows and a POSIX host: the engine hands a hook its host's spelling of a path, so Mitos tests map engine paths back to fixture keys (`fixtureKey` in `mitos/tests/contract.test.tsx`).

Draft specs for plugins not yet built live in `docs/specs/`.

## Conventions

- Commit messages: Conventional Commits with the plugin as scope, subject in French describing the resulting behaviour (`feat(mitos): ...`, `fix(prosopon): ...`, `ci: ...`).
- Code, comments, READMEs and `CONTRACT.md` are in English.

## Agent skills

### Issue tracker

Issues live as cards on the claude-peers shared roadmap (`mcp__kory-roadmap__roadmap_*`), not GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, set in the card's `triage` field. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
