// Tunable constants for the Emporion simulation. Values follow the design doc
// ("Emporion 企画・設計書 v2") and are starting points for balancing, not truths.

export const TILE_M = 200
export const CHUNK_TILES = 16
export const TILE_AREA_M2 = TILE_M * TILE_M
export const TILES_PER_CHUNK = CHUNK_TILES * CHUNK_TILES
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
    stationQualityBoardings: 20_000, // daily boardings at which a station gives its full lift
    stationQualityRange: [0.3, 1.5] as const,
    plannedStationBoardings: 10_000, // assumed for stations that are not open yet
    momentumWindow: 13, // ticks of population growth that move prices
    momentumGain: 4,
    momentumRange: [-0.2, 0.3] as const,
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
    // Where people and jobs want to be
    rentElasticity: -0.3,
    industryRentElasticity: -0.5,
    officeClusterJobs: 20_000, // office jobs at which clustering starts to pay off
    officeClusterExponent: 0.3,
    retailBoardingsScale: 20_000, // daily station boardings that double retail demand
    portIndustryBonus: 2,
    useShareOfBuildable: 0.3, // share of a chunk's buildable land one use can take
    environment: { view: 0.2, industry: -0.3, retail: 0.1, retailJobsForFullBonus: 5_000 } as const,
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
    parkingCoreOfficeFar: 6, // office FAR that marks a city core with paid parking
    carOccupancy: 1.3,
    peakHourShare: 0.1,
    intraChunkMin: 6,
    intraChunkKm: 1.6,
    accessDistanceFactor: 0.7, // residents live closer to a station than the chunk centre does
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
    trackYenPerKm: 20 * OKU, // a surface suburban line; tunnels and bridges come from terrainMult
    terrainMult: { plain: 1, hill: 1.3, river: 2.5, sea: 2.5, mountain: 2.5 } as const,
    stationYen: 8 * OKU,
    expressStationYen: 20 * OKU,
    carYen: 1.8 * OKU,
    carCapacity: 140,
    cruiseKmh: 70,
    stopLossMin: 1.0,
    turnaroundMin: 5,
    opYenPerCarKm: 400, // crew, power and car upkeep, near Japanese private railways
    maintYenPerKmYear: 0.5 * OKU,
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
    serviceLimits: { fareMult: [0.7, 1.3], cars: [1, 12], trainsPerHour: [0, 30] } as const,
  },
  // Real estate
  realEstate: {
    // Rents at the reference land value, near suburban levels in Japan.
    baseRentYenPerM2Month: { res: 2_400, office: 2_800, retail: 2_600, industry: 900 } as const,
    // Construction cost per m2 of floor, at recent Japanese levels.
    yenPerM2: { res: 450_000, office: 500_000, retail: 400_000, industry: 200_000, station: 500_000 } as const,
    buildTicks: { res: 12, office: 16, retail: 12, industry: 12, station: 20 } as const,
    buildM2PerTick: 5_000, // larger buildings take longer on top of the base time
    upfrontShare: 0.3,
    opexShare: 0.25,
    propertyTaxRate: 0.014,
    capBase: 0.03,
    capCityRisk: 0.005,
    capAgePerYear: 0.0002,
    capStationNear: 0.003,
    capUsePremium: { res: 0, office: 0.003, retail: 0.008, industry: 0.015 } as const, // shops and factories are riskier to own
    naturalVacancy: 0.05,
    rentAdjust: 0.002, // weekly change per natural-vacancy gap; about 10% a year when nothing is vacant
    rentMaxStepPerTick: 0.004, // about ±20% a year at most
    rentMultRange: [0.6, 1.8] as const,
    leaseUpPerTick: 0.08,
    buildingLifeYears: 40,
    condoSaleTicks: 8, // at least this long, however small
    condoSaleM2PerTick: 2_000, // about 25 homes a week find buyers
    condoPremium: 1.1,
    stationRentMult: 1.3,
    stationRentBoardingsScale: 50_000, // daily boardings that double a station building's rent
    stationNearM: 800, // buildings this close to an open station get a lower cap rate
    stationBuildingFar: 4,
  },
  // Permits from the mayors. A line needs every city it passes through.
  permits: {
    reviewTicks: 4,
    reviewTicksPerCityKm: 0.25, // longer stretches take longer, up to the cap
    reviewTicksMax: 8,
    approveAt: 0.6, // score at or above: approved without conditions
    rejectBelow: -0.2, // score below: refused outright
    maxRounds: 5,
    refileBlockTicks: 8,
    refuseRelation: -50, // below this a mayor will not negotiate
    relationWeight: 0.005, // score per relation point
    // How each kind of mayor weighs a line's effects (each effect is roughly -1..1).
    weights: {
      industry: { service: 0.6, jobs: 0.8, scenery: 0.2, nuisance: 0.4 },
      tourism: { service: 0.7, jobs: 0.3, scenery: 0.7, nuisance: 0.5 },
      populist: { service: 0.9, jobs: 0.5, scenery: 0.3, nuisance: 0.6 },
      prudent: { service: 0.6, jobs: 0.4, scenery: 0.4, nuisance: 0.4 },
    },
    servedPopForFullService: 30_000, // people near the city's stations for the full service effect
    spendForFullJobs: 200 * OKU, // construction spending in the city for the full jobs effect
    tilesForFullScenery: 20, // woodland and hill tiles crossed for the full scenery loss
    tilesForFullNuisance: 10, // tiles crossed through dense districts for the full nuisance
    denseChunkPop: 10_000,
    // What each promise is worth to each kind of mayor, in score.
    conditionValue: {
      industry: { plazaPer10Oku: 0.1, openBy: 0.15, expressStop: 0.15, fareFreeze: 0.1 },
      tourism: { plazaPer10Oku: 0.12, openBy: 0.1, expressStop: 0.2, fareFreeze: 0.1 },
      populist: { plazaPer10Oku: 0.2, openBy: 0.1, expressStop: 0.2, fareFreeze: 0.25 },
      prudent: { plazaPer10Oku: 0.05, openBy: 0.25, expressStop: 0.1, fareFreeze: 0.15 },
    },
    plazaStep: 5 * OKU,
    plazaMax: 60 * OKU,
    dealYears: 5,
    openBySlackTicks: 8, // a promised opening date leaves this much room after the build time
    penaltyYen: 10 * OKU,
    relation: { kept: 10, broken: -30, plazaPer10Oku: 3, rumor: -3 },
  },
  // AI rivals: the code proposes moves, the rival picks among them.
  rival: {
    actionsPerTick: 3,
    candidates: 10,
    reserveYen: 60 * OKU, // cash the rival keeps back
    aheadRadius: 2, // tiles around another firm's announced station worth buying
    developFarShare: 0.5,
    minDevelopMargin: 0.08,
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
    // Net debt to EBITDA by rating, at the levels of Japanese railway and
    // property groups, which hold A ratings at 7-10 times.
    ratings: [
      { name: 'AAA', debtToEbitda: 4, equityRatio: 0.4, spread: 0.002 },
      { name: 'A', debtToEbitda: 8, equityRatio: 0.25, spread: 0.006 },
      { name: 'BBB', debtToEbitda: 11, equityRatio: 0.15, spread: 0.012 },
      { name: 'BB', debtToEbitda: 14, equityRatio: 0.08, spread: 0.025 },
      { name: 'B', debtToEbitda: Infinity, equityRatio: -Infinity, spread: 0.045 },
    ],
    // Price to book: ROE and growth of recurring revenue (fares and rents), and
    // the market cap moves part of the way toward that price each quarter.
    pbr: { roe: 3, growth: 2, min: 0.5, max: 2.5, quarterlyPull: 0.3 },
    startingCash: 300 * OKU,
    loanYears: [5, 10, 20] as const,
    projectLoanYears: [10, 20, 30] as const, // lines and buildings repay from what they earn, over longer terms
    maxGraceYears: 3,
    overdraftMin: 10 * OKU,
  },
} as const

export type Params = typeof PARAMS
