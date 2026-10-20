import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsStat, On, SessionVersion } from 'claude-code'

const PLUGIN = 'mitos'
const SUPPORTED: SessionVersion = { version: '2.1.303', base: '2.1.303' }
const CWD = 'C:\\proj'

type Entry = { kind: FsStat['kind']; isLink?: boolean }

const DISK: Record<string, Entry> = {
  'C:/proj/src': { kind: 'dir' },
  'C:/proj/src/a.ts': { kind: 'file' },
  'C:/proj/src/b.md': { kind: 'file' },
  'C:/proj/src/page.html': { kind: 'file' },
  'C:/proj/src/tool.exe': { kind: 'file' },
  'C:/proj/src/tool.js': { kind: 'file' },
  'C:/proj/src/UPPER.JS': { kind: 'file' },
  'C:/proj/src/a.md.js': { kind: 'file' },
  'C:/proj/src/lib.d': { kind: 'dir' },
  'C:/proj/src/folder.md': { kind: 'dir' },
  'C:/proj/src/linked.md': { kind: 'file', isLink: true },
  'C:/proj/docs': { kind: 'other', isLink: true },
  'C:/proj/docs/x.md': { kind: 'file' },
  'C:/proj/enc': { kind: 'dir' },
  'C:/proj/enc/a%b#é.md': { kind: 'file' },
  'C:/Windows': { kind: 'dir' },
  'C:/Windows/win.ini': { kind: 'file' },
  'C:/proj/README.md': { kind: 'file' },
  'C:/ext': { kind: 'other', isLink: true },
  'C:/ext/x.md': { kind: 'file' },
  'C:/proj2': { kind: 'other', isLink: true },
  'C:/proj2/a.md': { kind: 'file' },
}

type World = { stats: string[]; logs: string[] }

// The engine hands the hook its host's spelling of the path mitos asked for: a Windows host
// uses backslashes and puts a rooted POSIX path on the current drive; a POSIX host does not
// know `C:/x` as absolute and joins it under the plugin folder. Both map back to the fixture key.
function fixtureKey(enginePath: string, disk: Record<string, Entry>): string {
  const slashed = enginePath.replace(/\\/g, '/')
  const driveForm = /(?:^|\/)([A-Za-z]:\/.*)$/.exec(slashed)?.[1]
  const rootedForm = slashed.replace(/^[A-Za-z]:(?=\/)/, '')
  return [slashed, driveForm, rootedForm].find((key) => key !== undefined && key in disk) ?? driveForm ?? slashed
}

function world(on: On, options: { version?: SessionVersion | 'reject'; cwd?: string | 'reject'; disk?: Record<string, Entry> } = {}): World {
  const { version = SUPPORTED, cwd = CWD, disk = DISK } = options
  const seen: World = { stats: [], logs: [] }
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine: {String(e.props.text)}</Text>
  })
  on('session.version', () => (version === 'reject' ? { deny: 'version unavailable' } : { value: version }))
  on('session.cwd', () => (cwd === 'reject' ? { deny: 'cwd unavailable' } : { value: cwd }))
  on('fs.stat', (_$, e) => {
    const path = fixtureKey(e.path, disk)
    seen.stats.push(path)
    const entry = disk[path]
    if (entry === undefined) return { deny: `failed: ENOENT` }
    return { value: { kind: entry.kind, size: 1, mtimeMs: 0, isLink: entry.isLink === true } }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(String(e.to))
    return { value: undefined }
  })
  return seen
}

async function rendered($: Engine, text: unknown, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string | undefined> {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true } as never,
    viewport: { columns: 120, rows: 40 },
  })
  return (await ui.find({ type: 'Text', text: /^engine: / }))?.text?.replace(/^engine: /, '')
}

