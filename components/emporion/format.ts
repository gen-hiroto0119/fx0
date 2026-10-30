import { OKU, type BuildingUse, type TileKind } from '@/lib/sim'

export function formatOku(yen: number): string {
  return `${(yen / OKU).toLocaleString('ja-JP', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}億円`
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('ja-JP')
}

export function formatYenPerM2(yen: number): string {
  return `${Math.round(yen).toLocaleString('ja-JP')}円/㎡`
}

export const TILE_KIND_LABEL: Record<TileKind, string> = {
  sea: '海',
  plain: '平地',
  hill: '丘陵',
  forest: '森林',
  river: '川',
  mountain: '山地',
}

export const USE_LABEL: Record<BuildingUse, string> = {
  res: '住宅',
  office: 'オフィス',
  retail: '商業',
  industry: '工場',
  station: '駅ビル',
}

export const ERROR_LABEL: Record<string, string> = {
  out_of_bounds: '地図の外です',
  not_buildable: 'この地形には建てられません',
  already_owned: 'すでに所有者がいます',
  insufficient_cash: '資金が足りません',
  unknown_firm: '会社が見つかりません',
  need_two_stations: '駅を2つ以上置いてください',
  station_not_buildable: '駅を置けない地形があります',
  station_on_others_land: '他社の土地に駅は置けません',
  unknown_line: '路線が見つかりません',
  wrong_stage: '今の段階ではできません',
  fare_out_of_range: '運賃は標準の70%〜130%の範囲です',
  cars_out_of_range: '編成は1〜12両です',
  frequency_out_of_range: '本数は1時間あたり0〜30本です',
  not_your_land: '自社の土地ではありません',
  already_built: 'すでに建物があります',
  only_housing_for_sale: '分譲できるのは住宅だけです',
  station_building_needs_own_station: '駅ビルは自社の駅の隣にだけ建てられます',
  zoning_forbids_use: 'この用途は用途地域で認められていません',
  exceeds_far: '容積率を超えています',
  unknown_building: '建物が見つかりません',
  not_operating: '稼働中の建物ではありません',
  invalid_amount: '金額が正しくありません',
  invalid_term: '期間は5年・10年・20年から選びます',
  invalid_grace: '据置は0〜3年です',
  line_not_approved: '許可された路線ではありません',
  exceeds_project_share: '融資は建設費と車両費の70%までです',
  grace_only_for_projects: '据置はプロジェクト融資だけです',
  exceeds_collateral: '担保が足りません',
  exceeds_debt_service: '返済能力を超えています',
}

export function errorLabel(code: string): string {
  return ERROR_LABEL[code] ?? code
}
