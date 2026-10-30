// @ts-expect-error Node strip-types tests require the source extension.
import { CHUNK_TILES, PARAMS, TILE_AREA_M2 } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { USES, type Chunk, type PerUse, type Use, type World } from './types.ts'

const G = PARAMS.growth

export function totalJobs(c: Chunk): number {
  return c.jobs.office + c.jobs.retail + c.jobs.industry
}

export function stock(c: Chunk, use: Use): number {
  return use === 'res' ? c.pop : c.jobs[use]
}

// --- Accessibility ---

export type Accessibility = { access: number; accessPop: number }

// Jobs and people reachable from each chunk, discounted by travel time.
export function computeAccessibility(chunks: Chunk[], minutes: number[][]): Accessibility[] {
  const beta = PARAMS.lv.beta
  return chunks.map((_, i) => {
    let access = 0
    let accessPop = 0
    chunks.forEach((d, j) => {
      const t = minutes[i][j]
      if (t === Infinity) return
      const w = Math.exp(-beta * t)
      access += totalJobs(d) * w
      accessPop += d.pop * w
    })
    return { access, accessPop }
  })
}

export function applyAccessibility(world: World, values: Accessibility[]) {
  world.chunks.forEach((c, i) => {
    c.access = values[i].access
    c.accessPop = values[i].accessPop
  })
}

export function popWeightedAccess(chunks: Chunk[]): number {
  let pop = 0
  let acc = 0
  for (const c of chunks) {
    pop += c.pop
    acc += c.pop * c.access
  }
  return pop > 0 ? acc / pop : 0
}

// --- Where people and jobs want to be ---

export function environment(c: Chunk): number {
  const E = G.environment
  const jobs = totalJobs(c)
  const industryShare = jobs > 0 ? c.jobs.industry / jobs : 0
  return 1 + E.view * c.view + E.industry * industryShare + E.retail * Math.min(1, c.jobs.retail / E.retailJobsForFullBonus)
}

// Buildable land in a chunk (tiles that are not water or mountain).
export function buildableM2(world: World, c: Chunk): number {
  const t = world.terrain
  let tiles = 0
  for (let y = c.cy * CHUNK_TILES; y < (c.cy + 1) * CHUNK_TILES; y++) {
    for (let x = c.cx * CHUNK_TILES; x < (c.cx + 1) * CHUNK_TILES; x++) {
      const k = t.kind[y * t.size + x]
      if (k !== 'sea' && k !== 'river' && k !== 'mountain') tiles++
    }
  }
  return tiles * TILE_AREA_M2
}

function locationWeights(world: World, use: Use): number[] {
  const lvRef = world.region.lvRef
  const port = world.terrain.resources.find((r) => r.kind === 'port')
  return world.chunks.map((c) => {
    if (c.zoneFar[use] <= 0) return 0
    const relativeLand = Math.max(c.lv, 1) / lvRef
    const rentFactor = relativeLand ** G.rentElasticity
    switch (use) {
      case 'res':
        return c.access * environment(c) * rentFactor
      case 'office':
        return c.accessPop * (1 + c.jobs.office / G.officeClusterJobs) ** G.officeClusterExponent * rentFactor
      case 'retail':
        return c.accessPop * (1 + c.boardings / G.retailBoardingsScale)
      case 'industry': {
        const hasPort = port && Math.floor(port.x / CHUNK_TILES) === c.cx && Math.floor(port.y / CHUNK_TILES) === c.cy
        return (1 + (hasPort ? G.portIndustryBonus : 0)) * relativeLand ** G.industryRentElasticity
      }
    }
  })
}

export function regionTargets(basicJobs: number): Record<Use, number> {
  const pop = (G.h / (1 - G.h * G.k)) * basicJobs
  return {
    res: pop,
    retail: G.k * pop,
    industry: G.industryShareOfBasic * basicJobs,
    office: (1 - G.industryShareOfBasic) * basicJobs,
  }
}

// --- One tick of growth ---

