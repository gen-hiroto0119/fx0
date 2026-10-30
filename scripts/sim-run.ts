// Headless balancing run: builds the design doc's sample line between the port
// city and the plain city, then prints quarterly figures.
//   node --experimental-strip-types scripts/sim-run.ts [seed] [ticks] [--no-line]
// @ts-expect-error Node strip-types tests require the source extension.
import { createWorld, lineKm, lvAtTile, OKU, projectCost, step } from '../lib/sim/index.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { buildSampleLine, corridorPoints, developWhenAffordable, PLAYER, STATION_COUNT } from './sample-scenario.ts'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const seed = Number(args[0] ?? 42)
const ticks = Number(args[1] ?? 260)
const withLine = !process.argv.includes('--no-line')

const world = createWorld(seed)
const [a] = world.cities
const player = PLAYER

const sample = withLine ? buildSampleLine(world) : null
if (sample) {
  const { line, landBank } = sample
  console.log(
    `line ${line.name}: ${lineKm(line).toFixed(1)} km, ${STATION_COUNT} stations, cost ${(line.cost / OKU).toFixed(0)}億 + cars ${((projectCost(line) - line.cost) / OKU).toFixed(0)}億, build ${line.buildTicksLeft} ticks, land bank ${landBank.length} tiles`,
  )
}

// Chunks the sample line's stations fall in, whether or not the line exists.
const corridorChunks = new Set(
  corridorPoints(world).map((p) => Math.floor(Math.round(p.y) / 16) * world.chunksPerSide + Math.floor(Math.round(p.x) / 16)),
)
const corridorPop = () => [...corridorChunks].reduce((s, id) => s + world.chunks[id].pop, 0)

const oku = (v: number) => (v / OKU).toFixed(1)
const sumLedger = (from: number, accounts: string[]) =>
  world.ledger
    .filter((e) => e.firm === player && e.tick >= from && accounts.includes(e.account))
    .reduce((s, e) => s + e.amount, 0)

console.log('tick | pop | corridor pop | riders/day | rail share | rail op profit 年 | RE NOI 年 | cash | debt | rating | lv mid station / city A core')
for (let t = 0; t < ticks; t++) {
  const traffic = step(world)
  const line = sample?.line
  if (sample && line?.stage === 'open') developWhenAffordable(world, sample.landBank)
  if (world.tick % 13 !== 0) continue
  const from = world.tick - 52
  const railOp = sumLedger(from, ['fare', 'rail_opex', 'rail_maint'])
  const reNoi = sumLedger(from, ['rent', 're_opex', 'property_tax'])
  const firm = world.firms[0]
  const debt = firm.loans.reduce((s, l) => s + l.balance, 0)
  const mid = line?.stations[3]
  const lvMid = mid ? lvAtTile(world, mid.x, mid.y) : 0
  const lvA = lvAtTile(world, a.x, a.y)
  console.log(
    [
      world.tick,
      Math.round(world.region.popHistory.at(-1)!),
      Math.round(corridorPop()),
      Math.round(line?.stats.dailyRiders ?? 0),
      (traffic.railShare * 100).toFixed(1) + '%',
      oku(railOp),
      oku(reNoi),
      oku(firm.cash),
      oku(debt),
      firm.rating,
      `${Math.round(lvMid)} / ${Math.round(lvA)}`,
    ].join(' | '),
  )
}
const notable = world.events.filter((e) => e.importance >= 3).map((e) => `${e.tick}:${e.type}`)
console.log('events:', notable.join(', '))
