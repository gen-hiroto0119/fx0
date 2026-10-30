'use client'

import { useState } from 'react'
import { Button } from '../ui/button'
import {
  CONDITION_KINDS,
  chunkAt,
  firmReport,
  landPrice,
  lineKm,
  lvAtTile,
  type BuildingUse,
  type ConditionKind,
  type Line,
  type Offer,
  type Permit,
  type Service,
  type World,
} from '@/lib/sim'
import {
  CONDITION_KIND_LABEL,
  conditionText,
  COVER_LABEL,
  formatCount,
  formatOku,
  formatYenPerM2,
  PERSONA_LABEL,
  TILE_KIND_LABEL,
  USE_LABEL,
} from './format'
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
  const cover = world.terrain.cover[y * world.terrain.size + x]
  const chunk = chunkAt(world, x, y)
  const city = world.cities.find((c) => c.id === chunk.cityId)
  const parcel = world.parcels[`${x},${y}`]
  const building = world.buildings.find((b) => b.x === x && b.y === y && b.status !== 'sold')
  const jobs = chunk.jobs.office + chunk.jobs.retail + chunk.jobs.industry
  return (
    <div className="space-y-1">
      <Row label="位置" value={`(${x}, ${y}) ${TILE_KIND_LABEL[kind]}`} />
      <Row label="土地被覆" value={`${COVER_LABEL[cover]}・標高${Math.round(world.terrain.height[y * world.terrain.size + x])}m`} />
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

const PERMIT_LABEL: Record<Permit['status'], string> = {
  reviewing: '審査中',
  negotiating: '交渉中',
  approved: '許可',
  rejected: '却下',
  withdrawn: '取り下げ',
}

const OKU_YEN = 100_000_000

// One round of negotiation: start from the mayor's ask and change what to promise.
function NegotiationForm({ permit, onOffer }: { permit: Permit; onOffer: (offer: Offer) => void }) {
  const askedPlaza = permit.ask.find((c) => c.kind === 'plaza')
  const [kinds, setKinds] = useState<ConditionKind[]>(permit.ask.map((c) => c.kind))
  const [plazaOku, setPlazaOku] = useState(askedPlaza?.kind === 'plaza' ? askedPlaza.yen / OKU_YEN : 0)
  return (
    <form
      className="mt-1 space-y-1"
      onSubmit={(event) => {
        event.preventDefault()
        onOffer({ kinds, plazaYen: plazaOku * OKU_YEN })
      }}
    >
      <p className="text-xs text-muted-foreground">市長の要求(第{permit.round}ラウンド): {permit.ask.map(conditionText).join('、')}</p>
      {CONDITION_KINDS.map((kind) => (
        <label key={kind} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={kinds.includes(kind)}
            onChange={(e) => setKinds(e.target.checked ? [...kinds, kind] : kinds.filter((k) => k !== kind))}
          />
          {CONDITION_KIND_LABEL[kind]}
          {kind === 'plaza' ? (
            <input
              type="number"
              min={0}
              step={5}
              value={plazaOku}
              onChange={(e) => setPlazaOku(Number(e.target.value))}
              className="w-16 border border-input bg-background px-1 text-xs"
              aria-label="負担額(億円)"
            />
          ) : null}
          {kind === 'plaza' ? '億円' : null}
        </label>
      ))}
      <Button type="submit" size="sm" variant="outline">
        この条件で提案
      </Button>
    </form>
  )
}

function PermitList({ world, line, onNegotiate }: { world: World; line: Line; onNegotiate: (permitId: string, offer: Offer) => void }) {
  const permits = world.permits.filter((p) => p.lineId === line.id && p.status !== 'withdrawn')
  return (
    <ul className="mt-2 space-y-2 text-sm">
      {permits.map((p) => {
        const city = world.cities.find((c) => c.id === p.cityId)
        return (
          <li key={p.id}>
            <div className="flex justify-between">
              <span>{city?.name}</span>
              <span className="text-muted-foreground">
                {PERMIT_LABEL[p.status]}
                {p.status === 'reviewing' ? ` あと${Math.max(0, p.decideTick - world.tick)}週` : ''}
              </span>
            </div>
            {p.status === 'negotiating' ? <NegotiationForm key={p.round} permit={p} onOffer={(offer) => onNegotiate(p.id, offer)} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

export function LinePanel({
  world,
  onApplyService,
  onStart,
  onNegotiate,
  onWithdraw,
}: {
  world: World
  onApplyService: (lineId: string, service: Service, expressStops: number[]) => void
  onStart: (lineId: string) => void
  onNegotiate: (permitId: string, offer: Offer) => void
  onWithdraw: (lineId: string) => void
}) {
  const lines = world.lines.filter((l) => l.owner === PLAYER)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = lines.find((l) => l.id === selectedId) ?? null
  if (lines.length === 0) return <p className="text-sm text-muted-foreground">まだ路線がありません。「路線を引く」で駅を置いてください。</p>
  return (
    <div className="space-y-3">
      {lines.map((line) => (
        <div key={line.id} className="border border-border p-2">
          <button type="button" onClick={() => setSelectedId(line.id === selectedId ? null : line.id)} className="block w-full text-left">
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
          {line.stage === 'applied' ? (
            <>
              <PermitList world={world} line={line} onNegotiate={onNegotiate} />
              <Button size="sm" variant="ghost" onClick={() => onWithdraw(line.id)}>
                申請を取り下げる
              </Button>
            </>
          ) : null}
          {line.stage === 'approved' ? (
            <Button size="sm" className="mt-2" onClick={() => onStart(line.id)}>
              着工する
            </Button>
          ) : null}
        </div>
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

// --- Mayors ---

export function MayorPanel({ world }: { world: World }) {
  const deals = world.deals.filter((d) => d.firm === PLAYER && d.status === 'active')
  return (
    <div className="space-y-2">
      {world.cities.map((city) => (
        <Row
          key={city.id}
          label={`${city.name}(${PERSONA_LABEL[city.persona]})`}
          value={`関係 ${Math.round(city.relation[PLAYER] ?? 0)}`}
        />
      ))}
      {deals.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {deals.map((d) => (
            <li key={d.id}>
              {world.cities.find((c) => c.id === d.cityId)?.name}との約束: {conditionText(d.condition)}
            </li>
          ))}
        </ul>
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
  permit_negotiating: '市長が条件を求めてきた',
  permit_agreed: '条件付きで許可',
  permit_rejected: '申請が却下',
  line_rejected: '路線が計画に差し戻し',
  deal_broken: '約束を破った',
  rival_move: '',
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
            {e.type === 'rival_move' && e.payload ? String(e.payload.reason) : ''}
            {e.payload?.city ? `(${world.cities.find((c) => c.id === e.payload?.city)?.name})` : ''}
            {e.type === 'rating_changed' && e.payload ? ` ${String(e.payload.from)}→${String(e.payload.to)}` : ''}
            {e.type === 'building_completed' && e.payload ? `(${USE_LABEL[e.payload.use as BuildingUse]})` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