describe('links', () => {
  test('links an existing relative file and keeps the line number in the label only', async ($, on) => {
    world(on)
    expect(await rendered($, 'See src/a.ts:42 now.')).toBe('See [src/a.ts:42](file:///C:/proj/src/a.ts) now.')
  })

  test('links an absolute path inside and outside the session directory', async ($, on) => {
    world(on)
    expect(await rendered($, 'C:\\proj\\src\\b.md and C:\\Windows\\win.ini')).toBe(
      '[C:\\\\proj\\\\src\\\\b.md](file:///C:/proj/src/b.md) and [C:\\\\Windows\\\\win.ini](file:///C:/Windows/win.ini)',
    )
  })

  test('links a POSIX path under a POSIX session directory', async ($, on) => {
    world(on, { cwd: '/home/u', disk: { '/home/u/src': { kind: 'dir' }, '/home/u/src/a.ts': { kind: 'file' } } })
    expect(await rendered($, 'src/a.ts')).toBe('[src/a.ts](file:///home/u/src/a.ts)')
  })

  test('links a POSIX absolute path outside a POSIX session directory and stops at a link', async ($, on) => {
    const seen = world(on, {
      cwd: '/home/u',
      disk: {
        '/opt': { kind: 'dir' },
        '/opt/notes.md': { kind: 'file' },
        '/home/u/docs': { kind: 'other', isLink: true },
        '/home/u/docs/x.md': { kind: 'file' },
      },
    })
    expect(await rendered($, '/opt/notes.md docs/x.md')).toBe('[/opt/notes.md](file:///opt/notes.md) docs/x.md')
    expect(seen.stats).toContain('/home/u/docs')
    expect(seen.stats).not.toContain('/home/u/docs/x.md')
  })

  test('percent-encodes %, # and non-ASCII characters of the target', async ($, on) => {
    world(on)
    expect(await rendered($, 'enc/a%b#é.md')).toBe('[enc/a%b#é.md](file:///C:/proj/enc/a%25b%23%C3%A9.md)')
  })

  test('is idempotent', async ($, on) => {
    world(on)
    const once = await rendered($, 'src/a.ts and C:\\Windows\\win.ini')
    expect(await rendered($, once)).toBe(once)
  })
})

describe('existence and links on disk', () => {
  test('leaves a missing path, a directory and a non-file unchanged', async ($, on) => {
    world(on)
    const text = 'src/missing.ts src/folder.md src/lib.d'
    expect(await rendered($, text)).toBe(text)
  })

  test('stops at a symbolic link and never stats beneath it', async ($, on) => {
    const seen = world(on)
    expect(await rendered($, 'docs/x.md')).toBe('docs/x.md')
    expect(seen.stats).toContain('C:/proj/docs')
    expect(seen.stats).not.toContain('C:/proj/docs/x.md')
  })

  test('stops at a symbolic link outside the session directory and never stats beneath it', async ($, on) => {
    const seen = world(on)
    expect(await rendered($, 'C:\\ext\\x.md')).toBe('C:\\ext\\x.md')
    expect(seen.stats).toContain('C:/ext')
    expect(seen.stats).not.toContain('C:/ext/x.md')
  })

  test('walks a sibling whose name only starts like the session directory from its root', async ($, on) => {
    const seen = world(on)
    expect(await rendered($, 'C:\\proj2\\a.md')).toBe('C:\\proj2\\a.md')
    expect(seen.stats).toContain('C:/proj2')
    expect(seen.stats).not.toContain('C:/proj2/a.md')
  })

  test('leaves a file that is itself a symbolic link unchanged', async ($, on) => {
    world(on)
    expect(await rendered($, 'src/linked.md')).toBe('src/linked.md')
  })
})

describe('refused spellings', () => {
  for (const path of ['\\\\host\\share\\a.md', '//host/share/a.md', '\\\\?\\C:\\proj\\README.md', '\\\\.\\C:\\proj\\README.md']) {
    test(`leaves ${path} unchanged without any stat`, async ($, on) => {
      const seen = world(on)
      expect(await rendered($, `see ${path}`)).toBe(`see ${path}`)
      expect(seen.stats).toEqual([])
    })
  }
})

describe('length', () => {
  const longDisk = (name: string): Record<string, Entry> => ({ 'C:/proj/l': { kind: 'dir' }, [`C:/proj/l/${name}`]: { kind: 'file' } })
  const prefix = 'file:///C:/proj/l/'
  const nameFor = (hrefLength: number) => `${'a'.repeat(hrefLength - prefix.length - 3)}.md`

  test('links a target of exactly 2048 characters', async ($, on) => {
    const name = nameFor(2048)
    world(on, { disk: longDisk(name) })
    expect(await rendered($, `l/${name}`)).toBe(`[l/${name}](${prefix}${name})`)
  })

  test('leaves a target over 2048 characters once encoded unchanged', async ($, on) => {
    const name = `${'é'.repeat(400)}.md`
    world(on, { disk: longDisk(name) })
    expect(await rendered($, `l/${name}`)).toBe(`l/${name}`)
  })
})

describe('untouched zones', () => {
  const zones = [
    '```\nsrc/a.ts\n```',
    '~~~ts\nsrc/a.ts\n~~~',
    'run `src/a.ts` now',
    '[a](src/a.ts)',
    '![a](src/b.md)',
    '<src/a.ts>',
    'https://example.com/?f=src/a.ts',
  ]
  for (const text of zones) {
    test(`leaves ${JSON.stringify(text)} unchanged`, async ($, on) => {
      world(on)
      expect(await rendered($, text)).toBe(text)
    })
  }
})

