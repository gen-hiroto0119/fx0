// @ts-expect-error Node strip-types tests require the source extension.
import { TILE_M } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { fbm, mulberry32 } from './rng.ts'
import type { City, CityKind, LandCover, Resource, Terrain, TileKind } from './types.ts'

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

// Plateaus (台地): old fan and terrace surfaces standing above the lowland,
// like Musashino or Shimousa in the Kanto plain. Rivers cut lowland valleys
// through them and small streams cut narrow valleys (谷津) into their edges.
const PLATEAU_SHARE = 0.5 // noise level above which the plain is plateau (lower = more plateau)
const PLATEAU_RISE_M = [15, 45] as const // height of the plateau surface above the lowland
const PLATEAU_MAX_UPLIFT = 5 // no plateaus where the mountains are rising
const VALLEY_MIN_AREA_KM2 = 2.5 // streams this large cut a valley into the plateau
const VALLEY_HALF_WIDTH_TILES = [
  { minAreaKm2: 100, tiles: 3 },
  { minAreaKm2: 20, tiles: 2 },
  { minAreaKm2: 0, tiles: 0 },
] as const

// A few metres of bumps on the plain, so small streams join into branching
// networks instead of running side by side down an even slope.
const PLAIN_ROUGHNESS_M = 3
const PLAIN_ROUGHNESS_TILES = 6

// An intermontane basin (盆地) like Kofu or Kyoto: a patch of the mountains
// that does not rise, so it fills with sediment and becomes a flat floor
// ringed by fans, drained through a gorge.
const BASIN = {
  offsetTiles: [12, 26] as const, // how far east of the mountain front its centre sits
  radiusTiles: [9, 14] as const,
  rimFanKm: 2, // fans spread this far onto the floor from the surrounding mountains
  floorSlope: 1 / 1000,
}

// Deltas: big rivers push their mouth out into the sea and split into
// distributaries across the new land.
const DELTA = {
  minAreaKm2: 100,
  radiusPerSqrtKm2: 0.9, // tiles of new land per square root of catchment
  radiusTiles: [4, 14] as const,
  distributaryAngles: [-0.55, 0, 0.55], // radians either side of the river's direction
  mouthHeightM: 1,
}

const RIVER_MIN_AREA_KM2 = 36
const SEA_DEPTH_M = -10

// Land cover (rise over run for slopes, metres for heights).
const PADDY_MAX = { aboveStreamM: 6, slope: 0.02 } // flat ground close to stream level is rice paddy
const BARE_SLOPE = 0.55 // rock shows where it is too steep for forest
const PLANTATION_MAX_M = 500 // cedar and cypress plantations stay on the lower mountain slopes

// Landforms from local relief (height range within two tiles) and slope, so a
// basin floor high in the mountains is still plain.
const RELIEF_RADIUS_TILES = 2
const MOUNTAIN = { reliefM: 150, slope: 0.3 }
const HILL = { reliefM: 70, slope: 0.1 }

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

type Basin = { x: number; y: number; rx: number; ry: number }

function placeBasin(seed: number, size: number): Basin | null {
  const random = mulberry32(seed + 8101)
  const y = (0.25 + 0.5 * random()) * size
  const [minOffset, maxOffset] = BASIN.offsetTiles
  const [minRadius, maxRadius] = BASIN.radiusTiles
  const x = mountainFront(seed, size, size * 0.6, y) + minOffset + (maxOffset - minOffset) * random()
  const rx = minRadius + (maxRadius - minRadius) * random()
  const ry = minRadius + (maxRadius - minRadius) * random()
  if (x + rx > size - 4) return null
  return { x, y, rx, ry }
}

// How far inside the basin a tile is: 1 on the floor, 0 outside, with a
// ragged rim. Also returns the distance to the rim for the marginal fans.
function basinAt(seed: number, basin: Basin | null, x: number, y: number): { inside: number; rimKm: number } {
  if (!basin) return { inside: 0, rimKm: Infinity }
  const ragged = 1 + 0.3 * (fbm(seed + 8203, x / 6, y / 6, 2) - 0.5)
  const d = Math.hypot((x - basin.x) / basin.rx, (y - basin.y) / basin.ry) * ragged
  const rimKm = Math.max(0, (1 - d) * Math.min(basin.rx, basin.ry) * (TILE_M / 1000))
  return { inside: smoothstep((1 - d) / 0.2), rimKm }
}

