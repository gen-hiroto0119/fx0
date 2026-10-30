// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS, TICKS_PER_YEAR, TILE_AREA_M2, TILE_M } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { book, firmById } from './finance.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { stock } from './growth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { lvAtTile } from './landvalue.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { chunkAt } from './network.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { USES, type Building, type Chunk, type Use, type World } from './types.ts'

const RE = PARAMS.realEstate
const G = PARAMS.growth

function marketUse(b: Building): Use {
  return b.use === 'station' ? 'retail' : b.use
}

export function chunkOccupancy(c: Chunk, use: Use): number {
  return c.floor[use] > 0 ? Math.min(1, (stock(c, use) * G.floorPerCapita[use]) / c.floor[use]) : 0
}

export function rentPerM2Month(world: World, b: Building): number {
  const c = chunkAt(world, b.x, b.y)
  const use = marketUse(b)
  const rel = Math.sqrt(Math.max(lvAtTile(world, b.x, b.y), 1) / world.region.lvRef)
  let rent = RE.baseRentYenPerM2Month[use] * rel * c.rentMult[use]
  if (b.use === 'station') rent *= RE.stationRentMult * (1 + c.boardings / 50_000)
  return rent
}

function nearOpenStation(world: World, b: Building): boolean {
  return world.lines.some(
    (l) => l.stage === 'open' && l.stations.some((s) => Math.hypot(s.x - b.x, s.y - b.y) * TILE_M <= 800),
  )
}

export function capRate(world: World, b: Building): number {
  const age = b.ageTicks / TICKS_PER_YEAR
  return (
    RE.capBase +
    PARAMS.finance.baseRate +
    RE.capCityRisk +
    age * RE.capAgePerYear -
    (nearOpenStation(world, b) ? RE.capStationNear : 0)
  )
}

export function annualNoi(world: World, b: Building, occupancy: number): number {
  const gross = rentPerM2Month(world, b) * b.floorArea * occupancy * 12
  const tax = lvAtTile(world, b.x, b.y) * TILE_AREA_M2 * RE.propertyTaxRate
  return gross * (1 - RE.opexShare) - tax
}

// Value at stabilized occupancy (the district's occupancy), as a buyer would see it.
export function buildingValue(world: World, b: Building): number {
  const occ = chunkOccupancy(chunkAt(world, b.x, b.y), marketUse(b))
  return Math.max(0, annualNoi(world, b, occ) / capRate(world, b))
}

function adjustRents(world: World) {
  for (const c of world.chunks) {
    for (const use of USES) {
      const vacancy = 1 - chunkOccupancy(c, use)
      const m = c.rentMult[use] * (1 + (RE.rentAdjust * (RE.naturalVacancy - vacancy)) / RE.naturalVacancy)
      c.rentMult[use] = Math.max(0.5, Math.min(2, m))
    }
  }
}

export function updateRealEstate(world: World) {
  adjustRents(world)
  for (const b of world.buildings) {
    if (b.status === 'sold') continue
    const firm = firmById(world, b.owner)
    if (firm.bankrupt) continue
    if (b.status === 'construction') {
      b.ticksLeft--
      if (b.ticksLeft > 0) continue
      const rest = b.cost - b.costPaid
      firm.cash -= rest
      b.costPaid = b.cost
      b.bookValue = b.cost
      book(world, firm.id, 'realestate', 'construction', -rest, false)
      b.status = b.mode === 'sale' ? 'selling' : 'operating'
      b.saleTicksLeft = RE.condoSaleTicks
      world.events.push({ tick: world.tick, type: 'building_completed', actor: firm.id, x: b.x, y: b.y, importance: 2, payload: { use: b.use } })
      continue
    }
    if (b.status === 'selling') {
      const value = buildingValue(world, b) * RE.condoPremium
      const share = 1 / b.saleTicksLeft
      const proceeds = value * share
      const cost = b.bookValue * share
      firm.cash += proceeds
      b.bookValue -= cost
      b.saleTicksLeft--
      book(world, firm.id, 'realestate', 'condo_sales', proceeds)
      book(world, firm.id, 'realestate', 'condo_cost', -cost)
      if (b.saleTicksLeft <= 0) {
        // The land goes to the buyers along with the units.
        b.status = 'sold'
        const key = `${b.x},${b.y}`
        const parcel = world.parcels[key]
        if (parcel) {
          book(world, firm.id, 'realestate', 'condo_cost', -parcel.cost)
          delete world.parcels[key]
        }
      }
      continue
    }
    if (b.status !== 'operating') continue
    b.ageTicks++
    const c = chunkAt(world, b.x, b.y)
    b.occupancy = Math.min(chunkOccupancy(c, marketUse(b)), b.occupancy + RE.leaseUpPerTick)
    const rent = (rentPerM2Month(world, b) * b.floorArea * b.occupancy * 12) / TICKS_PER_YEAR
    const tax = (lvAtTile(world, b.x, b.y) * TILE_AREA_M2 * RE.propertyTaxRate) / TICKS_PER_YEAR
    const dep = b.cost / (RE.buildingLifeYears * TICKS_PER_YEAR)
    b.bookValue -= dep
    firm.cash += rent * (1 - RE.opexShare) - tax
    book(world, firm.id, 'realestate', 'rent', rent)
    book(world, firm.id, 'realestate', 're_opex', -rent * RE.opexShare)
    book(world, firm.id, 'realestate', 'property_tax', -tax)
    book(world, firm.id, 'realestate', 're_dep', -dep)
  }
  // Land the firm holds but has not built on still pays property tax.
  for (const [key, p] of Object.entries(world.parcels)) {
    if (p.station || firmById(world, p.owner).bankrupt) continue
    if (world.buildings.some((b) => `${b.x},${b.y}` === key && b.status !== 'sold')) continue
    const [x, y] = key.split(',').map(Number)
    const tax = (lvAtTile(world, x, y) * TILE_AREA_M2 * RE.propertyTaxRate) / TICKS_PER_YEAR
    firmById(world, p.owner).cash -= tax
    book(world, p.owner, 'realestate', 'property_tax', -tax)
  }
}
