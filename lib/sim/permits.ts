// @ts-expect-error Node strip-types tests require the source extension.
import { OKU, PARAMS, TICKS_PER_YEAR } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { book, findFirm, firmById } from './finance.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { chunkAt, trackTiles } from './network.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { fail, ok, type Result } from './result.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { WOODLAND, type City, type Condition, type Line, type Permit, type World } from './types.ts'

// Permits follow the design doc's rule: the code scores every application and
// decides the clear cases; only the band in between is negotiated, and only
// with promises from a fixed menu that the code checks every week.

const P = PARAMS.permits

export type ConditionKind = Condition['kind']
export const CONDITION_KINDS: readonly ConditionKind[] = ['plaza', 'openBy', 'expressStop', 'fareFreeze']

// --- Who decides ---

// Every tile belongs to the nearest city; its mayor reviews track laid there.
export function cityOf(world: World, x: number, y: number): City {
  let best = world.cities[0]
  let bestD = Infinity
  for (const c of world.cities) {
    const d = Math.hypot(c.x - x, c.y - y)
    if (d < bestD) {
      best = c
      bestD = d
    }
  }
  return best
}

export function lineCities(world: World, line: Pick<Line, 'stations'>): City[] {
  const ids = new Set(trackTiles(line).map((t) => cityOf(world, t.x, t.y).id))
  for (const s of line.stations) ids.add(cityOf(world, s.x, s.y).id)
  return world.cities.filter((c) => ids.has(c.id))
}

function cityById(world: World, id: string): City {
  const city = world.cities.find((c) => c.id === id)
  if (!city) throw new Error(`unknown city ${id}`)
  return city
}

// --- How a mayor scores a line ---

export type LineImpact = { service: number; jobs: number; scenery: number; nuisance: number }

// The line's effects inside one city, each roughly between -1 and 1.
export function lineImpact(world: World, line: Line, cityId: string): LineImpact {
  const t = world.terrain
  const all = trackTiles(line)
  const inCity = all.filter((p) => cityOf(world, p.x, p.y).id === cityId)

  const servedChunks = new Set(
    line.stations.filter((s) => cityOf(world, s.x, s.y).id === cityId).map((s) => chunkAt(world, s.x, s.y)),
  )
  const served = [...servedChunks].reduce((s, c) => s + c.pop, 0)
  const spend = all.length > 0 ? (line.cost * inCity.length) / all.length : 0
  const scenic = inCity.filter((p) => {
    const i = p.y * t.size + p.x
    return WOODLAND.includes(t.cover[i]) || t.kind[i] === 'hill' || t.kind[i] === 'mountain'
  }).length
  const dense = inCity.filter((p) => chunkAt(world, p.x, p.y).pop > P.denseChunkPop).length

  return {
    service: Math.min(1.5, served / P.servedPopForFullService),
    jobs: Math.min(1, spend / P.spendForFullJobs),
    scenery: -Math.min(1, scenic / P.tilesForFullScenery),
    nuisance: -Math.min(1, dense / P.tilesForFullNuisance),
  }
}

export function permitScore(world: World, line: Line, city: City, firmId: string): number {
  const w = P.weights[city.persona]
  const x = lineImpact(world, line, city.id)
  const relation = city.relation[firmId] ?? 0
  return w.service * x.service + w.jobs * x.jobs + w.scenery * x.scenery + w.nuisance * x.nuisance + P.relationWeight * relation
}

// --- Promises ---

// The concrete form of each promise for this line and city, as the code
// would write it into a deal. Express stops need a station in the city.
function shapeCondition(world: World, line: Line, city: City, kind: ConditionKind, plazaYen: number): Condition | null {
  const until = world.tick + line.buildTicksLeft + P.dealYears * TICKS_PER_YEAR
  if (kind === 'plaza') return plazaYen > 0 ? { kind, yen: Math.min(P.plazaMax, plazaYen) } : null
  if (kind === 'openBy') return { kind, tick: world.tick + line.buildTicksLeft + P.openBySlackTicks }
  if (kind === 'fareFreeze') return { kind, fareMult: line.service.fareMult, untilTick: until }

  // The busiest station in the city, ends excluded: they always get express trains.
  let station = -1
  let best = -1
  line.stations.forEach((s, i) => {
    if (i === 0 || i === line.stations.length - 1 || cityOf(world, s.x, s.y).id !== city.id) return
    const pop = chunkAt(world, s.x, s.y).pop
    if (pop > best) {
      best = pop
      station = i
    }
  })
  return station >= 0 ? { kind, station, untilTick: until } : null
}

export function conditionWorth(city: City, c: Condition): number {
  const v = P.conditionValue[city.persona]
  if (c.kind === 'plaza') return (v.plazaPer10Oku * c.yen) / (10 * OKU)
  return v[c.kind]
}

function worth(city: City, conditions: Condition[]): number {
  return conditions.reduce((s, c) => s + conditionWorth(city, c), 0)
}

