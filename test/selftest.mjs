// Self-test for dsh-fs-search-plus against the official tools and services.
//
//   DSH_PACKAGES=<DSH install node_modules> node test/selftest.mjs
//
// Everything below is the real thing: a real cordis Context, the real tool
// registry, the real `glob`/`grep` plugins from `@deepseek-ai/dsh-tool-fs-search`,
// the real local subprocess provider, and the real timeout policy — the last one
// matters, because it is what replaces `exec.signal` and breaks the naive way of
// linking a spawn back to its arguments. Only `workingDirectory` and `spillStore`
// are supplied here, and the spill store is a spy so the test can prove the
// official spill still fires.
//
// Set DSH_BENCH=<dir> to also run the benchmark against a large real tree.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const PACKAGES = process.env.DSH_PACKAGES
if (!PACKAGES || !fs.existsSync(PACKAGES)) {
  console.log('set DSH_PACKAGES to the DSH installation node_modules directory')
  process.exit(2)
}
const anchor = pathToFileURL(path.join(PACKAGES, '__anchor__.js')).href
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (/^[@a-z]/i.test(specifier) && !specifier.startsWith('node:')) return next(specifier, { ...context, parentURL: anchor })
      throw error
    }
  },
})

const { Context } = await import('@deepseek-ai/cordis')
const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { default: LocalSubprocess } = await import('@deepseek-ai/dsh-subprocess-local')
const timeoutPolicy = await import('@deepseek-ai/dsh-tool-call-timeout-policy')
const fsSearch = await import('@deepseek-ai/dsh-tool-fs-search')
const plugin = await import('../lib/index.js')

let passed = 0
const failures = []
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++
  else failures.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`)
}
function checkThat(label, condition, detail) {
  if (condition) passed++
  else failures.push(`${label}${detail === undefined ? '' : `\n    ${detail}`}`)
}

// ---------------------------------------------------------------- fixtures
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-search-plus-')))
const mk = (...p) => {
  const d = path.join(tmp, ...p)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const write = (p, s = 'x\n') => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, s)
  return p
}
/** Write `p` with a modification time `ageSec` seconds in the past. */
const writeAged = (p, ageSec) => {
  write(p, 'x\n')
  const at = Date.now() / 1000 - ageSec
  fs.utimesSync(p, at, at)
  return p
}

// 150 files under one directory: 001 is newest, 150 is oldest. `glob` keeps the
// first 100 of its own ascending order, so the unpatched tool reports 051..150 —
// the oldest 100 — despite its description promising modification-time order.
const many = mk('many')
for (let i = 1; i <= 150; i++) {
  const name = `${String(i).padStart(3, '0')}.txt`
  writeAged(path.join(many, name), (i - 1) * 60 + 60)
}

// A tree with content for the grep half: context lines, mixed case, two file types.
const tree = mk('tree')
write(path.join(tree, 'a.ts'), 'header\nconst Alpha = 1\nmiddle\nconst beta = 2\nfooter\n')
write(path.join(tree, 'b.ts'), 'alpha again\nsecond line\n')
write(path.join(tree, 'c.py'), 'ALPHA = 3\n')

// A symlink pointing outside the search root, so `--follow` is observable.
const linkedTarget = mk('target')
write(path.join(linkedTarget, 'inside.txt'), 'x\n')
let linkWorks = true
try {
  fs.symlinkSync(linkedTarget, path.join(tree, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
} catch {
  linkWorks = false
}

// ---------------------------------------------------------------- host
const spills = []
/** Every spec handed to the real provider, captured below the plugin's wrapper. */
const spawns = []
const lastSpawn = () => spawns[spawns.length - 1]
const resetSpawns = () => { spawns.length = 0 }

async function host() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(LocalSubprocess, {})
  await ctx.plugin(timeoutPolicy, {})
  ctx.provide('workingDirectory', { ensure: async () => tmp })
  ctx.provide('spillStore', {
    async saveText(save) {
      const locator = `SPILL://${spills.length}`
      spills.push({ content: save?.content ?? '', name: save?.suggestedName })
      return { locator, retrievalHint: 'read it with the read tool' }
    },
  })
  await ctx.plugin(fsSearch, { sampleOverCapGlobResults: false })

  // Installed BEFORE the plugin loads, so the plugin wraps this spy rather than
  // the other way round: every recorded spec is the one the provider actually
  // received. (`ctx.inject` runs as an effect, not inline with `ctx.plugin`, so
  // the wait below is what makes the ordering deterministic.)
  const providerSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const spy = (spec) => {
    spawns.push(spec)
    return providerSpawn(spec)
  }
  ctx.subprocess.spawn = spy

  await ctx.plugin(plugin, {})
  for (let i = 0; i < 200 && ctx.subprocess.spawn === spy; i++) await new Promise((r) => setTimeout(r, 5))
  return ctx
}

