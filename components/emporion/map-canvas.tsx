'use client'

import { useEffect, useRef, useState } from 'react'
import { CHUNK_TILES, PARAMS, type Station, type TileKind, type World } from '@/lib/sim'

export type Overlay = 'none' | 'population' | 'landValue' | 'traffic'
export type Tile = { x: number; y: number }

type Props = {
  world: World
  revision: number // bumps whenever the world changed in place
  overlay: Overlay
  draft: Station[]
  selected: Tile | null
  onTileClick: (tile: Tile) => void
}

const TERRAIN_RGB: Record<TileKind, [number, number, number]> = {
  sea: [70, 130, 180],
  river: [100, 160, 210],
  plain: [196, 214, 160],
  forest: [110, 150, 95],
  hill: [170, 175, 130],
  mountain: [140, 125, 110],
}

const OWNER_COLOR: Record<string, string> = { player: '#2563eb', rival: '#ea580c' }
const USE_COLOR: Record<string, string> = {
  res: '#16a34a',
  office: '#7c3aed',
  retail: '#db2777',
  industry: '#78716c',
  station: '#0891b2',
}

// Hillshade lit from the north-west (top-left) at 45 degrees, the direction
// people assume light comes from; lighting from the other side makes
// mountains read as hollows. Heights are exaggerated because 200 m tiles make
// real slopes look faint.
const LIGHT_AZIMUTH = (315 * Math.PI) / 180
const LIGHT_ALTITUDE = Math.PI / 4
const VERTICAL_EXAGGERATION = 3
const TILE_SPAN_M = 200

function hillshade(dzdx: number, dzdy: number): number {
  // Surface normal (-dz/dx, -dz/dy, 1) against a light vector; +y points south.
  const lx = Math.sin(LIGHT_AZIMUTH) * Math.cos(LIGHT_ALTITUDE)
  const ly = -Math.cos(LIGHT_AZIMUTH) * Math.cos(LIGHT_ALTITUDE)
  const lz = Math.sin(LIGHT_ALTITUDE)
  const nx = -dzdx * VERTICAL_EXAGGERATION
  const ny = -dzdy * VERTICAL_EXAGGERATION
  const lit = (nx * lx + ny * ly + lz) / Math.hypot(nx, ny, 1)
  return lit / lz // flat ground keeps its base colour
}

// Lowland plains read greener and raised ground (plateaus, fans) more tan, so
// plateaus stand out from the valleys cut into them.
const LOWLAND_TINT_M = [10, 40] as const

function elevationTint(rgb: [number, number, number], kind: TileKind, heightM: number): [number, number, number] {
  if (kind !== 'plain') return rgb
  const [lo, hi] = LOWLAND_TINT_M
  const t = Math.max(0, Math.min(1, (heightM - lo) / (hi - lo)))
  const lowland: [number, number, number] = [178, 210, 150]
  const upland: [number, number, number] = [214, 210, 160]
  return [0, 1, 2].map((c) => lowland[c] + (upland[c] - lowland[c]) * t) as [number, number, number]
}

// The terrain never changes for a seed, so it is drawn once into a 1px-per-tile image.
function terrainImage(world: World): HTMLCanvasElement {
  const { size, kind, height } = world.terrain
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(size, size)
  const at = (x: number, y: number) => height[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))]
  for (let i = 0; i < size * size; i++) {
    const [r, g, b] = elevationTint(TERRAIN_RGB[kind[i]], kind[i], height[i])
    const x = i % size
    const y = Math.floor(i / size)
    const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * TILE_SPAN_M)
    const dzdy = (at(x, y + 1) - at(x, y - 1)) / (2 * TILE_SPAN_M)
    const shade = kind[i] === 'sea' ? 1 : Math.max(0.4, Math.min(1.3, hillshade(dzdx, dzdy)))
    image.data[i * 4] = Math.min(255, r * shade)
    image.data[i * 4 + 1] = Math.min(255, g * shade)
    image.data[i * 4 + 2] = Math.min(255, b * shade)
    image.data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

