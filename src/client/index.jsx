/**
 * Browser half: one right-Sidebar tab type that renders a local PDF, its guide
 * card, and a composer control that reveals it.
 *
 * The PDF is rendered by PDF.js inside this bundle, so the reader works without
 * moving files into the Session workspace and without a Host round trip. Quote
 * insertion goes through the composer's own `inputActions`, which gives the
 * draft its usual atomic quote node.
 */
import { BookIcon } from './icons.jsx'
import { ReaderBody } from './ReaderBody.jsx'
import { ReaderLauncher } from './ReaderLauncher.jsx'
import { CSS_TEXT } from './styles.js'
import { en, zh } from './locales.js'

/** Package identity: the Client bundle id, the tab type id, and every keyed seat key. */
const ID = '@local/pdf-reader'
/** Tab kind opened by the guide card and the composer control. */
const KIND = 'pdfReader'
/** Locale namespace owned by this plugin. */
const NS = 'pdfReader'

/** Services required before the seats and the type can register. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/**
 * Register the PDF reader type, its body, its guide card, and the composer entry.
 * @param ctx - browser plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pdf-reader: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = ID
    style.textContent = CSS_TEXT
    document.head.append(style)
    return () => { style.remove() }
  }, 'pdf-reader: styles')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: KIND,
    // Keeps the loaded document and its scroll position while the tab is hidden.
    keepMounted: true,
    title: () => t('title'),
    guide: [{
      id: 'open',
      order: 40,
      title: () => t('guideTitle'),
      description: () => t('guideDescription'),
      icon: BookIcon,
    }],
  }), 'pdf-reader: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ID,
    locale: NS,
  }, ReaderBody)), 'pdf-reader: reader body')
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: ID,
    order: 55,
    locale: NS,
  }, (props) => (
    <ReaderLauncher
      {...props}
      open={() => {
        try {
          ctx.sidebarRight.openTab(KIND)
        } catch {
          // No Session is on screen, so there is no right-Sidebar column to reveal.
        }
      }}
    />
  ))), 'pdf-reader: composer entry')
}