// The mayor's ask: the promises the mayor values most until the gap to
// approval closes, with a station-square payment for whatever is left.
// Null when even the most the menu allows would not be enough.
export function mayorAsk(world: World, line: Line, city: City, gap: number): Condition[] | null {
  const ask: Condition[] = []
  let covered = 0
  const values = P.conditionValue[city.persona]
  const promises = (['expressStop', 'openBy', 'fareFreeze'] as const)
    .map((kind) => shapeCondition(world, line, city, kind, 0))
    .filter((c): c is Condition => c !== null)
    .sort((a, b) => conditionWorth(city, b) - conditionWorth(city, a))
  for (const c of promises) {
    if (covered >= gap) break
    ask.push(c)
    covered += conditionWorth(city, c)
  }
  if (covered < gap) {
    const perYen = values.plazaPer10Oku / (10 * OKU)
    const yen = Math.ceil((gap - covered) / perYen / P.plazaStep) * P.plazaStep
    if (yen > P.plazaMax) return null
    ask.push({ kind: 'plaza', yen })
  }
  return ask
}

// --- Filing and review ---

const blockKey = (cityId: string, firmId: string) => `${cityId}:${firmId}`

// A city that refused this firm recently, if any, among the line's cities.
export function blockingCity(world: World, firmId: string, line: Line): City | null {
  return lineCities(world, line).find((c) => (world.blockedUntil[blockKey(c.id, firmId)] ?? 0) > world.tick) ?? null
}

// One permit per city the line passes through. Longer stretches in a city
// take longer to review.
export function filePermits(world: World, line: Line): Permit[] {
  const tiles = trackTiles(line)
  return lineCities(world, line).map((city) => {
    const km = (tiles.filter((t) => cityOf(world, t.x, t.y).id === city.id).length * 200) / 1000
    const review = Math.min(P.reviewTicksMax, P.reviewTicks + Math.round(km * P.reviewTicksPerCityKm))
    const permit: Permit = {
      id: `permit${world.nextId++}`,
      lineId: line.id,
      firm: line.owner,
      cityId: city.id,
      status: 'reviewing',
      filedTick: world.tick,
      decideTick: world.tick + review,
      score: 0,
      round: 0,
      ask: [],
      offered: [],
    }
    world.permits.push(permit)
    return permit
  })
}

function adjustRelation(city: City, firmId: string, delta: number) {
  city.relation[firmId] = Math.max(-100, Math.min(100, (city.relation[firmId] ?? 0) + delta))
}

function lineOfPermit(world: World, permit: Permit): Line {
  const line = world.lines.find((l) => l.id === permit.lineId)
  if (!line) throw new Error(`permit ${permit.id} has no line`)
  return line
}

function refuse(world: World, permit: Permit) {
  permit.status = 'rejected'
  world.blockedUntil[blockKey(permit.cityId, permit.firm)] = world.tick + P.refileBlockTicks
  world.events.push({
    tick: world.tick,
    type: 'permit_rejected',
    actor: permit.firm,
    importance: 3,
    payload: { line: permit.lineId, city: permit.cityId },
  })
}

// The mayor's first decision, once the review period is over.
function decide(world: World, permit: Permit) {
  const line = lineOfPermit(world, permit)
  const city = cityById(world, permit.cityId)
  permit.score = permitScore(world, line, city, permit.firm)
  if ((city.relation[permit.firm] ?? 0) < P.refuseRelation || permit.score < P.rejectBelow) return refuse(world, permit)
  if (permit.score >= P.approveAt) {
    permit.status = 'approved'
    return
  }
  const ask = mayorAsk(world, line, city, P.approveAt - permit.score)
  if (!ask) return refuse(world, permit)
  permit.status = 'negotiating'
  permit.round = 1
  permit.ask = ask
  world.events.push({
    tick: world.tick,
    type: 'permit_negotiating',
    actor: permit.firm,
    importance: 3,
    payload: { line: permit.lineId, city: permit.cityId },
  })
}

// A line goes ahead once every city has approved it. One refusal sends it
// back to planning, and the other cities' reviews and promises lapse.
function settleLine(world: World, line: Line) {
  if (line.stage !== 'applied') return
  const permits = world.permits.filter((p) => p.lineId === line.id && p.status !== 'withdrawn')
  if (permits.some((p) => p.status === 'rejected')) {
    for (const p of permits) if (p.status !== 'rejected') p.status = 'withdrawn'
    for (const d of world.deals) if (d.lineId === line.id && d.status === 'active') d.status = 'void'
    line.stage = 'planned'
    line.stageTick = world.tick
    world.events.push({ tick: world.tick, type: 'line_rejected', actor: line.owner, importance: 3, payload: { line: line.id } })
    return
  }
  if (permits.length > 0 && permits.every((p) => p.status === 'approved')) {
    line.stage = 'approved'
    line.stageTick = world.tick
    world.events.push({ tick: world.tick, type: 'line_approved', actor: line.owner, importance: 3, payload: { line: line.id } })
  }
}

export function reviewPermits(world: World) {
  for (const permit of world.permits) {
    if (permit.status === 'reviewing' && permit.decideTick <= world.tick) decide(world, permit)
  }
  for (const line of world.lines) settleLine(world, line)
}