// U/K for every tile: full in the mountains, rising across the front, and
// patchy low hills in the plain. The basin does not rise.
function upliftOverErodibility(seed: number, size: number, basin: Basin | null): number[] {
  const tileKm = TILE_M / 1000
  return Array.from({ length: size * size }, (_, i) => {
    const x = i % size
    const y = Math.floor(i / size)
    const eastOfFrontKm = (x - mountainFront(seed, size, x, y)) * tileKm
    const mountains = smoothstep(eastOfFrontKm / UPLIFT_RAMP_KM) * MOUNTAIN_U_OVER_K
    const variation = 0.7 + 0.6 * fbm(seed + 2203, x / 24, y / 24, 3)
    const hills = HILL_U_OVER_K * smoothstep((fbm(seed + 3301, x / 14, y / 14, 3) - 0.62) / 0.12)
    const sinking = 1 - basinAt(seed, basin, x, y).inside
    return Math.max(mountains * variation * sinking, hills)
  })
}

// Slope the plain is built with where uplift does not hold up the ground.
function plainSlope(seed: number, size: number, i: number, tilesToSea: number, basin: Basin | null): number {
  const tileKm = TILE_M / 1000
  const inBasin = basinAt(seed, basin, i % size, Math.floor(i / size))
  if (inBasin.inside > 0.5) {
    const t = smoothstep(inBasin.rimKm / BASIN.rimFanKm)
    return FAN_SLOPE * (1 - t) + BASIN.floorSlope * t
  }
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
  const basin = placeBasin(seed, size)
  let sea = seaMask(seed, size)
  const tilesToSea = coastDistance(size, sea)
  const uOverK = upliftOverErodibility(seed, size, basin)
  const plain = Array.from({ length: size * size }, (_, i) => plainSlope(seed, size, i, tilesToSea[i], basin))

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

  height = fillPits(size, roughenPlain(seed, size, height, sea, uOverK, tilesToSea), sea)
  drainage = computeDrainage(size, height, sea)
  height = fillPits(size, raisePlateaus(seed, size, height, sea, drainage, uOverK), sea)
  drainage = computeDrainage(size, height, sea)
  const delta = buildDeltas(seed, size, height, sea, drainage)
  sea = delta.sea
  height = delta.height
  drainage = computeDrainage(size, height, sea)

  const slope = localSlopes(size, height, sea, drainage)
  const kind = classifyLandform(size, height, sea, slope, drainage, delta.channels)
  const cover = classifyCover(seed, size, height, kind, slope, drainage)
  const basinCentre = basin ? { x: Math.round(basin.x), y: Math.round(basin.y) } : null
  const terrain: Terrain = { size, height, kind, cover, basin: basinCentre, resources: [] }
  terrain.resources = placeResources(terrain)
  return terrain
}

// The delta near the coast stays smooth so river mouths keep their low gradient.
function roughenPlain(
  seed: number,
  size: number,
  height: number[],
  sea: boolean[],
  uOverK: number[],
  tilesToSea: number[],
): number[] {
  const tileKm = TILE_M / 1000
  return height.map((h, i) => {
    if (sea[i] || uOverK[i] > PLATEAU_MAX_UPLIFT) return h
    const inland = smoothstep((tilesToSea[i] * tileKm) / DELTA_KM - 1)
    const bump = fbm(seed + 5011, (i % size) / PLAIN_ROUGHNESS_TILES, Math.floor(i / size) / PLAIN_ROUGHNESS_TILES, 2) - 0.5
    return Math.max(0.01, h + 2 * PLAIN_ROUGHNESS_M * bump * inland)
  })
}

