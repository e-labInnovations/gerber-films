// Films (what to print) + sheet settings -> pages with placed tiles.
import { unionBounds, type Bounds } from './geometry'
import type { Layer } from './load'

export interface Film {
  id: string
  enabled: boolean
  name: string
  layerId: string
  mirror: boolean
  negative: boolean
  drillDots: boolean
  outline: boolean
  copies: number
}

export type PageSize = 'A4' | 'A3' | 'Letter' | 'Legal' | 'custom'

/** Edge of the page, then which end of that edge. Left/right bars run vertically. */
export type ScaleBarPos =
  | 'bottom-left'
  | 'bottom-right'
  | 'top-left'
  | 'top-right'
  | 'left-top'
  | 'left-bottom'
  | 'right-top'
  | 'right-bottom'

export interface Settings {
  page: PageSize
  customW: number
  customH: number
  landscape: boolean
  margin: number
  gapX: number
  gapY: number
  columns: number // 0 = as many as fit
  order: 'pairs' | 'grouped'
  rotate: boolean
  tileMargin: number
  foldLine: boolean
  marks: boolean
  labels: boolean
  scaleBar: boolean
  scaleBarPos: ScaleBarPos
  dotSize: number
}

export const DEFAULT_SETTINGS: Settings = {
  page: 'A4',
  customW: 210,
  customH: 297,
  landscape: false,
  margin: 6,
  gapX: 12,
  gapY: 12,
  columns: 0,
  order: 'pairs',
  rotate: false,
  tileMargin: 2,
  foldLine: true,
  marks: true,
  labels: true,
  scaleBar: true,
  scaleBarPos: 'bottom-left',
  dotSize: 0.4,
}

const PAGES: Record<Exclude<PageSize, 'custom'>, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
}

/** Space the extras need outside the grid of boards (mm). Kept in sync with render.ts. */
export const MARK_OFF = 3
export const MARK_LEN = 4
const LABEL_REACH = MARK_OFF + 3

/**
 * Distance of the registration crosses from a tile edge. Normally MARK_OFF, but never more than half
 * the gap: with a narrow gap neighbouring tiles then share one cross in the middle of the gap instead
 * of their crosses passing each other (which makes a board look off-centre).
 */
export function markOffset(gap: number): number {
  return Math.min(MARK_OFF, Math.max(0.5, gap / 2))
}
export const SCALE_BAR = 6

/** Affine map [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number]

export interface Tile {
  film: Film
  x: number
  y: number
  w: number
  h: number
  m: Mat
}

export interface Page {
  w: number
  h: number
  tiles: Tile[]
  /** x positions of fold lines, each between the two tiles of a pair */
  folds: number[]
  /** registration cross offsets from the tile edges, across and down */
  markX: number
  markY: number
}

export interface Layout {
  pages: Page[]
  board: Bounds | null
  tileW: number
  tileH: number
  cols: number
  rows: number
  warnings: string[]
}

export function pageSize(s: Settings): [number, number] {
  const [w, h] = s.page === 'custom' ? [s.customW, s.customH] : PAGES[s.page]
  return s.landscape ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)]
}

export function mul(p: Mat, q: Mat): Mat {
  // p after q
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ]
}

/** Board frame shared by every film so that top and bottom copies register: the outline if present. */
export function boardBounds(layers: Layer[]): Bounds | null {
  const outline = layers.find((l) => l.type === 'outline' && l.bounds)
  return outline?.bounds ?? unionBounds(layers.map((l) => l.bounds))
}

