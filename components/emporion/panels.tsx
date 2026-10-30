'use client'

import { useState } from 'react'
import { Button } from '../ui/button'
import {
  chunkAt,
  firmReport,
  landPrice,
  lineKm,
  lvAtTile,
  type BuildingUse,
  type Line,
  type Service,
  type World,
} from '@/lib/sim'
import { formatCount, formatOku, formatYenPerM2, TILE_KIND_LABEL, USE_LABEL } from './format'
import type { Tile } from './map-canvas'

const PLAYER = 'player'

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-3">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

// --- Selected tile ---

const STAGE_LABEL: Record<Line['stage'], string> = {
  planned: '計画中',
  applied: '申請中',
  approved: '許可済み',
  construction: '工事中',
  open: '営業中',
}

export function TileInfo({ world, tile }: { world: World; tile: Tile | null }) {
  if (!tile) return <p className="text-sm text-muted-foreground">地図のマスをクリックすると詳細が出ます。</p>
  const { x, y } = tile
  const kind = world.terrain.kind[y * world.terrain.size + x]
  const chunk = chunkAt(world, x, y)
  const city = world.cities.find((c) => c.id === chunk.cityId)
  const parcel = world.parcels[`${x},${y}`]
  const building = world.buildings.find((b) => b.x === x && b.y === y && b.status !== 'sold')
  const jobs = chunk.jobs.office + chunk.jobs.retail + chunk.jobs.industry
  return (
    <div className="space-y-1">
      <Row label="位置" value={`(${x}, ${y}) ${TILE_KIND_LABEL[kind]}`} />
      <Row label="地区" value={city ? city.name : '郊外'} />
      <Row label="地区の人口 / 雇用" value={`${formatCount(chunk.pop)} / ${formatCount(jobs)}`} />
      <Row label="地価" value={formatYenPerM2(lvAtTile(world, x, y))} />
      <Row label="この土地の価格" value={parcel ? '—' : formatOku(landPrice(world, PLAYER, x, y))} />
      <Row label="所有" value={parcel ? (parcel.station ? '駅' : parcel.owner === PLAYER ? '自社' : '他社') : '個人'} />
      {building ? (
        <Row
          label="建物"
          value={`${USE_LABEL[building.use]} ${formatCount(building.floorArea)}㎡ (${building.status === 'construction' ? `工事中 残り${building.ticksLeft}週` : building.status === 'selling' ? '分譲中' : `入居${Math.round(building.occupancy * 100)}%`})`}
        />
      ) : null}
    </div>
  )
}

// --- Lines ---

const SERVICE_FIELDS: { key: keyof Service; label: string; step: number }[] = [
  { key: 'localPeak', label: '各停 ピーク(本/時)', step: 1 },
  { key: 'localOff', label: '各停 日中(本/時)', step: 1 },
  { key: 'expressPeak', label: '快速 ピーク(本/時)', step: 1 },
  { key: 'expressOff', label: '快速 日中(本/時)', step: 1 },
  { key: 'cars', label: '編成(両)', step: 1 },
  { key: 'fareMult', label: '運賃倍率', step: 0.05 },
]

function ServiceForm({ line, onApply }: { line: Line; onApply: (service: Service, expressStops: number[]) => void }) {
  const [service, setService] = useState<Service>(line.service)
  const [express, setExpress] = useState<number[]>(
    line.stations.flatMap((s, i) => (s.express && i > 0 && i < line.stations.length - 1 ? [i] : [])),
  )
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        onApply(service, express)
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        {SERVICE_FIELDS.map((f) => (
          <label key={f.key} className="text-xs text-muted-foreground">
            {f.label}
            <input
              type="number"
              step={f.step}
              value={service[f.key]}
              onChange={(event) => setService({ ...service, [f.key]: Number(event.target.value) })}
              className="mt-0.5 block w-full border border-input bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
        ))}
      </div>
      <fieldset className="text-xs text-muted-foreground">
        <legend>快速停車駅(始発・終点は必ず停車)</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {line.stations.slice(1, -1).map((_, k) => {
            const i = k + 1
            return (
              <label key={i} className="flex items-center gap-1 text-foreground">
                <input
                  type="checkbox"
                  checked={express.includes(i)}
                  onChange={(event) => setExpress(event.target.checked ? [...express, i] : express.filter((v) => v !== i))}
                />
                駅{i + 1}
              </label>
            )
          })}
        </div>
      </fieldset>
      <Button type="submit" size="sm" variant="outline">
        運行計画を反映
      </Button>
    </form>
  )
}

