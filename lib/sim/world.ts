// @ts-expect-error Node strip-types tests require the source extension.
import { CHUNK_TILES, PARAMS, TILE_AREA_M2 } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { buildableM2, computeAccess, popWeightedAccess } from './growth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { updateLandValue } from './landvalue.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { buildRoads } from './network.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { generateTerrain, placeCities } from './terrain.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { runTraffic } from './traffic.ts'
import type { Chunk, City, PerUse, World } from './types.ts'

const G = PARAMS.growth

const zero = (): PerUse => ({ res: 0, office: 0, retail: 0, industry: 0 })

const CITY_POP: Record<string, number> = { A: 120_000, B: 180_000, C: 40_000 }
const OFFICE_SHARE: Record<string, number> = { A: 0.35, B: 0.5, C: 0.15 }
const INDUSTRY_SHARE: Record<string, number> = { A: 0.7, B: 0.3, C: 0 }
const CITY_SCALE: Record<string, number> = { A: 1, B: 1, C: 1.5 } // C is a small town

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 1
}

function cityDistance(c: Chunk, city: City): number {
  const dx = (c.cx + 0.5) * CHUNK_TILES - city.x
  const dy = (c.cy + 0.5) * CHUNK_TILES - city.y
  return (Math.hypot(dx, dy) / CHUNK_TILES) * CITY_SCALE[city.id]
}

function makeChunks(world: World): Chunk[] {
  const t = world.terrain
  const n = world.chunksPerSide
  const chunks: Chunk[] = []
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const counts: Record<string, number> = { sea: 0, plain: 0, hill: 0, forest: 0, river: 0, mountain: 0 }
      for (let y = cy * CHUNK_TILES; y < (cy + 1) * CHUNK_TILES; y++) {
        for (let x = cx * CHUNK_TILES; x < (cx + 1) * CHUNK_TILES; x++) counts[t.kind[y * t.size + x]]++
      }
      const total = CHUNK_TILES * CHUNK_TILES
      const buildable = counts.plain + counts.hill + counts.forest
      const landFactor = buildable > 0 ? (counts.plain + 0.8 * counts.hill + 0.9 * counts.forest) / buildable : 0.1
      const view = Math.min(
        1,
        (counts.sea > total * 0.05 ? 0.5 : 0) + (counts.forest > total * 0.2 ? 0.3 : 0) + (counts.mountain > total * 0.1 ? 0.3 : 0),
      )
      chunks.push({
        id: cy * n + cx,
        cx,
        cy,
        cityId: null,
        landFactor,
        view,
        passable: counts.sea < total * 0.6 && counts.mountain < total * 0.85,
        mountainShare: counts.mountain / total,
        zoneFar: zero(),
        bgFloor: zero(),
        floor: zero(),
        pop: 0,
        jobs: { office: 0, retail: 0, industry: 0 },
        unmet: zero(),
        lowVacancyTicks: zero(),
        rentMult: { res: 1, office: 1, retail: 1, industry: 1 },
        lv: 0,
        lvTarget: 0,
        access: 0,
        accessPop: 0,
        boardings: 0,
        buildableM2: 0,
        rumorUntil: -1,
        purchases: [],
      })
    }
  }
  for (const c of chunks) c.buildableM2 = buildableM2(world, c)
  return chunks
}

