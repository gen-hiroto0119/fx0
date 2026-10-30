'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/button'
import {
  applyForLine,
  borrow,
  buyLand,
  chunkAt,
  createWorld,
  develop,
  firmReport,
  gameDate,
  grantLine,
  PARAMS,
  planLine,
  projectCost,
  setExpressStops,
  setService,
  startConstruction,
  step,
  TILE_AREA_M2,
  type BuildingUse,
  type Service,
  type Station,
  type World,
} from '@/lib/sim'
import { errorLabel, formatOku, USE_LABEL } from './format'
import { MapCanvas, type Overlay, type Tile } from './map-canvas'
import { FinancePanel, LinePanel, NewsPanel, Section, TileInfo } from './panels'
import { clearSave, loadWorld, saveWorld } from './storage'

const PLAYER = 'player'
const DEFAULT_SEED = 42
const PLAY_INTERVAL_MS = 400

type Tool = 'inspect' | 'buy' | 'line' | 'develop'
type DevelopPlan = { use: BuildingUse; farShare: number; mode: 'lease' | 'sale' }

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'inspect', label: '調べる' },
  { id: 'buy', label: '土地を買う' },
  { id: 'line', label: '路線を引く' },
  { id: 'develop', label: '建てる' },
]

const OVERLAYS: { id: Overlay; label: string }[] = [
  { id: 'none', label: 'なし' },
  { id: 'population', label: '人口' },
  { id: 'landValue', label: '地価' },
  { id: 'traffic', label: '道路の混雑' },
]

// The most floor the zoning allows on one tile, scaled by the chosen share.
function plannedFloor(world: World, tile: Tile, plan: DevelopPlan): number {
  const c = chunkAt(world, tile.x, tile.y)
  const far = plan.use === 'station' ? PARAMS.realEstate.stationBuildingFar : c.zoneFar[plan.use]
  return Math.round(far * TILE_AREA_M2 * plan.farShare)
}