export function LinePanel({
  world,
  onApplyService,
}: {
  world: World
  onApplyService: (lineId: string, service: Service, expressStops: number[]) => void
}) {
  const lines = world.lines.filter((l) => l.owner === PLAYER)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = lines.find((l) => l.id === selectedId) ?? null
  if (lines.length === 0) return <p className="text-sm text-muted-foreground">まだ路線がありません。「路線を引く」で駅を置いてください。</p>
  return (
    <div className="space-y-3">
      {lines.map((line) => (
        <button
          key={line.id}
          type="button"
          onClick={() => setSelectedId(line.id === selectedId ? null : line.id)}
          className="block w-full border border-border p-2 text-left hover:bg-accent"
        >
          <div className="flex justify-between text-sm font-medium">
            <span>{line.name}</span>
            <span className="text-muted-foreground">
              {STAGE_LABEL[line.stage]}
              {line.stage === 'construction' ? ` 残り${line.buildTicksLeft}週` : ''}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {lineKm(line).toFixed(1)}km・{line.stations.length}駅・建設費{formatOku(line.cost)}
            {line.stage === 'open'
              ? `・乗客${formatCount(line.stats.dailyRiders)}人/日・混雑率${Math.round(line.stats.peakLoadRatio * 100)}%`
              : ''}
          </div>
        </button>
      ))}
      {selected ? (
        <ServiceForm
          key={selected.id}
          line={selected}
          onApply={(service, express) => onApplyService(selected.id, service, express)}
        />
      ) : null}
    </div>
  )
}

// --- Finance ---

export function FinancePanel({
  world,
  onBorrow,
}: {
  world: World
  onBorrow: (amountOku: number, years: number) => void
}) {
  const [amount, setAmount] = useState(50)
  const [years, setYears] = useState(10)
  const report = firmReport(world, PLAYER)
  if (!report) return null
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Row label="鉄道 営業収支(直近1年)" value={formatOku(report.rail.profit)} />
        <Row label="不動産 収支(直近1年)" value={formatOku(report.realEstate.profit)} />
        <Row label="支払利息(直近1年)" value={formatOku(report.interest)} />
        <Row label="純利益(直近1年)" value={formatOku(report.netIncome)} />
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          onBorrow(amount, years)
        }}
      >
        <label className="text-xs text-muted-foreground">
          借入額(億円)
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(event) => setAmount(Number(event.target.value))}
            className="mt-0.5 block w-24 border border-input bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          期間
          <select
            value={years}
            onChange={(event) => setYears(Number(event.target.value))}
            className="mt-0.5 block border border-input bg-background px-2 py-1 text-sm text-foreground"
          >
            <option value={5}>5年</option>
            <option value={10}>10年</option>
            <option value={20}>20年</option>
          </select>
        </label>
        <Button type="submit" size="sm" variant="outline">
          借りる
        </Button>
      </form>
    </div>
  )
}

// --- News ---

const EVENT_LABEL: Record<string, string> = {
  line_applied: '路線を申請',
  line_approved: '路線が許可',
  line_opened: '路線が開業',
  building_completed: '建物が竣工',
  land_rumor: '買い集めの噂',
  rating_changed: '格付けが変更',
  overdraft: '当座借越を実行',
  forced_sale: '資産を強制売却',
  bankrupt: '倒産',
}

export function NewsPanel({ world }: { world: World }) {
  const recent = world.events.slice(-8).reverse()
  if (recent.length === 0) return <p className="text-sm text-muted-foreground">まだニュースはありません。</p>
  return (
    <ul className="space-y-1 text-sm">
      {recent.map((e, i) => (
        <li key={`${e.tick}-${i}`} className="flex gap-2">
          <span className="w-12 shrink-0 text-muted-foreground tabular-nums">{e.tick}週</span>
          <span>
            {e.actor && e.actor !== PLAYER ? `${world.firms.find((f) => f.id === e.actor)?.name ?? e.actor}: ` : ''}
            {EVENT_LABEL[e.type] ?? e.type}
            {e.type === 'rating_changed' && e.payload ? ` ${String(e.payload.from)}→${String(e.payload.to)}` : ''}
            {e.type === 'building_completed' && e.payload ? `(${USE_LABEL[e.payload.use as BuildingUse]})` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
