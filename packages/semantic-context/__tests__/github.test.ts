import { describe, expect, test } from 'bun:test'

import { parseOrgFromUrl } from '../src/github'

describe('parseOrgFromUrl', () => {
  test('extracts the org/user slug from common URL forms', () => {
    expect(parseOrgFromUrl('github.com/myorg')).toBe('myorg')
    expect(parseOrgFromUrl('https://github.com/myorg')).toBe('myorg')
    expect(parseOrgFromUrl('https://github.com/myorg/')).toBe('myorg')
    expect(parseOrgFromUrl('http://www.github.com/myorg/some-repo')).toBe('myorg')
    expect(parseOrgFromUrl('myorg')).toBe('myorg')
    expect(parseOrgFromUrl('github.com/myorg/repo.git')).toBe('myorg')
  })

  test('returns empty string for junk', () => {
    expect(parseOrgFromUrl('')).toBe('')
    expect(parseOrgFromUrl('https://github.com/')).toBe('')
  })
})
