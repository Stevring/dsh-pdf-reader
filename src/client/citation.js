/**
 * Quote text handed to the composer: a readable source line, then the passage.
 *
 * The agent learns which PDF is open from runtime context, so the quote itself
 * only names the file and the page; the document id never enters the draft.
 */

/**
 * @param {string | null} name - current PDF file name.
 * @param {number | null} page - 1-based page of the selection, or null.
 * @param {string} text - selected passage.
 * @returns `[PDF] <name> · p.<page>` followed by the passage.
 */
export function formatQuotedText(name, page, text) {
  const label = typeof name === 'string' ? name.trim() : ''
  const suffix = page === null || page === undefined ? '' : ` · p.${page}`
  return label === '' ? text : `[PDF] ${label}${suffix}\n${text}`
}
