// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS, TICKS_PER_YEAR, TILE_AREA_M2 } from './params.ts'
import {
  annualEbitda,
  annualized,
  book,
  debt,
  landMarketValue,
  newLoan,
  ratingFor,
  repayBuildingLoans,
  spread,
// @ts-expect-error Node strip-types tests require the source extension.
} from './finance.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { lvAtTile } from './landvalue.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { buildingValue } from './realestate.ts'
import type { Firm, World } from './types.ts'

const F = PARAMS.finance

// Revenue the market expects to come back every year; one-off condo and asset
// sales are left out of growth.
const RECURRING_REVENUE = new Set(['fare', 'rent'])

const RATING_ORDER = F.ratings.map((r) => r.name as string)

function worse(a: string, b: string): string {
  return RATING_ORDER[Math.max(RATING_ORDER.indexOf(a), RATING_ORDER.indexOf(b))]
}

// Agencies move a rating one notch at a time, so a single good or bad year
// does not swing it from end to end.
function oneNotchToward(current: string, target: string): string {
  const from = RATING_ORDER.indexOf(current)
  const to = RATING_ORDER.indexOf(target)
  if (from < 0) return target
  return RATING_ORDER[from + Math.sign(to - from)]
}

function bookAssets(world: World, firm: Firm): number {
  let assets = firm.cash
  for (const p of Object.values(world.parcels)) if (p.owner === firm.id) assets += p.cost
  for (const b of world.buildings) if (b.owner === firm.id && b.status !== 'sold') assets += b.status === 'construction' ? b.costPaid : b.bookValue
  for (const l of world.lines) if (l.owner === firm.id) assets += l.trackBookValue + l.carBookValue
  return assets
}

export function marketNav(world: World, firm: Firm): number {
  let nav = firm.cash + landMarketValue(world, firm.id) - debt(firm)
  for (const b of world.buildings) {
    if (b.owner !== firm.id) continue
    if (b.status === 'operating') nav += buildingValue(world, b)
    else if (b.status === 'construction' || b.status === 'selling') nav += b.status === 'construction' ? b.costPaid : b.bookValue
  }
  for (const l of world.lines) if (l.owner === firm.id) nav += l.trackBookValue + l.carBookValue
  return nav
}

export type Quarter = { rating: string; ebitda: number; netDebt: number; equityRatio: number; nav: number; pbr: number }

export function closeQuarter(world: World, firm: Firm): Quarter {
  const ebitda = annualEbitda(world, firm.id)
  const netDebt = debt(firm) - firm.cash
  const assets = bookAssets(world, firm)
  const equity = assets - debt(firm)
  const equityRatio = assets > 0 ? equity / assets : 0
  const leverage = netDebt <= 0 ? 0 : ebitda > 0 ? netDebt / ebitda : Infinity
  // With nothing earning yet, a firm is rated no better than A, or BBB once it
  // borrows; cash it holds is likely a loan waiting to pay for construction.
  const deserved = ebitda > 0 ? ratingFor(leverage, equityRatio) : worse(ratingFor(0, equityRatio), debt(firm) > 0 ? 'BBB' : 'A')
  const rating = oneNotchToward(firm.rating, deserved)
  if (rating !== firm.rating) {
    world.events.push({ tick: world.tick, type: 'rating_changed', actor: firm.id, importance: 3, payload: { from: firm.rating, to: rating } })
  }
  firm.rating = rating

  const netIncome = annualized(world, firm.id, TICKS_PER_YEAR, () => true)
  const roe = equity > 0 ? netIncome / equity : 0
  const recurring = (from: number, to: number) =>
    world.ledger
      .filter((e) => e.firm === firm.id && RECURRING_REVENUE.has(e.account) && e.tick >= from && e.tick < to)
      .reduce((s, e) => s + e.amount, 0)
  const recent = recurring(world.tick - TICKS_PER_YEAR, world.tick + 1)
  const prior = recurring(world.tick - 2 * TICKS_PER_YEAR, world.tick - TICKS_PER_YEAR)
  const growth = prior > 0 ? recent / prior - 1 : 0
  const pbr = Math.max(F.pbr.min, Math.min(F.pbr.max, 1 + F.pbr.roe * roe + F.pbr.growth * growth))
  firm.nav = marketNav(world, firm)
  const target = Math.max(0, firm.nav) * pbr
  firm.marketCap = firm.marketCap > 0 ? firm.marketCap + F.pbr.quarterlyPull * (target - firm.marketCap) : target
  return { rating, ebitda, netDebt, equityRatio, nav: firm.nav, pbr }
}

// Cash below zero: an expensive overdraft first, then forced sales at a
// discount, then bankruptcy.
export function handleShortfall(world: World, firm: Firm) {
  if (firm.cash >= 0) {
    firm.shortfallTicks = 0
    return
  }
  firm.shortfallTicks++
  if (firm.shortfallTicks === 1) {
    const monthlyRevenue = (annualized(world, firm.id, 13, (e) => e.amount > 0) / 12) || 0
    const limit = Math.max(F.overdraftMin, monthlyRevenue)
    const amount = Math.min(-firm.cash, limit)
    newLoan(world, firm, 'overdraft', amount, F.baseRate + spread(firm.rating) + F.overdraftPremium, 0.25, 0)
    world.events.push({ tick: world.tick, type: 'overdraft', actor: firm.id, importance: 3, payload: { amount } })
    if (firm.cash >= 0) return
  }
  for (const b of world.buildings) {
    if (firm.cash >= 0) break
    if (b.owner !== firm.id || b.status !== 'operating') continue
    const price = buildingValue(world, b) * F.forcedSaleShare
    firm.cash += price
    book(world, firm.id, 'realestate', 'forced_sale_loss', price - b.bookValue)
    repayBuildingLoans(world, firm, b.id, 1)
    b.owner = 'market'
    b.status = 'sold'
    delete world.parcels[`${b.x},${b.y}`]
    world.events.push({ tick: world.tick, type: 'forced_sale', actor: firm.id, x: b.x, y: b.y, importance: 4 })
  }
  for (const [key, p] of Object.entries(world.parcels)) {
    if (firm.cash >= 0) break
    if (p.owner !== firm.id || p.station) continue
    const [x, y] = key.split(',').map(Number)
    if (world.buildings.some((b) => b.x === x && b.y === y && b.status !== 'sold')) continue
    const price = lvAtTile(world, x, y) * TILE_AREA_M2 * F.forcedSaleShare
    firm.cash += price
    book(world, firm.id, 'realestate', 'forced_sale_loss', price - p.cost)
    delete world.parcels[key]
  }
  if (firm.cash < 0 && firm.shortfallTicks >= 2 && !firm.bankrupt) {
    firm.bankrupt = true
    world.events.push({ tick: world.tick, type: 'bankrupt', actor: firm.id, importance: 5 })
  }
}
