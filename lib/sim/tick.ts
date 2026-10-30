// @ts-expect-error Node strip-types tests require the source extension.
import { TICKS_PER_QUARTER } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { closeQuarter, handleShortfall } from './corporate.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { serviceLoans } from './finance.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { applyAccessibility, applyGrowth, computeAccessibility, planGrowth, refreshFloor } from './growth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { applyLandValues, computeLandValues } from './landvalue.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { chunkAt } from './network.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { checkDeals, reviewPermits } from './permits.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { operateLines, progressLines } from './rail.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { updateRealEstate } from './realestate.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { applyTraffic, computeTraffic, type TrafficResult } from './traffic.ts'
import type { World } from './types.ts'

const STATION_ZONE = { res: 1.5, office: 1, retail: 1.5 }

// A newly opened station upzones its chunk. Asking the mayor for more floor
// area is a later step.
function upzoneNewStations(world: World) {
  for (const line of world.lines) {
    if (line.stage !== 'open' || line.stageTick !== world.tick) continue
    for (const s of line.stations) {
      const c = chunkAt(world, s.x, s.y)
      c.zoneFar.res = Math.max(c.zoneFar.res, STATION_ZONE.res)
      c.zoneFar.office = Math.max(c.zoneFar.office, STATION_ZONE.office)
      c.zoneFar.retail = Math.max(c.zoneFar.retail, STATION_ZONE.retail)
    }
  }
}

// Advance the world by one tick (one game week). Each model reads the world and
// returns its result, and the step writes the results back in order:
// permits and promises, construction, travel, where people and jobs go, money,
// then prices.
export function step(world: World): TrafficResult {
  reviewPermits(world)
  checkDeals(world)
  progressLines(world)
  upzoneNewStations(world)
  refreshFloor(world)

  const traffic = computeTraffic(world)
  applyTraffic(world, traffic)
  applyAccessibility(world, computeAccessibility(world.chunks, traffic.minutes))
  applyGrowth(world, planGrowth(world))

  updateRealEstate(world)
  operateLines(world)
  applyLandValues(world, computeLandValues(world, traffic.minutes))

  for (const firm of world.firms) {
    if (firm.bankrupt) continue
    serviceLoans(world, firm)
    handleShortfall(world, firm)
    if (world.tick % TICKS_PER_QUARTER === TICKS_PER_QUARTER - 1) closeQuarter(world, firm)
  }

  world.tick++
  return traffic
}
