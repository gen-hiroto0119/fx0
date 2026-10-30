// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS, TICKS_PER_YEAR, TILE_AREA_M2, TILES_PER_CHUNK } from './params.ts'
import {
  annuity,
  annualDebtService,
  annualEbitda,
  book,
  collateralRoom,
  findFirm,
  newLoan,
  repayBuildingLoans,
  spread,
// @ts-expect-error Node strip-types tests require the source extension.
} from './finance.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { lvAtTile } from './landvalue.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { chunkAt } from './network.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { buildTicks, ensureCars, lineCost, projectCost } from './rail.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { buildingValue } from './realestate.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { blockingCity, filePermits, noteRumor } from './permits.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { fail, ok, type Result } from './result.ts'
import type { BuildingUse, Line, Service, Station, World } from './types.ts'

// The action API shared by the player and the AI rivals. Every action
// validates against the same rules and returns an error instead of throwing.
export type { Result } from './result.ts'

const L = PARAMS.lv
const RE = PARAMS.realEstate
const F = PARAMS.finance

function inBounds(world: World, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < world.terrain.size && y < world.terrain.size
}

export function landPrice(world: World, firmId: string, x: number, y: number): number {
  const c = chunkAt(world, x, y)
  const recent = c.purchases
    .filter((p) => p.firm === firmId && p.tick > world.tick - L.rumorWindow)
    .reduce((s, p) => s + p.tiles, 0)
  return lvAtTile(world, x, y) * TILE_AREA_M2 * (1 + L.kappa * (recent / TILES_PER_CHUNK))
}

// Once a line is filed its station sites are public and reserved for it, so
// nobody else can buy them out from under the line.
function reservedForStation(world: World, firmId: string, x: number, y: number): boolean {
  return world.lines.some(
    (l) => l.owner !== firmId && l.stage !== 'planned' && l.stations.some((s) => s.x === x && s.y === y),
  )
}

export function buyLand(world: World, firmId: string, x: number, y: number): Result<number> {
  if (!inBounds(world, x, y)) return fail('out_of_bounds')
  const kind = world.terrain.kind[y * world.terrain.size + x]
  if (kind === 'sea' || kind === 'river' || kind === 'mountain') return fail('not_buildable')
  const key = `${x},${y}`
  if (world.parcels[key]) return fail('already_owned')
  if (reservedForStation(world, firmId, x, y)) return fail('reserved_for_station')
  const firm = findFirm(world, firmId)
  if (!firm) return fail('unknown_firm')
  const price = landPrice(world, firmId, x, y)
  if (firm.cash < price) return fail('insufficient_cash')
  firm.cash -= price
  world.parcels[key] = { owner: firmId, cost: price }
  book(world, firmId, 'realestate', 'land_purchase', -price, false)

  const c = chunkAt(world, x, y)
  c.purchases.push({ tick: world.tick, firm: firmId, tiles: 1 })
  c.purchases = c.purchases.filter((p) => p.tick > world.tick - L.rumorWindow)
  const bought = c.purchases.filter((p) => p.firm === firmId).reduce((s, p) => s + p.tiles, 0)
  if (bought / TILES_PER_CHUNK > L.rumorShare && c.rumorUntil <= world.tick) {
    c.rumorUntil = world.tick + L.rumorTicks
    world.events.push({ tick: world.tick, type: 'land_rumor', actor: firmId, x, y, importance: 3 })
    noteRumor(world, firmId, x, y)
  }
  return ok(price)
}

export const DEFAULT_SERVICE: Service = { localPeak: 10, localOff: 6, expressPeak: 0, expressOff: 0, cars: 6, fareMult: 1 }

export function planLine(world: World, firmId: string, name: string, stations: Station[]): Result<Line> {
  if (!findFirm(world, firmId)) return fail('unknown_firm')
  if (stations.length < 2) return fail('need_two_stations')
  for (const s of stations) {
    if (!inBounds(world, s.x, s.y)) return fail('out_of_bounds')
    const kind = world.terrain.kind[s.y * world.terrain.size + s.x]
    if (kind === 'sea' || kind === 'river' || kind === 'mountain') return fail('station_not_buildable')
    const p = world.parcels[`${s.x},${s.y}`]
    if (p && p.owner !== firmId) return fail('station_on_others_land')
  }
  const line: Line = {
    id: `line${world.nextId++}`,
    owner: firmId,
    name,
    stations,
    stage: 'planned',
    stageTick: world.tick,
    buildTicksLeft: 0,
    cost: 0,
    costPaid: 0,
    carsOwned: 0,
    carBookValue: 0,
    trackBookValue: 0,
    service: { ...DEFAULT_SERVICE },
    stats: { dailyRiders: 0, dailyPassengerKm: 0, dailyFare: 0, peakLoadRatio: 0, boardings: stations.map(() => 0) },
    crowdingPenaltyMin: 0,
  }
  line.cost = lineCost(world, line)
  line.buildTicksLeft = buildTicks(line)
  world.lines.push(line)
  return ok(line)
}