const ctx = await host()
const call = (name, args, extra = {}) =>
  ctx.get('tools').execute({
    name,
    arguments: args,
    callId: `${name}-${Math.random().toString(36).slice(2)}`,
    signal: new AbortController().signal,
    agent: { session: { header: { id: 'sess-selftest' } } },
    ...extra,
  })
const textOf = (result) => (result.isError ? `ERROR ${result.error?.message}` : (result.content?.[0]?.text ?? ''))

// ---------------------------------------------------------------- 1. schema
console.log('--- schema projection ---')
const assembly = await ctx.get('systemPrompt').assemble({})
const byName = new Map(assembly.tools.map((tool) => [tool.name, tool]))
const propsOf = (n) => Object.keys(byName.get(n)?.parameters?.properties ?? {})
check('glob gains exactly `follow`', propsOf('glob'), ['pattern', 'path', 'follow'])
check('grep gains the six fields', propsOf('grep'), ['pattern', 'path', 'include', 'follow', 'ignoreCase', 'after', 'before', 'context', 'type'])
check('glob required unchanged', byName.get('glob')?.parameters?.required, ['pattern'])
check('grep required unchanged', byName.get('grep')?.parameters?.required, ['pattern'])
check('glob had no duplicate schemas', assembly.tools.filter((t) => t.name === 'glob').length, 1)
check('grep had no duplicate schemas', assembly.tools.filter((t) => t.name === 'grep').length, 1)
// The official definition object must not have been mutated in place.
const officialGlob = ctx.get('tools').get('glob')
check('official glob definition untouched', Object.keys(officialGlob.parameters.properties), ['pattern', 'path'])

// ---------------------------------------------------------------- 2. argv
console.log('\n--- argv rewriting ---')
resetSpawns()
await call('glob', { pattern: '**/*.txt', path: 'many' })
const globArgv = lastSpawn().argv
checkThat('glob: --sort removed', !globArgv.some((a) => a === '--sort' || a.startsWith('--sort=')), JSON.stringify(globArgv.slice(1)))
checkThat('glob: --follow inserted', globArgv.includes('--follow'), JSON.stringify(globArgv.slice(1)))
checkThat(
  'glob: --follow before the -- separator',
  globArgv.indexOf('--follow') < globArgv.indexOf('--'),
  `follow@${globArgv.indexOf('--follow')} sep@${globArgv.indexOf('--')}`,
)
checkThat('glob: no -j / --threads added', !globArgv.some((a) => a === '-j' || a === '--threads' || a.startsWith('--threads=')), JSON.stringify(globArgv.slice(1)))

resetSpawns()
await call('grep', { pattern: 'alpha', path: 'tree' })
const grepArgv = lastSpawn().argv
checkThat('grep: --follow inserted', grepArgv.includes('--follow'), JSON.stringify(grepArgv.slice(1)))
checkThat('grep: --json still first after the binary', grepArgv[1] === '--no-config' && grepArgv[2] === '--json', JSON.stringify(grepArgv.slice(1)))

resetSpawns()
await call('grep', {
  pattern: 'alpha',
  path: 'tree',
  ignoreCase: true,
  after: 1,
  before: 2,
  context: 3,
  type: 'ts',
  follow: false,
})
const fullArgv = lastSpawn().argv
checkThat('grep: --ignore-case', fullArgv.includes('--ignore-case'), JSON.stringify(fullArgv.slice(1)))
checkThat('grep: --after-context=1', fullArgv.includes('--after-context=1'), JSON.stringify(fullArgv.slice(1)))
checkThat('grep: --before-context=2', fullArgv.includes('--before-context=2'), JSON.stringify(fullArgv.slice(1)))
checkThat('grep: --context=3', fullArgv.includes('--context=3'), JSON.stringify(fullArgv.slice(1)))
checkThat('grep: --type=ts', fullArgv.includes('--type=ts'), JSON.stringify(fullArgv.slice(1)))
checkThat('grep: follow=false omits --follow', !fullArgv.includes('--follow'), JSON.stringify(fullArgv.slice(1)))

