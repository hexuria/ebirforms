import { existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadCatalog } from '../src/index.js'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const packageDir = join(repositoryRoot, 'vendor', 'buwiz-validation', 'package')
const frozenDir = join(repositoryRoot, 'vendor', 'buwiz-forms-html', 'html-frozen')
const catalog = loadCatalog(packageDir, frozenDir)

describe('official form catalog', () => {
  test('contains the 79 active options', () => {
    expect(catalog).toHaveLength(79)
  })

  test('does not include commented-out options', () => {
    const codes = catalog.map((entry) => entry.code)
    expect(codes).not.toContain('0620')
    expect(codes).not.toContain('1621')
    expect(codes).not.toContain('1709')
    expect(codes).not.toContain('2550DS')
  })

  test('has an existing HTA for every catalog entry', () => {
    expect(catalog.every((entry) => existsSync(join(packageDir, entry.htaFile)))).toBe(true)
  })

  test('maps each frozen form directory exactly once', () => {
    const printableSlugs = catalog.flatMap((entry) =>
      entry.printable ? [basename(entry.printable)] : [],
    )
    const frozenSlugs = readdirSync(frozenDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !['assets', 'fonts', 'keys'].includes(entry.name))
      .map((entry) => entry.name)
      .sort()

    expect(printableSlugs).toHaveLength(43)
    expect(new Set(printableSlugs).size).toBe(43)
    expect(printableSlugs.sort()).toEqual(frozenSlugs)
    expect(catalog.filter((entry) => entry.printable)).toHaveLength(43)
  })

  test('resolves every printable directory', () => {
    expect(
      catalog
        .filter((entry) => entry.printable)
        .every((entry) => existsSync(entry.printable!)),
    ).toBe(true)
  })
})
