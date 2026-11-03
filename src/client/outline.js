/** PDF outline (table of contents) extraction, resolved to 1-based page numbers. */

/**
 * Read one outline tree into render-ready rows.
 *
 * Outline destinations are either named (resolved through `getDestination`) or
 * explicit arrays whose first entry is a page reference or a legacy page index.
 * Items with no destination but with children are kept as group headings.
 * @param {object} pdf - loaded PDF document proxy.
 * @returns {Promise<Array<object>>} root rows, each `{ id, title, page, depth, children }`.
 */
export async function loadOutline(pdf) {
  let raw
  try {
    raw = await pdf.getOutline()
  } catch {
    return []
  }
  if (!Array.isArray(raw) || raw.length === 0) return []
  const pages = new Map()
  const destinations = new Map()
  const pageOf = async (dest) => {
    try {
      let target = dest
      if (typeof target === 'string') {
        if (!destinations.has(target)) destinations.set(target, await pdf.getDestination(target))
        target = destinations.get(target)
      }
      if (!Array.isArray(target) || target.length === 0) return null
      const ref = target[0]
      // Legacy outlines store a 0-based page index instead of a reference.
      if (typeof ref === 'number' && Number.isFinite(ref)) return ref + 1
      if (ref === null || typeof ref !== 'object' || typeof ref.num !== 'number') return null
      const key = `${ref.num}:${ref.gen ?? 0}`
      if (!pages.has(key)) pages.set(key, await pdf.getPageIndex(ref))
      const index = pages.get(key)
      return Number.isFinite(index) ? index + 1 : null
    } catch {
      return null
    }
  }
  const walk = async (items, depth, prefix) => {
    const rows = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (item === null || typeof item !== 'object') continue
      const title = typeof item.title === 'string' ? item.title.replace(/\s+/gu, ' ').trim() : ''
      const page = item.dest === null || item.dest === undefined ? null : await pageOf(item.dest)
      const children = depth < 8 && Array.isArray(item.items) && item.items.length > 0
        ? await walk(item.items, depth + 1, `${prefix}${index}.`)
        : []
      if (title === '' && children.length === 0) continue
      rows.push({
        id: `${prefix}${index}`,
        title: title === '' ? '—' : title,
        page,
        depth,
        children,
      })
    }
    return rows
  }
  return walk(raw, 0, '')
}

/**
 * Depth-first list of rows that name a page, in document order.
 * @param {Array<object>} items - outline rows from {@link loadOutline}.
 * @returns {Array<object>} flat rows, each still carrying `depth` and `id`.
 */
export function flattenOutline(items) {
  const rows = []
  const visit = (list) => {
    for (const item of list) {
      if (item.page !== null) rows.push(item)
      if (item.children.length > 0) visit(item.children)
    }
  }
  visit(items)
  return rows
}
