import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyForLine,
  borrow,
  buyLand,
  createWorld,
  grantLine,
  OKU,
  planLine,
  projectCost,
  setService,
  startConstruction,
  step,
} from '../lib/sim/index.ts'
import { annuity } from '../lib/sim/finance.ts'
import { edgeMinutes } from '../lib/sim/network.ts'

function firstTile(world, ok) {
  const i = world.terrain.kind.findIndex(ok)
  return { x: i % world.terrain.size, y: Math.floor(i / world.terrain.size) }
}

function buildable(world, x, y) {
  const k = world.terrain.kind[y * world.terrain.size + x]
  return k === 'plain' || k === 'hill' || k === 'forest'
}

function stationsBetween(world, a, b, count) {
  return Array.from({ length: count }, (_, i) => {
    let x = Math.round(a.x + ((b.x - a.x) * i) / (count - 1))
    let y = Math.round(a.y + ((b.y - a.y) * i) / (count - 1))
    while (!buildable(world, x, y)) x++
    return { x, y, express: false }
  })
}

test('the same seed always produces the same region', () => {
  const a = createWorld(7)
  const b = createWorld(7)
  assert.deepEqual(a.terrain.kind, b.terrain.kind)
  assert.deepEqual(a.cities, b.cities)
  assert.notDeepEqual(createWorld(8).terrain.kind, a.terrain.kind)
})

test('a region has sea, mountains and three settled cities', () => {
  const world = createWorld(42)
  const kinds = new Set(world.terrain.kind)
  assert.ok(kinds.has('sea') && kinds.has('mountain') && kinds.has('plain'))
  assert.equal(world.cities.length, 3)
  for (const city of world.cities) assert.ok(buildable(world, city.x, city.y), `${city.id} on buildable land`)
  const pop = world.chunks.reduce((s, c) => s + c.pop, 0)
  assert.ok(Math.abs(pop - 340_000) < 1, `initial population ${pop}`)
})

test('land can only be bought once, on buildable tiles, with enough cash', () => {
  const world = createWorld(42)
  const sea = firstTile(world, (k) => k === 'sea')
  assert.deepEqual(buyLand(world, 'player', sea.x, sea.y), { ok: false, error: 'not_buildable' })

  const plain = firstTile(world, (k) => k === 'plain')
  const bought = buyLand(world, 'player', plain.x, plain.y)
  assert.equal(bought.ok, true)
  assert.deepEqual(buyLand(world, 'rival', plain.x, plain.y), { ok: false, error: 'already_owned' })

  world.firms[1].cash = 0
  const other = firstTile(world, (k) => k === 'hill')
  assert.deepEqual(buyLand(world, 'rival', other.x, other.y), { ok: false, error: 'insufficient_cash' })
})

test('loan payments match the design doc example', () => {
  // 448億円 over 20 years at 2.5%: about 28.7億円 a year when paid yearly.
  // Weekly payments come out slightly lower.
  const yearly = annuity(448 * OKU, 0.025 / 52, 20 * 52) * 52
  assert.ok(Math.abs(yearly / OKU - 28.7) < 0.5, `yearly ${yearly / OKU}`)
})

test('congestion slows a road by 15% at capacity', () => {
  const edge = { a: 0, b: 1, km: 3.2, speedKmh: 30, capacityVph: 1200, arterial: false, dailyPersons: 0 }
  const free = edgeMinutes(edge)
  // Peak-hour vehicles per direction = persons / occupancy * peak share * 0.5.
  edge.dailyPersons = (1200 * 1.3) / (0.1 * 0.5)
  assert.ok(Math.abs(edgeMinutes(edge) / free - 1.15) < 1e-9)
})

test('project loans are capped at 70% of the line and its cars', () => {
  const world = createWorld(42)
  const [a, b] = world.cities
  const line = planLine(world, 'player', 'test', stationsBetween(world, a, b, 6))
  assert.equal(line.ok, true)
  const id = line.value.id
  assert.deepEqual(borrow(world, 'player', { amount: OKU, years: 20, lineId: id }), { ok: false, error: 'line_not_approved' })
  applyForLine(world, 'player', id)
  grantLine(world, id)
  const cap = projectCost(line.value) * 0.7
  assert.equal(borrow(world, 'player', { amount: cap * 1.01, years: 20, lineId: id }).ok, false)
  assert.equal(borrow(world, 'player', { amount: cap, years: 20, graceYears: 3, lineId: id }).ok, true)
})

test('a line pulls population toward its stations', () => {
  const run = (withLine) => {
    const world = createWorld(42)
    const [a, b] = world.cities
    const stations = stationsBetween(world, a, b, 8)
    const corridor = new Set(stations.map((s) => Math.floor(s.y / 16) * world.chunksPerSide + Math.floor(s.x / 16)))
    if (withLine) {
      const line = planLine(world, 'player', 'test', stations)
      const id = line.value.id
      applyForLine(world, 'player', id)
      grantLine(world, id)
      setService(world, 'player', id, { localPeak: 10, localOff: 6 })
      borrow(world, 'player', { amount: projectCost(line.value) * 0.7, years: 20, graceYears: 3, lineId: id })
      startConstruction(world, 'player', id)
    }
    for (let t = 0; t < 80; t++) step(world)
    for (const c of world.chunks) assert.ok(Number.isFinite(c.pop) && Number.isFinite(c.lv), 'no NaN in chunks')
    const pop = [...corridor].reduce((s, id) => s + world.chunks[id].pop, 0)
    return { world, pop }
  }
  const without = run(false)
  const withLine = run(true)
  const line = withLine.world.lines[0]
  assert.equal(line.stage, 'open')
  assert.ok(line.stats.dailyRiders > 10_000, `riders ${line.stats.dailyRiders}`)
  assert.ok(withLine.world.ledger.some((e) => e.account === 'fare' && e.amount > 0))
  assert.ok(withLine.pop > without.pop * 1.05, `corridor ${withLine.pop} vs ${without.pop}`)
})
