// @ts-expect-error Node strip-types tests require the source extension.
import { fbm } from './rng.ts'
import type { City, CityKind, Resource, Terrain, TileKind } from './types.ts'

// The region tilts from sea in the west up to mountains in the east, so every
// seed has a coast, a plain and a mountain range for the three cities.
export function generateTerrain(seed: number, size: number): Terrain {
  const height: number[] = new Array(size * size)
  const kind: TileKind[] = new Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(seed, (x / size) * 4, (y / size) * 4)
      height[y * size + x] = 0.5 * n + 0.7 * (x / size) - 0.1
    }
  }
  for (let i = 0; i < size * size; i++) {
    const h = height[i]
    const forest = fbm(seed + 77, (i % size) / 10, Math.floor(i / size) / 10, 2)
    if (h < 0.15) kind[i] = 'sea'
    else if (h > 0.78) kind[i] = 'mountain'
    else if (h > 0.6) kind[i] = forest > 0.6 ? 'forest' : 'hill'
    else kind[i] = forest > 0.66 ? 'forest' : 'plain'
  }
  carveRiver(size, height, kind)

  const terrain: Terrain = { size, height, kind, resources: [] }
  terrain.resources = placeResources(terrain)
  return terrain
}

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

function carveRiver(size: number, height: number[], kind: TileKind[]) {
  // Start at the highest tile in the middle band and walk downhill to the sea.
  let start = -1
  for (let y = Math.floor(size * 0.4); y < Math.floor(size * 0.6); y++) {
    for (let x = Math.floor(size * 0.6); x < size; x++) {
      const i = y * size + x
      if (start < 0 || height[i] > height[start]) start = i
    }
  }
  const seen = new Set<number>()
  let cur = start
  for (let step = 0; step < size * 4 && cur >= 0; step++) {
    if (kind[cur] === 'sea') return
    seen.add(cur)
    kind[cur] = 'river'
    const cx = cur % size
    const cy = Math.floor(cur / size)
    let next = -1
    let bestScore = Infinity
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const n = ny * size + nx
      if (seen.has(n)) continue
      // Prefer downhill, and drift west so the river always reaches the coast.
      const score = height[n] + dx * 0.02
      if (score < bestScore) {
        bestScore = score
        next = n
      }
    }
    cur = next
  }
}

function placeResources(t: Terrain): Resource[] {
  const out: Resource[] = []
  const port = nearest(t, t.size * 0.2, t.size * 0.3, (i) => t.kind[i] === 'plain' && touches(t, i, 'sea'))
  if (port >= 0) out.push({ kind: 'port', x: port % t.size, y: Math.floor(port / t.size) })
  const onsen = nearest(t, t.size * 0.75, t.size * 0.3, (i) => t.kind[i] === 'hill' && touches(t, i, 'mountain'))
  if (onsen >= 0) out.push({ kind: 'onsen', x: onsen % t.size, y: Math.floor(onsen / t.size) })
  const ore = nearest(t, t.size * 0.85, t.size * 0.75, (i) => t.kind[i] === 'mountain')
  if (ore >= 0) out.push({ kind: 'ore', x: ore % t.size, y: Math.floor(ore / t.size) })
  return out
}

function touches(t: Terrain, i: number, k: TileKind): boolean {
  const x = i % t.size
  const y = Math.floor(i / t.size)
  return NEIGHBORS.some(([dx, dy]) => {
    const nx = x + dx
    const ny = y + dy
    return nx >= 0 && ny >= 0 && nx < t.size && ny < t.size && t.kind[ny * t.size + nx] === k
  })
}

export function nearest(t: Terrain, px: number, py: number, ok: (i: number) => boolean): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < t.size * t.size; i++) {
    if (!ok(i)) continue
    const d = (i % t.size - px) ** 2 + (Math.floor(i / t.size) - py) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

const CITY_SPECS: { id: string; name: string; kind: CityKind; persona: City['persona']; at: [number, number]; tile: TileKind }[] = [
  { id: 'A', name: '港市', kind: 'port', persona: 'industry', at: [0.22, 0.3], tile: 'plain' },
  { id: 'B', name: '平野市', kind: 'plain', persona: 'prudent', at: [0.4, 0.72], tile: 'plain' },
  { id: 'C', name: '湯山市', kind: 'mountain', persona: 'tourism', at: [0.68, 0.32], tile: 'hill' },
]

export function placeCities(t: Terrain): City[] {
  return CITY_SPECS.map((s) => {
    const port = t.resources.find((r) => r.kind === 'port')
    const [px, py] = s.kind === 'port' && port ? [port.x + 2, port.y] : [s.at[0] * t.size, s.at[1] * t.size]
    const i = nearest(t, px, py, (j) => t.kind[j] === s.tile || t.kind[j] === 'plain')
    return { id: s.id, name: s.name, kind: s.kind, persona: s.persona, x: i % t.size, y: Math.floor(i / t.size) }
  })
}

export function tileKind(t: Terrain, x: number, y: number): TileKind {
  return t.kind[y * t.size + x]
}
