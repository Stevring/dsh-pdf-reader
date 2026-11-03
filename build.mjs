/**
 * Build the Client bundle for the PDF reader.
 *
 * The artifact is a CommonJS body wrapped in the DSH module-loader factory
 * handoff: platform modules (`react`, `react-dom`, …) resolve through the
 * injected `require`, everything else — including PDF.js and its worker source
 * — is inlined, so the plugin stays one self-contained file.
 *
 * PDF.js is taken from the DSH checkout's install because this package lives
 * outside the workspace and has no node_modules of its own. Point
 * `DSH_CHECKOUT` at a checkout whose install contains `pdfjs-dist`.
 */
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Checkout that owns the PDF.js install. Defaults to a sibling
 * `../deepseek-harness`; set `DSH_CHECKOUT` for any other layout.
 */
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'deepseek-harness')
if (!existsSync(join(DSH_CHECKOUT, 'node_modules'))) {
  throw new Error(`DSH_CHECKOUT does not look like an installed deepseek-harness checkout: ${DSH_CHECKOUT}\n`
    + 'Set DSH_CHECKOUT to the checkout whose node_modules contains pdfjs-dist.')
}
const PACKAGE = '@local/pdf-reader'

/** Shared browser module table; these specifiers stay `require(...)` calls in the bundle. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Load esbuild from the checkout when the package itself cannot resolve it. */
async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch {
    const store = join(DSH_CHECKOUT, 'node_modules', '.pnpm')
    const candidates = readdirSync(store)
      .filter(name => name.startsWith('esbuild@'))
      .sort()
      .reverse()
    for (const candidate of candidates) {
      try {
        return await import(pathToFileURL(join(store, candidate, 'node_modules', 'esbuild', 'lib', 'main.js')).href)
      } catch {
        // Try the next installed esbuild.
      }
    }
    throw new Error(`cannot resolve esbuild from ${DSH_CHECKOUT}`)
  }
}

/** Locate the PDF.js package installed by the DSH checkout. */
function findPdfjs() {
  const require = createRequire(join(DSH_CHECKOUT, 'package.json'))
  for (const anchor of [DSH_CHECKOUT, join(DSH_CHECKOUT, 'packages', 'client', 'ui-sidebar-documentpreview')]) {
    try {
      return dirname(require.resolve('pdfjs-dist/package.json', { paths: [anchor] }))
    } catch {
      // This anchor does not see pdfjs-dist; try the next one.
    }
  }
  const store = join(DSH_CHECKOUT, 'node_modules', '.pnpm')
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith('pdfjs-dist@')) continue
    const directory = join(store, entry, 'node_modules', 'pdfjs-dist')
    if (existsSync(join(directory, 'package.json'))) return directory
  }
  throw new Error(`cannot locate pdfjs-dist under ${DSH_CHECKOUT}; set DSH_CHECKOUT to a checkout with PDF.js installed`)
}

const PDFJS = findPdfjs()
const { build } = await loadEsbuild()

/** Resolve `pdfjs-dist/...` imports against the checkout install, and `...?raw` as a source string. */
const pdfjsPlugin = {
  name: 'pdfjs-from-checkout',
  setup(builder) {
    builder.onResolve({ filter: /^pdfjs-dist\// }, (args) => {
      const path = args.path.slice('pdfjs-dist/'.length)
      if (path.endsWith('?raw')) {
        return { path: join(PDFJS, path.slice(0, -'?raw'.length)), namespace: 'pdfjs-source' }
      }
      return { path: join(PDFJS, path), namespace: 'file' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'pdfjs-source' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

await build({
  bundle: true,
  entryPoints: ['src/client/index.jsx'],
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  // The bundle is a classic script fetched by the module loader, where
  // `import.meta` is a parse error; PDF.js only reads it on its Node path.
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '""' },
  legalComments: 'none',
  logLevel: 'info',
  plugins: [pdfjsPlugin],
  banner: {
    js: `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(PACKAGE)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;`,
  },
  footer: { js: '    return module.exports;\n  }\n});' },
})
