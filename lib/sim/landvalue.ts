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

function cityMomentum(world: World): number {
  const h = world.region.popHistory
  if (h.length < 14) return 1
  const growth = h[h.length - 1] / h[h.length - 14] - 1
  return 1 + Math.max(-0.2, Math.min(0.3, growth * 4))
}

function targetFromAccess(world: World, c: Chunk, access: number, momentum: number): number {
  const rel = Math.max(access, 1) / world.region.accessRef
  return L.base * c.landFactor * rel ** L.alpha * environment(c) * momentum
}

function accessWith(world: World, minutes: number[][], i: number): number {
  let a = 0
  world.chunks.forEach((d, j) => {
    const t = minutes[i][j]
    if (t !== Infinity) a += totalJobs(d) * Math.exp(-L.beta * t)
  })
  return a
}

const planned = (l: Line) => l.stage === 'applied' || l.stage === 'approved' || l.stage === 'construction'

// Travel minutes as if every publicly announced line were already open, plus
// how strongly each chunk prices that in (the stage probability p).
function plannedNetwork(world: World, minutes: number[][]): { minutes: number[][]; p: number[] } | null {
  if (!world.lines.some(planned)) return null
  const saved = world.lines
  world.lines = saved.map((l) => (planned(l) ? { ...l, stage: 'open' } : l))
  try {
    const access = world.chunks.map((c) => stationAccess(world, c))
    const p = access.map((list) =>
      list.reduce((best, a) => (planned(saved[a.line]) ? Math.max(best, L.stagePlanP[saved[a.line].stage]) : best), 0),
    )
    const car = carMatrix(world)
    const out = minutes.map((row, i) =>
      row.map((t, j) =>
        i === j ? t : Math.min(t, compositeMinutes(car.minutes[i][j], bestRail(world, access[i], access[j])?.minutes ?? Infinity)),
      ),
    )
    return { minutes: out, p }
  } finally {
    world.lines = saved
  }
}

export function updateLandValue(world: World, minutes: number[][]) {
  const momentum = cityMomentum(world)
  const plan = plannedNetwork(world, minutes)
  world.chunks.forEach((c, i) => {
    let target = targetFromAccess(world, c, c.access, momentum)
    if (plan && plan.p[i] > 0) {
      const withPlan = targetFromAccess(world, c, accessWith(world, plan.minutes, i), momentum)
      target += plan.p[i] * Math.max(0, withPlan - target)
    }
    if (c.rumorUntil > world.tick) target *= 1 + L.rumorBoost
    c.lvTarget = target
    c.lv += L.lambda * (target - c.lv)
  })
}

// Land value of one tile: the chunk's value lifted near busy stations.
export function lvAtTile(world: World, x: number, y: number): number {
  const c = chunkAt(world, x, y)
  let lift = 0
  for (const line of world.lines) {
    const p = line.stage === 'open' ? 1 : planned(line) ? L.stagePlanP[line.stage] : 0
    if (p <= 0) continue
    line.stations.forEach((s, si) => {
      const d = Math.hypot(s.x - x, s.y - y) * TILE_M
      const boardings = line.stage === 'open' ? (line.stats.boardings[si] ?? 0) : 10_000
      const quality = Math.max(0.3, Math.min(1.5, boardings / 20_000))
      lift = Math.max(lift, p * L.stationBonus * quality * Math.exp(-d / L.stationDecayM))
    })
  }
  return c.lv * (1 + lift)
}
