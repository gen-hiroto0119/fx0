// Balance report: runs the sample strategy and prints the figures the M2
// targets are judged by, next to the target ranges.
//   node --experimental-strip-types scripts/sim-balance.ts [seed] [years]
import {
  buildingValue,
  chunkAt,
  createWorld,
  lvAtTile,
  OKU,
  PARAMS,
  projectCost,
  step,
  TICKS_PER_YEAR,
  TILE_AREA_M2,
  type Building,
  type Use,
  type World,
// @ts-expect-error Node strip-types tests require the source extension.
} from '../lib/sim/index.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { annualNoi, capRate, chunkOccupancy } from '../lib/sim/realestate.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { buildSampleLine, developWhenAffordable, PLAYER } from './sample-scenario.ts'

const args = process.argv.slice(2)
const seed = Number(args[0] ?? 42)
const years = Number(args[1] ?? 10)

const RE = PARAMS.realEstate
const oku = (v: number) => `${(v / OKU).toFixed(1)}億`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

// --- Development economics on one tile, built to the zoning limit ---

function appraisal(world: World, x: number, y: number, use: Use, mode: 'sale' | 'lease'): Building {
  return {
    id: 'appraisal', owner: PLAYER, x, y, use, mode,
    floorArea: chunkAt(world, x, y).zoneFar[use] * TILE_AREA_M2,
    status: 'operating', ticksLeft: 0, cost: 0, costPaid: 0, bookValue: 0, occupancy: 1, ageTicks: 0, saleTicksLeft: 0,
  }
}

function printDeals(world: World, x: number, y: number, label: string) {
  console.log(`\n## 開発の採算 ${label} (${x},${y}) 地価 ${Math.round(lvAtTile(world, x, y)).toLocaleString()}円/㎡`)
  console.log('用途 | 床面積 | 土地 | 建築 | 価値 | 利益率(分譲) / 利回り(賃貸) (目標: 分譲10〜20%・賃貸5〜7%)')
  const c = chunkAt(world, x, y)
  const cases: [Use, 'sale' | 'lease'][] = [['res', 'sale'], ['res', 'lease'], ['office', 'lease'], ['retail', 'lease']]
  for (const [use, mode] of cases) {
    if (c.zoneFar[use] <= 0) continue
    const b = appraisal(world, x, y, use, mode)
    const landCost = lvAtTile(world, x, y) * TILE_AREA_M2
    const buildCost = b.floorArea * RE.yenPerM2[use]
    const cost = landCost + buildCost
    const value = buildingValue(world, b) * (mode === 'sale' ? RE.condoPremium : 1)
    const noi = annualNoi(world, b, chunkOccupancy(c, use))
    const metric = mode === 'sale' ? `利益率 ${pct((value - cost) / value)}` : `利回り ${pct(noi / cost)} (cap ${pct(capRate(world, b))})`
    console.log(`${use}/${mode} | ${Math.round(b.floorArea).toLocaleString()}㎡ | ${oku(landCost)} | ${oku(buildCost)} | ${oku(value)} | ${metric}`)
  }
}

// --- Run ---

const world = createWorld(seed)
const [cityA, cityB] = world.cities
const { line, landBank } = buildSampleLine(world)
const mid = line.stations[3]
const firm = world.firms.find((f) => f.id === PLAYER)!

const ruralTile = (() => {
  // The cheapest buildable tile in an outer-zone chunk, as a stand-in for farmland.
  let best = { x: 0, y: 0, lv: Infinity }
  for (let y = 0; y < world.terrain.size; y += 4) {
    for (let x = 0; x < world.terrain.size; x += 4) {
      if (world.terrain.kind[y * world.terrain.size + x] !== 'plain') continue
      const lv = lvAtTile(world, x, y)
      if (chunkAt(world, x, y).zoneFar.res > 0 && lv < best.lv) best = { x, y, lv }
    }
  }
  return best
})()

console.log(`seed ${seed}: 路線 ${oku(projectCost(line))} (うち車両 ${oku(projectCost(line) - line.cost)}), 土地 ${landBank.length}区画`)
console.log('\n## 地価 円/㎡ (1マス4haあたり)')
const lvRow = (label: string) =>
  console.log(
    `${label}: A都心 ${Math.round(lvAtTile(world, cityA.x, cityA.y)).toLocaleString()} (${oku(lvAtTile(world, cityA.x, cityA.y) * TILE_AREA_M2)})` +
      ` / B都心 ${Math.round(lvAtTile(world, cityB.x, cityB.y)).toLocaleString()}` +
      ` / 中間駅 ${Math.round(lvAtTile(world, mid.x, mid.y)).toLocaleString()} (${oku(lvAtTile(world, mid.x, mid.y) * TILE_AREA_M2)})` +
      ` / 郊外 ${Math.round(lvAtTile(world, ruralTile.x, ruralTile.y)).toLocaleString()}`,
  )
