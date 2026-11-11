// SVG painter: live preview and SVG export (one document per page, units in mm).
import type { Sub } from './geometry'
import type { Color, Painter } from './render'

const f = (n: number) => +n.toFixed(4)

export function pathData(subs: Sub[]): string {
  let d = ''
  for (const s of subs) {
    d += `M${f(s.start[0])} ${f(s.start[1])}`
    for (const g of s.segs) {
      d += g.c
        ? `C${f(g.c[0][0])} ${f(g.c[0][1])} ${f(g.c[1][0])} ${f(g.c[1][1])} ${f(g.p[0])} ${f(g.p[1])}`
        : `L${f(g.p[0])} ${f(g.p[1])}`
    }
    if (s.closed) d += 'Z'
  }
  return d
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const hex = (c: Color) => (c === 'black' ? '#000' : '#fff')

export class SvgPainter implements Painter {
  pages: string[] = []
  private parts: string[] = []
  private clipId = 0

  beginPage(w: number, h: number): void {
    this.parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">`,
      `<rect width="${f(w)}" height="${f(h)}" fill="#fff"/>`,
    ]
  }
  endPage(): void {
    this.parts.push('</svg>')
    this.pages.push(this.parts.join(''))
  }
  clip(x: number, y: number, w: number, h: number): void {
    const id = `c${this.clipId++}`
    this.parts.push(
      `<clipPath id="${id}"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"/></clipPath><g clip-path="url(#${id})">`,
    )
  }
  unclip(): void {
    this.parts.push('</g>')
  }
  rect(x: number, y: number, w: number, h: number, color: Color): void {
    this.parts.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${hex(color)}"/>`)
  }
  fill(subs: Sub[], color: Color): void {
    this.parts.push(`<path d="${pathData(subs)}" fill="${hex(color)}" fill-rule="nonzero"/>`)
  }
  stroke(subs: Sub[], width: number, color: Color, dash?: number[]): void {
    const da = dash ? ` stroke-dasharray="${dash.join(' ')}"` : ''
    this.parts.push(
      `<path d="${pathData(subs)}" fill="none" stroke="${hex(color)}" stroke-width="${f(width)}" stroke-linecap="round" stroke-linejoin="round"${da}/>`,
    )
  }
  dot(x: number, y: number, r: number, color: Color): void {
    this.parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${hex(color)}"/>`)
  }
  text(x: number, y: number, size: number, str: string, anchor: 'start' | 'middle'): void {
    this.parts.push(
      `<text x="${f(x)}" y="${f(y)}" font-family="Helvetica, Arial, sans-serif" font-size="${f(size)}" text-anchor="${anchor}">${esc(str)}</text>`,
    )
  }
}
