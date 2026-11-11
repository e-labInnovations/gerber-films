import './style.css'
import { loadFiles, type Layer } from './load'
import { DEFAULT_SETTINGS, layout, pageSize, type Film, type Layout, type PageSize, type Settings } from './layout'
import { drawLayout } from './render'
import { SvgPainter } from './svg'
import { PdfPainter } from './pdf'

// ---------------------------------------------------------------- state
const STORE = 'gerber-films:settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    /* private mode or blocked storage: defaults */
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(state.settings))
  } catch {
    /* ignore */
  }
}

const state = {
  layers: [] as Layer[],
  skipped: [] as string[],
  films: [] as Film[],
  settings: loadSettings(),
  page: 0,
  project: 'board',
  lay: null as Layout | null,
  source: '',
  expanded: new Set<string>(),
}

let filmSeq = 0
const newId = () => `F${filmSeq++}`

const SIDE_NAME: Record<string, string> = { top: 'Top', bottom: 'Bottom', inner: 'Inner', all: '', none: '' }
const TYPE_NAME: Record<string, string> = {
  copper: 'copper',
  soldermask: 'solder mask',
  silkscreen: 'silkscreen',
  solderpaste: 'paste',
  drill: 'drill',
  outline: 'outline',
  drawing: 'drawing',
  unknown: 'unknown',
}

function layerName(l: Layer): string {
  return `${SIDE_NAME[l.side] ?? ''} ${TYPE_NAME[l.type] ?? l.type}`.trim()
}

/** Sensible films for a fresh upload: copper pairs on, mask and silk ready but off. */
function presetFilms(layers: Layer[]): Film[] {
  const films: Film[] = []
  const add = (type: string, enabled: boolean, negative: boolean, drill: boolean) => {
    for (const side of ['top', 'bottom']) {
      const l = layers.find((x) => x.type === type && x.side === side)
      if (!l) continue
      films.push({
        id: newId(),
        enabled,
        name: layerName(l),
        layerId: l.id,
        mirror: side === 'top',
        negative,
        drillDots: drill,
        outline: true,
        copies: 2,
      })
    }
  }
  add('copper', true, true, true)
  add('soldermask', false, false, false)
  add('silkscreen', false, false, false)
  return films
}

// ---------------------------------------------------------------- dom helpers
type Attrs = Record<string, string | number | boolean | EventListener | undefined>

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids) if (kid !== null) el.append(kid)
  return el
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T

// ---------------------------------------------------------------- page
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="top">
    <div class="brand">
      <svg class="mark" viewBox="0 0 64 64" aria-hidden="true">
        <defs><clipPath id="mark-r"><rect x="2" y="2" width="60" height="60" rx="12"/></clipPath></defs>
        <g clip-path="url(#mark-r)">
          <rect x="2" y="2" width="30" height="60" fill="#1c1f24"/>
          <rect x="32" y="2" width="30" height="60" fill="#fff"/>
          <path d="M2 42H20L32 30" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M32 30L36 26H44" fill="none" stroke="#1c1f24" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="47" cy="26" r="7" fill="#b4232f"/>
          <circle cx="47" cy="26" r="2.6" fill="#fff"/>
        </g>
        <rect x="2" y="2" width="60" height="60" rx="12" fill="none" stroke="#b4232f" stroke-width="3"/>
      </svg>
      <div>
      <h1>Gerber Films</h1>
      <p>Gerber + drill files in, printable 1:1 photoresist and toner-transfer films out. Everything stays in your browser.</p>
      </div>
    </div>
    <div class="actions">
      <button id="pdf" class="primary" disabled>Download PDF</button>
      <button id="svg" disabled>SVG of this page</button>
    </div>
  </header>
  <main class="grid">
    <aside class="panel">
      <section>
        <h2>1. Files</h2>
        <label class="drop" id="drop">
          <input id="files" type="file" multiple />
          <strong id="drop-title">Drop a Gerber zip or files here</strong>
          <span id="drop-sub">or click to choose. KiCad, Eagle, Altium and EasyEDA names are recognised.</span>
        </label>
        <details id="layers-box" class="layers-box" hidden>
          <summary id="layers-sum">Detected layers</summary>
          <ul id="layers" class="layers"></ul>
        </details>
      </section>
      <section>
        <h2>2. Films</h2>
        <div class="row resist">
          <span id="resist-label">Copper</span>
          <div class="segmented" role="group" aria-labelledby="resist-label">
            <button data-resist="neg" aria-pressed="false" title="Dry-film (negative) resist: copper prints clear">Negative</button>
            <button data-resist="pos" aria-pressed="false" title="Positive resist or toner transfer: copper prints black">Positive</button>
          </div>
          <span id="resist-mixed" class="mixed" hidden>mixed</span>
        </div>
        <div id="films" class="films"></div>
        <button id="addFilm" class="ghost" disabled>+ Add film</button>
      </section>
      <section>
        <h2>3. Sheet</h2>
        <div id="sheet" class="sheet"></div>
      </section>
    </aside>
    <section class="view">
      <div class="viewbar">
        <div id="summary" class="summary">No files loaded.</div>
        <div class="pager">
          <button id="prev" aria-label="Previous page">‹</button>
          <span id="pageno">–</span>
          <button id="next" aria-label="Next page">›</button>
        </div>
      </div>
      <ul id="warnings" class="warnings"></ul>
      <div id="preview" class="preview"><div class="empty">Load Gerber files to see the sheet.</div></div>
    </section>
  </main>
