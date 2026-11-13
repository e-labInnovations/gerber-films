// Draw laid-out pages onto a Painter (SVG preview / PDF). All coordinates are page millimetres.
import type { Pt, Sub } from './geometry'
import type { Layer } from './load'
import { MARK_LEN, MARK_OFF, type Layout, type Mat, type Page, type Settings } from './layout'

export type Color = 'black' | 'white'

export interface Painter {
  beginPage(w: number, h: number): void
  endPage(): void
  clip(x: number, y: number, w: number, h: number): void
  unclip(): void
  rect(x: number, y: number, w: number, h: number, color: Color): void
  fill(subs: Sub[], color: Color): void
  stroke(subs: Sub[], width: number, color: Color, dash?: number[]): void
  dot(x: number, y: number, r: number, color: Color): void
  /** `vertical`: rotated to read upwards, (x, y) is then the anchor on the text's baseline */
  text(x: number, y: number, size: number, str: string, anchor: 'start' | 'middle' | 'end', vertical?: boolean): void
}


function apply(m: Mat, [x, y]: Pt): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function mapSubs(subs: Sub[], m: Mat): Sub[] {
  const f = (p: Pt) => apply(m, p)
  return subs.map((s) => ({
    start: f(s.start),
    segs: s.segs.map((g) => (g.c ? { p: f(g.p), c: [f(g.c[0]), f(g.c[1])] as [Pt, Pt] } : { p: f(g.p) })),
    closed: s.closed,
  }))
}

function line(x1: number, y1: number, x2: number, y2: number): Sub {
  return { start: [x1, y1], segs: [{ p: [x2, y2] }], closed: false }
}

export function filmLabel(name: string, mirror: boolean, negative: boolean): string {
  return `${name}${mirror ? '  (mirrored)' : ''}  |  ${negative ? 'NEGATIVE' : 'POSITIVE'}`
}

function drawPage(p: Painter, page: Page, layers: Map<string, Layer>, s: Settings, named: boolean): void {
  p.beginPage(page.w, page.h)
  for (const t of page.tiles) {
    const layer = layers.get(t.film.layerId)
    if (!layer) continue
    // outline and drill holes come from the tile's own board
    const own = [...layers.values()].filter((l) => l.boardId === layer.boardId)
    const outline = own.find((l) => l.type === 'outline')
    const drill = own.find((l) => l.type === 'drill')
    const fg: Color = t.film.negative ? 'white' : 'black'
    const bg: Color = t.film.negative ? 'black' : 'white'
    p.clip(t.x, t.y, t.w, t.h)
    if (t.film.negative) p.rect(t.x, t.y, t.w, t.h, 'black')
    for (const d of layer.drawables) {
      const subs = mapSubs(d.subs, t.m)
      const c = d.clear ? bg : fg // clear polarity erases back to the film's background
      if (d.kind === 'fill') p.fill(subs, c)
      else p.stroke(subs, d.width, c)
    }
    if (t.film.outline && outline && outline !== layer) {
      for (const d of outline.drawables) {
        const subs = mapSubs(d.subs, t.m)
        if (d.kind === 'stroke') p.stroke(subs, d.width, fg)
        else p.fill(subs, fg)
      }
    }
    if (t.film.drillDots && drill?.drill) {
      for (const c of drill.drill.dots) {
        const [x, y] = apply(t.m, c)
        p.dot(x, y, s.dotSize / 2, bg)
      }
      if (drill.drill.slots.length) p.stroke(mapSubs(drill.drill.slots, t.m), s.dotSize, bg)
    }
    p.unclip()
    if (s.marks) {
      const xs = [t.x - page.markX, t.x + t.w + page.markX]
      const ys = [t.y - page.markY, t.y + t.h + page.markY]
      const subs: Sub[] = []
      for (const x of xs) for (const y of ys) {
        subs.push(line(x - MARK_LEN / 2, y, x + MARK_LEN / 2, y), line(x, y - MARK_LEN / 2, x, y + MARK_LEN / 2))
      }
      p.stroke(subs, 0.2, 'black')
    }
    if (s.labels) {
      const name = named ? `${layer.boardName}: ${t.film.name}` : t.film.name
      p.text(t.x + t.w / 2, t.y + t.h + MARK_OFF + 1, 2.2, filmLabel(name, t.film.mirror, t.film.negative), 'middle')
    }
  }
  for (const f of page.folds) p.stroke([line(f.x, f.y0, f.x, f.y1)], 0.15, 'black', [2, 2])
  if (s.scaleBar) drawScaleBar(p, page, s)
  p.endPage()
}

/** 50 mm check bar with its note, on the edge and end chosen in the settings. */
function drawScaleBar(p: Painter, page: Page, s: Settings): void {
  const fold = page.folds.length ? '  |  fold on the dashed lines, toner inside' : ''
  const note = `50 mm  |  print at 100%, no scaling  |  toner side against the copper${fold}`
  const [edge, end] = s.scaleBarPos.split('-')
  const m = s.margin + 2
  const tick = 1.5
  if (edge === 'top' || edge === 'bottom') {
    const y = edge === 'top' ? s.margin + 2.5 : page.h - s.margin
    const x0 = end === 'left' ? m : page.w - m - 50
    const x1 = x0 + 50
    p.stroke([line(x0, y, x1, y), line(x0, y - tick, x0, y + tick), line(x1, y - tick, x1, y + tick)], 0.25, 'black')
    if (end === 'left') p.text(x1 + 3, y + 0.9, 2.5, note, 'start')
    else p.text(x0 - 3, y + 0.9, 2.5, note, 'end')
  } else {
    const x = edge === 'left' ? m : page.w - m
    const y1 = end === 'bottom' ? page.h - m : m + 50 // lower end of the bar
    const y0 = y1 - 50
    p.stroke([line(x, y0, x, y1), line(x - tick, y0, x + tick, y0), line(x - tick, y1, x + tick, y1)], 0.25, 'black')
    // text reads upwards along the bar: above it when the bar sits low, below it when the bar sits high
    if (end === 'bottom') p.text(x + 0.9, y0 - 3, 2.5, note, 'start', true)
    else p.text(x + 0.9, y1 + 3, 2.5, note, 'end', true)
  }
}

export function drawLayout(p: Painter, lay: Layout, layers: Layer[], s: Settings, only?: number): void {
  const byId = new Map(layers.map((l) => [l.id, l]))
  lay.pages.forEach((page, i) => {
    if (only === undefined || only === i) drawPage(p, page, byId, s, lay.boards > 1)
  })
}
