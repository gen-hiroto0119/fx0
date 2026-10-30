// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS, TILE_AREA_M2 } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { USES, type Chunk, type Use, type World } from './types.ts'

const G = PARAMS.growth

export function totalJobs(c: Chunk): number {
  return c.jobs.office + c.jobs.retail + c.jobs.industry
}

export function stock(c: Chunk, use: Use): number {
  return use === 'res' ? c.pop : c.jobs[use]
}

function setStock(c: Chunk, use: Use, v: number) {
  if (use === 'res') c.pop = v
  else c.jobs[use] = v
}

export function computeAccess(world: World, minutes: number[][]) {
  const beta = PARAMS.lv.beta
  world.chunks.forEach((c, i) => {
    let a = 0
    let p = 0
    world.chunks.forEach((d, j) => {
      const t = minutes[i][j]
      if (t === Infinity) return
      const w = Math.exp(-beta * t)
      a += totalJobs(d) * w
      p += d.pop * w
    })
    c.access = a
    c.accessPop = p
  })
}

export function environment(c: Chunk): number {
  const jobs = totalJobs(c)
  const industryShare = jobs > 0 ? c.jobs.industry / jobs : 0
  return 1 + 0.2 * c.view - 0.3 * industryShare + 0.1 * Math.min(1, c.jobs.retail / 5000)
}

// Buildable land in a chunk (tiles that are not water or mountain).
export function buildableM2(world: World, c: Chunk): number {
  const t = world.terrain
  let tiles = 0
  const n = 16
  for (let y = c.cy * n; y < (c.cy + 1) * n; y++) {
    for (let x = c.cx * n; x < (c.cx + 1) * n; x++) {
      const k = t.kind[y * t.size + x]
      if (k !== 'sea' && k !== 'river' && k !== 'mountain') tiles++
    }
  }
  return tiles * TILE_AREA_M2
}

function weights(world: World, use: Use): number[] {
  const lvRef = world.region.lvRef
  const port = world.terrain.resources.find((r) => r.kind === 'port')
  return world.chunks.map((c) => {
    if (c.zoneFar[use] <= 0) return 0
    const rentFactor = (Math.max(c.lv, 1) / lvRef) ** -0.3
    switch (use) {
      case 'res':
        return c.access * environment(c) * rentFactor
      case 'office':
        return c.accessPop * (1 + c.jobs.office / 20_000) ** 0.3 * rentFactor
      case 'retail':
        return c.accessPop * (1 + c.boardings / 20_000)
      case 'industry': {
        const nearPort = port && Math.floor(port.x / 16) === c.cx && Math.floor(port.y / 16) === c.cy ? 2 : 0
        return (1 + nearPort) * (Math.max(c.lv, 1) / lvRef) ** -0.5
      }
    }
  })
}

export function regionTargets(world: World): Record<Use, number> {
  const B = world.region.basicJobs
  const pop = (G.h / (1 - G.h * G.k)) * B
  return {
    res: pop,
    retail: G.k * pop,
    industry: G.industryShareOfBasic * B,
    office: (1 - G.industryShareOfBasic) * B,
  }
}

// One tick of the Lowry-style growth model: the region grows with its basic
// jobs, and a small share of people and jobs relocate toward accessible places,
// limited by the floor space that exists.
export function updateGrowth(world: World) {
  const meanAccess = popWeightedAccess(world)
  const lift = Math.sqrt(Math.max(meanAccess, 1) / Math.max(world.region.meanAccess0, 1))
  world.region.basicJobs *= 1 + G.basicGrowth * lift

  const targets = regionTargets(world)
  for (const use of USES) {
    const w = weights(world, use)
    const sum = w.reduce((s, v) => s + v, 0)
    if (sum <= 0) continue
    const perCapita = G.floorPerCapita[use]
    world.chunks.forEach((c, i) => {
      const desired = (targets[use] * w[i]) / sum
      const cap = c.floor[use] / perCapita
      const cur = stock(c, use)
      const next = Math.max(0, Math.min(cap, cur + G.relocation * (desired - cur)))
      setStock(c, use, next)
      c.unmet[use] = Math.max(0, desired - cap)
      const vacancy = c.floor[use] > 0 ? 1 - (next * perCapita) / c.floor[use] : 0
      const pressured = c.zoneFar[use] > 0 && c.unmet[use] > 0 && vacancy < G.bgDevVacancy
      c.lowVacancyTicks[use] = pressured ? c.lowVacancyTicks[use] + 1 : 0
      if (c.lowVacancyTicks[use] >= G.bgDevTicks) {
        const room = c.zoneFar[use] * c.buildableM2 * 0.3 - c.bgFloor[use]
        const add = Math.min(room, Math.max(G.bgDevMin, c.floor[use] * G.bgDevRate, c.unmet[use] * perCapita * G.bgDevUnmetShare))
        if (add > 0) c.bgFloor[use] += add
      }
    })
  }
  refreshFloor(world)
  world.region.popHistory.push(world.chunks.reduce((s, c) => s + c.pop, 0))
}

export function popWeightedAccess(world: World): number {
  let pop = 0
  let acc = 0
  for (const c of world.chunks) {
    pop += c.pop
    acc += c.pop * c.access
  }
  return pop > 0 ? acc / pop : 0
}

export function refreshFloor(world: World) {
  for (const c of world.chunks) {
    for (const use of USES) c.floor[use] = c.bgFloor[use]
  }
  for (const b of world.buildings) {
    if (b.status === 'construction') continue
    const c = world.chunks[Math.floor(b.y / 16) * world.chunksPerSide + Math.floor(b.x / 16)]
    c.floor[b.use === 'station' ? 'retail' : b.use] += b.floorArea
  }
}