`

// ---------------------------------------------------------------- files
async function handleFiles(list: FileList | File[]): Promise<void> {
  const files = [...list]
  if (!files.length) return
  $('#summary').textContent = 'Reading files…'
  const zip = files.find((f) => /\.zip$/i.test(f.name))
  state.source = zip?.name ?? (files.length === 1 ? files[0].name : `${files.length} files`)
  state.project = (zip?.name ?? files[0].name).replace(/\.[^.]+$/, '').replace(/[-_](F|B)[-_.].*$/i, '') || 'board'
  const res = await loadFiles(files)
  state.layers = res.layers
  state.skipped = res.skipped
  state.films = presetFilms(res.layers)
  state.expanded.clear()
  state.page = 0
  renderLayers()
  renderFilms()
  update()
}

$('#files').addEventListener('change', (e) => handleFiles((e.target as HTMLInputElement).files ?? []))
const drop = $('#drop')
drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('over')
})
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files)
})

function renderLayers(): void {
  const n = state.layers.length
  const loaded = n > 0
  $('#drop').classList.toggle('compact', loaded)
  $('#drop-title').textContent = loaded ? state.source : 'Drop a Gerber zip or files here'
  $('#drop-sub').textContent = loaded
    ? `${n} layer${n === 1 ? '' : 's'} · drop or click to replace`
    : 'or click to choose. KiCad, Eagle, Altium and EasyEDA names are recognised.'
  const box = $('#layers-box') as HTMLDetailsElement
  box.hidden = !loaded && !state.skipped.length
  const issues = state.layers.some((l) => l.warning) || state.skipped.length > 0
  box.open = issues
  $('#layers-sum').textContent = `Detected layers (${n})${issues ? ' · check' : ''}`
  $('#layers').replaceChildren(
    ...state.layers.map((l) =>
      h(
        'li',
        {},
        h('span', { class: `tag t-${l.type}` }, layerName(l) || l.type),
        h('span', { class: 'fname', title: l.filename }, l.filename),
        l.warning ? h('span', { class: 'warn' }, l.warning) : null,
      ),
    ),
    ...state.skipped.map((f) => h('li', { class: 'skipped' }, h('span', { class: 'tag' }, 'skipped'), h('span', { class: 'fname' }, f))),
  )
  ;($('#addFilm') as HTMLButtonElement).disabled = !loaded
}

// ---------------------------------------------------------------- films
/** Reflect the copper films' negative setting on the segmented control. */
function syncResist(): void {
  const copper = state.films.filter((f) => state.layers.find((l) => l.id === f.layerId)?.type === 'copper')
  const neg = copper.length > 0 && copper.every((f) => f.negative)
  const pos = copper.length > 0 && copper.every((f) => !f.negative)
  document.querySelectorAll<HTMLButtonElement>('[data-resist]').forEach((b) => {
    const on = b.dataset.resist === 'neg' ? neg : pos
    b.setAttribute('aria-pressed', String(on))
    b.disabled = copper.length === 0
  })
  $('#resist-mixed').hidden = copper.length === 0 || neg || pos
}

function chip(label: string, checked: boolean, title: string, onchange: (v: boolean) => void): HTMLElement {
  return h(
    'label',
    { class: 'chip', title },
    h('input', { type: 'checkbox', checked, onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked) }),
    h('span', {}, label),
  )
}

function renderFilms(): void {
  const plotLayers = state.layers.filter((l) => l.type !== 'drill')
  const changed = (structural = false) => {
    if (structural) renderFilms()
    update()
  }
  $('#films').replaceChildren(
    ...state.films.map((f, i) => {
      const open = state.expanded.has(f.id)
      const layer = state.layers.find((l) => l.id === f.layerId)
      const setCopies = (n: number) => {
        f.copies = Math.max(0, Math.min(50, n))
        changed(true)
      }
      const head = h(
        'div',
        { class: 'film-head' },
        h(
          'label',
          { class: 'switch', title: f.enabled ? 'Printing: click to skip' : 'Skipped: click to print' },
          h('input', {
            type: 'checkbox',
            checked: f.enabled,
            'aria-label': `Print ${f.name}`,
            onchange: (e: Event) => {
              f.enabled = (e.target as HTMLInputElement).checked
              changed(true)
            },
          }),
          h('span', { class: 'knob' }),
        ),
        h('input', {
          class: 'name',
          value: f.name,
          'aria-label': 'Film name',
          title: layer ? `${layerName(layer)} · ${layer.filename}` : '',
          oninput: (e: Event) => {
            f.name = (e.target as HTMLInputElement).value
            update()
          },
        }),
        f.enabled
          ? h(
              'div',
              { class: 'stepper', title: 'Copies' },
              h('button', { 'aria-label': 'Fewer copies', disabled: f.copies <= 1, onclick: () => setCopies(f.copies - 1) }, '−'),
              h('span', { 'aria-live': 'polite' }, `${f.copies}`),
              h('button', { 'aria-label': 'More copies', disabled: f.copies >= 50, onclick: () => setCopies(f.copies + 1) }, '+'),
            )
          : null,
        h(
          'button',
          {
            class: `icon more ${open ? 'open' : ''}`,
            title: 'Layer and more',
            'aria-label': 'Layer and more',
            'aria-expanded': String(open),
            onclick: () => {
              if (open) state.expanded.delete(f.id)
              else state.expanded.add(f.id)
              renderFilms()
            },
          },
          '⋯',
        ),
      )
      const chips = f.enabled
        ? h(
            'div',
            { class: 'chips' },
            chip('Mirror', f.mirror, 'Mirror: on for top-side films so the toner faces the copper', (v) => {
              f.mirror = v
              changed()
            }),
            chip('Negative', f.negative, 'Negative: copper clear, rest black (dry-film resist)', (v) => {
              f.negative = v
              changed()
            }),
            chip('Drill dots', f.drillDots, 'Small centre dots in every hole, to guide the drill', (v) => {
              f.drillDots = v
              changed()
            }),
            chip('Outline', f.outline, 'Draw the board outline', (v) => {
              f.outline = v
              changed()
            }),
          )
        : null
      const more = open
        ? h(
            'div',
            { class: 'film-more' },
            h(
              'label',
              { class: 'mini' },
              'Layer',
              h(
                'select',
                {
                  onchange: (e: Event) => {
                    f.layerId = (e.target as HTMLSelectElement).value
                    changed(true)
                  },
                },
                ...plotLayers.map((l) => h('option', { value: l.id, selected: l.id === f.layerId }, `${layerName(l)} — ${l.filename}`)),
              ),
            ),
            h(
              'button',
              {
                class: 'link danger',
                onclick: () => {
                  state.films.splice(i, 1)
                  state.expanded.delete(f.id)
                  changed(true)
                },
              },
              'Remove film',
            ),
          )
        : null
      return h('div', { class: `film ${f.enabled ? '' : 'off'}` }, head, chips, more)
    }),
  )
}

$('#addFilm').addEventListener('click', () => {
  const l = state.layers.find((x) => x.type !== 'drill')
  if (!l) return
  state.films.push({ id: newId(), enabled: true, name: layerName(l), layerId: l.id, mirror: false, negative: false, drillDots: false, outline: true, copies: 1 })
  renderFilms()
  update()
})

document.querySelectorAll<HTMLButtonElement>('[data-resist]').forEach((b) =>
  b.addEventListener('click', () => {
    const neg = b.dataset.resist === 'neg'
    for (const f of state.films) {
      const l = state.layers.find((x) => x.id === f.layerId)
      if (l?.type === 'copper') f.negative = neg
    }
    renderFilms()
    update()
  }),
)

// ---------------------------------------------------------------- sheet settings
function segmented<T extends string>(label: string, value: T, options: Array<[T, string, string?]>, onpick: (v: T) => void): HTMLElement {
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    ...options.map(([v, text, title]) =>
      h('button', { 'aria-pressed': String(v === value), title: title ?? '', onclick: () => onpick(v) }, text),
    ),
  )
}

function numberField(label: string, value: number, step: number, min: number, title: string, onset: (v: number) => void): HTMLElement {
  return h(
    'label',
    { class: 'num', title },
    h('span', {}, label),
    h('input', {
      type: 'number',
      step,
      min,
      value,
      oninput: (e: Event) => onset(Math.max(min, +(e.target as HTMLInputElement).value || 0)),
    }),
  )
}

function group(title: string, ...kids: Array<HTMLElement | null>): HTMLElement {
  return h('div', { class: 'group' }, h('h3', {}, title), ...kids)
}

function renderSheet(): void {
  const s = state.settings
  const set = <K extends keyof Settings>(k: K, v: Settings[K], rerender = false) => {
    s[k] = v
    if (rerender) renderSheet()
    update()
  }
  const pageSel = h(
    'select',
    { 'aria-label': 'Page size', onchange: (e: Event) => set('page', (e.target as HTMLSelectElement).value as PageSize, true) },
    ...([['A4', 'A4'], ['A3', 'A3'], ['Letter', 'Letter'], ['Legal', 'Legal'], ['custom', 'Custom…']] as Array<[PageSize, string]>).map(([v, l]) =>
      h('option', { value: v, selected: s.page === v }, l),
    ),
  )
  const colsSel = h(
    'select',
    { 'aria-label': 'Columns', onchange: (e: Event) => set('columns', +(e.target as HTMLSelectElement).value) },
    ...[0, 1, 2, 3, 4, 5, 6].map((c) => h('option', { value: c, selected: s.columns === c }, c === 0 ? 'Auto' : `${c}`)),
  )
  $('#sheet').replaceChildren(
    group(
      'Page',
      h(
        'div',
        { class: 'line' },
        pageSel,
        segmented('Orientation', s.landscape ? 'l' : 'p', [['p', 'Portrait'], ['l', 'Landscape']], (v) => set('landscape', v === 'l', true)),
      ),
      s.page === 'custom'
        ? h(
            'div',
            { class: 'pair' },
            numberField('Width', s.customW, 1, 20, 'Page width in mm', (v) => set('customW', v)),
            numberField('Height', s.customH, 1, 20, 'Page height in mm', (v) => set('customH', v)),
          )
        : null,
    ),
    group(
      'Layout',
      h('div', { class: 'line' }, h('label', { class: 'inline' }, 'Columns', colsSel), chip('Rotate 90°', s.rotate, 'Turn boards sideways to fit more copies', (v) => set('rotate', v))),
      segmented(
        'Order',
        s.order,
        [
          ['pairs', 'Pairs', 'One copy of each film per row: top and bottom side by side'],
          ['grouped', 'Grouped', 'All copies of a film together'],
        ],
        (v) => set('order', v, true),
      ),
    ),
    group(
      'Spacing (mm)',
      h(
        'div',
        { class: 'quad' },
        numberField('Margin', s.margin, 0.5, 0, 'Blank border around the page', (v) => set('margin', v)),
        numberField('Border', s.tileMargin, 0.5, 0, 'Extra space around each board (black in negatives)', (v) => set('tileMargin', v)),
        numberField('Gap across', s.gapX, 0.5, 0, 'Between columns: room for crosses and cutting', (v) => set('gapX', v)),
        numberField('Gap down', s.gapY, 0.5, 0, 'Between rows: room for crosses and labels', (v) => set('gapY', v)),
      ),
    ),
    group(
      'Marks',
      h(
        'div',
        { class: 'chips' },
        chip('Fold line', s.foldLine, 'Dashed line between two columns of fold pairs', (v) => set('foldLine', v)),
        chip('Crosses', s.marks, 'Registration crosses at every corner', (v) => set('marks', v)),
        chip('Labels', s.labels, 'Film name under each copy', (v) => set('labels', v)),
        chip('50 mm bar', s.scaleBar, 'Measure it after printing to check the scale', (v) => set('scaleBar', v)),
      ),
      numberField('Drill dot (mm)', s.dotSize, 0.05, 0.05, 'Diameter of the drill-centre dots', (v) => set('dotSize', v)),
    ),
  )
}

// ---------------------------------------------------------------- preview + export
function update(): void {
  saveSettings()
  syncResist()
  const s = state.settings
  const lay = layout(state.films, state.layers, s)
  state.lay = lay
  state.page = Math.min(state.page, Math.max(0, lay.pages.length - 1))
  const [W, H] = pageSize(s)
  const b = lay.board
  const filmsOn = state.films.filter((f) => f.enabled && f.copies > 0).length
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  $('#summary').textContent = !state.layers.length
    ? 'No files loaded.'
    : b
      ? `Board ${(b.x1 - b.x0).toFixed(1)} × ${(b.y1 - b.y0).toFixed(1)} mm · ${plural(filmsOn, 'film')} · ${lay.cols} × ${lay.rows} per ${W.toFixed(0)} × ${H.toFixed(0)} mm page · ${plural(lay.pages.length, 'page')}`
      : 'No board outline or copper found.'
  $('#warnings').replaceChildren(...lay.warnings.map((w) => h('li', {}, w)))
  $('#pageno').textContent = lay.pages.length ? `${state.page + 1} / ${lay.pages.length}` : '–'
  ;($('#prev') as HTMLButtonElement).disabled = state.page <= 0
  ;($('#next') as HTMLButtonElement).disabled = state.page >= lay.pages.length - 1
  ;($('#pdf') as HTMLButtonElement).disabled = !lay.pages.length
  ;($('#svg') as HTMLButtonElement).disabled = !lay.pages.length
  const preview = $('#preview')
  if (!lay.pages.length) {
    preview.innerHTML = `<div class="empty">${state.layers.length ? 'Nothing to print: enable a film.' : 'Load Gerber files to see the sheet.'}</div>`
    return
  }
  const painter = new SvgPainter()
  drawLayout(painter, lay, state.layers, s, state.page)
  preview.innerHTML = painter.pages[0]
  const svg = preview.querySelector('svg')
  if (svg) {
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.style.aspectRatio = `${W} / ${H}`
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

async function buildPdf(): Promise<Blob | null> {
  if (!state.lay) return null
  const p = new PdfPainter()
  drawLayout(p, state.lay, state.layers, state.settings)
  return p.toBlob()
}

$('#pdf').addEventListener('click', async () => {
  const blob = await buildPdf()
  if (blob) download(blob, `${state.project}-films.pdf`)
})

$('#svg').addEventListener('click', () => {
  if (!state.lay) return
  const p = new SvgPainter()
  drawLayout(p, state.lay, state.layers, state.settings, state.page)
  download(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${p.pages[0]}`], { type: 'image/svg+xml' }), `${state.project}-films-p${state.page + 1}.svg`)
})

$('#prev').addEventListener('click', () => {
  state.page = Math.max(0, state.page - 1)
  update()
})
$('#next').addEventListener('click', () => {
  state.page += 1
  update()
})

renderSheet()
update()

// hook for automated checks; harmless in normal use
;(window as unknown as { gerberFilms: unknown }).gerberFilms = { handleFiles, buildPdf, state }
