// @ts-expect-error Node strip-types tests require the source extension.
import { PARAMS } from './params.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { bestRail, carMatrix, chunkAt, stationAccess, type CarMatrix, type RailTrip } from './network.ts'
import type { Line, LineStats, RoadEdge, World } from './types.ts'

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

export type LineTraffic = { stats: LineStats; crowdingPenaltyMin: number }

export type TrafficResult = {
  minutes: number[][] // composite travel minutes between chunks, used for accessibility
  railShare: number
  dailyTrips: number
  roadPersons: number[] // daily car travellers per road edge, after averaging
  lines: (LineTraffic | null)[] // per line in world.lines; null for lines not open
  chunkBoardings: number[]
}

type LineFlow = { riders: number; pkm: number; fare: number; boardings: number[]; up: number[]; down: number[] }

const emptyFlow = (line: Line): LineFlow => ({
  riders: 0,
  pkm: 0,
  fare: 0,
  boardings: line.stations.map(() => 0),
  up: line.stations.map(() => 0),
  down: line.stations.map(() => 0),
})

// Each person travels i -> j and back, so every trip counts twice.
function addRailFlow(flow: LineFlow, trip: RailTrip, persons: number) {
  flow.riders += 2 * persons
  flow.pkm += 2 * persons * trip.km
  flow.fare += 2 * persons * trip.fare
  flow.boardings[trip.a] += persons
  flow.boardings[trip.b] += persons

  const [lo, hi] = trip.a < trip.b ? [trip.a, trip.b] : [trip.b, trip.a]
  const outbound = trip.a < trip.b ? flow.up : flow.down
  const inbound = trip.a < trip.b ? flow.down : flow.up
  for (let s = lo; s < hi; s++) {
    outbound[s] += persons
    inbound[s] += persons
  }
}

function addCarFlow(carPersons: number[], roads: RoadEdge[], car: CarMatrix, from: number, to: number, persons: number) {
  for (let v = to; car.pred[from][v] >= 0; ) {
    const ei = car.pred[from][v]
    carPersons[ei] += 2 * persons
    const e = roads[ei]
    v = e.a === v ? e.b : e.a
  }
}

function railShareOf(trip: RailTrip | null, carMinutes: number, carCost: number): number {
  if (!trip) return 0
  const railCost = trip.minutes * T.valueOfTimeYenPerMin + trip.fare + trip.accessYen
  const logit = carCost === Infinity ? 1 : 1 / (1 + Math.exp(T.theta * (railCost - carCost)))
  const captive = trip.minutes <= carMinutes * T.captiveMaxTimeRatio ? T.captiveRailShare : 0
  return captive + (1 - captive) * logit
}

function summarizeLine(line: Line, flow: LineFlow): LineTraffic {
  const svc = line.service
  const peakSeats = (svc.localPeak + svc.expressPeak) * svc.cars * R.carCapacity
  const maxLoad = Math.max(0, ...flow.up, ...flow.down)
  const peakLoadRatio = peakSeats > 0 ? (maxLoad * R.peakDirectionShare) / peakSeats : 0
  const crowdingPenaltyMin =
    peakLoadRatio > R.crowdingThreshold ? R.crowdingPenaltyMin * (peakLoadRatio - R.crowdingThreshold) : 0
  return {
    stats: {
      dailyRiders: flow.riders,
      dailyPassengerKm: flow.pkm,
      dailyFare: flow.fare,
      peakLoadRatio,
      boardings: flow.boardings,
    },
    crowdingPenaltyMin,
  }
}

// Daily trips (commutes and shopping) from the current population and jobs,
// split between car and rail with a logit model, then assigned to roads with
// a few rounds of method-of-successive-averages so congestion pushes trips to
// rail. Reads the world and returns the result; applyTraffic writes it back.
export function computeTraffic(world: World): TrafficResult {
  const n = world.chunks.length
  const access = world.chunks.map((c) => stationAccess(world.lines, c))
  const rail: (RailTrip | null)[][] = world.chunks.map((_, i) =>
    world.chunks.map((__, j) => (i === j ? null : bestRail(world.lines, access[i], access[j]))),
  )
  const jobs = world.chunks.map((c) => c.jobs.office + c.jobs.retail + c.jobs.industry)
  const retail = world.chunks.map((c) => c.jobs.retail)

  // Road volumes are averaged across iterations on a private copy.
  const roads = world.roads.map((e) => ({ ...e }))
  let flows: LineFlow[] = []
  let car = carMatrix(roads, n)
  let railTrips = 0
  let allTrips = 0

  for (let k = 1; k <= T.msaIterations; k++) {
    car = carMatrix(roads, n)
    const carPersons = new Array(roads.length).fill(0)
    flows = world.lines.map(emptyFlow)
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
        // Destination choice: attractive places nearby get more trips.
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
          const travellers = (persons * w[j]) / total
          const trip = rail[i][j]
          const parking = commute && world.chunks[j].zoneFar.office >= T.parkingCoreOfficeFar ? T.parkingYenCore : 0
          const carCost =
            car.minutes[i][j] === Infinity
              ? Infinity
              : car.minutes[i][j] * T.valueOfTimeYenPerMin + car.km[i][j] * T.carYenPerKm + parking

          const viaRail = travellers * railShareOf(trip, car.minutes[i][j], carCost)
          const viaCar = carCost === Infinity ? 0 : travellers - viaRail
          allTrips += 2 * (viaRail + viaCar)

          if (trip && viaRail > 0) {
            railTrips += 2 * viaRail
            addRailFlow(flows[trip.line], trip, viaRail)
          }
          if (viaCar > 0 && i !== j) addCarFlow(carPersons, roads, car, i, j, viaCar)
        }
      }
    }

    roads.forEach((e, ei) => {
      e.dailyPersons = (1 - 1 / k) * e.dailyPersons + (1 / k) * carPersons[ei]
    })
  }

  const lines = world.lines.map((line, li) => (line.stage === 'open' && flows[li] ? summarizeLine(line, flows[li]) : null))
  const chunkBoardings = world.chunks.map(() => 0)
  world.lines.forEach((line, li) => {
    const result = lines[li]
    if (!result) return
    line.stations.forEach((s, si) => {
      chunkBoardings[chunkAt(world, s.x, s.y).id] += result.stats.boardings[si]
    })
  })

  return {
    minutes: car.minutes.map((row, i) => row.map((t, j) => compositeMinutes(t, rail[i][j]?.minutes ?? Infinity))),
    railShare: allTrips > 0 ? railTrips / allTrips : 0,
    dailyTrips: allTrips,
    roadPersons: roads.map((e) => e.dailyPersons),
    lines,
    chunkBoardings,
  }
}

export function applyTraffic(world: World, traffic: TrafficResult) {
  world.roads.forEach((e, ei) => {
    e.dailyPersons = traffic.roadPersons[ei]
  })
  world.lines.forEach((line, li) => {
    const result = traffic.lines[li]
    if (!result) return
    line.stats = result.stats
    line.crowdingPenaltyMin = result.crowdingPenaltyMin
  })
  world.chunks.forEach((c, i) => {
    c.boardings = traffic.chunkBoardings[i]
  })
}
