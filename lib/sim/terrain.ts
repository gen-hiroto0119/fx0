// @ts-expect-error Node strip-types tests require the source extension.
import { TILE_M } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { fbm } from './rng.ts'
import type { City, CityKind, Resource, Terrain, TileKind } from './types.ts'

// Terrain follows the stream power law: where the ground is uplifted, rivers
// cut down until erosion balances uplift, which at steady state gives each
// channel the slope S = (U / K) / A^m (A = drainage area). Mountains, valleys
// and their river networks emerge from that balance. Where there is no uplift
// (the plain), slopes are set from Japanese river segments instead: alluvial
// fans below the mountain front, then floodplain, then a delta at the coast.
// Heights are in metres; the sea surface is 0.

const NOISE_SCALE = 4 // noise cells across the map: the size of the initial roughness
const WARP = 0.8 // how far (in noise cells) the initial valleys are bent sideways

const AREA_EXPONENT = 0.5 // m in the stream power law (with n = 1)
const MOUNTAIN_U_OVER_K = 60 // uplift over erodibility in the mountains (m^1/2 in area units of m2)
const HILL_U_OVER_K = 25 // scattered low hills and terraces rising out of the plain
const MOUNTAIN_FRONT_SHARE = 0.58 // west edge of the uplift, as a share of the map width
const UPLIFT_RAMP_KM = 4 // uplift grows from nothing to full over this distance east of the front
const MAX_SLOPE = Math.tan(Math.PI / 6) // hillslopes cannot stand steeper than 30 degrees
const EROSION_ITERATIONS = 8

// Gradients of Japanese river segments (MLIT): fan 1/60-1/400,
// floodplain 1/400-1/5000, delta below 1/5000.
const FAN_SLOPE = 1 / 150
const FAN_KM = 5
const FLOODPLAIN_SLOPE = 1 / 2000
const DELTA_SLOPE = 1 / 6000
const DELTA_KM = 2.5

const RIVER_MIN_AREA_KM2 = 36
const SEA_DEPTH_M = -10

// Kinds from height and slope (metres, rise over run).
const MOUNTAIN = { heightM: 350, slope: 0.3 }
const HILL = { heightM: 60, slope: 0.1 }

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

const NEIGHBORS_8 = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const

// --- Small helpers ---

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

function forEachNeighbor(size: number, i: number, visit: (n: number) => void) {
  const x = i % size
  const y = Math.floor(i / size)
  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx
    const ny = y + dy
    if (nx >= 0 && ny >= 0 && nx < size && ny < size) visit(ny * size + nx)
  }
}

const smoothstep = (t: number) => {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

// --- Inputs: coast, roughness, uplift and plain gradients ---

function warpedNoise(seed: number, size: number, x: number, y: number): number {
  const nx = (x / size) * NOISE_SCALE
  const ny = (y / size) * NOISE_SCALE
  const warpX = fbm(seed + 311, nx * 0.75, ny * 0.75, 3) - 0.5
  const warpY = fbm(seed + 733, nx * 0.75, ny * 0.75, 3) - 0.5
  return fbm(seed, nx + WARP * warpX, ny + WARP * warpY)
}

// The sea fills the low western edge of a tilted noise surface.
function seaMask(seed: number, size: number): boolean[] {
  const sea: boolean[] = new Array(size * size)
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    sea[i] = 0.5 * warpedNoise(seed, size, x, y) + 0.7 * (x / size) - 0.1 < 0.15
  }
  return sea
}

// Tiles to the nearest sea tile, walking the grid.
function coastDistance(size: number, sea: boolean[]): number[] {
  const dist = new Array<number>(size * size).fill(Infinity)
  const queue: number[] = []
  sea.forEach((s, i) => {
    if (!s) return
    dist[i] = 0
    queue.push(i)
  })
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k]
    forEachNeighbor(size, c, (n) => {
      if (dist[n] !== Infinity) return
      dist[n] = dist[c] + 1
      queue.push(n)
    })
  }
  return dist
}