export function layout(films: Film[], layers: Layer[], s: Settings): Layout {
  const warnings: string[] = []
  const [W, H] = pageSize(s)
  const board = boardBounds(layers)
  const active = films.filter((f) => f.enabled && f.copies > 0 && layers.some((l) => l.id === f.layerId))
  if (!board || !active.length) return { pages: [], board, tileW: 0, tileH: 0, cols: 0, rows: 0, warnings }

  const bw = board.x1 - board.x0 + 2 * s.tileMargin
  const bh = board.y1 - board.y0 + 2 * s.tileMargin
  const [tw, th] = s.rotate ? [bh, bw] : [bw, bh]
  // keep crosses, labels and the check bar on the page and off each other
  const markX = markOffset(s.gapX)
  const markY = markOffset(s.gapY)
  const edgeX = s.marks ? markX + MARK_LEN / 2 : 0
  const bar = (edge: string) => (s.scaleBar && s.scaleBarPos.startsWith(edge) ? SCALE_BAR : 0)
  const left = edgeX + bar('left')
  const right = edgeX + bar('right')
  const top = (s.marks ? markY + MARK_LEN / 2 : 0) + bar('top')
  const bottom = Math.max(s.marks ? markY + MARK_LEN / 2 : 0, s.labels ? LABEL_REACH : 0) + bar('bottom')
  const availW = W - 2 * s.margin - left - right
  const availH = H - 2 * s.margin - top - bottom
  const fitCols = Math.floor((availW + s.gapX) / (tw + s.gapX))
  const rows = Math.floor((availH + s.gapY) / (th + s.gapY))
  const foldPairs = s.foldLine && s.order === 'pairs' && active.length === 2
  // auto columns: as many as fit; for fold pairs, as many whole pairs as fit
  let cols = s.columns > 0 ? s.columns : foldPairs && fitCols >= 2 ? fitCols - (fitCols % 2) : fitCols
  if (fitCols < 1 || rows < 1) {
    warnings.push('The board does not fit on this page with these margins. Try a bigger page, landscape or rotation.')
    return { pages: [], board, tileW: tw, tileH: th, cols: 0, rows: 0, warnings }
  }
  if (cols > fitCols) {
    warnings.push(`${cols} columns do not fit; using ${fitCols}.`)
    cols = fitCols
  }

  const seq: Film[] = []
  if (s.order === 'pairs') {
    const most = Math.max(...active.map((f) => f.copies))
    for (let i = 0; i < most; i++) for (const f of active) if (i < f.copies) seq.push(f)
  } else {
    for (const f of active) for (let i = 0; i < f.copies; i++) seq.push(f)
  }

  const perPage = cols * rows
  const cx = (board.x0 + board.x1) / 2
  const cy = (board.y0 + board.y1) / 2
  const pages: Page[] = []
  for (let start = 0; start < seq.length; start += perPage) {
    const chunk = seq.slice(start, start + perPage)
    const usedRows = Math.ceil(chunk.length / cols)
    const totalW = cols * tw + (cols - 1) * s.gapX
    const totalH = usedRows * th + (usedRows - 1) * s.gapY
    const ox = s.margin + left + (availW - totalW) / 2
    const oy = s.margin + top + (availH - totalH) / 2
    const tiles: Tile[] = chunk.map((film, i) => {
      const x = ox + (i % cols) * (tw + s.gapX)
      const y = oy + Math.floor(i / cols) * (th + s.gapY)
      let m: Mat = [1, 0, 0, 1, -cx, -cy]
      if (s.rotate) m = mul([0, 1, -1, 0, 0, 0], m)
      // mirror across the page's vertical axis, after rotating, so a fold always lands top on bottom
      if (film.mirror) m = mul([-1, 0, 0, 1, 0, 0], m)
      m = mul([1, 0, 0, 1, x + tw / 2, y + th / 2], m)
      return { film, x, y, w: tw, h: th, m }
    })
    // a fold line in the middle of every pair of columns
    const folds: number[] = []
    if (s.foldLine && cols >= 2 && cols % 2 === 0) {
      for (let c = 0; c < cols; c += 2) folds.push(ox + c * (tw + s.gapX) + tw + s.gapX / 2)
    }
    pages.push({ w: W, h: H, tiles, folds, markX, markY })
  }
  if (s.foldLine && cols >= 2) {
    if (s.order !== 'pairs' || active.length !== 2) {
      warnings.push('Fold pairs need exactly two films (e.g. top and bottom copper) in "Pairs" order; otherwise rows mix layers.')
    } else if (cols % 2) {
      warnings.push('Use an even number of columns for fold pairs.')
    } else if (active[0].copies !== active[1].copies) {
      warnings.push('For fold pairs, give both films the same number of copies.')
    }
  }
  return { pages, board, tileW: tw, tileH: th, cols, rows, warnings }
}
