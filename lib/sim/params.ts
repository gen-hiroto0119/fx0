// Tunable constants for the Emporion simulation. Values follow the design doc
// ("Emporion 企画・設計書 v2") and are starting points for balancing, not truths.

export const TILE_M = 200
export const CHUNK_TILES = 16
export const TILE_AREA_M2 = TILE_M * TILE_M
export const TICKS_PER_YEAR = 52
export const TICKS_PER_QUARTER = 13

export const OKU = 100_000_000

export const PARAMS = {
  // Land value
  lv: {
    alpha: 0.8,
    beta: 0.05, // per minute, accessibility decay
    lambda: 0.15, // per tick, convergence toward target
    base: 50_000, // yen per m2 at reference accessibility on flat land
    kappa: 0.5, // price markup per share of chunk bought recently
    rumorShare: 0.05,
    rumorWindow: 8,
    rumorTicks: 13,
    rumorBoost: 0.05,
    stagePlanP: { planned: 0, applied: 0.4, approved: 0.8, construction: 0.95, open: 1 } as const,
    stationBonus: 0.6,
    stationDecayM: 400,
  },
  // City growth (simplified Lowry model)
  growth: {
    h: 2.0, // residents per job
    k: 0.25, // retail/service jobs per resident
    industryShareOfBasic: 0.4,
    relocation: 0.03,
    basicGrowth: 0.0008, // per tick at initial accessibility
    floorPerCapita: { res: 35, office: 15, retail: 25, industry: 50 } as const,
    bgDevVacancy: 0.05,
    bgDevTicks: 3,
    bgDevRate: 0.02,
    bgDevMin: 2_000,
    bgDevUnmetShare: 0.1, // share of unmet demand local developers build per tick
    shoppingTripsPerResident: 0.3,
  },
  // Transport
  traffic: {
    valueOfTimeYenPerMin: 30,
    theta: 0.004, // logit sensitivity per yen
    noCarShare: 0.25, // people without a car: rail if it exists, otherwise a bus
    busTimeFactor: 2, // bus takes this many times the car time
    logsumScaleMin: 10, // how much a second mode improves the composite travel time
    captiveRailShare: 0.1,
    captiveMaxTimeRatio: 1.5, // no-car travellers use rail only when it is not far slower than driving
    carYenPerKm: 15,
    parkingYenCore: 400, // commutes into a city's office core
    carOccupancy: 1.3,
    peakHourShare: 0.1,
    intraChunkMin: 6,
    intraChunkKm: 1.6,
    walkMPerMin: 80,
    feederWaitMin: 6,
    feederMPerMin: 250,
    feederFareYen: 200,
    maxAccessMin: 18,
    bprA: 0.15,
    bprB: 4,
    msaIterations: 3,
    carTerminalMin: 4, // parking and walking at each end of a car trip between chunks
    roadSpeedKmh: { urban: 25, rural: 50, mountain: 25, arterialUrban: 30, arterialRural: 60 } as const,
    roadCapacityVph: { local: 1200, arterial: 2400 } as const,
  },
  // Rail
  rail: {
    trackYenPerKm: 30 * OKU,
    terrainMult: { plain: 1, hill: 1.3, forest: 1.1, river: 2.5, sea: 2.5, mountain: 2.5 } as const,
    stationYen: 10 * OKU,
    expressStationYen: 25 * OKU,
    carYen: 1.8 * OKU,
    carCapacity: 140,
    cruiseKmh: 70,
    stopLossMin: 1.0,
    turnaroundMin: 5,
    opYenPerCarKm: 250,
    maintYenPerKmYear: 0.3 * OKU,
    trackLifeYears: 40,
    carLifeYears: 15,
    curvature: 1.1,
    fareBase: 160,
    fareBaseKm: 3,
    farePerKm: 18,
    peakHours: 4,
    offHours: 14,
    peakDirectionShare: 0.15, // share of daily one-direction riders in the peak hour
    crowdingThreshold: 1.5,
    crowdingPenaltyMin: 10,
    buildTicksPerKm: 1.5,
    buildTicksMin: 12,
  },
  // Real estate
  realEstate: {
    baseRentYenPerM2Month: { res: 2_500, office: 4_000, retail: 4_500, industry: 1_200 } as const,
    yenPerM2: { res: 300_000, office: 400_000, retail: 350_000, industry: 150_000, station: 450_000 } as const,
    buildTicks: { res: 12, office: 16, retail: 12, industry: 12, station: 20 } as const,
    upfrontShare: 0.3,
    opexShare: 0.25,
    propertyTaxRate: 0.014,
    capBase: 0.03,
    capCityRisk: 0.005,
    capAgePerYear: 0.0002,
    capStationNear: 0.003,
    naturalVacancy: 0.05,
    rentAdjust: 0.02,
    leaseUpPerTick: 0.08,
    buildingLifeYears: 40,
    condoSaleTicks: 8,
    condoPremium: 1.1,
    stationRentMult: 1.3,
  },
  // Finance
  finance: {
    baseRate: 0.015,
    projectPremium: 0.004,
    projectMaxShare: 0.7,
    ltv: { land: 0.6, building: 0.7, rail: 0.5 } as const,
    dscr: 1.2,
    overdraftPremium: 0.08,
    forcedSaleShare: 0.7,
    ratings: [
      { name: 'AAA', debtToEbitda: 2, equityRatio: 0.5, spread: 0.002 },
      { name: 'A', debtToEbitda: 4, equityRatio: 0.35, spread: 0.006 },
      { name: 'BBB', debtToEbitda: 6, equityRatio: 0.25, spread: 0.012 },
      { name: 'BB', debtToEbitda: 8, equityRatio: 0.15, spread: 0.025 },
      { name: 'B', debtToEbitda: Infinity, equityRatio: -Infinity, spread: 0.045 },
    ],
    pbr: { roe: 3, growth: 2, min: 0.3, max: 3 },
    startingCash: 300 * OKU,
  },
} as const

export type Params = typeof PARAMS