export default function Game() {
  const [world, setWorld] = useState<World>(() => loadWorld() ?? createWorld(DEFAULT_SEED))
  // The simulation changes the world in place; bumping this re-renders the views.
  const [revision, setRevision] = useState(0)
  const [tool, setTool] = useState<Tool>('inspect')
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [selected, setSelected] = useState<Tile | null>(null)
  const [draft, setDraft] = useState<Station[]>([])
  const [developPlan, setDevelopPlan] = useState<DevelopPlan>({ use: 'res', farShare: 0.5, mode: 'sale' })
  const [projectLoan, setProjectLoan] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const commit = useCallback(
    (note?: string) => {
      saveWorld(world)
      setRevision((r) => r + 1)
      if (note !== undefined) setMessage(note)
    },
    [world],
  )

  const advance = useCallback(
    (weeks: number) => {
      for (let i = 0; i < weeks; i++) {
        if (world.firms.find((f) => f.id === PLAYER)?.bankrupt) {
          setPlaying(false)
          break
        }
        step(world)
      }
      commit()
    },
    [world, commit],
  )

  // Auto-play runs one tick per interval until paused or the component unmounts.
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => advance(1), PLAY_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [playing, advance])

  const handleTileClick = (tile: Tile) => {
    setSelected(tile)
    if (tool === 'buy') {
      const result = buyLand(world, PLAYER, tile.x, tile.y)
      commit(result.ok ? `土地を${formatOku(result.value)}で買いました` : errorLabel(result.error))
      return
    }
    if (tool === 'line') {
      const last = draft[draft.length - 1]
      if (last && last.x === tile.x && last.y === tile.y) return
      setDraft([...draft, { x: tile.x, y: tile.y, express: false }])
      return
    }
    if (tool === 'develop') {
      const floor = plannedFloor(world, tile, developPlan)
      const result = develop(world, PLAYER, tile.x, tile.y, developPlan.use, floor, developPlan.mode)
      commit(result.ok ? `${USE_LABEL[developPlan.use]}(${floor.toLocaleString('ja-JP')}㎡)に着工しました` : errorLabel(result.error))
    }
  }

  const confirmLine = () => {
    const name = `${world.lines.filter((l) => l.owner === PLAYER).length + 1}号線`
    const planned = planLine(world, PLAYER, name, draft)
    if (!planned.ok) {
      setMessage(errorLabel(planned.error))
      return
    }
    // Permits are granted at once until the AI mayors arrive (M3).
    const line = planned.value
    applyForLine(world, PLAYER, line.id)
    grantLine(world, line.id)
    if (projectLoan) {
      const loan = borrow(world, PLAYER, { amount: projectCost(line) * 0.7, years: 20, graceYears: 3, lineId: line.id })
      if (!loan.ok) setMessage(errorLabel(loan.error))
    }
    startConstruction(world, PLAYER, line.id)
    setDraft([])
    commit(`${name}に着工しました(建設費${formatOku(line.cost)}、工期${line.buildTicksLeft}週)`)
  }

  const applyService = (lineId: string, service: Service, expressStops: number[]) => {
    const stops = setExpressStops(world, PLAYER, lineId, expressStops)
    const result = stops.ok ? setService(world, PLAYER, lineId, service) : stops
    commit(result.ok ? '運行計画を反映しました' : errorLabel(result.error))
  }

  const borrowCash = (amountOku: number, years: number) => {
    const result = borrow(world, PLAYER, { amount: amountOku * 100_000_000, years })
    commit(result.ok ? `${amountOku}億円を借りました` : errorLabel(result.error))
  }

  const newGame = () => {
    if (!window.confirm('今のゲームを消して最初からやり直しますか?')) return
    clearSave()
    setPlaying(false)
    setDraft([])
    setSelected(null)
    const next = createWorld(Math.floor(Math.random() * 1_000_000))
    saveWorld(next)
    setWorld(next)
    setMessage('新しい地域を作りました')
  }

  const report = firmReport(world, PLAYER)

  return (
    <main className="mx-auto max-w-6xl p-4">
      <header className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        <h1 className="text-lg font-semibold">Emporion</h1>
        <span className="tabular-nums">{gameDate(world.tick).label}</span>
        {report ? (
          <span className="text-sm text-muted-foreground tabular-nums">
            現金 {formatOku(report.cash)}・借入 {formatOku(report.debt)}・格付け {report.rating}・時価総額 {formatOku(report.marketCap)}
            {report.bankrupt ? '・倒産' : ''}
          </span>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => advance(1)}>
            1週進める
          </Button>
          <Button size="sm" variant="outline" onClick={() => advance(13)}>
            3か月進める
          </Button>
          <Button size="sm" onClick={() => setPlaying(!playing)}>
            {playing ? '一時停止' : '自動で進める'}
          </Button>
          <Button size="sm" variant="ghost" onClick={newGame}>
            最初から
          </Button>
        </div>
      </header>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-2">
          <MapCanvas
            world={world}
            revision={revision}
            overlay={overlay}
            draft={draft}
            selected={selected}
            onTileClick={handleTileClick}
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">表示:</span>
            {OVERLAYS.map((o) => (
              <Button key={o.id} size="sm" variant={overlay === o.id ? 'secondary' : 'ghost'} onClick={() => setOverlay(o.id)}>
                {o.label}
              </Button>
            ))}
          </div>
          {message ? (
            <p role="status" className="text-sm">
              {message}
            </p>
          ) : null}
        </div>

        <aside className="space-y-4">
          <Section title="操作">
            <div className="flex flex-wrap gap-2">
              {TOOLS.map((t) => (
                <Button key={t.id} size="sm" variant={tool === t.id ? 'default' : 'outline'} onClick={() => setTool(t.id)}>
                  {t.label}
                </Button>
              ))}
            </div>
            {tool === 'line' ? (
              <div className="mt-3 space-y-2 text-sm">
                <p className="text-muted-foreground">地図をクリックして駅を順に置きます。置いた駅: {draft.length}</p>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={projectLoan} onChange={(e) => setProjectLoan(e.target.checked)} />
                  建設費と車両費の70%をプロジェクト融資で借りる(20年・据置3年)
                </label>
                <div className="flex gap-2">
                  <Button size="sm" onClick={confirmLine} disabled={draft.length < 2}>
                    この路線で着工
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDraft([])} disabled={draft.length === 0}>
                    やり直す
                  </Button>
                </div>
              </div>
            ) : null}
            {tool === 'develop' ? (
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <label>
                  用途
                  <select
                    value={developPlan.use}
                    onChange={(e) => setDevelopPlan({ ...developPlan, use: e.target.value as BuildingUse })}
                    className="mt-0.5 block w-full border border-input bg-background px-1 py-1 text-sm text-foreground"
                  >
                    {(['res', 'office', 'retail', 'station'] as const).map((u) => (
                      <option key={u} value={u}>
                        {USE_LABEL[u]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  容積率の使用
                  <select
                    value={developPlan.farShare}
                    onChange={(e) => setDevelopPlan({ ...developPlan, farShare: Number(e.target.value) })}
                    className="mt-0.5 block w-full border border-input bg-background px-1 py-1 text-sm text-foreground"
                  >
                    <option value={0.25}>25%</option>
                    <option value={0.5}>50%</option>
                    <option value={1}>100%</option>
                  </select>
                </label>
                <label>
                  売り方
                  <select
                    value={developPlan.mode}
                    onChange={(e) => setDevelopPlan({ ...developPlan, mode: e.target.value as DevelopPlan['mode'] })}
                    className="mt-0.5 block w-full border border-input bg-background px-1 py-1 text-sm text-foreground"
                  >
                    <option value="sale">分譲</option>
                    <option value="lease">賃貸</option>
                  </select>
                </label>
                <p className="col-span-3">自社の土地をクリックすると着工します。</p>
              </div>
            ) : null}
          </Section>
          <Section title="選択中のマス">
            <TileInfo world={world} tile={selected} />
          </Section>
          <Section title="路線">
            <LinePanel world={world} onApplyService={applyService} />
          </Section>
          <Section title="財務">
            <FinancePanel world={world} onBorrow={borrowCash} />
          </Section>
          <Section title="ニュース">
            <NewsPanel world={world} />
          </Section>
        </aside>
      </div>
    </main>
  )
}
