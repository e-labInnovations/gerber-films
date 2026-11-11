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
  text(x: number, y: number, size: number, str: string, anchor: 'start' | 'middle'): void
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

function drawPage(p: Painter, page: Page, layers: Map<string, Layer>, s: Settings): void {
  p.beginPage(page.w, page.h)
  const outline = [...layers.values()].find((l) => l.type === 'outline')
  const drill = [...layers.values()].find((l) => l.type === 'drill')
  for (const t of page.tiles) {
    const layer = layers.get(t.film.layerId)
    if (!layer) continue
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
      const xs = [t.x - MARK_OFF, t.x + t.w + MARK_OFF]
      const ys = [t.y - MARK_OFF, t.y + t.h + MARK_OFF]
      const subs: Sub[] = []
      for (const x of xs) for (const y of ys) {
        subs.push(line(x - MARK_LEN / 2, y, x + MARK_LEN / 2, y), line(x, y - MARK_LEN / 2, x, y + MARK_LEN / 2))
      }
      p.stroke(subs, 0.2, 'black')
    }
    if (s.labels) {
      p.text(t.x + t.w / 2, t.y + t.h + MARK_OFF + 1, 2.2, filmLabel(t.film.name, t.film.mirror, t.film.negative), 'middle')
    }
  }
  if (page.folds.length && page.tiles.length) {
    const top = Math.min(...page.tiles.map((t) => t.y)) - MARK_OFF
    const bottom = Math.max(...page.tiles.map((t) => t.y + t.h)) + MARK_OFF
    for (const x of page.folds) p.stroke([line(x, top, x, bottom)], 0.15, 'black', [2, 2])
  }
  if (s.scaleBar) {
    const bx = s.margin + 2
    const by = page.h - s.margin
    p.stroke([line(bx, by, bx + 50, by), line(bx, by - 1.5, bx, by + 1.5), line(bx + 50, by - 1.5, bx + 50, by + 1.5)], 0.25, 'black')
    const fold = page.folds.length ? '  |  fold on the dashed lines, toner inside' : ''
    p.text(bx + 53, by + 0.9, 2.5, `50 mm  |  print at 100%, no scaling  |  toner side against the copper${fold}`, 'start')
  }
  p.endPage()
}

export function drawLayout(p: Painter, lay: Layout, layers: Layer[], s: Settings, only?: number): void {
  const byId = new Map(layers.map((l) => [l.id, l]))
  lay.pages.forEach((page, i) => {
    if (only === undefined || only === i) drawPage(p, page, byId, s)
  })
}