function lineOf(world: World, firmId: string, lineId: string): Line | null {
  const line = world.lines.find((l) => l.id === lineId)
  return line && line.owner === firmId ? line : null
}

// Filing makes the plan public; land prices along it start to move. Each city
// the line passes through reviews it (see permits.ts).
export function applyForLine(world: World, firmId: string, lineId: string): Result {
  const line = lineOf(world, firmId, lineId)
  if (!line) return fail('unknown_line')
  if (line.stage !== 'planned') return fail('wrong_stage')
  if (blockingCity(world, firmId, line)) return fail('refile_blocked')
  filePermits(world, line)
  line.stage = 'applied'
  line.stageTick = world.tick
  world.events.push({ tick: world.tick, type: 'line_applied', actor: firmId, importance: 3, payload: { line: line.id, name: line.name } })
  return ok(undefined)
}

// Approves a filed line without the mayors. For balancing scripts and tests
// that need a line to go ahead; the game goes through permits.ts.
export function grantLine(world: World, lineId: string): Result {
  const line = world.lines.find((l) => l.id === lineId)
  if (!line) return fail('unknown_line')
  if (line.stage !== 'applied') return fail('wrong_stage')
  for (const p of world.permits) if (p.lineId === line.id && p.status === 'reviewing') p.status = 'approved'
  line.stage = 'approved'
  line.stageTick = world.tick
  world.events.push({ tick: world.tick, type: 'line_approved', actor: line.owner, importance: 3, payload: { line: line.id } })
  return ok(undefined)
}

export function startConstruction(world: World, firmId: string, lineId: string): Result {
  const line = lineOf(world, firmId, lineId)
  if (!line) return fail('unknown_line')
  if (line.stage !== 'approved') return fail('wrong_stage')
  for (const s of line.stations) {
    const key = `${s.x},${s.y}`
    const p = world.parcels[key]
    if (p && p.owner !== firmId) return fail('station_on_others_land')
    world.parcels[key] = { owner: firmId, cost: p?.cost ?? 0, station: true }
  }
  line.stage = 'construction'
  line.stageTick = world.tick
  return ok(undefined)
}

export function setService(world: World, firmId: string, lineId: string, service: Partial<Service>): Result {
  const line = lineOf(world, firmId, lineId)
  if (!line) return fail('unknown_line')
  const next = { ...line.service, ...service }
  const limits = PARAMS.rail.serviceLimits
  const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi
  if (!within(next.fareMult, limits.fareMult)) return fail('fare_out_of_range')
  if (!within(next.cars, limits.cars)) return fail('cars_out_of_range')
  const frequencies = [next.localPeak, next.localOff, next.expressPeak, next.expressOff]
  if (!frequencies.every((v) => within(v, limits.trainsPerHour))) return fail('frequency_out_of_range')
  line.service = next
  if (line.stage === 'open') ensureCars(world, line)
  return ok(undefined)
}

export function setExpressStops(world: World, firmId: string, lineId: string, stops: number[]): Result {
  const line = lineOf(world, firmId, lineId)
  if (!line) return fail('unknown_line')
  const set = new Set(stops)
  line.stations.forEach((s, i) => {
    s.express = set.has(i) || i === 0 || i === line.stations.length - 1
  })
  return ok(undefined)
}

