// @ts-expect-error Node strip-types tests require the source extension.
import { TICKS_PER_QUARTER } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { closeQuarter, handleShortfall } from './corporate.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { serviceLoans } from './finance.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { computeAccess, refreshFloor, updateGrowth } from './growth.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { updateLandValue } from './landvalue.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { chunkAt } from './network.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { operateLines, progressLines } from './rail.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { updateRealEstate } from './realestate.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { runTraffic, type TrafficResult } from './traffic.ts'
import type { World } from './types.ts'

const STATION_ZONE = { res: 1.5, office: 1, retail: 1.5, industry: 0 }

// Until the AI mayors arrive (M3), a newly opened station upzones its chunk.
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

// Advance the world by one tick (one game week). Order matters: construction,
// then travel, then where people and jobs go, then money, then prices.
export function step(world: World): TrafficResult {
  progressLines(world)
  upzoneNewStations(world)
  refreshFloor(world)
  const traffic = runTraffic(world)
  computeAccess(world, traffic.minutes)
  updateGrowth(world)
  updateRealEstate(world)
  operateLines(world)
  updateLandValue(world, traffic.minutes)
  for (const firm of world.firms) {
    if (firm.bankrupt) continue
    serviceLoans(world, firm)
    handleShortfall(world, firm)
    if (world.tick % TICKS_PER_QUARTER === TICKS_PER_QUARTER - 1) closeQuarter(world, firm)
  }
  world.tick++
  return traffic
}
