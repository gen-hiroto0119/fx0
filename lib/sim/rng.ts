// Deterministic randomness: the same seed must always produce the same region,
// because terrain is regenerated from the seed instead of being stored.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash2(seed: number, ix: number, iy: number): number {
  let h = (seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smooth = (t: number) => t * t * (3 - 2 * t)

export function valueNoise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = smooth(x - ix)
  const fy = smooth(y - iy)
  const a = hash2(seed, ix, iy)
  const b = hash2(seed, ix + 1, iy)
  const c = hash2(seed, ix, iy + 1)
  const d = hash2(seed, ix + 1, iy + 1)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

// Fractal noise in [0, 1).
export function fbm(seed: number, x: number, y: number, octaves = 4): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let freq = 1
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(seed + o * 1013, x * freq, y * freq) * amp
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}