// --- Negotiation ---

export type Offer = { kinds: ConditionKind[]; plazaYen?: number }

// One round: the firm offers promises from the menu. Enough to close the gap
// and the mayor signs; otherwise the mayor repeats the ask, and after the
// last round the application is refused.
export function respondToPermit(world: World, firmId: string, permitId: string, offer: Offer): Result<'approved' | 'countered' | 'rejected'> {
  const permit = world.permits.find((p) => p.id === permitId)
  if (!permit || permit.firm !== firmId) return fail('unknown_permit')
  if (permit.status !== 'negotiating') return fail('not_negotiating')
  const firm = findFirm(world, firmId)
  if (!firm) return fail('unknown_firm')
  const line = lineOfPermit(world, permit)
  const city = cityById(world, permit.cityId)

  const conditions = [...new Set(offer.kinds)]
    .map((kind) => shapeCondition(world, line, city, kind, offer.plazaYen ?? 0))
    .filter((c): c is Condition => c !== null)
  const plaza = conditions.find((c) => c.kind === 'plaza')
  if (plaza && plaza.kind === 'plaza' && firm.cash < plaza.yen) return fail('insufficient_cash')
  permit.offered = conditions

  if (worth(city, conditions) >= P.approveAt - permit.score) {
    sign(world, permit, city, conditions)
    settleLine(world, line)
    return ok('approved')
  }
  permit.round++
  if (permit.round > P.maxRounds) {
    refuse(world, permit)
    settleLine(world, line)
    return ok('rejected')
  }
  return ok('countered')
}

function sign(world: World, permit: Permit, city: City, conditions: Condition[]) {
  permit.status = 'approved'
  const firm = firmById(world, permit.firm)
  for (const condition of conditions) {
    const kept = condition.kind === 'plaza'
    world.deals.push({
      id: `deal${world.nextId++}`,
      firm: permit.firm,
      cityId: city.id,
      lineId: permit.lineId,
      condition,
      status: kept ? 'kept' : 'active',
      agreedTick: world.tick,
    })
    if (condition.kind === 'plaza') {
      firm.cash -= condition.yen
      book(world, firm.id, 'corporate', 'public_contribution', -condition.yen)
      adjustRelation(city, firm.id, (P.relation.plazaPer10Oku * condition.yen) / (10 * OKU))
    }
  }
  world.events.push({
    tick: world.tick,
    type: 'permit_agreed',
    actor: permit.firm,
    importance: 3,
    payload: { line: permit.lineId, city: city.id, conditions: conditions.map((c) => c.kind) },
  })
}

// Pulls an application back: its permits lapse and the line returns to planning.
export function withdrawLine(world: World, firmId: string, lineId: string): Result {
  const line = world.lines.find((l) => l.id === lineId)
  if (!line || line.owner !== firmId) return fail('unknown_line')
  if (line.stage !== 'applied') return fail('wrong_stage')
  for (const p of world.permits) if (p.lineId === lineId && p.status !== 'rejected') p.status = 'withdrawn'
  for (const d of world.deals) if (d.lineId === lineId && d.status === 'active') d.status = 'void'
  line.stage = 'planned'
  line.stageTick = world.tick
  return ok(undefined)
}

// --- Keeping promises ---

function breakDeal(world: World, deal: World['deals'][number], city: City) {
  deal.status = 'broken'
  const firm = firmById(world, deal.firm)
  firm.cash -= P.penaltyYen
  book(world, firm.id, 'corporate', 'penalty', -P.penaltyYen)
  adjustRelation(city, firm.id, P.relation.broken)
  world.events.push({
    tick: world.tick,
    type: 'deal_broken',
    actor: deal.firm,
    importance: 4,
    payload: { city: city.id, line: deal.lineId, condition: deal.condition.kind },
  })
}

function keepDeal(deal: World['deals'][number], city: City) {
  deal.status = 'kept'
  adjustRelation(city, deal.firm, P.relation.kept)
}

// Checks each active promise against the world this week.
export function checkDeals(world: World) {
  for (const deal of world.deals) {
    if (deal.status !== 'active') continue
    const city = cityById(world, deal.cityId)
    const line = world.lines.find((l) => l.id === deal.lineId)
    if (!line) continue
    const c = deal.condition
    if (c.kind === 'openBy') {
      if (line.stage === 'open') keepDeal(deal, city)
      else if (world.tick > c.tick) breakDeal(world, deal, city)
    } else if (c.kind === 'expressStop') {
      if (line.stage === 'open' && !line.stations[c.station]?.express) breakDeal(world, deal, city)
      else if (world.tick >= c.untilTick) keepDeal(deal, city)
    } else if (c.kind === 'fareFreeze') {
      if (line.service.fareMult > c.fareMult + 1e-9) breakDeal(world, deal, city)
      else if (world.tick >= c.untilTick) keepDeal(deal, city)
    }
  }
}

// Buying up a district against the mayor's wishes costs goodwill.
export function noteRumor(world: World, firmId: string, x: number, y: number) {
  adjustRelation(cityOf(world, x, y), firmId, P.relation.rumor)
}
