// @ts-expect-error Node strip-types tests require the source extension.
import { CHUNK_TILES, PARAMS, TILE_M } from './params.ts'
import type { Chunk, Line, RoadEdge, World } from './types.ts'

const T = PARAMS.traffic
const R = PARAMS.rail

export const CHUNK_M = CHUNK_TILES * TILE_M

export function chunkCenterM(c: Chunk): [number, number] {
  return [(c.cx + 0.5) * CHUNK_M, (c.cy + 0.5) * CHUNK_M]
}

export function chunkAt(world: World, x: number, y: number): Chunk {
  const n = world.chunksPerSide
  return world.chunks[Math.floor(y / CHUNK_TILES) * n + Math.floor(x / CHUNK_TILES)]
}

// Road network: one node per chunk, edges to the four neighbours. Edges on the
// fastest route between city centres become arterials with double capacity.
export function buildRoads(world: World): RoadEdge[] {
  const n = world.chunksPerSide
  const edges: RoadEdge[] = []
  for (const c of world.chunks) {
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const nx = c.cx + dx
      const ny = c.cy + dy
      if (nx >= n || ny >= n) continue
      const d = world.chunks[ny * n + nx]
      if (!c.passable || !d.passable) continue
      const mountain = Math.max(c.mountainShare, d.mountainShare) > 0.4
      edges.push({
        a: c.id,
        b: d.id,
        km: CHUNK_M / 1000,
        speedKmh: mountain ? T.roadSpeedKmh.mountain : c.cityId || d.cityId ? T.roadSpeedKmh.urban : T.roadSpeedKmh.rural,
        capacityVph: T.roadCapacityVph.local,
        arterial: false,
        dailyPersons: 0,
      })
    }
  }
  const centers = world.cities.map((city) => chunkAt(world, city.x, city.y).id)
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const { pred } = dijkstra(world.chunks.length, edges, centers[i], (e) => (e.km / e.speedKmh) * 60)
      for (let v = centers[j]; pred[v] >= 0; ) {
        const e = edges[pred[v]]
        const urban = world.chunks[e.a].cityId || world.chunks[e.b].cityId
        e.arterial = true
        e.capacityVph = T.roadCapacityVph.arterial
        e.speedKmh = Math.max(e.speedKmh, urban ? T.roadSpeedKmh.arterialUrban : T.roadSpeedKmh.arterialRural)
        v = e.a === v ? e.b : e.a
      }
    }
  }
  return edges
}

export function edgeMinutes(e: RoadEdge): number {
  const free = (e.km / e.speedKmh) * 60
  const vph = (e.dailyPersons / T.carOccupancy) * T.peakHourShare * 0.5
  return free * (1 + T.bprA * (vph / e.capacityVph) ** T.bprB)
}

