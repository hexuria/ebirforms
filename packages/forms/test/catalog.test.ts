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

  test('assigns a return frequency to every active form', () => {
    const frequency = (code: string) => catalog.find((entry) => entry.code === code)?.frequency
    expect(frequency('1601Cv2018')).toBe('monthly')
    expect(frequency('0619E')).toBe('monthly')
    expect(frequency('2551Qv2018')).toBe('quarterly')
    expect(frequency('1601EQ')).toBe('quarterly')
    expect(frequency('1604C')).toBe('annual')
    expect(frequency('1701Qv2018')).toBe('quarterly')
    expect(frequency('1701A')).toBe('annual')
    expect(frequency('2550M')).toBe('monthly')
    expect(catalog.every((entry) => ['monthly', 'quarterly', 'annual'].includes(entry.frequency))).toBe(true)
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
