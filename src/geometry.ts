// Gerber/Excellon plot (tracespace ImageTree) -> filled and stroked paths in millimetres,
// y axis pointing down (page orientation). Arcs become cubic Béziers so SVG and PDF draw the same thing.
import type { ImageTree, PathSegment, Position, Shape, SimpleShape } from '@tracespace/plotter'

export type Pt = [number, number]
/** Line to `p`, or cubic Bézier to `p` with control points `c`. */
export interface Seg {
  p: Pt
  c?: [Pt, Pt]
}
export interface Sub {
  start: Pt
  segs: Seg[]
  closed: boolean
}
/** Filled with the non-zero rule; hole outlines run the opposite way. */
export interface Fill {
  kind: 'fill'
  subs: Sub[]
}
/** Round caps and joins, like a circular Gerber aperture. */
export interface Stroke {
  kind: 'stroke'
  subs: Sub[]
  width: number
}
export type Drawable = Fill | Stroke
export interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}
export interface DrillMarks {
  dots: Pt[]
  slots: Sub[]
}

const EPS = 1e-6

function toMm(units: string): number {
  return units === 'in' ? 25.4 : 1
}

/** Bézier pieces of a circular arc, in Gerber coordinates (y up), from angle a0 to a1. */
function arcSegs(cx: number, cy: number, r: number, a0: number, a1: number): Seg[] {
  const sweep = a1 - a0
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - EPS))
  const d = sweep / n
  const k = (4 / 3) * Math.tan(d / 4)
  const segs: Seg[] = []
  for (let i = 0; i < n; i++) {
    const s = a0 + i * d
    const e = s + d
    const p0: Pt = [cx + r * Math.cos(s), cy + r * Math.sin(s)]
    const p3: Pt = [cx + r * Math.cos(e), cy + r * Math.sin(e)]
    const c1: Pt = [p0[0] - k * r * Math.sin(s), p0[1] + k * r * Math.cos(s)]
    const c2: Pt = [p3[0] + k * r * Math.sin(e), p3[1] - k * r * Math.cos(e)]
    segs.push({ p: p3, c: [c1, c2] })
  }
  return segs
}

function same(a: Position | Pt, b: Position | Pt): boolean {
  return Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS
}

/** Split a Gerber segment list into connected sub-paths. */
function segmentsToSubs(segments: PathSegment[], close: boolean): Sub[] {
  const subs: Sub[] = []
  let cur: Sub | null = null
  for (const s of segments) {
    const start: Pt = [s.start[0], s.start[1]]
    if (!cur || !same(lastPoint(cur), start)) {
      cur = { start, segs: [], closed: close }
      subs.push(cur)
    }
    if (s.type === 'line') {
      cur.segs.push({ p: [s.end[0], s.end[1]] })
    } else {
      cur.segs.push(...arcSegs(s.center[0], s.center[1], s.radius, s.start[2], s.end[2]))
    }
  }
  if (!close) {
    for (const sub of subs) sub.closed = sub.segs.length > 0 && same(lastPoint(sub), sub.start)
  }
  return subs
}

function lastPoint(sub: Sub): Pt {
  return sub.segs.length ? sub.segs[sub.segs.length - 1].p : sub.start
}

function circleSub(cx: number, cy: number, r: number): Sub {
  return { start: [cx + r, cy], segs: arcSegs(cx, cy, r, 0, 2 * Math.PI), closed: true }
}

function rectSub(x: number, y: number, w: number, h: number, r = 0): Sub {
  if (r <= EPS) {
    return {
      start: [x, y],
      segs: [{ p: [x + w, y] }, { p: [x + w, y + h] }, { p: [x, y + h] }, { p: [x, y] }],
      closed: true,
    }
  }
  const q = Math.PI / 2
  return {
    start: [x + r, y],
    segs: [
      { p: [x + w - r, y] },
      ...arcSegs(x + w - r, y + r, r, -q, 0),
      { p: [x + w, y + h - r] },
      ...arcSegs(x + w - r, y + h - r, r, 0, q),
      { p: [x + r, y + h] },
      ...arcSegs(x + r, y + h - r, r, q, 2 * q),
      { p: [x, y + r] },
      ...arcSegs(x + r, y + r, r, 2 * q, 3 * q),
    ],
    closed: true,
  }
}

/**
 * tracespace 5.0.0-alpha.0 builds macro "vector line" primitives (code 20) with the width offset
 * along the line instead of across it, which gives a flat sliver. KiCad's rounded-rectangle pads
 * use four of them for their edges. Rebuild such slivers as the intended rectangle.
 */
function repairVectorLine(points: Position[]): Position[] {
  if (points.length !== 4) return points
  const [a, b, c, d] = points
  const s: Pt = [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2]
  const e: Pt = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]
  const dir: Pt = [e[0] - s[0], e[1] - s[1]]
  const off: Pt = [a[0] - s[0], a[1] - s[1]]
  const len = Math.hypot(...dir)
  const w = Math.hypot(...off)
  const cross = dir[0] * off[1] - dir[1] * off[0]
  const flat = Math.abs(polygonArea(points)) < 1e-9
  if (!flat || len < EPS || w < EPS || Math.abs(cross) > 1e-6 * len * w) return points
  const p: Pt = [-off[1], off[0]] // the offset turned 90°
  return [
    [s[0] + p[0], s[1] + p[1]],
    [e[0] + p[0], e[1] + p[1]],
    [e[0] - p[0], e[1] - p[1]],
    [s[0] - p[0], s[1] - p[1]],
  ]
}