describe('cap', () => {
  test('links at most 32 distinct paths in one message', async ($, on) => {
    const disk: Record<string, Entry> = { 'C:/proj/m': { kind: 'dir' } }
    const names = Array.from({ length: 40 }, (_, i) => `m/f${i}.md`)
    for (const name of names) disk[`C:/proj/${name}`] = { kind: 'file' }
    world(on, { disk })
    const out = await rendered($, names.join(' '))
    expect(out?.match(/\]\(file:/g)?.length).toBe(32)
  })
})

describe('size bounds', () => {
  test('a reply over 64 KiB passes through without any check on disk', async ($, on) => {
    const seen = world(on)
    const text = `src/a.ts ${'x'.repeat(64 * 1024)}`
    expect(await rendered($, text)).toBe(text)
    expect(seen.stats).toEqual([])
  })

  test('a whitespace-free run longer than 2048 characters is not scanned', async ($, on) => {
    const seen = world(on)
    const text = `src/a.ts,${'y'.repeat(2100)}`
    expect(await rendered($, text)).toBe(text)
    expect(seen.stats).toEqual([])
  })
})

describe('extension allow-list', () => {
  test('the default list leaves html, exe and js unlinked', async ($, on) => {
    world(on)
    expect(await rendered($, 'src/page.html src/tool.exe src/tool.js')).toBe('src/page.html src/tool.exe src/tool.js')
  })

  test('a js file stays unlinked when configuration adds js, whatever its case or inner extension', { options: { allowed_extensions: ['js', 'md'] } }, async ($, on) => {
    world(on)
    const text = 'src/tool.js src/UPPER.JS src/a.md.js src/b.md'
    expect(await rendered($, text)).toBe('src/tool.js src/UPPER.JS src/a.md.js [src/b.md](file:///C:/proj/src/b.md)')
  })

  test('a configured list replaces the default one', { options: { allowed_extensions: ['html'] } }, async ($, on) => {
    world(on)
    expect(await rendered($, 'src/page.html src/b.md')).toBe('[src/page.html](file:///C:/proj/src/page.html) src/b.md')
  })

  test('an executable extension added by configuration is still never linked', { options: { allowed_extensions: ['exe', '.EXE', 'md'] } }, async ($, on) => {
    const seen = world(on)
    expect(await rendered($, 'src/tool.exe src/b.md')).toBe('src/tool.exe [src/b.md](file:///C:/proj/src/b.md)')
    expect(seen.logs).toEqual(['debug'])
  })
})

describe('R4 quota', () => {
  test('a short limit message stays as written', async ($, on) => {
    world(on)
    const text = "You've hit your limit · resets 10pm, see src/a.ts"
    expect(await rendered($, text)).toBe(text)
  })
})

describe('R6 version', () => {
  const unsupported: Array<[string, SessionVersion]> = [
    ['an older release', { version: '2.1.302', base: '2.1.302' }],
    ['a -dev build', { version: '2.1.304-dev.20261020', base: '2.1.304-dev' }],
    ['an absent base', { version: '2.1.304' }],
  ]
  for (const [label, version] of unsupported) {
    test(`leaves the text unchanged on ${label}`, async ($, on) => {
      world(on, { version })
      expect(await rendered($, 'src/a.ts')).toBe('src/a.ts')
    })
  }

  test('links on a later release', async ($, on) => {
    world(on, { version: { version: '2.2.0', base: '2.2.0' } })
    expect(await rendered($, 'src/a.ts')).toBe('[src/a.ts](file:///C:/proj/src/a.ts)')
  })
})

describe('R7 fail open', () => {
  test('a rejected session.version leaves the text unchanged and logs to debug', async ($, on) => {
    const seen = world(on, { version: 'reject' })
    expect(await rendered($, 'src/a.ts')).toBe('src/a.ts')
    expect(seen.logs).toEqual(['debug'])
  })

  test('a rejected session.cwd leaves the text unchanged and logs to debug', async ($, on) => {
    const seen = world(on, { cwd: 'reject' })
    expect(await rendered($, 'src/a.ts')).toBe('src/a.ts')
    expect(seen.logs).toEqual(['debug'])
  })

  test('another surface passes the text through', async ($, on) => {
    world(on)
    expect(await rendered($, 'src/a.ts', 'desktop')).toBe('src/a.ts')
  })

  test('a non-string text passes through untouched', async ($, on) => {
    world(on)
    expect(await rendered($, 42)).toBe('42')
  })
})