resetSpawns()
await call('glob', { pattern: '**/*.txt', path: 'many', follow: false })
checkThat('glob: follow=false omits --follow', !lastSpawn().argv.includes('--follow'), JSON.stringify(lastSpawn().argv.slice(1)))

// ---------------------------------------------------------------- 3. ordering
console.log('\n--- glob ordering (150 files, 001 newest) ---')
const spillsBeforeOrdering = spills.length
const ordered = await call('glob', { pattern: '*.txt', path: 'many' })
const orderedLines = textOf(ordered).split('\n').filter((l) => l.endsWith('.txt'))
check('newest file first', orderedLines[0], path.join('many', '001.txt'))
check('descending through the second', orderedLines[1], path.join('many', '002.txt'))
checkThat('descending through the tenth', orderedLines[9] === path.join('many', '010.txt'), `got ${orderedLines[9]}`)

// ---------------------------------------------------------------- 4. spill
console.log('\n--- official spill still fires over the cap ---')
checkThat('150 hits exceed the 100 cap', orderedLines.length > 0)
const spillText = spills.length > spillsBeforeOrdering ? spills[spills.length - 1].content : ''
checkThat('spill content mentions SPILL://', textOf(ordered).includes('SPILL://'), textOf(ordered).slice(-200))
checkThat('spill holds all 150 paths', spillText.split('\n').filter((l) => l.endsWith('.txt')).length === 150, `${spillText.split('\n').filter((l) => l.endsWith('.txt')).length} paths`)
checkThat('spill is newest first too', spillText.split('\n')[0] === path.join('many', '001.txt'), spillText.split('\n')[0])
checkThat('inline page reports 100 of 150', textOf(ordered).includes('Showing 100 of 150 paths'), textOf(ordered).slice(-200))

// ---------------------------------------------------------------- 4b. large list
// The sort must not degrade above any count: the shipped tool promises
// modification-time order unconditionally.
console.log('\n--- glob ordering above any old threshold (60,000 files) ---')
const big = mk('big')
const BIG = 60000
const BIG_DIRS = 60
for (let d = 0; d < BIG_DIRS; d++) {
  const dir = path.join(big, `d${d}`)
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < BIG / BIG_DIRS; i++) {
    // newest in d0, oldest in d59 — the newest file lives in the first directory
    const name = `f${String(i).padStart(4, '0')}.txt`
    const p = path.join(dir, name)
    fs.writeFileSync(p, 'x')
    const at = Date.now() / 1000 - (d * 1000 + i)
    fs.utimesSync(p, at, at)
  }
}
const bigStarted = Date.now()
const bigResult = await call('glob', { pattern: '**/*.txt', path: 'big' })
const bigMs = Date.now() - bigStarted
const bigText = textOf(bigResult)
const bigSpill = spills[spills.length - 1]?.content ?? ''
const bigLines = bigSpill.split('\n').filter((l) => l.endsWith('.txt'))
checkThat('60,000 hits were not skipped', bigLines.length === BIG, `${bigLines.length} paths in spill`)
checkThat('first path is the newest', bigLines[0]?.includes(path.join('d0', 'f0000.txt')), bigLines[0])
checkThat('last path is the oldest', bigLines[bigLines.length - 1]?.includes(path.join('d59', 'f0999.txt')), bigLines[bigLines.length - 1])
checkThat('order is monotonically non-increasing', (() => {
  const mtimes = bigLines.map((p) => fs.statSync(path.join(tmp, p)).mtimeMs)
  return mtimes.every((m, i) => i === 0 || mtimes[i - 1] >= m)
})(), 'out of order')
console.log(`  (60,000 paths sorted in ${bigMs} ms)`)

// ---------------------------------------------------------------- 5. follow
console.log('\n--- follow semantics ---')
if (linkWorks) {
  const withFollow = await call('glob', { pattern: 'inside.txt', path: 'tree' })
  checkThat('follow=true sees through the link', textOf(withFollow).includes('inside.txt'), textOf(withFollow))
  const withoutFollow = await call('glob', { pattern: 'inside.txt', path: 'tree', follow: false })
  checkThat('follow=false does not', !textOf(withoutFollow).includes('inside.txt'), textOf(withoutFollow))
} else {
  console.log('  (skipped: this platform refused to create the link)')
}