function drawOverlay(ctx: CanvasRenderingContext2D, world: World, overlay: Overlay, px: number) {
  const chunkPx = CHUNK_TILES * px
  if (overlay === 'population' || overlay === 'landValue') {
    const values = world.chunks.map((c) => (overlay === 'population' ? c.pop : c.lv))
    const max = Math.max(1, ...values)
    world.chunks.forEach((c, i) => {
      const alpha = 0.6 * (values[i] / max)
      ctx.fillStyle = overlay === 'population' ? `rgba(220, 38, 38, ${alpha})` : `rgba(234, 179, 8, ${alpha})`
      ctx.fillRect(c.cx * chunkPx, c.cy * chunkPx, chunkPx, chunkPx)
    })
  }
  if (overlay === 'traffic') {
    const T = PARAMS.traffic
    ctx.lineCap = 'round'
    for (const e of world.roads) {
      const a = world.chunks[e.a]
      const b = world.chunks[e.b]
      const vph = (e.dailyPersons / T.carOccupancy) * T.peakHourShare * 0.5
      const load = Math.min(1.5, vph / e.capacityVph)
      ctx.strokeStyle = load < 0.6 ? '#22c55e' : load < 1 ? '#eab308' : '#dc2626'
      ctx.lineWidth = e.arterial ? 4 : 2
      ctx.beginPath()
      ctx.moveTo((a.cx + 0.5) * chunkPx, (a.cy + 0.5) * chunkPx)
      ctx.lineTo((b.cx + 0.5) * chunkPx, (b.cy + 0.5) * chunkPx)
      ctx.stroke()
    }
  }
}

function drawProperty(ctx: CanvasRenderingContext2D, world: World, px: number) {
  for (const [key, parcel] of Object.entries(world.parcels)) {
    if (parcel.station) continue
    const [x, y] = key.split(',').map(Number)
    ctx.strokeStyle = OWNER_COLOR[parcel.owner] ?? '#000'
    ctx.lineWidth = 2
    ctx.strokeRect(x * px + 1, y * px + 1, px - 2, px - 2)
  }
  for (const b of world.buildings) {
    if (b.status === 'sold') continue
    ctx.globalAlpha = b.status === 'construction' ? 0.45 : 1
    ctx.fillStyle = USE_COLOR[b.use]
    ctx.fillRect(b.x * px + 2, b.y * px + 2, px - 4, px - 4)
    ctx.globalAlpha = 1
  }
}

function drawStations(ctx: CanvasRenderingContext2D, stations: Station[], px: number, color: string, dashed: boolean) {
  const center = (s: Station): [number, number] => [(s.x + 0.5) * px, (s.y + 0.5) * px]
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.setLineDash(dashed ? [6, 4] : [])
  ctx.beginPath()
  stations.forEach((s, i) => {
    const [x, y] = center(s)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
  ctx.setLineDash([])
  for (const s of stations) {
    const [x, y] = center(s)
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x, y, s.express ? 5 : 3.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}

function drawLabels(ctx: CanvasRenderingContext2D, world: World, px: number) {
  ctx.font = '600 12px system-ui, sans-serif'
  ctx.textAlign = 'center'
  for (const city of world.cities) {
    const x = (city.x + 0.5) * px
    const y = (city.y + 0.5) * px - 10
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.strokeText(city.name, x, y)
    ctx.fillStyle = '#111'
    ctx.fillText(city.name, x, y)
  }
}

export function MapCanvas({ world, revision, overlay, draft, selected, onTileClick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const terrainRef = useRef<{ seed: number; image: HTMLCanvasElement } | null>(null)
  const [width, setWidth] = useState(640)

  // Follow the container's width; stop observing when the map unmounts.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = world.terrain.size
    const px = width / size
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(width * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    if (terrainRef.current?.seed !== world.seed) terrainRef.current = { seed: world.seed, image: terrainImage(world) }
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(terrainRef.current.image, 0, 0, width, width)

    drawOverlay(ctx, world, overlay, px)
    drawProperty(ctx, world, px)
    for (const line of world.lines) {
      const color = OWNER_COLOR[line.owner] ?? '#000'
      drawStations(ctx, line.stations, px, color, line.stage !== 'open')
    }
    if (draft.length > 0) drawStations(ctx, draft, px, '#111', true)
    drawLabels(ctx, world, px)
    if (selected) {
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 2
      ctx.strokeRect(selected.x * px, selected.y * px, px, px)
    }
  }, [world, revision, overlay, draft, selected, width])

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const px = rect.width / world.terrain.size
    const x = Math.floor((event.clientX - rect.left) / px)
    const y = Math.floor((event.clientY - rect.top) / px)
    if (x >= 0 && y >= 0 && x < world.terrain.size && y < world.terrain.size) onTileClick({ x, y })
  }

  return (
    <div ref={wrapRef} className="w-full">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ width, height: width }}
        className="block cursor-crosshair border border-border"
        aria-label="地域の地図"
      />
    </div>
  )
}