// Raises plateau surfaces out of the plain, leaving lowland valleys along
// the streams that cut through them and a one-tile scarp at their edge.
function raisePlateaus(
  seed: number,
  size: number,
  height: number[],
  sea: boolean[],
  drainage: Drainage,
  uOverK: number[],
): number[] {
  // Distance (in tiles) from every tile to the nearest valley-cutting stream,
  // minus that stream's half-width, so 0 or less means "in the valley".
  const outsideValley = new Array<number>(size * size).fill(Infinity)
  const queue: number[] = []
  for (let i = 0; i < size * size; i++) {
    const areaKm2 = drainage.areaM2[i] / 1e6
    if (sea[i] || areaKm2 < VALLEY_MIN_AREA_KM2) continue
    const halfWidth = VALLEY_HALF_WIDTH_TILES.find((v) => areaKm2 >= v.minAreaKm2)!.tiles
    outsideValley[i] = -halfWidth
    queue.push(i)
  }
  queue.sort((a, b) => outsideValley[a] - outsideValley[b])
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k]
    forEachNeighbor(size, c, (n) => {
      if (outsideValley[n] <= outsideValley[c] + 1) return
      outsideValley[n] = outsideValley[c] + 1
      queue.push(n)
    })
  }

  const [lowRise, highRise] = PLATEAU_RISE_M
  return height.map((h, i) => {
    if (sea[i] || uOverK[i] > PLATEAU_MAX_UPLIFT) return h
    const x = i % size
    const y = Math.floor(i / size)
    const plateau = smoothstep((fbm(seed + 4409, x / 22, y / 22, 3) - PLATEAU_SHARE) / 0.06)
    const rise = lowRise + (highRise - lowRise) * fbm(seed + 4507, x / 30, y / 30, 2)
    const scarp = smoothstep(outsideValley[i])
    return h + plateau * rise * scarp
  })
}

// Pushes land out into the sea at big river mouths and carves distributary
// channels across it. Returns the new sea mask and heights, and the channel
// tiles, which are always river.
function buildDeltas(seed: number, size: number, height: number[], seaIn: boolean[], drainage: Drainage) {
  const sea = seaIn.slice()
  const next = height.slice()
  const channels = new Set<number>()
  const mouths = drainage.lowToHigh
    .filter((i) => {
      const r = drainage.receiver[i]
      return r >= 0 && seaIn[r] && drainage.areaM2[i] >= DELTA.minAreaKm2 * 1e6
    })
    .sort((a, b) => drainage.areaM2[b] - drainage.areaM2[a])
  const built: { x: number; y: number; radius: number }[] = []

  for (const mouth of mouths) {
    const mx = mouth % size
    const my = Math.floor(mouth / size)
    const [minR, maxR] = DELTA.radiusTiles
    const radius = Math.max(minR, Math.min(maxR, Math.round(DELTA.radiusPerSqrtKm2 * Math.sqrt(drainage.areaM2[mouth] / 1e6))))
    if (built.some((b) => Math.hypot(b.x - mx, b.y - my) < b.radius + radius)) continue
    built.push({ x: mx, y: my, radius })

    // The river's direction as it reaches the sea.
    const r = drainage.receiver[mouth]
    const len = Math.hypot((r % size) - mx, Math.floor(r / size) - my)
    const dirX = ((r % size) - mx) / len
    const dirY = (Math.floor(r / size) - my) / len

    // A lobe of low land in front of the mouth, with a ragged shoreline.
    for (let y = my - radius; y <= my + radius; y++) {
      for (let x = mx - radius; x <= mx + radius; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const i = y * size + x
        if (!sea[i]) continue
        const dx = x - mx
        const dy = y - my
        const d = Math.hypot(dx, dy)
        const forward = d > 0 ? (dx * dirX + dy * dirY) / d : 1
        const reach = radius * (0.75 + 0.5 * fbm(seed + 9001, x / 3, y / 3, 2)) * (0.4 + 0.6 * Math.max(0, forward))
        if (d > reach) continue
        sea[i] = false
        next[i] = DELTA.mouthHeightM * (1 - d / (reach + 1)) + 0.05
      }
    }

    // Distributaries fan out from the mouth to the new shoreline.
    for (const angle of DELTA.distributaryAngles) {
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const ax = dirX * cos - dirY * sin
      const ay = dirX * sin + dirY * cos
      let px = mx
      let py = my
      let prev = mouth
      for (let step = 0; step < radius * 3; step++) {
        const bend = 0.6 * (fbm(seed + 9103 + Math.round(angle * 10), px / 4, py / 4, 2) - 0.5)
        px += ax - ay * bend
        py += ay + ax * bend
        const tx = Math.round(px)
        const ty = Math.round(py)
        if (tx < 0 || ty < 0 || tx >= size || ty >= size) break
        const i = ty * size + tx
        if (i === prev) continue
        // Keep the channel connected edge to edge.
        const prevX = prev % size
        const prevY = Math.floor(prev / size)
        if (tx !== prevX && ty !== prevY && !sea[prevY * size + tx]) channels.add(prevY * size + tx)
        if (sea[i]) break
        channels.add(i)
        prev = i
      }
    }
    channels.add(mouth)
  }
  return { sea, height: next, channels }
}

