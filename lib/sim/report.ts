// @ts-expect-error Node strip-types tests require the source extension.
import { TICKS_PER_YEAR } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { debt, findFirm } from './finance.ts'
import type { LedgerEntry, World } from './types.ts'

// A tick is one week; a game year is 52 weeks split into 12 months of 4-5 weeks.
export function gameDate(tick: number): { year: number; month: number; week: number; label: string } {
  const year = Math.floor(tick / TICKS_PER_YEAR) + 1
  const weekOfYear = tick % TICKS_PER_YEAR
  const month = Math.min(12, Math.floor((weekOfYear * 12) / TICKS_PER_YEAR) + 1)
  const monthStart = Math.ceil(((month - 1) * TICKS_PER_YEAR) / 12)
  const week = weekOfYear - monthStart + 1
  return { year, month, week, label: `${year}年目 ${month}月 第${week}週` }
}

export type SegmentResult = { revenue: number; profit: number }

export type FirmReport = {
  cash: number
  debt: number
  rating: string
  marketCap: number
  bankrupt: boolean
  // Profit and loss over the last 52 weeks (fewer at the start of the game).
  rail: SegmentResult
  realEstate: SegmentResult
  interest: number
  netIncome: number
}

function segmentResult(entries: LedgerEntry[], segment: LedgerEntry['segment']): SegmentResult {
  let revenue = 0
  let profit = 0
  for (const e of entries) {
    if (e.segment !== segment) continue
    profit += e.amount
    if (e.amount > 0) revenue += e.amount
  }
  return { revenue, profit }
}

export function firmReport(world: World, firmId: string): FirmReport | null {
  const firm = findFirm(world, firmId)
  if (!firm) return null
  const from = world.tick - TICKS_PER_YEAR
  const entries = world.ledger.filter((e) => e.firm === firmId && e.pl && e.tick >= from)
  const interest = entries.filter((e) => e.account === 'interest').reduce((s, e) => s + e.amount, 0)
  return {
    cash: firm.cash,
    debt: debt(firm),
    rating: firm.rating,
    marketCap: firm.marketCap,
    bankrupt: firm.bankrupt,
    rail: segmentResult(entries, 'rail'),
    realEstate: segmentResult(entries, 'realestate'),
    interest,
    netIncome: entries.reduce((s, e) => s + e.amount, 0),
  }
}
