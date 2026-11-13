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

export interface Fold {
  x: number
  y0: number
  y1: number
}

export interface Page {
  w: number
  h: number
  tiles: Tile[]
  /** fold lines, each in the gap between the two tiles of a pair */
  folds: Fold[]
  /** registration cross offsets from the tile edges, across and down */
  markX: number
  markY: number
}

export interface Layout {
  pages: Page[]
  /** frame of the board when exactly one board is printed, else null */
  board: Bounds | null
  /** number of boards with films on the sheet */
  boards: number
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

/** Usable area of the page after margins and the room crosses, labels and the check bar need. */
function frame(s: Settings) {
  const [W, H] = pageSize(s)
  const markX = markOffset(s.gapX)
  const markY = markOffset(s.gapY)
  const edgeX = s.marks ? markX + MARK_LEN / 2 : 0
  const bar = (edge: string) => (s.scaleBar && s.scaleBarPos.startsWith(edge) ? SCALE_BAR : 0)
  const left = edgeX + bar('left')
  const right = edgeX + bar('right')
  const top = (s.marks ? markY + MARK_LEN / 2 : 0) + bar('top')
  const bottom = Math.max(s.marks ? markY + MARK_LEN / 2 : 0, s.labels ? LABEL_REACH : 0) + bar('bottom')
  return { W, H, markX, markY, x0: s.margin + left, y0: s.margin + top, availW: W - 2 * s.margin - left - right, availH: H - 2 * s.margin - top - bottom }
}

/** Board size on the sheet, border included, after the optional quarter turn. */
function tileSize(board: Bounds, s: Settings): [number, number] {
  const bw = board.x1 - board.x0 + 2 * s.tileMargin
  const bh = board.y1 - board.y0 + 2 * s.tileMargin
  return s.rotate ? [bh, bw] : [bw, bh]
}

/** Board centre -> rotate -> mirror (after rotating, so a fold always lands top on bottom) -> tile centre. */
function tileMatrix(film: Film, board: Bounds, s: Settings, x: number, y: number, tw: number, th: number): Mat {
  let m: Mat = [1, 0, 0, 1, -(board.x0 + board.x1) / 2, -(board.y0 + board.y1) / 2]
  if (s.rotate) m = mul([0, 1, -1, 0, 0, 0], m)
  if (film.mirror) m = mul([-1, 0, 0, 1, 0, 0], m)
  return mul([1, 0, 0, 1, x + tw / 2, y + th / 2], m)
}

/** Copies in print order: one of each film per round ("pairs") or all copies of a film together. */
function sequence(active: Film[], s: Settings): Film[] {
  const seq: Film[] = []
  if (s.order === 'pairs') {
    const most = Math.max(...active.map((f) => f.copies))
    for (let i = 0; i < most; i++) for (const f of active) if (i < f.copies) seq.push(f)
  } else {
    for (const f of active) for (let i = 0; i < f.copies; i++) seq.push(f)
  }
  return seq
}

export function layout(films: Film[], layers: Layer[], s: Settings): Layout {
  const byId = new Map(layers.map((l) => [l.id, l]))
  const active = films.filter((f) => f.enabled && f.copies > 0 && byId.has(f.layerId))
  const boardIds = [...new Set(active.map((f) => byId.get(f.layerId)!.boardId))]
  if (boardIds.length > 1) return packedLayout(active, layers, boardIds, s)
  // one board: the films' board, or the first one loaded when nothing is switched on yet
  const id = boardIds[0] ?? layers[0]?.boardId
  return gridLayout(active, layers.filter((l) => l.boardId === id), s)
}

/** One board: a regular grid, so whole columns of fold pairs can be folded at once. */
function gridLayout(active: Film[], layers: Layer[], s: Settings): Layout {
  const warnings: string[] = []
  const board = boardBounds(layers)
  const empty = { pages: [], board, boards: board && active.length ? 1 : 0, cols: 0, rows: 0, warnings }
  if (!board || !active.length) return empty
  const [tw, th] = tileSize(board, s)
  const { W, H, markX, markY, x0, y0, availW, availH } = frame(s)
  const fitCols = Math.floor((availW + s.gapX) / (tw + s.gapX))
  const rows = Math.floor((availH + s.gapY) / (th + s.gapY))
  const foldPairs = s.foldLine && s.order === 'pairs' && active.length === 2
  // auto columns: as many as fit; for fold pairs, as many whole pairs as fit
  let cols = s.columns > 0 ? s.columns : foldPairs && fitCols >= 2 ? fitCols - (fitCols % 2) : fitCols
  if (fitCols < 1 || rows < 1) {
    warnings.push('The board does not fit on this page with these margins. Try a bigger page, landscape or rotation.')
    return empty
  }
  if (cols > fitCols) {
    warnings.push(`${cols} columns do not fit; using ${fitCols}.`)
    cols = fitCols
  }

  const seq = sequence(active, s)
  const perPage = cols * rows
  const pages: Page[] = []
  for (let start = 0; start < seq.length; start += perPage) {
    const chunk = seq.slice(start, start + perPage)
    const usedRows = Math.ceil(chunk.length / cols)
    const totalW = cols * tw + (cols - 1) * s.gapX
    const totalH = usedRows * th + (usedRows - 1) * s.gapY
    const ox = x0 + (availW - totalW) / 2
    const oy = y0 + (availH - totalH) / 2
    const tiles: Tile[] = chunk.map((film, i) => {
      const x = ox + (i % cols) * (tw + s.gapX)
      const y = oy + Math.floor(i / cols) * (th + s.gapY)
      return { film, x, y, w: tw, h: th, m: tileMatrix(film, board, s, x, y, tw, th) }
    })
    // a fold line in the middle of every pair of columns, over the full height of the grid
    const folds: Fold[] = []
    if (s.foldLine && cols >= 2 && cols % 2 === 0) {
      for (let c = 0; c < cols; c += 2) folds.push({ x: ox + c * (tw + s.gapX) + tw + s.gapX / 2, y0: oy - markY, y1: oy + totalH + markY })
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
  return { pages, board, boards: 1, cols, rows, warnings }
}

/** A run of tiles kept together on one row: a fold pair or a single copy. */
interface Unit {
  films: Film[]
  board: Bounds
  tw: number
  th: number
  w: number
}

/** Skyline segment: the free space above y, from x to x + w. */
interface Seg {
  x: number
  y: number
  w: number
}

const EPS = 1e-6

/** Lowest, then leftmost, spot where a w × h box sits on the skyline inside W × H, or null. */
function fitSkyline(sky: Seg[], w: number, h: number, W: number, H: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null
  for (let i = 0; i < sky.length; i++) {
    const x = sky[i].x
    if (x + w > W + EPS) break
    let y = 0
    let span = 0
    for (let j = i; j < sky.length && span < w - EPS; j++) {
      y = Math.max(y, sky[j].y)
      span += sky[j].w
    }
    if (y + h > H + EPS) continue
    if (!best || y < best.y - EPS) best = { x, y }
  }
  return best
}

/** Skyline after a box of width w is placed at x with its top edge (in page terms, bottom) at top. */
function raiseSkyline(sky: Seg[], x: number, top: number, w: number): Seg[] {
  const out: Seg[] = []
  for (const g of sky) {
    if (g.x + g.w <= x + EPS || g.x >= x + w - EPS) out.push(g)
    else {
      if (g.x < x - EPS) out.push({ x: g.x, y: g.y, w: x - g.x })
      if (g.x + g.w > x + w + EPS) out.push({ x: x + w, y: g.y, w: g.x + g.w - x - w })
    }
  }
  out.push({ x, y: top, w })
  out.sort((a, b) => a.x - b.x)
  // merge neighbours at the same height
  return out.reduce<Seg[]>((acc, g) => {
    const last = acc[acc.length - 1]
    if (last && Math.abs(last.y - g.y) < EPS) last.w += g.w
    else acc.push({ ...g })
    return acc
  }, [])
}

/**
 * Several boards: copies of different sizes packed onto the sheet, biggest first, smaller ones in the
 * space beside them.
 * Each board's two films stay side by side as a fold pair with its own short fold line.
 */
function packedLayout(active: Film[], layers: Layer[], boardIds: string[], s: Settings): Layout {
  const warnings: string[] = []
  const { W, H, markX, markY, x0, y0, availW, availH } = frame(s)
  const byId = new Map(layers.map((l) => [l.id, l]))
  if (s.columns > 0) warnings.push('Columns apply to a single board. Several boards are packed to fit.')

  const units: Unit[] = []
  for (const id of boardIds) {
    const own = layers.filter((l) => l.boardId === id)
    const name = own[0]?.boardName ?? id
    const board = boardBounds(own)
    const films = active.filter((f) => byId.get(f.layerId)!.boardId === id)
    if (!board) continue
    const [tw, th] = tileSize(board, s)
    if (tw > availW || th > availH) {
      warnings.push(`${name} does not fit on this page. Try a bigger page, landscape or rotation.`)
      continue
    }
    const pairs = s.foldLine && s.order === 'pairs' && films.length === 2
    const pairFits = 2 * tw + s.gapX <= availW
    if (pairs && !pairFits) warnings.push(`${name}: a fold pair is wider than the page, so its copies are placed singly.`)
    if (s.foldLine && s.order === 'pairs' && films.length > 2) warnings.push(`${name}: fold pairs need exactly two films for the board.`)
    const seq = sequence(films, s)
    for (let i = 0; i < seq.length; ) {
      if (pairs && pairFits && seq[i + 1] && seq[i + 1] !== seq[i]) {
        units.push({ films: [seq[i], seq[i + 1]], board, tw, th, w: 2 * tw + s.gapX })
        i += 2
      } else {
        units.push({ films: [seq[i]], board, tw, th, w: tw })
        i += 1
      }
    }
  }

  // skyline packing: biggest copies first, each into the lowest (then leftmost) free spot of the
  // first sheet with room, so small boards fill the space beside tall ones. Every footprint carries
  // one gap on its right and bottom; the page gets the same so the last gap can hang off it.
  const FW = availW + s.gapX
  const FH = availH + s.gapY
  const sheets: Array<{ sky: Seg[]; placed: Array<{ u: Unit; x: number; y: number }> }> = []
  const sorted = [...units].sort((a, b) => b.th - a.th || b.w - a.w)
  for (const u of sorted) {
    const w = u.w + s.gapX
    const h = u.th + s.gapY
    let sheet = sheets.find((sh) => fitSkyline(sh.sky, w, h, FW, FH))
    if (!sheet) sheets.push((sheet = { sky: [{ x: 0, y: 0, w: FW }], placed: [] }))
    const at = fitSkyline(sheet.sky, w, h, FW, FH)!
    sheet.sky = raiseSkyline(sheet.sky, at.x, at.y + h, w)
    sheet.placed.push({ u, ...at })
  }

  const pages: Page[] = sheets.map(({ placed }) => {
    // centre the packed block as a whole, so rows and columns keep common edges
    const usedW = Math.max(...placed.map((p) => p.x + p.u.w))
    const usedH = Math.max(...placed.map((p) => p.y + p.u.th))
    const ox = x0 + (availW - usedW) / 2
    const oy = y0 + (availH - usedH) / 2
    const tiles: Tile[] = []
    const folds: Fold[] = []
    for (const { u, x: px, y: py } of placed) {
      const x = ox + px
      const y = oy + py
      u.films.forEach((film, k) => {
        const tx = x + k * (u.tw + s.gapX)
        tiles.push({ film, x: tx, y, w: u.tw, h: u.th, m: tileMatrix(film, u.board, s, tx, y, u.tw, u.th) })
      })
      if (u.films.length === 2) folds.push({ x: x + u.tw + s.gapX / 2, y0: y - markY, y1: y + u.th + markY })
    }
    return { w: W, h: H, tiles, folds, markX, markY }
  })
  return { pages, board: null, boards: boardIds.length, cols: 0, rows: 0, warnings }
}
