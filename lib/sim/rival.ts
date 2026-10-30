// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS, TILE_AREA_M2, TILE_M } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { borrow, buyLand, develop, landPrice } from './actions.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { debt, findFirm } from './finance.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { chunkAt } from './network.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { plannedValue } from './realestate.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { fail, type Result } from './result.ts'
import type { Building, Firm, Line, RivalPersona, World } from './types.ts'

// AI rivals follow the design doc: the code reads what is public, proposes a
// short list of moves with their expected return, and the rival picks among
// them. The picking is a function so a language model can take it over; the
// moves still go through the same actions and checks as the player's.

const RV = PARAMS.rival
const L = PARAMS.lv
const RE = PARAMS.realEstate

export type CandidateKind = 'buyAhead' | 'followRumor' | 'develop'

export type Candidate = {
  id: string
  kind: CandidateKind
  x: number
  y: number
  cost: number // cash it needs now
  gain: number // expected value it adds
  reason: string // one line, also what the news reports
}

// What a rival knows: its own books and what every firm can see.
export type Briefing = {
  tick: number
  cash: number
  debt: number
  rating: string
  announcedLines: { id: string; owner: string; name: string; stage: Line['stage']; stations: number }[]
  rumors: { x: number; y: number; firm: string }[]
}

export type Chooser = (persona: RivalPersona, briefing: Briefing, candidates: Candidate[]) => string[]

export function rivalBriefing(world: World, firm: Firm): Briefing {
  const rumors: Briefing['rumors'] = []
  for (const e of world.events) {
    if (e.type !== 'land_rumor' || e.actor === firm.id || e.x === undefined || e.y === undefined) continue
    if (chunkAt(world, e.x, e.y).rumorUntil > world.tick) rumors.push({ x: e.x, y: e.y, firm: e.actor ?? '' })
  }
  return {
    tick: world.tick,
    cash: firm.cash,
    debt: debt(firm),
    rating: firm.rating,
    announcedLines: world.lines
      .filter((l) => l.owner !== firm.id && l.stage !== 'planned')
      .map((l) => ({ id: l.id, owner: l.owner, name: l.name, stage: l.stage, stations: l.stations.length })),
    rumors,
  }
}

// --- Candidates ---

function buildable(world: World, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.terrain.size || y >= world.terrain.size) return false
  const k = world.terrain.kind[y * world.terrain.size + x]
  return k === 'plain' || k === 'hill'
}

function free(world: World, x: number, y: number): boolean {
  return buildable(world, x, y) && !world.parcels[`${x},${y}`] && !world.lines.some((l) => l.stations.some((s) => s.x === x && s.y === y))
}

// Land near a station another firm has announced but not opened: its price
// still has the rest of the station's lift to come.
function buyAheadCandidates(world: World, firm: Firm): Candidate[] {
  const out: Candidate[] = []
  for (const line of world.lines) {
    if (line.owner === firm.id || line.stage === 'planned' || line.stage === 'open') continue
    const toCome = 1 - L.stagePlanP[line.stage]
    for (const s of line.stations) {
      for (let dy = -RV.aheadRadius; dy <= RV.aheadRadius; dy++) {
        for (let dx = -RV.aheadRadius; dx <= RV.aheadRadius; dx++) {
          const x = s.x + dx
          const y = s.y + dy
          if (!free(world, x, y)) continue
          const price = landPrice(world, firm.id, x, y)
          const lift = L.stationBonus * Math.exp(-(Math.hypot(dx, dy) * TILE_M) / L.stationDecayM)
          out.push({
            id: `buy:${x},${y}`,
            kind: 'buyAhead',
            x,
            y,
            cost: price,
            gain: price * lift * toCome,
            reason: `${line.name}の駅予定地の近くを先回りで取得`,
          })
        }
      }
    }
  }
  return out
}

// A district another firm is buying up: something is coming, though not what.
function rumorCandidates(world: World, firm: Firm, briefing: Briefing): Candidate[] {
  const out: Candidate[] = []
  for (const r of briefing.rumors) {
    const c = chunkAt(world, r.x, r.y)
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = r.x + dx
        const y = r.y + dy
        if (!free(world, x, y) || chunkAt(world, x, y) !== c) continue
        const price = landPrice(world, firm.id, x, y)
        out.push({
          id: `buy:${x},${y}`,
          kind: 'followRumor',
          x,
          y,
          cost: price,
          gain: price * L.rumorBoost * 2,
          reason: `買い集めの噂が出た地区に便乗して取得`,
        })
      }
    }
  }
  return out
}