export type ChunkGrowth = { stock: PerUse; unmet: PerUse; lowVacancyTicks: PerUse; bgFloor: PerUse }
export type GrowthPlan = { basicJobs: number; chunks: ChunkGrowth[] }

// The Lowry-style growth model: the region grows with its basic jobs, and a
// small share of people and jobs relocate toward accessible places, limited by
// the floor space that exists. Local developers add floor where demand stays
// unmet. Reads the world and returns the next state; applyGrowth writes it.
export function planGrowth(world: World): GrowthPlan {
  const meanAccess = popWeightedAccess(world.chunks)
  const lift = Math.sqrt(Math.max(meanAccess, 1) / Math.max(world.region.meanAccess0, 1))
  const basicJobs = world.region.basicJobs * (1 + G.basicGrowth * lift)
  const targets = regionTargets(basicJobs)

  const chunks: ChunkGrowth[] = world.chunks.map((c) => ({
    stock: { res: c.pop, office: c.jobs.office, retail: c.jobs.retail, industry: c.jobs.industry },
    unmet: { ...c.unmet },
    lowVacancyTicks: { ...c.lowVacancyTicks },
    bgFloor: { ...c.bgFloor },
  }))

  for (const use of USES) {
    const w = locationWeights(world, use)
    const sum = w.reduce((s, v) => s + v, 0)
    if (sum <= 0) continue
    const perCapita = G.floorPerCapita[use]

    world.chunks.forEach((c, i) => {
      const next = chunks[i]
      const desired = (targets[use] * w[i]) / sum
      const capacity = c.floor[use] / perCapita
      const current = stock(c, use)
      next.stock[use] = Math.max(0, Math.min(capacity, current + G.relocation * (desired - current)))
      next.unmet[use] = Math.max(0, desired - capacity)

      const vacancy = c.floor[use] > 0 ? 1 - (next.stock[use] * perCapita) / c.floor[use] : 0
      const pressured = c.zoneFar[use] > 0 && next.unmet[use] > 0 && vacancy < G.bgDevVacancy
      next.lowVacancyTicks[use] = pressured ? c.lowVacancyTicks[use] + 1 : 0
      if (next.lowVacancyTicks[use] < G.bgDevTicks) return

      const room = c.zoneFar[use] * c.buildableM2 * G.useShareOfBuildable - c.bgFloor[use]
      const wanted = Math.max(G.bgDevMin, c.floor[use] * G.bgDevRate, next.unmet[use] * perCapita * G.bgDevUnmetShare)
      const add = Math.min(room, wanted)
      if (add > 0) next.bgFloor[use] += add
    })
  }
  return { basicJobs, chunks }
}

export function applyGrowth(world: World, plan: GrowthPlan) {
  world.region.basicJobs = plan.basicJobs
  world.chunks.forEach((c, i) => {
    const next = plan.chunks[i]
    c.pop = next.stock.res
    c.jobs = { office: next.stock.office, retail: next.stock.retail, industry: next.stock.industry }
    c.unmet = next.unmet
    c.lowVacancyTicks = next.lowVacancyTicks
    c.bgFloor = next.bgFloor
  })
  refreshFloor(world)
  world.region.popHistory.push(world.chunks.reduce((s, c) => s + c.pop, 0))
}

// --- Floor space ---

// Floor per chunk: local developers' floor plus the firms' finished buildings.
export function floorByChunk(world: World): PerUse[] {
  const floors = world.chunks.map((c) => ({ ...c.bgFloor }))
  for (const b of world.buildings) {
    if (b.status === 'construction') continue
    const id = Math.floor(b.y / CHUNK_TILES) * world.chunksPerSide + Math.floor(b.x / CHUNK_TILES)
    floors[id][b.use === 'station' ? 'retail' : b.use] += b.floorArea
  }
  return floors
}

export function refreshFloor(world: World) {
  const floors = floorByChunk(world)
  world.chunks.forEach((c, i) => {
    c.floor = floors[i]
  })
}
