import { describe, expect, test } from 'bun:test'

import { HashFallbackEmbedder } from '../src/embedder'
import { DictionaryEmbedder } from './test-utils'

function l2Norm(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

describe('HashFallbackEmbedder', () => {
  test('reports correct dimensionality', async () => {
    const e = new HashFallbackEmbedder(64)
    expect(e.dim).toBe(64)
    const [v] = await e.embed(['hello world'])
    expect(v.length).toBe(64)
  })

  test('vectors are L2-normalized', async () => {
    const e = new HashFallbackEmbedder(32)
    const vecs = await e.embed(['some example text', 'another one'])
    for (const v of vecs) {
      expect(l2Norm(v)).toBeCloseTo(1, 5)
    }
  })

  test('identical inputs produce identical vectors', async () => {
    const e = new HashFallbackEmbedder(32)
    const [a] = await e.embed(['function getUser() {}'])
    const [b] = await e.embed(['function getUser() {}'])
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i])
  })

  test('empty input returns empty array', async () => {
    const e = new HashFallbackEmbedder(8)
    expect(await e.embed([])).toEqual([])
  })
})

describe('Embedder interface', () => {
  test('DictionaryEmbedder gives semantically meaningful similarity', async () => {
    const e = new DictionaryEmbedder(['user', 'account', 'pasta'])
    const [a, b, c] = await e.embed([
      'lookup a user account by id',
      'fetch an account profile',
      'cook pasta with tomatoes',
    ])
    const dot = (x: Float32Array, y: Float32Array) => {
      let s = 0
      for (let i = 0; i < x.length; i++) s += x[i] * y[i]
      return s
    }
    expect(dot(a, b)).toBeGreaterThan(dot(a, c))
  })
})