// Housing on land the rival already owns, when selling it beats the cost.
function developCandidates(world: World, firm: Firm): Candidate[] {
  const out: Candidate[] = []
  for (const [key, parcel] of Object.entries(world.parcels)) {
    if (parcel.owner !== firm.id || parcel.station) continue
    const [x, y] = key.split(',').map(Number)
    if (world.buildings.some((b) => b.x === x && b.y === y && b.status !== 'sold')) continue
    const floor = chunkAt(world, x, y).zoneFar.res * TILE_AREA_M2 * RV.developFarShare
    if (floor <= 0) continue
    const appraisal: Building = {
      id: 'appraisal', owner: firm.id, x, y, use: 'res', mode: 'sale', floorArea: floor, status: 'operating',
      ticksLeft: 0, cost: 0, costPaid: 0, bookValue: 0, occupancy: 1, ageTicks: 0, saleTicksLeft: 0,
    }
    const buildCost = floor * RE.yenPerM2.res
    const value = plannedValue(world, appraisal) * RE.condoPremium
    const margin = (value - buildCost - parcel.cost) / value
    if (margin < RV.minDevelopMargin) continue
    out.push({
      id: `develop:${x},${y}`,
      kind: 'develop',
      x,
      y,
      cost: buildCost * RE.upfrontShare,
      gain: value - buildCost - parcel.cost,
      reason: `自社の土地に分譲住宅を建設(利益率${Math.round(margin * 100)}%)`,
    })
  }
  return out
}

// The best few moves by expected return, at most one per tile.
export function rivalCandidates(world: World, firm: Firm, briefing: Briefing): Candidate[] {
  const all = [...buyAheadCandidates(world, firm), ...rumorCandidates(world, firm, briefing), ...developCandidates(world, firm)]
  const byTile = new Map<string, Candidate>()
  for (const c of all) {
    const key = `${c.x},${c.y}`
    const held = byTile.get(key)
    if (!held || c.gain / c.cost > held.gain / held.cost) byTile.set(key, c)
  }
  return [...byTile.values()].sort((a, b) => b.gain / b.cost - a.gain / a.cost).slice(0, RV.candidates)
}

// --- Choosing ---

const PERSONA_TASTE: Record<RivalPersona, Record<CandidateKind, number>> = {
  property: { buyAhead: 1, followRumor: 0.6, develop: 0.8 },
  expansion: { buyAhead: 0.6, followRumor: 0.3, develop: 0.6 },
  discount: { buyAhead: 0.5, followRumor: 0.3, develop: 0.5 },
}

// The rule-based chooser: return on cost, weighted by what the persona likes.
export const chooseByPersona: Chooser = (persona, _briefing, candidates) =>
  [...candidates]
    .sort((a, b) => (PERSONA_TASTE[persona][b.kind] * b.gain) / b.cost - (PERSONA_TASTE[persona][a.kind] * a.gain) / a.cost)
    .slice(0, RV.actionsPerTick)
    .map((c) => c.id)

// --- Acting ---

// Cash the rival may spend: what it holds, less construction still to pay
// and a reserve it keeps back.
function spendable(world: World, firm: Firm): number {
  const unpaid = world.buildings
    .filter((b) => b.owner === firm.id && b.status === 'construction')
    .reduce((s, b) => s + b.cost - b.costPaid, 0)
  return firm.cash - unpaid - RV.reserveYen
}

function execute(world: World, firm: Firm, c: Candidate): Result<unknown> {
  if (c.cost > spendable(world, firm)) return fail('insufficient_cash')
  if (c.kind !== 'develop') return buyLand(world, firm.id, c.x, c.y)
  const floor = chunkAt(world, c.x, c.y).zoneFar.res * TILE_AREA_M2 * RV.developFarShare
  const built = develop(world, firm.id, c.x, c.y, 'res', floor, 'sale')
  if (!built.ok) return built
  const cost = floor * RE.yenPerM2.res
  return borrow(world, firm.id, { amount: cost * PARAMS.finance.projectMaxShare, years: 10, graceYears: 2, buildingId: built.value })
}

export type RivalTurn = { firm: string; chosen: Candidate[]; done: Candidate[] }

export function playRival(world: World, firmId: string, choose: Chooser = chooseByPersona): RivalTurn {
  const firm = findFirm(world, firmId)
  if (!firm || firm.bankrupt || !firm.persona) return { firm: firmId, chosen: [], done: [] }
  const briefing = rivalBriefing(world, firm)
  const candidates = rivalCandidates(world, firm, briefing)
  const ids = choose(firm.persona, briefing, candidates).slice(0, RV.actionsPerTick)
  const chosen = ids.map((id) => candidates.find((c) => c.id === id)).filter((c): c is Candidate => c !== undefined)

  const done: Candidate[] = []
  for (const c of chosen) {
    if (!execute(world, firm, c).ok) continue
    done.push(c)
    world.events.push({
      tick: world.tick,
      type: 'rival_move',
      actor: firm.id,
      x: c.x,
      y: c.y,
      importance: 2,
      payload: { kind: c.kind, reason: c.reason },
    })
  }
  return { firm: firmId, chosen, done }
}

// Every AI firm takes its turn after the week's simulation.
export function playRivals(world: World, choose: Chooser = chooseByPersona): RivalTurn[] {
  return world.firms.filter((f) => f.kind === 'ai').map((f) => playRival(world, f.id, choose))
}