export function dijkstra(
  nodes: number,
  edges: RoadEdge[],
  source: number,
  cost: (e: RoadEdge) => number,
): { dist: number[]; pred: number[] } {
  const adj: number[][] = Array.from({ length: nodes }, () => [])
  edges.forEach((e, i) => {
    adj[e.a].push(i)
    adj[e.b].push(i)
  })
  const dist = new Array(nodes).fill(Infinity)
  const pred = new Array(nodes).fill(-1)
  const done = new Array(nodes).fill(false)
  dist[source] = 0
  for (;;) {
    let u = -1
    for (let i = 0; i < nodes; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i
    if (u < 0 || dist[u] === Infinity) break
    done[u] = true
    for (const ei of adj[u]) {
      const e = edges[ei]
      const v = e.a === u ? e.b : e.a
      const nd = dist[u] + cost(e)
      if (nd < dist[v]) {
        dist[v] = nd
        pred[v] = ei
      }
    }
  }
  return { dist, pred }
}

export type CarMatrix = { minutes: number[][]; km: number[][]; pred: number[][] }

export function carMatrix(world: World): CarMatrix {
  const n = world.chunks.length
  const minutes: number[][] = []
  const km: number[][] = []
  const pred: number[][] = []
  for (let s = 0; s < n; s++) {
    const t = dijkstra(n, world.roads, s, edgeMinutes)
    const d = dijkstra(n, world.roads, s, (e) => e.km)
    for (let j = 0; j < n; j++) if (j !== s) t.dist[j] += 2 * T.carTerminalMin
    t.dist[s] = T.intraChunkMin
    d.dist[s] = T.intraChunkKm
    minutes.push(t.dist)
    km.push(d.dist)
    pred.push(t.pred)
  }
  return { minutes, km, pred }
}

// --- Rail ---

export function stationGapsKm(line: Line): number[] {
  const gaps: number[] = []
  for (let i = 1; i < line.stations.length; i++) {
    const a = line.stations[i - 1]
    const b = line.stations[i]
    gaps.push((Math.hypot(a.x - b.x, a.y - b.y) * TILE_M * R.curvature) / 1000)
  }
  return gaps
}

export function lineKm(line: Line): number {
  return stationGapsKm(line).reduce((s, g) => s + g, 0)
}

function cumulativeKm(line: Line): number[] {
  const out = [0]
  for (const g of stationGapsKm(line)) out.push(out[out.length - 1] + g)
  return out
}

export function rideMinutes(line: Line, a: number, b: number, express: boolean): number {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const km = cumulativeKm(line)
  let stops = 0
  for (let i = lo + 1; i < hi; i++) if (!express || line.stations[i].express) stops++
  return ((km[hi] - km[lo]) / R.cruiseKmh) * 60 + stops * R.stopLossMin
}

export function rideKm(line: Line, a: number, b: number): number {
  const km = cumulativeKm(line)
  return Math.abs(km[b] - km[a])
}

export function fare(line: Line, km: number): number {
  const extra = Math.max(0, km - R.fareBaseKm)
  return Math.round((R.fareBase + extra * R.farePerKm) * line.service.fareMult)
}

function dayAverage(peak: number, off: number): number {
  return (peak * R.peakHours + off * R.offHours) / (R.peakHours + R.offHours)
}

export type StationAccess = { line: number; station: number; minutes: number; yen: number }

// Stations a chunk's residents can reach: walk, or a feeder bus when walking is slow.
export function stationAccess(world: World, chunk: Chunk): StationAccess[] {
  const [cx, cy] = chunkCenterM(chunk)
  const out: StationAccess[] = []
  world.lines.forEach((line, li) => {
    if (line.stage !== 'open') return
    line.stations.forEach((s, si) => {
      const d = Math.hypot((s.x + 0.5) * TILE_M - cx, (s.y + 0.5) * TILE_M - cy) * 0.7
      const walk = d / T.walkMPerMin
      const feeder = T.feederWaitMin + d / T.feederMPerMin
      const [minutes, yen] = walk <= feeder ? [walk, 0] : [feeder, T.feederFareYen]
      if (minutes <= T.maxAccessMin) out.push({ line: li, station: si, minutes, yen })
    })
  })
  return out
}

export type RailTrip = { minutes: number; fare: number; accessYen: number; line: number; a: number; b: number; km: number }

export function bestRail(world: World, from: StationAccess[], to: StationAccess[]): RailTrip | null {
  let best: RailTrip | null = null
  let bestCost = Infinity
  for (const o of from) {
    for (const d of to) {
      if (o.line !== d.line || o.station === d.station) continue
      const line = world.lines[o.line]
      const svc = line.service
      const options: [boolean, number][] = [[false, dayAverage(svc.localPeak, svc.localOff)]]
      const expressStops = line.stations[o.station].express && line.stations[d.station].express
      if (expressStops) options.push([true, dayAverage(svc.expressPeak, svc.expressOff)])
      for (const [express, freq] of options) {
        if (freq <= 0) continue
        const km = rideKm(line, o.station, d.station)
        const minutes =
          o.minutes + 30 / freq + rideMinutes(line, o.station, d.station, express) + line.crowdingPenaltyMin + d.minutes
        const price = fare(line, km)
        const cost = minutes * T.valueOfTimeYenPerMin + price + o.yen + d.yen
        if (cost < bestCost) {
          bestCost = cost
          best = { minutes, fare: price, accessYen: o.yen + d.yen, line: o.line, a: o.station, b: d.station, km }
        }
      }
    }
  }
  return best
}

export function roundTripMinutes(line: Line): number {
  return 2 * rideMinutes(line, 0, line.stations.length - 1, false) + 2 * R.turnaroundMin
}

export function trainsNeeded(line: Line): number {
  const svc = line.service
  const peak = svc.localPeak + svc.expressPeak
  if (peak <= 0) return 0
  return Math.ceil(roundTripMinutes(line) / (60 / peak))
}

export function dailyCarKm(line: Line): number {
  const svc = line.service
  const trainsPerDirection = (svc.localPeak + svc.expressPeak) * R.peakHours + (svc.localOff + svc.expressOff) * R.offHours
  return trainsPerDirection * 2 * lineKm(line) * svc.cars
}
