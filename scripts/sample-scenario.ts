// The design doc's sample strategy, shared by the balancing scripts: a line
// from the port city to the plain city on a 70% project loan, a little land
// next to the middle stations, and housing there at opening, also 70% financed.
import {
  applyForLine,
  chunkAt,
  PARAMS,
  borrow,
  buyLand,
  develop,
  grantLine,
  planLine,
  projectCost,
  setExpressStops,
  setService,
  startConstruction,
  TILE_AREA_M2,
  type Line,
  type Station,
  type World,
// @ts-expect-error Node strip-types tests require the source extension.
} from '../lib/sim/index.ts'

export const PLAYER = 'player'
export const STATION_COUNT = 8
export const LAND_BANK_TILES = 2
export const DEVELOP_FAR_SHARE = 0.5 // half of what zoning allows
export const LOAN_SHARE = 0.7
const EQUITY_CUSHION = 1.5

function buildable(w: World, x: number, y: number): boolean {
  const k = w.terrain.kind[y * w.terrain.size + x]
  return k === 'plain' || k === 'hill'
}

function snap(w: World, x: number, y: number): Station {
  for (let r = 0; r < 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = Math.round(x) + dx
        const ny = Math.round(y) + dy
        if (buildable(w, nx, ny)) return { x: nx, y: ny, express: false }
      }
    }
  }
  throw new Error(`no buildable tile near ${x},${y}`)
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${r.error}`)
  return r.value
}

// Points on the straight line between the first two cities, where the stations go.
export function corridorPoints(world: World): { x: number; y: number }[] {
  const [a, b] = world.cities
  return Array.from({ length: STATION_COUNT }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / (STATION_COUNT - 1),
    y: a.y + ((b.y - a.y) * i) / (STATION_COUNT - 1),
  }))
}

export type SampleLine = { line: Line; landBank: [number, number][] }

export function buildSampleLine(world: World): SampleLine {
  const stations = corridorPoints(world).map((p) => snap(world, p.x, p.y))
  const line = must(planLine(world, PLAYER, '港平線', stations), 'plan')
  must(setExpressStops(world, PLAYER, line.id, [3]), 'express')

  // Buy land next to the middle stations before the plan becomes public.
  const landBank: [number, number][] = []
  for (const s of stations.slice(3, 3 + LAND_BANK_TILES)) {
    if (buyLand(world, PLAYER, s.x + 1, s.y).ok) landBank.push([s.x + 1, s.y])
  }

  must(applyForLine(world, PLAYER, line.id), 'apply')
  must(grantLine(world, line.id), 'grant')
  must(setService(world, PLAYER, line.id, { localPeak: 8, localOff: 4, expressPeak: 4, expressOff: 2, cars: 4 }), 'service')
  must(borrow(world, PLAYER, { amount: projectCost(line) * LOAN_SHARE, years: 30, graceYears: 3, lineId: line.id }), 'borrow')
  must(startConstruction(world, PLAYER, line.id), 'construct')
  return { line, landBank }
}

// Builds on the next empty tile of the land bank, alternating condos and rental
// housing at half the zoning limit, once cash covers the 30% equity with room
// to spare. The rest of the cost comes from a construction loan.
export function developWhenAffordable(world: World, landBank: [number, number][]): boolean {
  const firm = world.firms.find((f) => f.id === PLAYER)!
  const built = (x: number, y: number) => world.buildings.some((b) => b.x === x && b.y === y)
  const next = landBank.findIndex(([x, y]) => world.parcels[`${x},${y}`]?.owner === PLAYER && !built(x, y))
  if (next < 0) return false

  const [x, y] = landBank[next]
  const floor = chunkAt(world, x, y).zoneFar.res * TILE_AREA_M2 * DEVELOP_FAR_SHARE
  const equity = floor * PARAMS.realEstate.yenPerM2.res * (1 - LOAN_SHARE)
  // Loan money already drawn is spoken for until the buildings it pays for are finished.
  const unpaid = world.buildings.filter((b) => b.owner === PLAYER && b.status === 'construction').reduce((s, b) => s + b.cost - b.costPaid, 0)
  if (firm.cash - unpaid < equity * EQUITY_CUSHION) return false

  const mode = next % 2 === 0 ? 'sale' : 'lease'
  const id = must(develop(world, PLAYER, x, y, 'res', floor, mode), 'develop')
  const cost = world.buildings.find((b) => b.id === id)!.cost
  must(borrow(world, PLAYER, { amount: cost * LOAN_SHARE, years: mode === 'sale' ? 10 : 20, graceYears: mode === 'sale' ? 2 : 1, buildingId: id }), 'building loan')
  return true
}
