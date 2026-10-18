// Builds the published Host bundle from the TypeScript source.
//
//   src/index.ts → lib/index.js   ESM, loaded by the Host through Node
//
// Type checking is a separate step (`npm run typecheck`): tsc here only strips
// types, so a build never depends on the checker having passed.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'lib')
const ENTRY = 'index.ts'

const HOST = {
  target: ts.ScriptTarget.ES2024,
  // `transpileModule` sees one file and no package.json, so ESM has to be spelled
  // out here; NodeNext would fall back to CommonJS and break the package's exports.
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  verbatimModuleSyntax: false,
  sourceMap: false,
  declaration: false,
}

/** Compile one entry in memory and return the emitted JavaScript. */
async function emit(entry, options) {
  const file = join(ROOT, 'src', entry)
  const result = ts.transpileModule(await readFile(file, 'utf8'), { fileName: file, compilerOptions: options })
  if (result.diagnostics !== undefined && result.diagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    })
    throw new Error(formatted)
  }
  return result.outputText
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, 'index.js'), await emit(ENTRY, HOST), 'utf8')
console.log('built lib/index.js')
