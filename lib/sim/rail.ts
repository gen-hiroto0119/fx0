// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS, TICKS_PER_YEAR, TILE_M } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { book, firmById } from './finance.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { dailyCarKm, lineKm, trainsNeeded } from './network.ts'
import type { Line, TileKind, World } from './types.ts'

const R = PARAMS.rail

// Construction cost: track priced by the terrain it crosses, plus stations.
export function lineCost(world: World, line: Line): number {
  const t = world.terrain
  let cost = 0
  for (let i = 1; i < line.stations.length; i++) {
    const a = line.stations[i - 1]
    const b = line.stations[i]
    const steps = Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.y - b.y)))
    const km = (Math.hypot(a.x - b.x, a.y - b.y) * TILE_M * R.curvature) / 1000
    let mult = 0
    for (let s = 0; s < steps; s++) {
      const x = Math.round(a.x + ((b.x - a.x) * (s + 0.5)) / steps)
      const y = Math.round(a.y + ((b.y - a.y) * (s + 0.5)) / steps)
      mult += R.terrainMult[t.kind[y * t.size + x] as TileKind]
    }
    cost += km * R.trackYenPerKm * (mult / steps)
  }
  for (const s of line.stations) cost += s.express ? R.expressStationYen : R.stationYen
  return cost
}

// What a project loan can finance: the line plus the cars its timetable needs.
export function projectCost(line: Line): number {
  return line.cost + trainsNeeded(line) * line.service.cars * R.carYen
}

export function buildTicks(line: Line): number {
  return Math.max(R.buildTicksMin, Math.round(lineKm(line) * R.buildTicksPerKm))
}

// Buy (never sell) cars so the timetable can run.
export function ensureCars(world: World, line: Line) {
  const need = trainsNeeded(line) * line.service.cars
  const extra = need - line.carsOwned
  if (extra <= 0) return
  const firm = firmById(world, line.owner)
  const cost = extra * R.carYen
  firm.cash -= cost
  line.carsOwned = need
  line.carBookValue += cost
  book(world, firm.id, 'rail', 'rolling_stock', -cost, false)
}

export function progressLines(world: World) {
  for (const line of world.lines) {
    if (line.stage !== 'construction') continue
    const firm = firmById(world, line.owner)
    const pay = Math.min(line.cost - line.costPaid, line.cost / buildTicks(line))
    firm.cash -= pay
    line.costPaid += pay
    line.trackBookValue += pay
    book(world, firm.id, 'rail', 'construction', -pay, false)
    line.buildTicksLeft--
    if (line.buildTicksLeft > 0) continue
    line.stage = 'open'
    line.stageTick = world.tick
    ensureCars(world, line)
    world.events.push({ tick: world.tick, type: 'line_opened', actor: firm.id, importance: 4, payload: { line: line.id, name: line.name } })
  }
}

export function operateLines(world: World) {
  for (const line of world.lines) {
    if (line.stage !== 'open') continue
    const firm = firmById(world, line.owner)
    if (firm.bankrupt) continue
    const fare = (line.stats.dailyFare * 365) / TICKS_PER_YEAR
    const opex = (dailyCarKm(line) * R.opYenPerCarKm * 365) / TICKS_PER_YEAR
    const maint = (lineKm(line) * R.maintYenPerKmYear) / TICKS_PER_YEAR
    const trackDep = line.cost / (R.trackLifeYears * TICKS_PER_YEAR)
    const carDep = (line.carsOwned * R.carYen) / (R.carLifeYears * TICKS_PER_YEAR)
    line.trackBookValue = Math.max(0, line.trackBookValue - trackDep)
    line.carBookValue = Math.max(0, line.carBookValue - carDep)
    firm.cash += fare - opex - maint
    book(world, firm.id, 'rail', 'fare', fare)
    book(world, firm.id, 'rail', 'rail_opex', -opex)
    book(world, firm.id, 'rail', 'rail_maint', -maint)
    book(world, firm.id, 'rail', 'rail_dep', -(trackDep + carDep))
  }
}
