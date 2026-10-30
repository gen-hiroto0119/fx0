// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS, TILE_M } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { environment, totalJobs } from './growth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { bestRail, carMatrix, chunkAt, stationAccess } from './network.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { compositeMinutes } from './traffic.ts'
import type { Chunk, Line, World } from './types.ts'

const L = PARAMS.lv

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, v))

// Prices run ahead in a growing region and lag in a shrinking one.
function cityMomentum(popHistory: number[]): number {
  const h = popHistory
  if (h.length < L.momentumWindow + 1) return 1
  const growth = h[h.length - 1] / h[h.length - 1 - L.momentumWindow] - 1
  return 1 + clamp(growth * L.momentumGain, L.momentumRange)
}

function targetFromAccess(world: World, c: Chunk, access: number, momentum: number): number {
  const rel = Math.max(access, 1) / world.region.accessRef
  return L.base * c.landFactor * rel ** L.alpha * environment(c) * momentum
}

function accessWith(chunks: Chunk[], minutes: number[][], i: number): number {
  let a = 0
  chunks.forEach((d, j) => {
    const t = minutes[i][j]
    if (t !== Infinity) a += totalJobs(d) * Math.exp(-L.beta * t)
  })
  return a
}

const isPlanned = (l: Line) => l.stage === 'applied' || l.stage === 'approved' || l.stage === 'construction'

type PlannedNetwork = { minutes: number[][]; p: number[] }

// Travel minutes as if every publicly announced line were already open, plus
// how strongly each chunk prices that in (the stage probability p).
function plannedNetwork(world: World, minutes: number[][]): PlannedNetwork | null {
  if (!world.lines.some(isPlanned)) return null
  const asIfOpen = world.lines.map((l) => (isPlanned(l) ? { ...l, stage: 'open' as const } : l))
  const access = world.chunks.map((c) => stationAccess(asIfOpen, c))
  const p = access.map((list) =>
    list.reduce((best, a) => {
      const line = world.lines[a.line]
      return isPlanned(line) ? Math.max(best, L.stagePlanP[line.stage]) : best
    }, 0),
  )
  const car = carMatrix(world.roads, world.chunks.length)
  const withPlan = minutes.map((row, i) =>
    row.map((t, j) => {
      if (i === j) return t
      const railMinutes = bestRail(asIfOpen, access[i], access[j])?.minutes ?? Infinity
      return Math.min(t, compositeMinutes(car.minutes[i][j], railMinutes))
    }),
  )
  return { minutes: withPlan, p }
}

export type LandValue = { lv: number; lvTarget: number }

// Each chunk's target price from accessibility (plus announced plans and
// rumours); the price itself moves part of the way there every tick.
export function computeLandValues(world: World, minutes: number[][]): LandValue[] {
  const momentum = cityMomentum(world.region.popHistory)
  const plan = plannedNetwork(world, minutes)
  return world.chunks.map((c, i) => {
    let target = targetFromAccess(world, c, c.access, momentum)
    if (plan && plan.p[i] > 0) {
      const planned = targetFromAccess(world, c, accessWith(world.chunks, plan.minutes, i), momentum)
      target += plan.p[i] * Math.max(0, planned - target)
    }
    if (c.rumorUntil > world.tick) target *= 1 + L.rumorBoost
    return { lvTarget: target, lv: c.lv + L.lambda * (target - c.lv) }
  })
}

export function applyLandValues(world: World, values: LandValue[]) {
  world.chunks.forEach((c, i) => {
    c.lvTarget = values[i].lvTarget
    c.lv = values[i].lv
  })
}

// Land value of one tile: the chunk's value lifted near busy stations.
export function lvAtTile(world: World, x: number, y: number): number {
  const c = chunkAt(world, x, y)
  let lift = 0
  for (const line of world.lines) {
    const p = line.stage === 'open' ? 1 : isPlanned(line) ? L.stagePlanP[line.stage] : 0
    if (p <= 0) continue
    line.stations.forEach((s, si) => {
      const d = Math.hypot(s.x - x, s.y - y) * TILE_M
      const boardings = line.stage === 'open' ? (line.stats.boardings[si] ?? 0) : L.plannedStationBoardings
      const quality = clamp(boardings / L.stationQualityBoardings, L.stationQualityRange)
      lift = Math.max(lift, p * L.stationBonus * quality * Math.exp(-d / L.stationDecayM))
    })
  }
  return c.lv * (1 + lift)
}