export function develop(
  world: World,
  firmId: string,
  x: number,
  y: number,
  use: BuildingUse,
  floorArea: number,
  mode: 'lease' | 'sale' = 'lease',
): Result<string> {
  const key = `${x},${y}`
  const parcel = world.parcels[key]
  if (!parcel || parcel.owner !== firmId || parcel.station) return fail('not_your_land')
  if (world.buildings.some((b) => b.x === x && b.y === y && b.status !== 'sold')) return fail('already_built')
  if (mode === 'sale' && use !== 'res') return fail('only_housing_for_sale')
  if (use === 'station') {
    const nextToOwnStation = world.lines.some(
      (l) => l.owner === firmId && l.stations.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) === 1),
    )
    if (!nextToOwnStation) return fail('station_building_needs_own_station')
  }
  const c = chunkAt(world, x, y)
  const zoneUse = use === 'station' ? 'retail' : use
  const far = Math.max(c.zoneFar[zoneUse], use === 'station' ? RE.stationBuildingFar : 0)
  if (far <= 0) return fail('zoning_forbids_use')
  if (floorArea <= 0 || floorArea > far * TILE_AREA_M2) return fail('exceeds_far')
  const firm = findFirm(world, firmId)
  if (!firm) return fail('unknown_firm')
  const cost = floorArea * RE.yenPerM2[use]
  const upfront = cost * RE.upfrontShare
  if (firm.cash < upfront) return fail('insufficient_cash')
  firm.cash -= upfront
  book(world, firmId, 'realestate', 'construction', -upfront, false)
  const id = `bld${world.nextId++}`
  world.buildings.push({
    id,
    owner: firmId,
    x,
    y,
    use,
    mode,
    floorArea,
    status: 'construction',
    ticksLeft: RE.buildTicks[use] + Math.round(floorArea / RE.buildM2PerTick),
    cost,
    costPaid: upfront,
    bookValue: upfront,
    occupancy: 0,
    ageTicks: 0,
    saleTicksLeft: 0,
  })
  return ok(id)
}

export function sellBuilding(world: World, firmId: string, buildingId: string): Result<number> {
  const b = world.buildings.find((x) => x.id === buildingId)
  if (!b || b.owner !== firmId) return fail('unknown_building')
  if (b.status !== 'operating') return fail('not_operating')
  const firm = findFirm(world, firmId)
  if (!firm) return fail('unknown_firm')
  const price = buildingValue(world, b)
  const parcel = world.parcels[`${b.x},${b.y}`]
  firm.cash += price
  book(world, firmId, 'realestate', 'sale_gain', price - b.bookValue - (parcel?.cost ?? 0))
  repayBuildingLoans(world, firm, b.id, 1)
  b.owner = 'market'
  b.status = 'sold'
  delete world.parcels[`${b.x},${b.y}`]
  return ok(price)
}

// A project loan names the line or the building under construction it pays
// for; anything else is a corporate loan against collateral.
export type BorrowRequest = { amount: number; years: number; graceYears?: number; lineId?: string; buildingId?: string }

export function borrow(world: World, firmId: string, req: BorrowRequest): Result<string> {
  const firm = findFirm(world, firmId)
  if (!firm) return fail('unknown_firm')
  if (!(req.amount > 0)) return fail('invalid_amount')
  const isProject = Boolean(req.lineId || req.buildingId)
  const terms: readonly number[] = isProject ? F.projectLoanYears : F.loanYears
  if (!terms.includes(req.years)) return fail(isProject ? 'invalid_project_term' : 'invalid_term')
  const grace = req.graceYears ?? 0
  if (grace < 0 || grace > F.maxGraceYears) return fail('invalid_grace')
  const rate = F.baseRate + spread(firm.rating)
  if (req.lineId) {
    const line = lineOf(world, firmId, req.lineId)
    if (!line) return fail('unknown_line')
    if (line.stage !== 'approved' && line.stage !== 'construction') return fail('line_not_approved')
    const drawn = firm.loans.filter((l) => l.lineId === line.id).reduce((s, l) => s + l.principal, 0)
    if (drawn + req.amount > projectCost(line) * F.projectMaxShare) return fail('exceeds_project_share')
    return ok(newLoan(world, firm, 'project', req.amount, rate + F.projectPremium, req.years, grace, { lineId: line.id }).id)
  }
  if (req.buildingId) {
    const b = world.buildings.find((x) => x.id === req.buildingId)
    if (!b || b.owner !== firmId) return fail('unknown_building')
    if (b.status !== 'construction') return fail('not_under_construction')
    const drawn = firm.loans.filter((l) => l.buildingId === b.id).reduce((s, l) => s + l.principal, 0)
    if (drawn + req.amount > b.cost * F.projectMaxShare) return fail('exceeds_building_share')
    return ok(newLoan(world, firm, 'project', req.amount, rate + F.projectPremium, req.years, grace, { buildingId: b.id }).id)
  }
  if (grace > 0) return fail('grace_only_for_projects')
  if (req.amount > collateralRoom(world, firm, (b) => buildingValue(world, b))) return fail('exceeds_collateral')
  const yearly = annuity(req.amount, rate / TICKS_PER_YEAR, req.years * TICKS_PER_YEAR) * TICKS_PER_YEAR
  if (annualDebtService(firm) + yearly > annualEbitda(world, firmId) / F.dscr) return fail('exceeds_debt_service')
  return ok(newLoan(world, firm, 'corporate', req.amount, rate, req.years, 0).id)
}