function zoneAndSettle(world: World) {
  const port = world.terrain.resources.find((r) => r.kind === 'port')
  for (const c of world.chunks) {
    if (c.buildableM2 < TILE_AREA_M2 * 8) continue
    let best: City | null = null
    let bestD = Infinity
    for (const city of world.cities) {
      const d = cityDistance(c, city)
      if (d < bestD) {
        bestD = d
        best = city
      }
    }
    if (!best || bestD >= 2.6) continue
    c.cityId = best.id
    const nearPort = port ? Math.hypot(port.x / CHUNK_TILES - (c.cx + 0.5), port.y / CHUNK_TILES - (c.cy + 0.5)) < 2 : false
    if (bestD < 0.9) c.zoneFar = { res: 3, office: 6, retail: 6, industry: 0 }
    else if (bestD < 1.8) c.zoneFar = { res: 2, office: 1, retail: 2, industry: best.id === 'B' ? 0.8 : 0 }
    else c.zoneFar = { res: 1, office: 0, retail: 0.5, industry: 0 }
    if (best.id === 'A' && nearPort && bestD >= 0.9) c.zoneFar.industry = 1
  }

  for (const city of world.cities) {
    const mine = world.chunks.filter((c) => c.cityId === city.id)
    const spread = (weight: (c: Chunk) => number, total: number, apply: (c: Chunk, v: number) => void) => {
      const w = mine.map(weight)
      const sum = w.reduce((s, v) => s + v, 0)
      if (sum > 0) mine.forEach((c, i) => apply(c, (total * w[i]) / sum))
    }
    const pop = CITY_POP[city.id]
    const basic = (Object.values(CITY_POP).reduce((s, v) => s + v, 0) * (1 - G.h * G.k)) / G.h
    spread(
      (c) => (c.zoneFar.res > 0 ? Math.exp(-cityDistance(c, city) / 0.9) * c.buildableM2 : 0),
      pop,
      (c, v) => (c.pop = v),
    )
    spread(
      (c) => (c.zoneFar.office > 0 ? Math.exp(-cityDistance(c, city) / 0.5) : 0),
      basic * (1 - G.industryShareOfBasic) * OFFICE_SHARE[city.id],
      (c, v) => (c.jobs.office = v),
    )
    spread(
      (c) => (c.zoneFar.industry > 0 ? 1 : 0),
      basic * G.industryShareOfBasic * INDUSTRY_SHARE[city.id],
      (c, v) => (c.jobs.industry = v),
    )
    for (const c of mine) c.jobs.retail = G.k * c.pop
  }

  for (const c of world.chunks) {
    c.bgFloor = {
      res: (c.pop * G.floorPerCapita.res) / 0.95,
      office: (c.jobs.office * G.floorPerCapita.office) / 0.95,
      retail: (c.jobs.retail * G.floorPerCapita.retail) / 0.95,
      industry: (c.jobs.industry * G.floorPerCapita.industry) / 0.95,
    }
    c.floor = { ...c.bgFloor }
  }
}

export function createWorld(seed: number, size = 128): World {
  const terrain = generateTerrain(seed, size)
  const world: World = {
    seed,
    tick: 0,
    terrain,
    chunksPerSide: size / CHUNK_TILES,
    chunks: [],
    cities: placeCities(terrain),
    roads: [],
    firms: [],
    parcels: {},
    buildings: [],
    lines: [],
    ledger: [],
    events: [],
    region: { basicJobs: 0, accessRef: 1, meanAccess0: 1, lvRef: 1, popHistory: [] },
    nextId: 1,
  }
  world.chunks = makeChunks(world)
  zoneAndSettle(world)
  world.roads = buildRoads(world)
  world.region.basicJobs = world.chunks.reduce((s, c) => s + c.jobs.office + c.jobs.industry, 0)
  for (const [id, name, kind] of [
    ['player', 'Emporion', 'player'],
    ['rival', '大和開発', 'ai'],
  ] as const) {
    world.firms.push({
      id,
      name,
      kind,
      cash: PARAMS.finance.startingCash,
      loans: [],
      shares: 100_000_000,
      rating: 'A',
      marketCap: PARAMS.finance.startingCash,
      nav: PARAMS.finance.startingCash,
      bankrupt: false,
      shortfallTicks: 0,
    })
  }

  // Calibrate the reference values so today's land prices sit near the base.
  const traffic = runTraffic(world)
  computeAccess(world, traffic.minutes)
  const settled = world.chunks.filter((c) => c.pop > 0)
  world.region.accessRef = median(settled.map((c) => c.access))
  world.region.meanAccess0 = popWeightedAccess(world)
  updateLandValue(world, traffic.minutes)
  for (const c of world.chunks) c.lv = c.lvTarget
  world.region.lvRef = median(settled.map((c) => c.lv))
  world.region.popHistory.push(world.chunks.reduce((s, c) => s + c.pop, 0))
  return world
}