lvRow('開始時')

type YearRow = { year: number; riders: number; railEbitda: number; railOperating: number; railInterest: number; reProfit: number; cash: number; debt: number; rating: string; nav: number; cap: number }
const rows: YearRow[] = []
const ratingQuarters: string[] = []
let minCash = firm.cash
let openedTick = -1

const sum = (from: number, pick: (e: World['ledger'][number]) => boolean) =>
  world.ledger.filter((e) => e.firm === PLAYER && e.tick > from && pick(e)).reduce((s, e) => s + e.amount, 0)

let railInterest = 0
for (let t = 0; t < years * TICKS_PER_YEAR; t++) {
  for (const loan of firm.loans) if (loan.lineId === line.id) railInterest += (loan.balance * loan.rate) / TICKS_PER_YEAR
  step(world)
  minCash = Math.min(minCash, firm.cash)
  if (world.tick % 13 === 0) ratingQuarters.push(firm.rating)
  if (line.stage === 'open' && openedTick < 0) {
    openedTick = world.tick
    lvRow('開業時')
    printDeals(world, landBank[0][0], landBank[0][1], '駅隣・開業時')
    printDeals(world, cityA.x, cityA.y, 'A都心・開業時')
  }
  if (line.stage === 'open') developWhenAffordable(world, landBank)
  if (world.tick % TICKS_PER_YEAR !== 0) continue
  const from = world.tick - TICKS_PER_YEAR
  rows.push({
    year: world.tick / TICKS_PER_YEAR,
    riders: line.stats.dailyRiders,
    railEbitda: sum(from, (e) => ['fare', 'rail_opex', 'rail_maint'].includes(e.account)),
    railOperating: sum(from, (e) => e.segment === 'rail' && e.pl),
    railInterest,
    reProfit: sum(from, (e) => e.segment === 'realestate' && e.pl),
    cash: firm.cash,
    debt: firm.loans.reduce((s, l) => s + l.balance, 0),
    rating: firm.rating,
    nav: firm.nav,
    cap: firm.marketCap,
  })
  railInterest = 0
}
lvRow(`${years}年後`)

console.log('\n## 年次')
console.log('年 | 乗客/日 | 鉄道EBITDA | 鉄道営業利益(償却後) | 鉄道(利息後) | 不動産損益 | 現金 | 負債 | 格付け | 純資産(時価) | 時価総額')
for (const r of rows) {
  console.log(
    [r.year, Math.round(r.riders).toLocaleString(), oku(r.railEbitda), oku(r.railOperating), oku(r.railOperating - r.railInterest), oku(r.reProfit), oku(r.cash), oku(r.debt), r.rating, oku(r.nav), oku(r.cap)].join(' | '),
  )
}

// Simple payback: project cost over the average rail EBITDA of the years after opening.
const railYears = rows.filter((r) => r.year * TICKS_PER_YEAR > openedTick + TICKS_PER_YEAR)
const avgEbitda = railYears.reduce((s, r) => s + r.railEbitda, 0) / Math.max(1, railYears.length)
const lastEbitda = rows.at(-1)?.railEbitda ?? 0

console.log('\n## 目標との比較')
const firstYear = rows.find((r) => r.year * TICKS_PER_YEAR > openedTick)
console.log(`鉄道 初年度の利息後損益: ${oku(firstYear ? firstYear.railOperating - firstYear.railInterest : 0)} (目標: 赤字)`)
console.log(`鉄道 単純回収年数: 平均EBITDAで ${(projectCost(line) / avgEbitda).toFixed(1)}年 / 最終年EBITDAで ${(projectCost(line) / lastEbitda).toFixed(1)}年 (目標: 成熟後のEBITDAで回収 8〜15年)`)
console.log(`最低現金: ${oku(minCash)} / 倒産: ${firm.bankrupt ? 'あり' : 'なし'} / 格付け(四半期ごと): ${ratingQuarters.join(' ')} (目標: 倒産なし・BB以上)`)
console.log(`最終: 時価総額 ${oku(firm.marketCap)} / 時価純資産 ${oku(firm.nav)} / 現金 ${oku(firm.cash)}`)