// A dangling link under `--follow` makes ripgrep exit 2, which the tool maps to
// a failed search and throws the collected output away. The wrapper has to
// normalize exactly that case, and only that case.
console.log('\n--- a dangling link does not discard a completed search ---')
const broken = mk('broken')
write(path.join(broken, 'keep.txt'), 'keep\n')
let danglingWorks = true
try {
  fs.symlinkSync(path.join(broken, 'nope-does-not-exist'), path.join(broken, 'gone.txt'), 'file')
} catch {
  danglingWorks = false
}
if (danglingWorks) {
  const withDangling = await call('glob', { pattern: '*.txt', path: 'broken' })
  checkThat('dangling link: search still returns', !withDangling.isError && textOf(withDangling).includes('keep.txt'), textOf(withDangling))
  const grepDangling = await call('grep', { pattern: 'keep', path: 'broken' })
  checkThat('dangling link: grep still returns', !grepDangling.isError && textOf(grepDangling).includes('keep'), textOf(grepDangling))
} else {
  console.log('  (skipped: this platform refused to create the dangling link)')
}

// The other exit-2 cause is a caller error and must stay an error.
const missing = await call('glob', { pattern: '*.txt', path: 'no-such-directory' })
checkThat('missing search root still fails', missing.isError === true, textOf(missing))
checkThat('missing root failure names the cause', /no-such-directory/u.test(textOf(missing)), textOf(missing))

// A rejected pattern is a caller error too.
const badPattern = await call('grep', { pattern: '([', path: 'tree' })
checkThat('invalid regex still fails', badPattern.isError === true, textOf(badPattern))

// An unknown --type makes ripgrep exit 2 with "unrecognized file type". That is a
// caller error and must NOT be normalised into "No matches found" — the model
// would conclude the tree is empty when its query was simply invalid.
console.log('\n--- an unknown --type is a caller error, not an empty result ---')
const unknownType = await call('grep', { pattern: 'alpha', path: 'tree', type: 'notarealtype' })
checkThat('unknown type fails', unknownType.isError === true, textOf(unknownType))
checkThat('unknown type message names the cause', /unrecognized file type/u.test(textOf(unknownType)), textOf(unknownType))
const unknownTypeGlob = await call('glob', { pattern: '*.txt', path: 'tree' })
checkThat('a good call right after still works', unknownTypeGlob.isError === false, textOf(unknownTypeGlob))

// ---------------------------------------------------------------- 6. grep flags
console.log('\n--- grep flags take effect ---')
const caseSensitive = await call('grep', { pattern: 'ALPHA', path: 'tree' })
const caseInsensitive = await call('grep', { pattern: 'ALPHA', path: 'tree', ignoreCase: true })
const countOf = (r) => Number(/Found (\d+) match/.exec(textOf(r))?.[1] ?? -1)
checkThat('ignoreCase returns more', countOf(caseInsensitive) > countOf(caseSensitive), `${countOf(caseSensitive)} -> ${countOf(caseInsensitive)}`)

const typed = await call('grep', { pattern: 'alpha', path: 'tree', ignoreCase: true, type: 'py' })
checkThat('type=py only reports the .py file', textOf(typed).includes('c.py') && !textOf(typed).includes('b.ts'), textOf(typed))

const plain = await call('grep', { pattern: 'beta', path: 'tree' })
const withContext = await call('grep', { pattern: 'beta', path: 'tree', context: 1 })
check('context off: one match', countOf(plain), 1)
checkThat('context on: surrounding lines appear', countOf(withContext) > countOf(plain), textOf(withContext))
checkThat('context on: the next line is present', textOf(withContext).includes('footer'), textOf(withContext))
checkThat('context on: the previous line is present', textOf(withContext).includes('middle'), textOf(withContext))

// A value the model supplied must reach ripgrep unchanged: no silent cap.
console.log('\n--- context has no artificial ceiling ---')
resetSpawns()
await call('grep', { pattern: 'beta', path: 'tree', context: 10000 })
checkThat('context=10000 reaches argv verbatim', lastSpawn()?.argv.includes('--context=10000') === true, JSON.stringify(lastSpawn()?.argv))
resetSpawns()
await call('grep', { pattern: 'beta', path: 'tree', after: 999, before: 500 })
checkThat('after=999 reaches argv verbatim', lastSpawn()?.argv.includes('--after-context=999') === true, JSON.stringify(lastSpawn()?.argv))
checkThat('before=500 reaches argv verbatim', lastSpawn()?.argv.includes('--before-context=500') === true, JSON.stringify(lastSpawn()?.argv))
checkThat('a huge context still returns content (ripgrep clamps to the file)', (await call('grep', { pattern: 'beta', path: 'tree', context: 10000 })).isError === false)

