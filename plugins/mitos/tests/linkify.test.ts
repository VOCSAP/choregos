import { describe, expect, test } from 'claude-code/testing'

import { resolveHrefs } from '../hooks/guard'
import { allowedExtensions, encodeFileHref, EXECUTABLE_FLOOR, refusedSpelling, toAbsolute } from '../hooks/linkify'

describe('href resolution', () => {
  test('never stats a refused spelling, whatever produced the path', async () => {
    const stats: string[] = []
    const stat = async (path: string) => {
      stats.push(path)
      return { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }
    }
    const paths = ['\\\\host\\share\\a.md', '//host/share/a.md', '\\\\?\\C:\\a.md', 'C:a.md', 'C:\\a.md:secret']
    const hrefs = await resolveHrefs(paths, { cwd: 'C:\\proj', allowed: new Set(['md']), stat }, 32)
    expect([...hrefs]).toEqual([])
    expect(stats).toEqual([])
  })
})

describe('refused spellings', () => {
  const refused: Array<[string, string]> = [
    ['\\\\host\\share\\a.md', 'network or device path'],
    ['//host/share/a.md', 'network or device path'],
    ['\\\\?\\C:\\a.md', 'network or device path'],
    ['\\\\.\\C:\\a.md', 'network or device path'],
    ['C:a.md', 'drive-relative path'],
    ['C:\\a.md:secret', 'alternate data stream'],
    ['a.md:secret', 'alternate data stream'],
    [`a${String.fromCharCode(7)}.md`, 'control character'],
    ['bin.exe.\\', 'trailing dot or space'],
    ['C:\\proj\\bin.exe \\x.md', 'trailing dot or space'],
    ['src/a.md.', 'trailing dot or space'],
    ['.../a.md', 'trailing dot or space'],
  ]
  for (const [path, reason] of refused) {
    test(`refuses ${JSON.stringify(path)}`, () => {
      expect(refusedSpelling(path)).toBe(reason)
    })
  }

  test('accepts a local absolute and a relative path', () => {
    expect(refusedSpelling('C:\\proj\\a.md')).toBeUndefined()
    expect(refusedSpelling('src/a.md')).toBeUndefined()
  })

  test('accepts dot segments and a leading dot', () => {
    expect(refusedSpelling('../src/./a.md')).toBeUndefined()
    expect(refusedSpelling('..')).toBeUndefined()
    expect(refusedSpelling('C:\\proj\\.git\\')).toBeUndefined()
  })
})

describe('absolute target', () => {
  test('folds dot segments and refuses climbing above the root', () => {
    expect(toAbsolute('../x/./a.md', 'C:\\proj\\src')).toBe('C:/proj/x/a.md')
    expect(toAbsolute('../../../a.md', 'C:\\proj')).toBeUndefined()
  })

  test('encodes a POSIX target with two slashes after the scheme', () => {
    expect(encodeFileHref('/home/u/a b.md')).toBe('file:///home/u/a%20b.md')
  })
})

describe('allowed extensions', () => {
  test('normalizes entries and drops invalid ones and the executable floor', () => {
    const { allowed, refused } = allowedExtensions(['.MD', ' ts ', 'exe', 'a.b', '', 3])
    expect([...allowed]).toEqual(['md', 'ts'])
    expect(refused).toEqual(['exe', 'a.b', '', '3'])
  })

  test('keeps every executable extension in the floor', () => {
    expect([...EXECUTABLE_FLOOR].sort()).toEqual(
      [
        'appref-ms', 'bat', 'cmd', 'com', 'exe', 'hta', 'jar', 'lnk', 'msi', 'ps1', 'psm1', 'reg', 'scr', 'sh', 'url', 'vbs',
        'js', 'jse', 'vbe', 'wsf', 'wsh', 'msc', 'cpl', 'pif', 'chm', 'scf', 'settingcontent-ms', 'application', 'gadget',
      ].sort(),
    )
  })
})
