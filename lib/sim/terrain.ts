// @ts-expect-error Node strip-types tests require the source extension.
import { fbm } from './rng.ts'
import type { City, CityKind, Resource, Terrain, TileKind } from './types.ts'

const NOISE_SCALE = 4 // noise cells across the map: the size of hills and valleys
const WARP = 0.8 // how far (in noise cells) valleys are bent sideways
const RIVER_MIN_CATCHMENT = 900 // tiles draining through a tile before it is drawn as river
// Water routing sees the height plus a smooth wobble of about this size, so
// rivers swing back and forth even on an even slope.
const MEANDER_AMPLITUDE = 0.2
const MEANDER_TILES = 12 // wavelength of the wobble, in tiles

// The region tilts from sea in the west up to mountains in the east, so every
// seed has a coast, a plain and a mountain range for the three cities.
// The hills are domain-warped noise: the noise is read at shifted coordinates,
// which bends ridges and valleys so the rivers that follow them meander.
export function generateTerrain(seed: number, size: number): Terrain {
  const height: number[] = new Array(size * size)
  const kind: TileKind[] = new Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * NOISE_SCALE
      const ny = (y / size) * NOISE_SCALE
      const warpX = fbm(seed + 311, nx * 0.75, ny * 0.75, 3) - 0.5
      const warpY = fbm(seed + 733, nx * 0.75, ny * 0.75, 3) - 0.5
      const n = fbm(seed, nx + WARP * warpX, ny + WARP * warpY)
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
  carveRivers(seed, size, height, kind)

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

// Minimal binary heap keyed by priority, for the priority-flood below.
function heapPush(heap: [number, number][], item: [number, number]) {
  heap.push(item)
  let i = heap.length - 1
  while (i > 0) {
    const parent = (i - 1) >> 1
    if (heap[parent][0] <= heap[i][0]) break
    ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
    i = parent
  }
}

function heapPop(heap: [number, number][]): [number, number] | undefined {
  const top = heap[0]
  const last = heap.pop()
  if (heap.length > 0 && last) {
    heap[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heap.length && heap[l][0] < heap[m][0]) m = l
      if (r < heap.length && heap[r][0] < heap[m][0]) m = r
      if (m === i) break
      ;[heap[m], heap[i]] = [heap[i], heap[m]]
      i = m
    }
  }
  return top
}

// Where every tile's water goes. The routing surface is the height plus a
// smooth wobble (MEANDER_*), so rivers swing even on an even slope.
// 1. A priority-flood from the sea and the map edge raises every pit to its
//    spill level, so all water can reach an outlet. The flood front spreads in
//    order of the wobble, so across a filled flat it advances unevenly.
// 2. On slopes a tile drains to its lowest neighbour; on a filled flat it
//    drains to the tile the front came from, which winds instead of running
//    straight to the spill point.
// Returns each tile's downstream tile (-1 for outlets) and every tile ordered
// from the lowest to the highest, so downstream tiles always come first.
function drainage(seed: number, size: number, height: number[], kind: TileKind[]) {
  const wobble = (i: number) =>
    MEANDER_AMPLITUDE * (fbm(seed + 997, (i % size) / MEANDER_TILES, Math.floor(i / size) / MEANDER_TILES, 2) - 0.5)
  const surface = height.map((h, i) => h + wobble(i))
  const filled = surface.slice()
  const cameFrom = new Array<number>(size * size).fill(-1)
  const raised = new Array<boolean>(size * size).fill(false)
  const reached = new Array<boolean>(size * size).fill(false)
  const isOutlet = new Array<boolean>(size * size).fill(false)
  const heap: [number, number][] = []

  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    const onEdge = x === 0 || y === 0 || x === size - 1 || y === size - 1
    if (kind[i] !== 'sea' && !onEdge) continue
    reached[i] = true
    isOutlet[i] = true
    heapPush(heap, [filled[i], i])
  }

  for (let item = heapPop(heap); item; item = heapPop(heap)) {
    const c = item[1]
    forEachNeighbor(size, c, (n) => {
      if (reached[n]) return
      reached[n] = true
      cameFrom[n] = c
      raised[n] = surface[n] <= filled[c]
      filled[n] = Math.max(surface[n], filled[c] + 1e-6)
      // Inside a flat the front is steered by the wobble instead of distance.
      heapPush(heap, [raised[n] ? filled[n] + wobble(n) : filled[n], n])
    })
  }

  const downstream = new Array<number>(size * size).fill(-1)
  for (let i = 0; i < size * size; i++) {
    if (isOutlet[i]) continue
    if (raised[i]) {
      downstream[i] = cameFrom[i]
      continue
    }
    let lowest = cameFrom[i]
    forEachNeighbor(size, i, (n) => {
      if (filled[n] < filled[lowest]) lowest = n
    })
    downstream[i] = lowest
  }
  const lowToHigh = Array.from({ length: size * size }, (_, i) => i).sort((a, b) => filled[a] - filled[b])
  return { downstream, lowToHigh }
}

function forEachNeighbor(size: number, i: number, visit: (n: number) => void) {
  const x = i % size
  const y = Math.floor(i / size)
  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx
    const ny = y + dy
    if (nx >= 0 && ny >= 0 && nx < size && ny < size) visit(ny * size + nx)
  }
}

// Tiles that collect water from a large enough area become river.
function carveRivers(seed: number, size: number, height: number[], kind: TileKind[]) {
  const { downstream, lowToHigh } = drainage(seed, size, height, kind)
  const catchment = new Array<number>(size * size).fill(1)
  for (let k = lowToHigh.length - 1; k >= 0; k--) {
    const i = lowToHigh[k]
    if (downstream[i] >= 0) catchment[downstream[i]] += catchment[i]
  }
  for (let i = 0; i < size * size; i++) {
    if (kind[i] !== 'sea' && catchment[i] >= RIVER_MIN_CATCHMENT) kind[i] = 'river'
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