// Column where the mountains begin at a tile. The front wanders along the
// rows and is ragged locally, so spurs reach into the plain and valleys reach
// into the mountains.
function mountainFront(seed: number, size: number, x: number, y: number): number {
  const wander = 0.25 * (fbm(seed + 1501, y / 28, 0.5, 2) - 0.5)
  const ragged = 0.08 * (fbm(seed + 1777, x / 9, y / 9, 3) - 0.5)
  return (MOUNTAIN_FRONT_SHARE + wander + ragged) * size
}

// U/K for every tile: full in the mountains, rising across the front, and
// patchy low hills in the plain.
function upliftOverErodibility(seed: number, size: number): number[] {
  const tileKm = TILE_M / 1000
  return Array.from({ length: size * size }, (_, i) => {
    const x = i % size
    const y = Math.floor(i / size)
    const eastOfFrontKm = (x - mountainFront(seed, size, x, y)) * tileKm
    const mountains = smoothstep(eastOfFrontKm / UPLIFT_RAMP_KM) * MOUNTAIN_U_OVER_K
    const variation = 0.7 + 0.6 * fbm(seed + 2203, x / 24, y / 24, 3)
    const hills = HILL_U_OVER_K * smoothstep((fbm(seed + 3301, x / 14, y / 14, 3) - 0.62) / 0.12)
    return Math.max(mountains * variation, hills)
  })
}

// Slope the plain is built with where uplift does not hold up the ground.
function plainSlope(seed: number, size: number, i: number, tilesToSea: number): number {
  const tileKm = TILE_M / 1000
  const westOfFrontKm = (mountainFront(seed, size, i % size, Math.floor(i / size)) - (i % size)) * tileKm
  if (westOfFrontKm < FAN_KM) {
    const t = smoothstep(westOfFrontKm / FAN_KM)
    return FAN_SLOPE * (1 - t) + FLOODPLAIN_SLOPE * t
  }
  return tilesToSea * tileKm < DELTA_KM ? DELTA_SLOPE : FLOODPLAIN_SLOPE
}

// --- Drainage ---

export type Drainage = {
  receiver: number[] // tile each tile drains to, -1 for the sea
  distanceM: number[] // length of that step
  areaM2: number[] // drainage area including the tile itself
  lowToHigh: number[] // land tiles from the lowest to the highest
}

// Each land tile drains to its steepest-downhill neighbour of the eight.
export function computeDrainage(size: number, height: number[], sea: boolean[]): Drainage {
  const receiver = new Array<number>(size * size).fill(-1)
  const distanceM = new Array<number>(size * size).fill(0)
  for (let i = 0; i < size * size; i++) {
    if (sea[i]) continue
    const x = i % size
    const y = Math.floor(i / size)
    let best = -1
    let bestDrop = 0
    let bestDist = 0
    for (const [dx, dy, d] of NEIGHBORS_8) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const n = ny * size + nx
      const base = sea[n] ? 0 : height[n]
      const drop = (height[i] - base) / d
      if (drop > bestDrop) {
        bestDrop = drop
        best = n
        bestDist = d
      }
    }
    receiver[i] = best
    distanceM[i] = bestDist * TILE_M
  }
  const lowToHigh = Array.from({ length: size * size }, (_, i) => i)
    .filter((i) => !sea[i])
    .sort((a, b) => height[a] - height[b])
  const areaM2 = new Array<number>(size * size).fill(TILE_M * TILE_M)
  for (let k = lowToHigh.length - 1; k >= 0; k--) {
    const i = lowToHigh[k]
    if (receiver[i] >= 0 && !sea[receiver[i]]) areaM2[receiver[i]] += areaM2[i]
  }
  return { receiver, distanceM, areaM2, lowToHigh }
}

