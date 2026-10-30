// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS, TICKS_PER_YEAR, TILE_AREA_M2 } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { lvAtTile } from './landvalue.ts'
import type { Firm, LedgerEntry, Loan, World } from './types.ts'

const F = PARAMS.finance

export function firmById(world: World, id: string): Firm {
  const f = world.firms.find((x) => x.id === id)
  if (!f) throw new Error(`unknown firm ${id}`)
  return f
}

export function book(
  world: World,
  firm: string,
  segment: LedgerEntry['segment'],
  account: string,
  amount: number,
  pl = true,
) {
  if (amount === 0) return
  world.ledger.push({ tick: world.tick, firm, segment, account, amount, pl })
}

export function spread(rating: string): number {
  return (F.ratings.find((r) => r.name === rating) ?? F.ratings[F.ratings.length - 1]).spread
}

export function annuity(balance: number, weeklyRate: number, ticks: number): number {
  if (ticks <= 0) return balance
  if (weeklyRate === 0) return balance / ticks
  return (balance * weeklyRate) / (1 - (1 + weeklyRate) ** -ticks)
}

export function debt(firm: Firm): number {
  return firm.loans.reduce((s, l) => s + l.balance, 0)
}

// Sum of P&L entries over the last `ticks` ticks, annualized.
export function annualized(world: World, firm: string, ticks: number, include: (e: LedgerEntry) => boolean): number {
  const from = world.tick - ticks
  let sum = 0
  for (const e of world.ledger) if (e.firm === firm && e.pl && e.tick >= from && include(e)) sum += e.amount
  const covered = Math.min(ticks, world.tick + 1)
  return covered > 0 ? (sum * TICKS_PER_YEAR) / covered : 0
}

const NON_CASH = new Set(['rail_dep', 're_dep', 'interest', 'condo_cost'])

export function annualEbitda(world: World, firm: string): number {
  return annualized(world, firm, TICKS_PER_YEAR, (e) => !NON_CASH.has(e.account))
}

export function annualDebtService(firm: Firm): number {
  return firm.loans.reduce((s, l) => {
    const r = l.rate / TICKS_PER_YEAR
    const remaining = l.termTicks - Math.max(l.ageTicks, l.graceTicks)
    return s + annuity(l.balance, r, remaining) * TICKS_PER_YEAR
  }, 0)
}

export function landMarketValue(world: World, firm: string): number {
  let v = 0
  for (const [key, p] of Object.entries(world.parcels)) {
    if (p.owner !== firm || p.station) continue
    const [x, y] = key.split(',').map(Number)
    v += lvAtTile(world, x, y) * TILE_AREA_M2
  }
  return v
}

export function collateralRoom(world: World, firm: Firm, buildingValue: (id: string) => number): number {
  let room = landMarketValue(world, firm.id) * F.ltv.land
  for (const b of world.buildings) if (b.owner === firm.id && b.status === 'operating') room += buildingValue(b.id) * F.ltv.building
  for (const l of world.lines) if (l.owner === firm.id) room += (l.trackBookValue + l.carBookValue) * F.ltv.rail
  return room - debt(firm)
}

export function serviceLoans(world: World, firm: Firm) {
  for (const loan of firm.loans) {
    const r = loan.rate / TICKS_PER_YEAR
    const interest = loan.balance * r
    let principal = 0
    if (loan.ageTicks >= loan.graceTicks) {
      principal = Math.min(loan.balance, annuity(loan.balance, r, loan.termTicks - loan.ageTicks) - interest)
    }
    loan.balance -= principal
    loan.ageTicks++
    firm.cash -= interest + principal
    book(world, firm.id, 'corporate', 'interest', -interest)
    book(world, firm.id, 'corporate', 'loan_repayment', -principal, false)
  }
  firm.loans = firm.loans.filter((l) => l.balance > 1)
}

export function newLoan(
  world: World,
  firm: Firm,
  kind: Loan['kind'],
  amount: number,
  rate: number,
  years: number,
  graceYears: number,
  lineId?: string,
) {
  const loan: Loan = {
    id: `loan${world.nextId++}`,
    kind,
    principal: amount,
    balance: amount,
    rate,
    termTicks: Math.round(years * TICKS_PER_YEAR),
    graceTicks: Math.round(graceYears * TICKS_PER_YEAR),
    ageTicks: 0,
    lineId,
  }
  firm.loans.push(loan)
  firm.cash += amount
  book(world, firm.id, 'corporate', 'loan_drawdown', amount, false)
  return loan
}

export function ratingFor(debtToEbitda: number, equityRatio: number): string {
  for (const r of F.ratings) if (debtToEbitda < r.debtToEbitda && equityRatio >= r.equityRatio) return r.name
  return F.ratings[F.ratings.length - 1].name
}
