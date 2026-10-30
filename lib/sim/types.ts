// Shared state shapes for the Emporion simulation. Everything here is plain data
// so a world can be serialized to the database between ticks.

// The landform. It decides what can be built and what construction costs.
export type TileKind = 'sea' | 'plain' | 'hill' | 'river' | 'mountain'

// What covers the ground, independent of the landform: farmland, woods of
// several kinds, or bare rock. Used for how the map looks and for scenery.
export type LandCover =
  | 'water'
  | 'paddy' // 水田
  | 'field' // 畑
  | 'grove' // 屋敷林・平地林
  | 'satoyama' // 里山の雑木林
  | 'bamboo' // 竹林
  | 'conifer' // スギ・ヒノキの人工林
  | 'broadleaf' // 広葉樹林
  | 'bare' // 岩場

export const WOODLAND: readonly LandCover[] = ['grove', 'satoyama', 'bamboo', 'conifer', 'broadleaf']
export type Use = 'res' | 'office' | 'retail' | 'industry'
export type JobUse = Exclude<Use, 'res'>
export type PerUse = Record<Use, number>

export const USES: readonly Use[] = ['res', 'office', 'retail', 'industry']
export const JOB_USES: readonly JobUse[] = ['office', 'retail', 'industry']

export type Resource = { kind: 'port' | 'onsen' | 'ore'; x: number; y: number }

export type Terrain = {
  size: number
  height: number[] // metres above sea level
  kind: TileKind[]
  cover: LandCover[]
  basin: { x: number; y: number } | null // centre of the intermontane basin, if any
  resources: Resource[]
}

export type CityKind = 'port' | 'plain' | 'mountain'

export type City = {
  id: string
  name: string
  kind: CityKind
  persona: 'industry' | 'tourism' | 'populist' | 'prudent'
  x: number
  y: number
}

export type Chunk = {
  id: number
  cx: number
  cy: number
  cityId: string | null
  landFactor: number // B in the land value formula
  view: number // scenic bonus from sea, forest or mountains nearby
  passable: boolean
  mountainShare: number
  zoneFar: PerUse // 0 means the use is not allowed
  bgFloor: PerUse // floor built by the background (local) developers, m2
  floor: PerUse // bgFloor plus operating firm buildings, m2
  pop: number
  jobs: Record<JobUse, number>
  unmet: PerUse
  lowVacancyTicks: PerUse
  rentMult: PerUse
  lv: number // yen per m2
  lvTarget: number
  access: number // jobs reachable, weighted by travel time
  accessPop: number
  boardings: number // daily rail boardings at stations in this chunk
  buildableM2: number
  rumorUntil: number
  purchases: { tick: number; firm: string; tiles: number }[]
}

export type RoadEdge = {
  a: number
  b: number
  km: number
  speedKmh: number
  capacityVph: number
  arterial: boolean
  dailyPersons: number // both directions, from the last assignment
}

export type Station = { x: number; y: number; express: boolean }

export type Service = {
  localPeak: number // trains per hour
  localOff: number
  expressPeak: number
  expressOff: number
  cars: number
  fareMult: number
}

export type LineStage = 'planned' | 'applied' | 'approved' | 'construction' | 'open'

export type LineStats = {
  dailyRiders: number
  dailyPassengerKm: number
  dailyFare: number
  peakLoadRatio: number
  boardings: number[]
}

export type Line = {
  id: string
  owner: string
  name: string
  stations: Station[]
  stage: LineStage
  stageTick: number
  buildTicksLeft: number
  cost: number
  costPaid: number
  carsOwned: number
  carBookValue: number
  trackBookValue: number
  service: Service
  stats: LineStats
  crowdingPenaltyMin: number
}

export type Loan = {
  id: string
  kind: 'corporate' | 'project' | 'overdraft'
  principal: number
  balance: number
  rate: number // annual
  termTicks: number
  graceTicks: number
  ageTicks: number
  lineId?: string // project loans name what they financed
  buildingId?: string
}

export type Firm = {
  id: string
  name: string
  kind: 'player' | 'ai'
  cash: number
  loans: Loan[]
  shares: number
  rating: string
  marketCap: number
  nav: number
  bankrupt: boolean
  shortfallTicks: number
}

export type BuildingUse = Use | 'station'

export type Building = {
  id: string
  owner: string
  x: number
  y: number
  use: BuildingUse
  mode: 'lease' | 'sale'
  floorArea: number
  status: 'construction' | 'operating' | 'selling' | 'sold'
  ticksLeft: number
  cost: number
  costPaid: number
  bookValue: number
  occupancy: number
  ageTicks: number
  saleTicksLeft: number
}

export type Parcel = { owner: string; cost: number; station?: boolean }

export type LedgerEntry = {
  tick: number
  firm: string
  segment: 'rail' | 'realestate' | 'corporate'
  account: string
  amount: number
  pl: boolean // false for capital flows such as land purchases and loan principal
}

export type SimEvent = {
  tick: number
  type: string
  actor?: string
  x?: number
  y?: number
  importance: number
  payload?: Record<string, unknown>
}

export type World = {
  seed: number
  tick: number
  terrain: Terrain
  chunksPerSide: number
  chunks: Chunk[]
  cities: City[]
  roads: RoadEdge[]
  firms: Firm[]
  parcels: Record<string, Parcel>
  buildings: Building[]
  lines: Line[]
  ledger: LedgerEntry[]
  events: SimEvent[]
  region: {
    basicJobs: number
    accessRef: number // median accessibility at creation, for normalization
    meanAccess0: number
    lvRef: number
    popHistory: number[]
  }
  nextId: number
}