function polygonArea(points: Position[]): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

function simpleShapeSubs(s: SimpleShape): Sub[] {
  switch (s.type) {
    case 'circle':
      return [circleSub(s.cx, s.cy, s.r)]
    case 'rectangle':
      return [rectSub(s.x, s.y, s.xSize, s.ySize, s.r ?? 0)]
    case 'polygon': {
      const pts = repairVectorLine(s.points)
      return [
        {
          start: [pts[0][0], pts[0][1]],
          segs: pts.slice(1).map((p) => ({ p: [p[0], p[1]] as Pt })),
          closed: true,
        },
      ]
    }
    case 'outline':
      return segmentsToSubs(s.segments, true)
  }
}

function signedArea(sub: Sub): number {
  const pts = [sub.start, ...sub.segs.map((s) => s.p)]
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

function reversed(sub: Sub): Sub {
  const pts = [sub.start, ...sub.segs.map((s) => s.p)]
  const segs: Seg[] = []
  for (let i = sub.segs.length - 1; i >= 0; i--) {
    const seg = sub.segs[i]
    const to = pts[i]
    segs.push(seg.c ? { p: to, c: [seg.c[1], seg.c[0]] } : { p: to })
  }
  return { start: lastPoint(sub), segs, closed: sub.closed }
}

/** Force winding: positive for copper, negative for holes (non-zero fill then cuts them out). */
function oriented(sub: Sub, positive: boolean): Sub {
  return signedArea(sub) >= 0 === positive ? sub : reversed(sub)
}

function shapeFill(shape: Shape): Fill {
  if (shape.type === 'layeredShape') {
    const subs: Sub[] = []
    for (const part of shape.shapes) {
      for (const sub of simpleShapeSubs(part)) subs.push(oriented(sub, !part.erase))
    }
    return { kind: 'fill', subs }
  }
  return { kind: 'fill', subs: simpleShapeSubs(shape).map((s) => oriented(s, true)) }
}

function mapSub(sub: Sub, f: (p: Pt) => Pt): Sub {
  return {
    start: f(sub.start),
    segs: sub.segs.map((s) => (s.c ? { p: f(s.p), c: [f(s.c[0]), f(s.c[1])] } : { p: f(s.p) })),
    closed: sub.closed,
  }
}

function pageMapper(units: string): (p: Pt) => Pt {
  const k = toMm(units)
  return ([x, y]) => [x * k, -y * k]
}

/** Copper, mask, silkscreen or outline layer as drawables (mm, y down). */
export function toDrawables(img: ImageTree): Drawable[] {
  const f = pageMapper(img.units)
  const k = toMm(img.units)
  const out: Drawable[] = []
  for (const node of img.children) {
    if (node.type === 'imageShape') {
      const fill = shapeFill(node.shape)
      out.push({ kind: 'fill', subs: fill.subs.map((s) => mapSub(s, f)) })
    } else if (node.type === 'imageRegion') {
      const subs = segmentsToSubs(node.segments, true).map((s) => mapSub(oriented(s, true), f))
      out.push({ kind: 'fill', subs })
    } else if (node.type === 'imagePath') {
      const subs = segmentsToSubs(node.segments, false).map((s) => mapSub(s, f))
      out.push({ kind: 'stroke', subs, width: Math.max(node.width * k, 0.05) })
    }
  }
  return out
}

/** Hole centres and slot centre lines from a drill file. */
export function toDrillMarks(img: ImageTree): DrillMarks {
  const f = pageMapper(img.units)
  const marks: DrillMarks = { dots: [], slots: [] }
  for (const node of img.children) {
    if (node.type === 'imageShape' && node.shape.type === 'circle') {
      marks.dots.push(f([node.shape.cx, node.shape.cy]))
    } else if (node.type === 'imagePath') {
      for (const s of segmentsToSubs(node.segments, false)) marks.slots.push(mapSub(s, f))
    }
  }
  return marks
}

/** Envelope of a plot in mm, y down. Empty plots give null. */
export function imageBounds(img: ImageTree): Bounds | null {
  if (img.size.length !== 4) return null
  const k = toMm(img.units)
  const [x1, y1, x2, y2] = img.size
  return { x0: x1 * k, y0: -y2 * k, x1: x2 * k, y1: -y1 * k }
}

export function unionBounds(list: Array<Bounds | null>): Bounds | null {
  const b = list.filter((x): x is Bounds => x !== null)
  if (!b.length) return null
  return {
    x0: Math.min(...b.map((v) => v.x0)),
    y0: Math.min(...b.map((v) => v.y0)),
    x1: Math.max(...b.map((v) => v.x1)),
    y1: Math.max(...b.map((v) => v.y1)),
  }
}
