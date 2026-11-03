/** One lazily rendered PDF page: canvas bitmap plus PDF.js's selectable text layer. */
import { memo, useEffect, useRef, useState } from 'react'
import { TextLayer } from './pdf.js'

/** Largest canvas area one page may allocate; PDF.js pages are rasterized to CSS pixels. */
const MAX_CANVAS_AREA = 16_777_216

/**
 * Render one page when it approaches the viewport and re-render it when the
 * fitted width changes while it is visible.
 * @param props.pdf - loaded PDF document proxy.
 * @param props.number - 1-based page number.
 * @param props.scale - current fit-width scale.
 * @param props.estimate - first page's base size, used as the placeholder before this page renders.
 * @param props.scrollRoot - the scrolling container used as the observer root.
 * @param props.t - locale lookup.
 */
export const PdfPage = memo(function PdfPage({ pdf, number, scale, estimate, scrollRoot, t }) {
  const hostRef = useRef(null)
  const canvasRef = useRef(null)
  const textRef = useRef(null)
  const renderedKey = useRef(null)
  const [requested, setRequested] = useState(number === 1)
  const [visible, setVisible] = useState(number === 1)
  const [size, setSize] = useState(null)
  const [status, setStatus] = useState('idle')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const node = hostRef.current
    if (node === null || typeof IntersectionObserver === 'undefined') {
      setRequested(true)
      setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver((entries) => {
      const intersecting = entries.some(entry => entry.isIntersecting)
      setVisible(intersecting)
      if (intersecting) setRequested(true)
    }, { root: scrollRoot.current, rootMargin: '600px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [scrollRoot])

  const renderKey = `${scale}:${attempt}`
  useEffect(() => {
    if (!requested || pdf === null) return undefined
    if (renderedKey.current === renderKey) return undefined
    // A page that already has a bitmap keeps it until it is visible again.
    if (renderedKey.current !== null && !visible) return undefined
    const lifetime = new AbortController()
    let page = null
    let task = null
    let layer = null
    const run = async () => {
      try {
        setStatus('rendering')
        page = await pdf.getPage(number)
        if (lifetime.signal.aborted) return
        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current
        const context = canvas === null ? null : canvas.getContext('2d')
        if (canvas === null || context === null) throw new Error('pdf-reader: the page has no 2D canvas')
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(MAX_CANVAS_AREA / (viewport.width * viewport.height)),
        )
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
        task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
        await task.promise
        if (lifetime.signal.aborted) return
        const container = textRef.current
        if (container === null) return
        container.replaceChildren()
        container.style.setProperty('--total-scale-factor', String(viewport.scale))
        container.style.setProperty('--scale-round-x', '1px')
        container.style.setProperty('--scale-round-y', '1px')
        layer = new TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container,
          viewport,
        })
        await layer.render()
        if (lifetime.signal.aborted) return
        renderedKey.current = renderKey
        setSize({ width: viewport.width, height: viewport.height })
        setStatus('ready')
      } catch (error) {
        if (lifetime.signal.aborted) return
        if (error !== null && typeof error === 'object'
          && (error.name === 'RenderingCancelledException' || error.name === 'AbortException')) return
        setStatus('error')
      } finally {
        if (page !== null) {
          try {
            page.cleanup()
          } catch {
            // A page already released by a cancelled load has nothing left to clean.
          }
        }
      }
    }
    void run()
    return () => {
      lifetime.abort()
      try {
        task?.cancel()
      } catch {
        // The render task already settled.
      }
      try {
        layer?.cancel()
      } catch {
        // The text layer already settled.
      }
    }
  }, [requested, pdf, number, scale, visible, attempt, renderKey])

  const box = size ?? {
    width: (estimate?.width ?? 600) * scale,
    height: (estimate?.height ?? 800) * scale,
  }
  const failed = size === null && status === 'error'

  return (
    <div
      ref={hostRef}
      className="pdfr-page"
      data-pdf-page={number}
      style={{ width: `${box.width}px`, height: `${box.height}px` }}
    >
      <canvas ref={canvasRef} className="pdfr-canvas" aria-hidden="true" />
      <div ref={textRef} className="pdfr-textLayer" />
      {size === null && !failed && (
        <div className="pdfr-pageState" role="status">{t('rendering')}</div>
      )}
      {failed && (
        <div className="pdfr-pageState" role="alert">
          <span>{t('pageFailed')}</span>
          <button
            type="button"
            className="pdfr-link"
            onClick={() => {
              renderedKey.current = null
              setAttempt(value => value + 1)
            }}
          >
            {t('retry')}
          </button>
        </div>
      )}
    </div>
  )
})
