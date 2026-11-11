// Read Gerber / Excellon files (loose or zipped), identify layers, plot them.
import JSZip from 'jszip'
import { parse } from '@tracespace/parser'
import { plot } from '@tracespace/plotter'
import { identifyLayers } from '@tracespace/identify-layers'
import { imageBounds, toDrawables, toDrillMarks, type Bounds, type Drawable, type DrillMarks } from './geometry'

export type LayerType = 'copper' | 'soldermask' | 'silkscreen' | 'solderpaste' | 'drill' | 'outline' | 'drawing' | 'unknown'
export type LayerSide = 'top' | 'bottom' | 'inner' | 'all' | 'none'

export interface Layer {
  id: string
  filename: string
  type: LayerType
  side: LayerSide
  bounds: Bounds | null
  drawables: Drawable[]
  drill: DrillMarks | null
  warning?: string
}

const SKIP = /\.(gbrjob|pdf|txt|rpt|md|csv|pos|json|png|jpe?g|zip)$/i

async function expand(files: File[]): Promise<Array<{ name: string; text: string }>> {
  const out: Array<{ name: string; text: string }> = []
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f)
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || SKIP.test(entry.name) || /(^|\/)(__MACOSX|\.)/.test(entry.name)) continue
        out.push({ name: entry.name.split('/').pop() as string, text: await entry.async('string') })
      }
    } else if (!SKIP.test(f.name)) {
      out.push({ name: f.name, text: await f.text() })
    }
  }
  return out
}

export interface LoadResult {
  layers: Layer[]
  skipped: string[]
}

export async function loadFiles(files: File[]): Promise<LoadResult> {
  const sources = await expand(files)
  const ids = identifyLayers(sources.map((s) => s.name))
  const layers: Layer[] = []
  const skipped: string[] = []
  sources.forEach((src, i) => {
    try {
      const tree = parse(src.text)
      const img = plot(tree)
      const idt = ids[src.name] ?? { type: null, side: null }
      const isDrill = tree.filetype === 'drill'
      const type: LayerType = isDrill ? 'drill' : ((idt.type ?? 'unknown') as LayerType)
      const layer: Layer = {
        id: `L${i}`,
        filename: src.name,
        type,
        side: (idt.side ?? (isDrill ? 'all' : 'none')) as LayerSide,
        bounds: imageBounds(img),
        drawables: isDrill ? [] : toDrawables(img),
        drill: isDrill ? toDrillMarks(img) : null,
      }
      // the plotter ignores clear polarity (%LPC*%); say so instead of drawing it wrong
      if (/%LPC\*%/.test(src.text)) layer.warning = 'uses clear polarity (LPC), which is not supported: check the preview'
      layers.push(layer)
    } catch {
      skipped.push(src.name)
    }
  })
  const order: LayerType[] = ['copper', 'soldermask', 'silkscreen', 'solderpaste', 'outline', 'drill', 'drawing', 'unknown']
  const sideOrder: LayerSide[] = ['top', 'inner', 'bottom', 'all', 'none']
  layers.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || sideOrder.indexOf(a.side) - sideOrder.indexOf(b.side))
  return { layers, skipped }
}
