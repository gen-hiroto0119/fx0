// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { bestRail, carMatrix, chunkAt, stationAccess, type RailTrip } from './network.ts'
import type { World } from './types.ts'

const T = PARAMS.traffic
const R = PARAMS.rail
const G = PARAMS.growth

// Expected travel minutes over the population: drivers pick the better of car
// and rail (a logsum, so a second option helps even when it is slower), and
// people without a car take rail if it exists, otherwise a slow bus.
export function compositeMinutes(carMin: number, railMin: number): number {
  const busOrRail = Math.min(railMin, carMin * T.busTimeFactor)
  const s = T.logsumScaleMin
  const drivers = railMin === Infinity ? carMin : -s * Math.log(Math.exp(-carMin / s) + Math.exp(-railMin / s))
  return (1 - T.noCarShare) * drivers + T.noCarShare * busOrRail
}

export type TrafficResult = {
  // Travel minutes between chunks by the faster mode, used for accessibility.
  minutes: number[][]
  railShare: number
  dailyTrips: number
}

type LineFlow = { riders: number; pkm: number; fare: number; boardings: number[]; up: number[]; down: number[] }

// Daily trips (commutes and shopping) from the current population and jobs,
// split between car and rail with a logit model, then assigned to roads with
// a few rounds of method-of-successive-averages so congestion pushes trips to rail.
export function runTraffic(world: World): TrafficResult {
  const n = world.chunks.length
  const access = world.chunks.map((c) => stationAccess(world, c))
  const rail: (RailTrip | null)[][] = world.chunks.map((_, i) =>
    world.chunks.map((__, j) => (i === j ? null : bestRail(world, access[i], access[j]))),
  )
  const jobs = world.chunks.map((c) => c.jobs.office + c.jobs.retail + c.jobs.industry)
  const retail = world.chunks.map((c) => c.jobs.retail)

  let flows: LineFlow[] = []
  let car = carMatrix(world)
  let railTrips = 0
  let allTrips = 0
  for (let k = 1; k <= T.msaIterations; k++) {
    car = carMatrix(world)
    const carPersons = new Array(world.roads.length).fill(0)
    flows = world.lines.map((l) => ({
      riders: 0,
      pkm: 0,
      fare: 0,
      boardings: l.stations.map(() => 0),
      up: l.stations.map(() => 0),
      down: l.stations.map(() => 0),
    }))
    railTrips = 0
    allTrips = 0
    for (let i = 0; i < n; i++) {
      const c = world.chunks[i]
      if (c.pop <= 0) continue
      const tau = (j: number) => compositeMinutes(car.minutes[i][j], rail[i][j]?.minutes ?? Infinity)
      const purposes: [number, number[], boolean][] = [
        [c.pop / G.h, jobs, true],
        [c.pop * G.shoppingTripsPerResident, retail, false],
      ]
      for (const [persons, weightOf, commute] of purposes) {
        let total = 0
        const w = new Array(n)
        for (let j = 0; j < n; j++) {
          const t = tau(j)
          w[j] = t === Infinity ? 0 : weightOf[j] * Math.exp(-PARAMS.lv.beta * t)
          total += w[j]
        }
        if (total <= 0) continue
        for (let j = 0; j < n; j++) {
          if (w[j] <= 0) continue
          const p = (persons * w[j]) / total // people making a round trip i -> j -> i
          const trip = rail[i][j]
          const parking = commute && world.chunks[j].zoneFar.office >= 6 ? T.parkingYenCore : 0
          const carCost =
            car.minutes[i][j] === Infinity
              ? Infinity
              : car.minutes[i][j] * T.valueOfTimeYenPerMin + car.km[i][j] * T.carYenPerKm + parking
          let share = 0
          if (trip) {
            const railCost = trip.minutes * T.valueOfTimeYenPerMin + trip.fare + trip.accessYen
            const logit = carCost === Infinity ? 1 : 1 / (1 + Math.exp(T.theta * (railCost - carCost)))
            const captive = trip.minutes <= car.minutes[i][j] * T.captiveMaxTimeRatio ? T.captiveRailShare : 0
            share = captive + (1 - captive) * logit
          }
          const viaRail = p * share
          const viaCar = carCost === Infinity ? 0 : p - viaRail
          allTrips += 2 * (viaRail + viaCar)
          if (trip && viaRail > 0) {
            railTrips += 2 * viaRail
            const f = flows[trip.line]
            f.riders += 2 * viaRail
            f.pkm += 2 * viaRail * trip.km
            f.fare += 2 * viaRail * trip.fare
            f.boardings[trip.a] += viaRail
            f.boardings[trip.b] += viaRail
            const [lo, hi] = trip.a < trip.b ? [trip.a, trip.b] : [trip.b, trip.a]
            const outbound = trip.a < trip.b ? f.up : f.down
            const inbound = trip.a < trip.b ? f.down : f.up
            for (let s = lo; s < hi; s++) {
              outbound[s] += viaRail
              inbound[s] += viaRail
            }
          }
          if (viaCar > 0 && i !== j) {
            for (let v = j; car.pred[i][v] >= 0; ) {
              const ei = car.pred[i][v]
              carPersons[ei] += 2 * viaCar
              const e = world.roads[ei]
              v = e.a === v ? e.b : e.a
            }
          }
        }
      }
    }
    world.roads.forEach((e, ei) => {
      e.dailyPersons = (1 - 1 / k) * e.dailyPersons + (1 / k) * carPersons[ei]
    })
  }

  for (const c of world.chunks) c.boardings = 0
  world.lines.forEach((line, li) => {
    const f = flows[li]
    if (!f || line.stage !== 'open') return
    const svc = line.service
    const peakSeats = (svc.localPeak + svc.expressPeak) * svc.cars * R.carCapacity
    const maxLoad = Math.max(0, ...f.up, ...f.down)
    const peakLoadRatio = peakSeats > 0 ? (maxLoad * R.peakDirectionShare) / peakSeats : 0
    line.stats = {
      dailyRiders: f.riders,
      dailyPassengerKm: f.pkm,
      dailyFare: f.fare,
      peakLoadRatio,
      boardings: f.boardings,
    }
    line.crowdingPenaltyMin =
      peakLoadRatio > R.crowdingThreshold ? R.crowdingPenaltyMin * (peakLoadRatio - R.crowdingThreshold) : 0
    line.stations.forEach((s, si) => {
      chunkAt(world, s.x, s.y).boardings += f.boardings[si]
    })
  })

  const minutes = car.minutes.map((row, i) => row.map((t, j) => compositeMinutes(t, rail[i][j]?.minutes ?? Infinity)))
  return { minutes, railShare: allTrips > 0 ? railTrips / allTrips : 0, dailyTrips: allTrips }
}
