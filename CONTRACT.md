# Prosopon contract

Each requirement has a stable identifier and a matching `claude plugin test` case.

**Scope.** R1, R2, R3, R5 and R8 constrain what Prosopon adds or creates around the agent's text: the frame, its ornaments and any link it builds. The agent's Markdown passes through unchanged and would render the same in Claude Code's stock renderer, so these rules do not inspect it. R4 is the exception: it reads the agent's content. In M0 the dimmed summary line (`dim`) keeps the stock renderer until L2's differential capture of the stock and plugin renders, because its indentation changes where lines wrap.

- **R1** -- A frame added by Prosopon uses only `┌┐└┘─│`; Prosopon adds no round-corner glyph `╭╮╰╯`.
- **R2** -- Prosopon adds no line matching the numbered picker cue `^\s*❯\s+\d+\.`.
- **R3** -- Prosopon adds no line exactly `columns` wide made only of `─`, bare or with a central label.
- **R4** -- A short limit or quota message (at most 400 characters and 3 lines, holding `limit`, `reset`, `quota`, `overloaded` or `usage`) remains in Claude Code's stock renderer.
- **R5** -- Prosopon adds no spinner glyph and no spinner-row cue, including the ASCII `*` frame followed by a verb and an ellipsis.
- **R6** -- Layout support requires `SessionVersion.base` to be a release `MAJOR.MINOR.PATCH` at or above the minimum supported version (`2.1.303`), compared numerically component by component; an absent, `-dev`, unreadable or older version uses the stock renderer.
- **R7** -- Any malformed layout input or rendering error uses the stock renderer. Prosopon performs no network or process access and only permits filesystem existence checks when such checks are introduced.
- **R8** -- Prosopon creates no link of its own in M0. A link it creates may use only `http:`, `https:`, or `file:`, is at most 2048 characters, defines no plugin-specific scheme, and never executes while read.