// Raises every pit to its spill level (priority-flood from the sea), so the
// starting surface drains everywhere. Only needed for the noisy first surface.
function fillPits(size: number, height: number[], sea: boolean[]): number[] {
  const filled = height.slice()
  const reached = sea.slice()
  const heap: [number, number][] = []
  sea.forEach((s, i) => {
    if (s) heapPush(heap, [0, i])
  })
  for (let item = heapPop(heap); item; item = heapPop(heap)) {
    const c = item[1]
    const base = sea[c] ? 0 : filled[c]
    forEachNeighbor(size, c, (n) => {
      if (reached[n]) return
      reached[n] = true
      filled[n] = Math.max(filled[n], base + 1e-3)
      heapPush(heap, [filled[n], n])
    })
  }
  return filled
}

// --- Generation ---

export function generateTerrain(seed: number, size: number): Terrain {
  const sea = seaMask(seed, size)
  const tilesToSea = coastDistance(size, sea)
  const uOverK = upliftOverErodibility(seed, size)
  const plain = Array.from({ length: size * size }, (_, i) => plainSlope(seed, size, i, tilesToSea[i]))

  // A rough first surface only decides where the first valleys run.
  let height = Array.from({ length: size * size }, (_, i) =>
    sea[i] ? SEA_DEPTH_M : 150 * warpedNoise(seed, size, i % size, Math.floor(i / size)) + uOverK[i] * 8,
  )
  height = fillPits(size, height, sea)

  // Rebuild the surface from the coast upward with steady-state slopes, then
  // re-route the water over the new surface and repeat.
  let drainage = computeDrainage(size, height, sea)
  for (let iteration = 0; iteration < EROSION_ITERATIONS; iteration++) {
    const next = height.map((h, i) => (sea[i] ? SEA_DEPTH_M : h))
    for (const i of drainage.lowToHigh) {
      const r = drainage.receiver[i]
      const base = r < 0 || sea[r] ? 0 : next[r]
      const fluvial = uOverK[i] / drainage.areaM2[i] ** AREA_EXPONENT
      const slope = Math.min(MAX_SLOPE, Math.max(fluvial, plain[i]))
      next[i] = base + slope * drainage.distanceM[i]
    }
    height = next
    drainage = computeDrainage(size, height, sea)
  }

  const kind = classify(seed, size, height, sea, drainage)
  const terrain: Terrain = { size, height, kind, resources: [] }
  terrain.resources = placeResources(terrain)
  return terrain
}

function classify(seed: number, size: number, height: number[], sea: boolean[], drainage: Drainage): TileKind[] {
  const kind: TileKind[] = new Array(size * size)
  for (let i = 0; i < size * size; i++) {
    if (sea[i]) {
      kind[i] = 'sea'
      continue
    }
    const r = drainage.receiver[i]
    const slope = r >= 0 ? (height[i] - (sea[r] ? 0 : height[r])) / drainage.distanceM[i] : 0
    const forest = fbm(seed + 77, (i % size) / 10, Math.floor(i / size) / 10, 2)
    if (height[i] > MOUNTAIN.heightM || slope > MOUNTAIN.slope) kind[i] = 'mountain'
    else if (height[i] > HILL.heightM || slope > HILL.slope) kind[i] = forest > 0.5 ? 'forest' : 'hill'
    else kind[i] = forest > 0.66 ? 'forest' : 'plain'
  }

  // Large catchments are rivers. A diagonal step also marks one side tile so
  // the river stays connected edge to edge on the grid.
  const minArea = RIVER_MIN_AREA_KM2 * 1e6
  for (let i = 0; i < size * size; i++) {
    if (sea[i] || drainage.areaM2[i] < minArea) continue
    kind[i] = 'river'
    const r = drainage.receiver[i]
    if (r < 0) continue
    const dx = (r % size) - (i % size)
    const dy = Math.floor(r / size) - Math.floor(i / size)
    if (dx !== 0 && dy !== 0) {
      const side = Math.floor(i / size) * size + (r % size)
      if (!sea[side]) kind[side] = 'river'
    }
  }
  return kind
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