// ---------------------------------------------------------------- 6b. bad types
// A wrong type must FAIL, not be dropped: a dropped `follow` would silently run
// the opposite of what was asked, and a dropped `context` would return matches
// without the surrounding lines the caller wanted.
console.log('\n--- a wrong argument type fails instead of being dropped ---')
const rejects = async (label, argName, args, expectInMessage) => {
  resetSpawns()
  const r = await call('grep', { pattern: 'beta', path: 'tree', ...args })
  checkThat(`${label} is an error`, r.isError === true, textOf(r))
  const msg = r.isError ? String(r.error?.message ?? '') : ''
  checkThat(`${label} names the argument`, argName === undefined || msg.includes(argName), msg)
  checkThat(`${label} explains the expectation`, expectInMessage === undefined || expectInMessage.test(msg), msg)
  checkThat(`${label} never reached ripgrep`, spawns.length === 0, JSON.stringify(spawns.map((s) => s.argv)))
  return msg
}

await rejects('follow:"no"', 'follow', { follow: 'no' }, /true or false/u)
await rejects('follow:0', 'follow', { follow: 0 }, /true or false/u)
await rejects('ignoreCase:"true"', 'ignoreCase', { ignoreCase: 'true' }, /true or false/u)
await rejects('context:"1"', 'context', { context: '1' }, /positive integer/u)
await rejects('context:1.5', 'context', { context: 1.5 }, /positive integer/u)
await rejects('context:-1', 'context', { context: -1 }, /positive integer/u)
await rejects('context:0', 'context', { context: 0 }, /positive integer/u)
await rejects('after:"3"', 'after', { after: '3' }, /positive integer/u)
// NaN / Infinity are not losslessly JSON-serializable, so the registry rejects
// them before this plugin ever sees the call; that is its own check, not ours.
await rejects('before:true', 'before', { before: true }, /positive integer/u)
await rejects('type:123', 'type', { type: 123 }, /file type name/u)
await rejects('type:"type script"', 'type', { type: 'type script' }, /file type name/u)

// A rejected call must leave the tool usable for the NEXT call.
resetSpawns()
const afterReject = await call('grep', { pattern: 'beta', path: 'tree', context: 1 })
checkThat('the tool still works after a rejected call', afterReject.isError === false, textOf(afterReject))
checkThat('a valid follow:false still drops the flag', (await (async () => {
  resetSpawns()
  await call('grep', { pattern: 'beta', path: 'tree', follow: false })
  return lastSpawn()?.argv.includes('--follow') === false
})()) === true)

// ---------------------------------------------------------------- 7. concurrency
console.log('\n--- two concurrent calls keep their own arguments ---')
resetSpawns()
await Promise.all([
  call('grep', { pattern: 'Alpha', path: 'tree', ignoreCase: false }),
  call('grep', { pattern: 'Alpha', path: 'tree', ignoreCase: true }),
])
const [first, second] = spawns
checkThat('both spawned', spawns.length === 2, `${spawns.length}`)
const firstHas = first?.argv.includes('--ignore-case')
const secondHas = second?.argv.includes('--ignore-case')
checkThat('exactly one run is case-insensitive', firstHas !== secondHas, `${String(firstHas)} vs ${String(secondHas)}`)

// ---------------------------------------------------------------- 8. passthrough
console.log('\n--- a non-search spawn passes through untouched ---')
resetSpawns()
const other = ctx.subprocess.spawn({
  argv: [process.execPath, '-e', 'process.stdout.write("hi")'],
  cwd: tmp,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
  graceMs: 1000,
})
const otherRead = await other.done.then(() => other.collected.stdout.readFrom(0))
await other.waitForExit?.()
check('unrelated spawn output intact', otherRead.text, 'hi')
checkThat('unrelated spawn got no --follow', !lastSpawn().argv.includes('--follow'))

// ---------------------------------------------------------------- 9. optional benchmark
const bench = process.env.DSH_BENCH
if (bench !== undefined && fs.existsSync(bench)) {
  console.log(`\n--- benchmark: ${bench} ---`)
  for (const pattern of ['**/*.cs', '**/*']) {
    const started = Date.now()
    const result = await call('glob', { pattern, path: bench })
    const elapsed = Date.now() - started
    const shown = /Showing (\d+) of (\d+)/.exec(textOf(result))
    console.log(`  ${pattern}: ${elapsed} ms, ${shown?.[2] ?? textOf(result).split('\n').length} hits`)
  }
}

// ---------------------------------------------------------------- report
console.log(`\n${passed} passed, ${failures.length} failed`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
