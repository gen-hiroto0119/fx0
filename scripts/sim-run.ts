// Headless balancing run: builds the design doc's sample line between the port
// city and the plain city, then prints quarterly figures.
//   node --experimental-strip-types scripts/sim-run.ts [seed] [ticks] [--no-line]
import {
  applyForLine,
  borrow,
  buyLand,
  createWorld,
  develop,
  grantLine,
  lineKm,
  lvAtTile,
  OKU,
  planLine,
  projectCost,
  setExpressStops,
  setService,
  startConstruction,
  step,
  type Station,
  type World,
// @ts-expect-error Node strip-types tests require the source extension.
} from '../lib/sim/index.ts'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const seed = Number(args[0] ?? 42)
const ticks = Number(args[1] ?? 260)
const withLine = !process.argv.includes('--no-line')

const world = createWorld(seed)
const [a, b] = world.cities
const player = 'player'

function buildable(w: World, x: number, y: number): boolean {
  const k = w.terrain.kind[y * w.terrain.size + x]
  return k === 'plain' || k === 'hill' || k === 'forest'
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

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error}`)
  return r.value
}

const landBank: [number, number][] = []
let lineId = ''
if (withLine) {
  const stations = Array.from({ length: 8 }, (_, i) => snap(world, a.x + ((b.x - a.x) * i) / 7, a.y + ((b.y - a.y) * i) / 7))
  const line = must(planLine(world, player, '港平線', stations), 'plan')
  lineId = line.id
  must(setExpressStops(world, player, lineId, [3]), 'express')
  // Buy land around the middle stations before the plan becomes public.
  for (const s of stations.slice(2, 6)) {
    for (const [dx, dy] of [[1, 0]]) {
      const r = buyLand(world, player, s.x + dx, s.y + dy)
      if (r.ok) landBank.push([s.x + dx, s.y + dy])
    }
  }
  must(applyForLine(world, player, lineId), 'apply')
  must(grantLine(world, lineId), 'grant')
  must(setService(world, player, lineId, { localPeak: 10, localOff: 6, expressPeak: 4, expressOff: 2, cars: 6 }), 'service')
  must(borrow(world, player, { amount: projectCost(line) * 0.7, years: 20, graceYears: 3, lineId }), 'borrow')
  must(startConstruction(world, player, lineId), 'construct')
  console.log(
    `line ${line.name}: ${lineKm(line).toFixed(1)} km, ${stations.length} stations, cost ${(line.cost / OKU).toFixed(0)}億 + cars ${((projectCost(line) - line.cost) / OKU).toFixed(0)}億, build ${line.buildTicksLeft} ticks, land bank ${landBank.length} tiles`,
  )
}

// Chunks the sample line's stations fall in, whether or not the line exists.
const corridorChunks = new Set(
  Array.from({ length: 8 }, (_, i) => {
    const x = Math.round(a.x + ((b.x - a.x) * i) / 7)
    const y = Math.round(a.y + ((b.y - a.y) * i) / 7)
    return Math.floor(y / 16) * world.chunksPerSide + Math.floor(x / 16)
  }),
)
const corridorPop = () => [...corridorChunks].reduce((s, id) => s + world.chunks[id].pop, 0)

const oku = (v: number) => (v / OKU).toFixed(1)
const sumLedger = (from: number, accounts: string[]) =>
  world.ledger
    .filter((e) => e.firm === player && e.tick >= from && accounts.includes(e.account))
    .reduce((s, e) => s + e.amount, 0)

console.log('tick | pop | corridor pop | riders/day | rail share | rail op profit 年 | RE NOI 年 | cash | debt | rating | lv mid station / city A core')
let developed = false
for (let t = 0; t < ticks; t++) {
  const traffic = step(world)
  const line = world.lines.find((l) => l.id === lineId)
  if (line?.stage === 'open' && !developed) {
    developed = true
    for (const [i, [x, y]] of landBank.entries()) {
      const mode = i % 2 === 1 ? 'lease' : 'sale'
      develop(world, player, x, y, 'res', 8_000, mode)
    }
  }
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
