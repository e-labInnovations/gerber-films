// Minimal vector PDF writer. Page size is set in points from millimetres (1 mm = 72 / 25.4 pt), and
// nothing is rasterised or rescaled, so "Actual size" printing gives true 1:1 films.
import type { Sub } from './geometry'
import type { Color, Painter } from './render'

const PT = 72 / 25.4
const n = (v: number) => (+v.toFixed(3)).toString()

// Helvetica advance widths (1/1000 em) for printable ASCII, used to centre labels
const HELV =
  '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'
    .split(',')
    .map(Number)

function textWidth(str: string, size: number): number {
  let w = 0
  for (const ch of str) {
    const c = ch.charCodeAt(0)
    w += c >= 32 && c <= 126 ? HELV[c - 32] : 556
  }
  return (w / 1000) * size
}

export class PdfPainter implements Painter {
  private pages: Array<{ w: number; h: number; ops: string[] }> = []
  private ops: string[] = []
  private h = 0

  beginPage(w: number, h: number): void {
    this.ops = []
    this.h = h
    this.pages.push({ w, h, ops: this.ops })
  }
  endPage(): void {}

  private xy(x: number, y: number): string {
    return `${n(x * PT)} ${n((this.h - y) * PT)}`
  }
  private path(subs: Sub[]): void {
    for (const s of subs) {
      this.ops.push(`${this.xy(s.start[0], s.start[1])} m`)
      for (const g of s.segs) {
        this.ops.push(
          g.c
            ? `${this.xy(g.c[0][0], g.c[0][1])} ${this.xy(g.c[1][0], g.c[1][1])} ${this.xy(g.p[0], g.p[1])} c`
            : `${this.xy(g.p[0], g.p[1])} l`,
        )
      }
      if (s.closed) this.ops.push('h')
    }
  }
  private gray(c: Color, stroke: boolean): string {
    return `${c === 'black' ? 0 : 1} ${stroke ? 'G' : 'g'}`
  }

  clip(x: number, y: number, w: number, h: number): void {
    this.ops.push(`q ${n(x * PT)} ${n((this.h - y - h) * PT)} ${n(w * PT)} ${n(h * PT)} re W n`)
  }
  unclip(): void {
    this.ops.push('Q')
  }
  rect(x: number, y: number, w: number, h: number, color: Color): void {
    this.ops.push(`${this.gray(color, false)} ${n(x * PT)} ${n((this.h - y - h) * PT)} ${n(w * PT)} ${n(h * PT)} re f`)
  }
  fill(subs: Sub[], color: Color): void {
    this.ops.push(this.gray(color, false))
    this.path(subs)
    this.ops.push('f')
  }
  stroke(subs: Sub[], width: number, color: Color, dash?: number[]): void {
    this.ops.push(`${this.gray(color, true)} ${n(width * PT)} w 1 J 1 j ${dash ? `[${dash.map((d) => n(d * PT)).join(' ')}] 0 d` : '[] 0 d'}`)
    this.path(subs)
    this.ops.push('S')
  }
  dot(x: number, y: number, r: number, color: Color): void {
    const k = 0.5523 * r
    this.fill(
      [
        {
          start: [x + r, y],
          segs: [
            { p: [x, y + r], c: [[x + r, y + k], [x + k, y + r]] },
            { p: [x - r, y], c: [[x - k, y + r], [x - r, y + k]] },
            { p: [x, y - r], c: [[x - r, y - k], [x - k, y - r]] },
            { p: [x + r, y], c: [[x + k, y - r], [x + r, y - k]] },
          ],
          closed: true,
        },
      ],
      color,
    )
  }
  text(x: number, y: number, size: number, str: string, anchor: 'start' | 'middle' | 'end', vertical = false): void {
    const safe = str.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')
    const w = textWidth(str, size)
    const shift = anchor === 'middle' ? w / 2 : anchor === 'end' ? w : 0
    if (vertical) {
      // reads upwards: the text starts `shift` below the anchor; text matrix turned 90° (PDF y is up)
      this.ops.push(`0 g BT /F1 ${n(size * PT)} Tf 0 1 -1 0 ${this.xy(x, y + shift)} Tm (${safe}) Tj ET`)
    } else {
      this.ops.push(`0 g BT /F1 ${n(size * PT)} Tf ${this.xy(x - shift, y)} Td (${safe}) Tj ET`)
    }
  }

  async toBlob(): Promise<Blob> {
    const enc = new TextEncoder()
    const chunks: Uint8Array[] = []
    const offsets: number[] = []
    let size = 0
    const push = (b: Uint8Array | string) => {
      const u = typeof b === 'string' ? enc.encode(b) : b
      chunks.push(u)
      size += u.length
    }
    const obj = (i: number, body: string | Uint8Array, dict?: string) => {
      offsets[i] = size
      if (typeof body === 'string' && !dict) {
        push(`${i} 0 obj\n${body}\nendobj\n`)
      } else {
        push(`${i} 0 obj\n${dict}\nstream\n`)
        push(body)
        push('\nendstream\nendobj\n')
      }
    }
    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    const np = this.pages.length
    // 1 catalog, 2 pages, 3 font, 4 info, then per page: page object, content stream
    const kids = this.pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${np} >>`)
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    obj(4, '<< /Producer (gerber-films) >>')
    for (let i = 0; i < np; i++) {
      const pg = this.pages[i]
      obj(
        5 + 2 * i,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pg.w * PT)} ${n(pg.h * PT)}] /Contents ${6 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      )
      const data = await deflate(enc.encode(pg.ops.join('\n')))
      obj(6 + 2 * i, data, `<< /Length ${data.length} /Filter /FlateDecode >>`)
    }
    const count = 5 + 2 * np
    const xref = size
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let i = 1; i < count; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
    push(table)
    push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
    return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
  }
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate') // zlib format, which is what /FlateDecode expects
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
