# Issue tracker: claude-peers roadmap

Issues and specs for this repo live as cards on the claude-peers shared roadmap, scoped to this repository and shared by every session. Use the `mcp__claude-peers__roadmap_*` tools; GitHub Issues are not used.

## Conventions

- **Create a card**: `roadmap_add` with `title`, `kind` (feature, bug, debt, idea, chore), `priority`, `triage`, `tags`, a `description`, and always `context`: the briefing a session with none of this one's context needs (objective, scope, files, acceptance criteria, decisions).
- **Read a card**: `roadmap_get id` (full id or 8-character prefix), `with_documents: true` for attached documents.
- **List cards**: `roadmap_list` always with a filter (`statuses`, `triages`, `tags`, `kinds`, `q`).
- **Parent / child**: no native sub-cards. Tag the child `part-of:<parent-id8>` and put `Part of <parent-id8>` at the top of its description.
- **Comment**: `roadmap_append_context id text`. Never `roadmap_update context`, which replaces the whole field.
- **Triage state**: `roadmap_update id triage=<role>`; other labels go in `tags`.
- **Close**: `roadmap_update id status=done`. A rejected card: `triage=wontfix` with `priority=wont`.

`status` (idea, planned, in_progress, done) is independent of `triage`. `in_progress` locks the card under your peer_id: set it only when work starts, back to `planned` if you stop before finishing.

## When a skill says "publish to the issue tracker"

Create a card with `roadmap_add`.

## When a skill says "fetch the relevant ticket"

Read it with `roadmap_get`; the user normally passes the id or its prefix.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a card with **child** cards as tickets.

- **Map**: a card tagged `wayfinder:map`, whose `description` holds the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a card tagged `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`) and `part-of:<map-id8>`.
- **Blocking**: the child's `depends_on` lists its blockers' ids. A ticket is unblocked when every card it depends on is `done`.
- **Frontier**: `roadmap_list tags:["part-of:<map-id8>"] statuses:["idea","planned"]`, drop cards with an unfinished dependency; first in queue order wins.
- **Claim**: `roadmap_update id status=in_progress`, the session's first write (it also locks the card).
- **Resolve**: `roadmap_append_context` with the answer, `status=done`, then append a context pointer (gist + id) to the map's Decisions-so-far with `roadmap_append_context`.
