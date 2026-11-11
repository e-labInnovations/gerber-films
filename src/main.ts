import './style.css'
import { loadFiles, type Layer } from './load'
import { DEFAULT_SETTINGS, layout, pageSize, type Film, type Layout, type Settings } from './layout'
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
          <strong>Drop a Gerber zip or files here</strong>
          <span>or click to choose. KiCad, Eagle, Altium and EasyEDA names are recognised.</span>
        </label>
        <ul id="layers" class="layers"></ul>
      </section>
      <section>
        <h2>2. Films</h2>
        <div class="row resist">
          <span id="resist-label">Copper films:</span>
          <div class="segmented" role="group" aria-labelledby="resist-label">
            <button data-resist="neg" aria-pressed="false">Negative (dry film)</button>
            <button data-resist="pos" aria-pressed="false">Positive</button>
          </div>
          <span id="resist-mixed" class="mixed" hidden>mixed</span>
        </div>
        <div id="films"></div>
        <button id="addFilm" class="ghost" disabled>+ Add film</button>
      </section>
      <section>
        <h2>3. Sheet</h2>
        <div id="sheet" class="form"></div>
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
  state.project = (zip?.name ?? files[0].name).replace(/\.[^.]+$/, '').replace(/[-_](F|B)[-_.].*$/i, '') || 'board'
  const res = await loadFiles(files)
  state.layers = res.layers
  state.skipped = res.skipped
  state.films = presetFilms(res.layers)
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
  ;($('#addFilm') as HTMLButtonElement).disabled = !state.layers.length
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

function renderFilms(): void {
  const plotLayers = state.layers.filter((l) => l.type !== 'drill')
  $('#films').replaceChildren(
    ...state.films.map((f, i) => {
      const set = (k: keyof Film, structural = false) => (e: Event) => {
        const t = e.target as HTMLInputElement
        const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Math.max(0, Math.floor(+t.value || 0)) : t.value
        ;(f as unknown as Record<string, unknown>)[k] = v
        if (structural) renderFilms()
        update()
      }
      const check = (k: keyof Film, label: string, title: string) =>
        h('label', { class: 'chk', title }, h('input', { type: 'checkbox', checked: f[k] as boolean, onchange: set(k) }), label)
      const remove = () => {
        state.films.splice(i, 1)
        renderFilms()
        update()
      }
      return h(
        'div',
        { class: `film ${f.enabled ? '' : 'off'}` },
        h(
          'div',
          { class: 'film-head' },
          h('input', { type: 'checkbox', checked: f.enabled, title: 'Print this film', onchange: set('enabled', true) }),
          h('input', { class: 'name', value: f.name, 'aria-label': 'Film name', oninput: set('name') }),
          h('label', { class: 'copies', title: 'Copies' }, '×', h('input', { type: 'number', min: 0, max: 50, value: f.copies, oninput: set('copies') })),
          h('button', { class: 'icon', title: 'Remove film', 'aria-label': 'Remove film', onclick: remove }, '✕'),
        ),
        h(
          'div',
          { class: 'film-opts' },
          h(
            'select',
            { onchange: set('layerId'), 'aria-label': 'Layer' },
            ...plotLayers.map((l) => h('option', { value: l.id, selected: l.id === f.layerId }, `${layerName(l)} — ${l.filename}`)),
          ),
          check('mirror', 'Mirror', 'Mirror: on for top-side films so the toner faces the copper'),
          check('negative', 'Negative', 'Negative: copper clear, rest black (dry-film resist)'),
          check('drillDots', 'Drill dots', 'Small centre dots in every hole, to guide the drill'),
          check('outline', 'Outline', 'Draw the board outline'),
        ),
      )
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
type Field =
  | { k: keyof Settings; label: string; kind: 'number'; step?: number; min?: number; hint?: string }
  | { k: keyof Settings; label: string; kind: 'check'; hint?: string }
  | { k: keyof Settings; label: string; kind: 'select'; options: Array<[string, string]> }

const FIELDS: Field[] = [
  { k: 'page', label: 'Page', kind: 'select', options: [['A4', 'A4'], ['A3', 'A3'], ['Letter', 'Letter'], ['Legal', 'Legal'], ['custom', 'Custom']] },
  { k: 'customW', label: 'Width (mm)', kind: 'number', step: 1, min: 20 },
  { k: 'customH', label: 'Height (mm)', kind: 'number', step: 1, min: 20 },
  { k: 'landscape', label: 'Landscape', kind: 'check' },
  { k: 'rotate', label: 'Rotate boards 90°', kind: 'check' },
  { k: 'margin', label: 'Page margin (mm)', kind: 'number', step: 0.5, min: 0 },
  { k: 'columns', label: 'Columns (0 = auto)', kind: 'number', step: 1, min: 0 },
  { k: 'gapX', label: 'Gap across (mm)', kind: 'number', step: 0.5, min: 0, hint: 'Room for crosses and cutting' },
  { k: 'gapY', label: 'Gap down (mm)', kind: 'number', step: 0.5, min: 0, hint: 'Room for crosses and labels' },
  { k: 'tileMargin', label: 'Border round board (mm)', kind: 'number', step: 0.5, min: 0 },
  { k: 'dotSize', label: 'Drill dot size (mm)', kind: 'number', step: 0.05, min: 0.05 },
  { k: 'order', label: 'Order', kind: 'select', options: [['pairs', 'Pairs: one of each film per row'], ['grouped', 'Grouped: all copies of a film together']] },
  { k: 'foldLine', label: 'Fold line', kind: 'check' },
  { k: 'marks', label: 'Registration crosses', kind: 'check' },
  { k: 'labels', label: 'Labels', kind: 'check' },
  { k: 'scaleBar', label: '50 mm check bar', kind: 'check' },
]

function renderSheet(): void {
  const s = state.settings
  $('#sheet').replaceChildren(
    ...FIELDS.filter((f) => s.page === 'custom' || (f.k !== 'customW' && f.k !== 'customH')).map((f) => {
      const id = `s-${f.k}`
      const onchange = (e: Event) => {
        const t = e.target as HTMLInputElement
        const v = f.kind === 'check' ? t.checked : f.kind === 'number' ? Math.max(f.min ?? 0, +t.value || 0) : t.value
        ;(s as unknown as Record<string, unknown>)[f.k] = v
        if (f.k === 'page') renderSheet()
        update()
      }
      let input: HTMLElement
      if (f.kind === 'select') {
        input = h('select', { id, onchange }, ...f.options.map(([v, l]) => h('option', { value: v, selected: s[f.k] === v }, l)))
      } else if (f.kind === 'check') {
        input = h('input', { id, type: 'checkbox', checked: s[f.k] as boolean, onchange })
      } else {
        input = h('input', { id, type: 'number', step: f.step ?? 1, min: f.min ?? 0, value: s[f.k] as number, oninput: onchange })
      }
      const hint = f.kind !== 'select' && f.hint ? h('small', {}, f.hint) : null
      return h('div', { class: `field ${f.kind}` }, h('label', { for: id }, f.label), input, hint)
    }),
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