// Each tile's slope toward the tile it drains to.
function localSlopes(size: number, height: number[], sea: boolean[], drainage: Drainage): number[] {
  return height.map((h, i) => {
    const r = drainage.receiver[i]
    if (sea[i] || r < 0) return 0
    return (h - (sea[r] ? 0 : height[r])) / drainage.distanceM[i]
  })
}

// Height range within a few tiles: how hilly the surroundings are.
function localRelief(size: number, height: number[], sea: boolean[]): number[] {
  const R = RELIEF_RADIUS_TILES
  return height.map((_, i) => {
    const x = i % size
    const y = Math.floor(i / size)
    let lo = Infinity
    let hi = -Infinity
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        const h = sea[ny * size + nx] ? 0 : height[ny * size + nx]
        lo = Math.min(lo, h)
        hi = Math.max(hi, h)
      }
    }
    return hi - lo
  })
}

function classifyLandform(
  size: number,
  height: number[],
  sea: boolean[],
  slope: number[],
  drainage: Drainage,
  channels: Set<number>,
): TileKind[] {
  const relief = localRelief(size, height, sea)
  const kind: TileKind[] = height.map((_, i) => {
    if (sea[i]) return 'sea'
    if (relief[i] > MOUNTAIN.reliefM || slope[i] > MOUNTAIN.slope) return 'mountain'
    if (relief[i] > HILL.reliefM || slope[i] > HILL.slope) return 'hill'
    return 'plain'
  })
  for (const i of channels) if (!sea[i]) kind[i] = 'river'

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

// What grows where, following the usual Japanese pattern: paddies on the
// river lowland, fields on fans and plateaus with scattered groves, coppice
// woods (里山) and bamboo on hills and scarps, cedar plantations low in the
// mountains, broadleaf forest above them, and rock where it is too steep.
// Height of each tile above the nearest stream (rivers and the streams that
// cut valleys), found by spreading stream levels outward over the grid.
function heightAboveStream(size: number, height: number[], kind: TileKind[], drainage: Drainage): number[] {
  const streamLevel = new Array<number>(size * size).fill(NaN)
  const queue: number[] = []
  for (let i = 0; i < size * size; i++) {
    if (kind[i] === 'river' || (kind[i] !== 'sea' && drainage.areaM2[i] >= VALLEY_MIN_AREA_KM2 * 1e6)) {
      streamLevel[i] = height[i]
      queue.push(i)
    }
  }
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k]
    forEachNeighbor(size, c, (n) => {
      if (!Number.isNaN(streamLevel[n])) return
      streamLevel[n] = streamLevel[c]
      queue.push(n)
    })
  }
  return height.map((h, i) => (Number.isNaN(streamLevel[i]) ? Infinity : h - streamLevel[i]))
}

function classifyCover(
  seed: number,
  size: number,
  height: number[],
  kind: TileKind[],
  slope: number[],
  drainage: Drainage,
): LandCover[] {
  const aboveStream = heightAboveStream(size, height, kind, drainage)
  const noise = (offset: number, i: number, scale: number) => fbm(seed + offset, (i % size) / scale, Math.floor(i / size) / scale, 2)
  return kind.map((k, i) => {
    switch (k) {
      case 'sea':
      case 'river':
        return 'water'
      case 'mountain':
        if (slope[i] > BARE_SLOPE) return 'bare'
        return height[i] < PLANTATION_MAX_M && noise(6007, i, 9) > 0.5 ? 'conifer' : 'broadleaf'
      case 'hill':
        if (noise(6101, i, 5) > 0.68) return 'bamboo'
        return noise(6203, i, 8) > 0.6 ? 'conifer' : 'satoyama'
      case 'plain':
        if (noise(77, i, 10) > 0.68) return 'grove'
        return aboveStream[i] < PADDY_MAX.aboveStreamM && slope[i] < PADDY_MAX.slope ? 'paddy' : 'field'
    }
  })
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
    const [px, py] =
      s.kind === 'port' && port
        ? [port.x + 2, port.y]
        : s.kind === 'mountain' && t.basin
          ? [t.basin.x, t.basin.y]
          : [s.at[0] * t.size, s.at[1] * t.size]
    const i = nearest(t, px, py, (j) => t.kind[j] === s.tile || t.kind[j] === 'plain')
    return { id: s.id, name: s.name, kind: s.kind, persona: s.persona, x: i % t.size, y: Math.floor(i / t.size), relation: {} }
  })
}

export function tileKind(t: Terrain, x: number, y: number): TileKind {
  return t.kind[y * t.size + x]
}
