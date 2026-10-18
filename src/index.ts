/**
 * dsh-fs-search-plus — extend the built-in `glob` / `grep` tools from the outside.
 *
 * DSH ships both tools in `@deepseek-ai/dsh-tool-fs-search`, driven by the
 * packaged ripgrep binary through `ctx.subprocess.spawn()`, with a fixed argv
 * that this plugin widens. Nothing here registers a tool, replaces a tool
 * definition, or re-implements result parsing: the official tool keeps owning
 * its schema, argv skeleton, retention caps, formatting, and spill.
 *
 * ## Two layers, and why each one has to be where it is
 *
 * 1. **Schema layer** — `system-prompt/assemble` is a waterfall over the
 *    assembled prompt, and its return value is authoritative. Rewriting
 *    `assembly.tools` there is the only way to widen a *built-in* tool's
 *    parameters: `systemPrompt.tools()` appends a provider rather than
 *    shadowing one, and `orderTools` sorts without de-duplicating, so a second
 *    `grep` schema would be shown twice.
 *
 * 2. **argv layer** — `ctx.subprocess.spawn` is wrapped so every ripgrep run
 *    this plugin recognizes gets the caller's extra flags. The tool builds its
 *    argv immediately before spawning and reads the handle afterwards, so this
 *    is the one seam where both the request and the response are visible.
 *
 * ## Linking a spawn back to the model's arguments
 *
 * The wrapper has to know *which* `glob`/`grep` call a given spawn belongs to.
 * The obvious key — `exec.signal` — does not work in a real composition:
 * `@deepseek-ai/dsh-tool-call-timeout-policy` substitutes `exec.signal` inside
 * its own `tools/execute` wrapper, so the signal seen by `tools/pre-execute`,
 * by the tool body, and by `spawn` are three different objects. Instead, the
 * `tools/execute` listener opens an `AsyncLocalStorage` scope around `next()`;
 * the spawn inherits it across every `await` in between, including under
 * concurrency. A spawn with no store (the `bash` tool, a user plugin, anything
 * that is not these two tools) passes through untouched.
 *
 * ## What each flag can and cannot do
 *
 * `--follow`, `--ignore-case`, and `--type` change what ripgrep *walks and
 * matches*, so they need nothing but argv.
 *
 * The context flags (`-A` / `-B` / `-C`) do not: `grep` runs with `--json`, and
 * its `parseRecord` returns `undefined` for every record whose `type` is not
 * `match`, so `context` frames are silently dropped before formatting. Adding
 * them alone would cost time and return nothing. The wrapper therefore promotes
 * each `context` record to a `match` record in the collected stdout, which is
 * the only way a surrounding line can reach the model at all. Two consequences
 * are deliberate and documented in the README: those lines render exactly like
 * matching lines (`Line N: <text>`), and they count toward the reported match
 * total and the `grepMaxMatches` cap.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'dsh-fs-search-plus'

const LOG = '[fs-search-plus]'

/** How many `stat` calls the reorder keeps in flight. */
const STAT_CONCURRENCY = 32

/**
 * ripgrep's own diagnostics for something the CALLER has to fix, which stay
 * failures instead of being normalised away.
 *
 * Three exit-2 families exist, and only one of them is traversal damage:
 * - caller errors (a rejected pattern or glob, an unknown `--type`) — ripgrep
 *   prints a specific diagnostic and the model must see it. Reporting "no
 *   matches" for an unknown `--type` would claim the tree contains nothing when
 *   the query was simply invalid.
 * - a missing search root — also a caller error, but indistinguishable from
 *   traversal damage in stderr (both print `IO error for operation on`), so it is
 *   decided from the filesystem by {@link missingRoot}.
 * - an unreadable entry under `--follow` — the only family that is normalised.
 *
 * `unrecognized file type` belongs to the first group; it was missing here once,
 * which turned a typo in `type` into a confident "No matches found".
 */
const CALLER_ERROR = /regex parse error|error parsing glob|unrecognized file type/iu

/**
 * Whether an exit 2 run only tripped over entries it could not read (a dangling
 * link somewhere in the tree) rather than over something the caller has to fix.
 *
 * `runRipgrep` accepts only exit 0 and 1, so one broken link under `--follow`
 * discards an otherwise complete result and reports "search failed".
 * @param stderr - the retained diagnostic tail.
 */
function isTraversalOnlyFailure(stderr: string): boolean {
  return !CALLER_ERROR.test(stderr)
}

/**
 * Whether any root the caller spelled is absent.
 *
 * Decided before spawning so a genuinely wrong `path` keeps its failure instead
 * of being reported as an empty result.
 * @param argv - the ripgrep argv, binary first.
 * @param cwd - the directory ripgrep runs in.
 */
function missingRoot(argv: readonly string[], cwd: string): boolean {
  const separator = separatorIndex(argv)
  if (separator === -1) return false
  return argv.slice(separator + 1).some((root) => {
    try {
      return !existsSync(isAbsolute(root) ? root : resolve(cwd, root))
    } catch {
      return true
    }
  })
}

/**
 * Whether ripgrep produced any result record.
 *
 * `glob` prints one path per line; `grep` runs with `--json`, whose stream also
 * carries `begin` / `end` / `context` / `summary` frames, and a `summary` frame
 * is emitted even when nothing matched. The record type is read from the parsed
 * field rather than matched inside the text, so a search pattern containing the
 * word "summary" cannot be mistaken for a frame.
 * @param stdout - the complete collected stdout.
 */
function hasResultRecord(stdout: string): boolean {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('{')) {
      try {
        const record = JSON.parse(trimmed) as { type?: unknown }
        if (typeof record.type === 'string' && (record.type === 'summary' || record.type === 'end' || record.type === 'begin')) continue
      } catch {
        // Not a JSON frame; count it as output.
      }
    }
    return true
  }
  return false
}

/** The model-supplied arguments of the call being dispatched. */
interface CallScope {
  readonly tool: 'glob' | 'grep'
  readonly args: Record<string, unknown>
}

/**
 * The one piece of ambient state this plugin owns: which `glob`/`grep` call a
 * spawn belongs to. Keyed by async context rather than by any object identity,
 * because every identity-bearing field the registry hands out is either
 * replaced by another policy or not visible at the spawn.
 */
const currentCall = new AsyncLocalStorage<CallScope>()

/** Whether this argv is a ripgrep invocation; matched on the base name so no install path is spelled here. */
function isRipgrepArgv(argv: readonly string[] | undefined): boolean {
  const head = argv?.[0]
  return typeof head === 'string' && /(^|[\\/])rg(\.exe)?$/iu.test(head)
}

/** The index of the `--` separator, or `-1`. */
const separatorIndex = (argv: readonly string[]): number => argv.indexOf('--')

/**
 * Insert one flag before the `--` separator. Everything after the separator is
 * a path, so a trailing `--follow` would be searched for as a file name.
 */
function insertFlag(argv: readonly string[], flag: string): string[] {
  const next = [...argv]
  const separator = separatorIndex(next)
  if (separator === -1) next.push(flag)
  else next.splice(separator, 0, flag)
  return next
}

/**
 * Drop every `--sort` spelling from a glob argv.
 *
 * `glob` always appends `--sort=modified`, and ripgrep forces a single thread
 * whenever a sort is requested (`hiargs.rs`: `threads = if sort.is_some() { 1 }`
 * plus `assert_eq!(1, self.threads, "sorting implies single threaded")`). The
 * ordering is produced here instead, so the walk can stay parallel.
 * @param argv - the original vector.
 * @returns a vector without `--sort`, and whether any was present.
 */
function stripSort(argv: readonly string[]): { argv: string[]; sorting: boolean } {
  let sorting = false
  const kept: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--sort') {
      sorting = true
      i++ // drop the value too
      continue
    }
    if (arg.startsWith('--sort=')) {
      sorting = true
      continue
    }
    kept.push(arg)
  }
  return { argv: kept, sorting }
}

/**
 * The error raised for a model-supplied argument this plugin cannot honour.
 *
 * A plain `Error` is an ordinary tool argument error: the registry catches it,
 * reports it as the tool result's message, and the model can correct itself and
 * retry. That is the only acceptable outcome for a value whose type is wrong —
 * dropping it silently would run a *different* search than the one requested,
 * and changing it silently (a cap, a coercion) is the same problem.
 * @param name - the argument name as the schema spells it.
 * @param expected - what the schema accepts.
 * @param value - what arrived.
 */
function badArgument(name: string, expected: string, value: unknown): Error {
  return new Error(`${name} must be ${expected}, got ${JSON.stringify(value)}`)
}

/** A boolean argument, or `undefined` when absent. Throws when present and not a boolean. */
function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw badArgument(name, 'true or false', value)
  return value
}

/**
 * A positive-integer argument, or `undefined` when absent.
 *
 * No upper bound is imposed: ripgrep clamps context to the file's own length,
 * and the tool's `rawOutputMaxBytes` already rejects an oversized result with a
 * clear message. Silently capping a value the model supplied would change the
 * answer without saying so.
 */
function optionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw badArgument(name, 'a positive integer', value)
  }
  return value
}

/**
 * A ripgrep `--type` name, or `undefined` when absent.
 *
 * The character set is ripgrep's own type-name grammar. There is deliberately no
 * length cap: ripgrep validates the name against its built-in list and fails the
 * run for an unknown one, which the tool already surfaces as an argument error.
 */
const FILE_TYPE = /^[A-Za-z0-9_+-]+$/

/** A `--type` name, or `undefined` when absent. Throws when present and malformed. */
function optionalFileType(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !FILE_TYPE.test(value)) {
    throw badArgument('type', 'a ripgrep file type name such as "ts" or "py"', value)
  }
  return value
}

/**
 * Translate the model's `grep` extensions into ripgrep flags.
 * @param argv - the tool's own argv.
 * @param args - the call's arguments.
 * @returns the widened argv, and whether context frames have to be promoted.
 * @throws Error when a supplied argument has the wrong type.
 */
function addGrepFlags(argv: readonly string[], args: Record<string, unknown>): { argv: string[]; context: boolean } {
  // Validate everything before touching argv, so a rejected call changes nothing.
  const ignoreCase = optionalBoolean(args.ignoreCase, 'ignoreCase')
  const type = optionalFileType(args.type)
  const after = optionalCount(args.after, 'after')
  const before = optionalCount(args.before, 'before')
  const context = optionalCount(args.context, 'context')

  const flags: string[] = []
  // No duplicate guard on any of these: `buildGrepCommand` emits a fixed vector
  // (`--json`, `--regexp=`, an optional `--glob=`, then `--`), so nothing here can
  // already be present, and ripgrep accepts a repeated flag either way.
  if (ignoreCase === true) flags.push('--ignore-case')
  if (type !== undefined) flags.push(`--type=${type}`)
  if (after !== undefined) flags.push(`--after-context=${after}`)
  if (before !== undefined) flags.push(`--before-context=${before}`)
  if (context !== undefined) flags.push(`--context=${context}`)
  let next = [...argv]
  for (const flag of flags) next = insertFlag(next, flag)
  return { argv: next, context: after !== undefined || before !== undefined || context !== undefined }
}

/** One collected stream, re-read after the process settles. */
interface CollectedReader {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

/** The mutable side of a handle this plugin relies on. */
interface MutableHandle {
  collected?: { stdout?: CollectedReader; stderr?: CollectedReader }
}

/** Replace one collected stream with fixed text, keeping the reader contract. */
function replaceStdout(handle: unknown, text: string): void {
  const mutable = handle as MutableHandle
  const collected = mutable.collected
  if (collected === undefined) return
  collected.stdout = {
    readFrom: () => ({ text, nextOffset: text.length, lossy: false }),
  }
}

/** `mtime` for one path, `0` when it cannot be read (a dangling link, a file removed mid-walk). */
async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Reorder one glob result newest-first.
 *
 * `--sort=modified` is ascending, and `glob` has no reverse: the 100 paths it
 * keeps are the *oldest* ones. Statting the complete list and sorting it here
 * restores the order the tool's own description promises.
 *
 * Every path is statted, whatever the list length: the shipped tool promises
 * modification-time order unconditionally, so degrading to walk order above some
 * count would break that promise silently. Measured on 50,000 files, the whole
 * stat-and-sort pass costs ~0.4 s while ripgrep's own `--sort=modified` walk
 * costs ~1.2 s, so the parallel replacement stays ahead even at that size.
 * @param paths - ripgrep's paths, in walk order.
 * @param cwd - the directory ripgrep ran in; printed paths are resolved against it.
 * @returns the paths newest-first.
 */
async function newestFirst(paths: string[], cwd: string): Promise<string[]> {
  const stamped = paths.map((path) => ({ path, mtime: 0 }))
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= stamped.length) return
      const entry = stamped[index]
      if (entry === undefined) return
      entry.mtime = await mtimeOf(resolve(cwd, entry.path))
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, stamped.length) }, worker))
  // Stable sort: equal timestamps keep ripgrep's own order.
  stamped.sort((a, b) => b.mtime - a.mtime)
  return stamped.map((entry) => entry.path)
}

/**
 * Promote ripgrep's `context` records to `match` records.
 *
 * `grep`'s `parseRecord` drops every non-`match` record, so a context frame
 * that arrived intact still never reaches the model. Re-typing the record is
 * the only lever a patch has, and it keeps the payload (`data.path`,
 * `data.line_number`, `data.lines`) exactly as ripgrep reported it.
 * @param text - one complete `--json` stream.
 * @returns the rewritten stream, or `undefined` when nothing had to change.
 */
function promoteContext(text: string): string | undefined {
  let changed = false
  const lines = text.split('\n').map((line) => {
    if (line.length < 2 || line.charCodeAt(0) !== 0x7b /* { */) return line
    let record: { type?: unknown }
    try {
      record = JSON.parse(line) as { type?: unknown }
    } catch {
      return line
    }
    if (record === null || typeof record !== 'object' || record.type !== 'context') return line
    changed = true
    return JSON.stringify({ ...record, type: 'match' })
  })
  return changed ? lines.join('\n') : undefined
}

/**
 * Wrap `ctx.subprocess.spawn` so a `glob` / `grep` run carries the flags the
 * model asked for and returns results in the promised order.
 *
 * The handle is copied with its own descriptors rather than spread: spreading
 * would evaluate a getter-backed member once and freeze it, while the tool
 * reads `collected` after `done` settles.
 * @param sub - the subprocess service, patched in place.
 * @returns a disposer restoring the original method.
 */
function patchSpawn(sub: { spawn: (...args: never[]) => unknown }): () => void {
  const original = sub.spawn
  const wrapper = function (this: unknown, spec: { argv: readonly string[]; cwd?: string }) {
    const call = currentCall.getStore()
    if (call === undefined || !isRipgrepArgv(spec.argv)) return original.apply(this, [spec] as never)

    // Arguments were already validated in the `tools/execute` wrapper, so the
    // readers below can treat a present value as well-typed. `follow` defaults to
    // true: a search that silently ignores directory links finds nothing under a
    // junction and reports it as "no matches".
    const follow = call.args.follow !== false

    let argv = [...spec.argv]
    if (follow) argv = insertFlag(argv, '--follow')

    let sorting = false
    let context = false
    if (call.tool === 'glob') {
      const stripped = stripSort(argv)
      argv = stripped.argv
      sorting = stripped.sorting
    } else {
      const grep = addGrepFlags(argv, call.args)
      argv = grep.argv
      context = grep.context
    }

    // A root the caller spelled but that is not there is a caller error, not
    // traversal damage; decide it before spawning so the failure keeps its code.
    const cwd = spec.cwd ?? process.cwd()
    const rootMissing = follow && missingRoot(argv, cwd)

    const handle = original.apply(this, [{ ...spec, argv }] as never) as {
      done: Promise<unknown>
      collected?: { stdout?: CollectedReader; stderr?: CollectedReader }
    }

    const done = handle.done.then((outcome: unknown) => {
      const settled = outcome as { exitCode?: number | null; signal?: string | null }
      // Only a run this plugin made follow links can turn a broken link into
      // exit 2; without `--follow` an exit 2 is the caller's problem.
      if (!follow || rootMissing || settled.exitCode !== 2) return outcome
      const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      if (!isTraversalOnlyFailure(stderr)) return outcome
      const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
      // 0 = results came back, 1 = the search completed with none. Either way the
      // tool proceeds instead of discarding what it already collected.
      return { ...settled, exitCode: hasResultRecord(stdout) ? 0 : 1 }
    })

    if (!sorting && !context) {
      return Object.create(Object.getPrototypeOf(handle), {
        ...Object.getOwnPropertyDescriptors(handle),
        done: { value: done, enumerable: true, configurable: true, writable: true },
      })
    }

    const rewritten = done.then((outcome: unknown) => {
      const stream = handle.collected?.stdout
      if (stream === undefined) return outcome
      const read = stream.readFrom(0)
      // A lossy read is a truncated head, which is neither sortable nor parseable;
      // leave the official overflow handling to report it.
      if (read === undefined || read.lossy) return outcome
      if (read.text.length === 0) return outcome

      if (context) {
        const promoted = promoteContext(read.text)
        if (promoted !== undefined) {
          replaceStdout(handle, promoted)
          return outcome
        }
      }
      if (sorting) {
        const paths = read.text.split('\n').filter((line) => line.length > 0)
        return newestFirst(paths, cwd).then((ordered) => {
          replaceStdout(handle, `${ordered.join('\n')}\n`)
          return outcome
        })
      }
      return outcome
    })

    return Object.create(Object.getPrototypeOf(handle), {
      ...Object.getOwnPropertyDescriptors(handle),
      done: { value: rewritten, enumerable: true, configurable: true, writable: true },
    })
  }

  const hadOwn = Object.hasOwn(sub, 'spawn')
  sub.spawn = wrapper as never
  return () => {
    if (Object.getOwnPropertyDescriptor(sub, 'spawn')?.value === wrapper) {
      if (hadOwn) sub.spawn = original
      else delete (sub as { spawn?: unknown }).spawn
    }
  }
}

// ---------------------------------------------------------------- schema layer

const FOLLOW_DESCRIPTION =
  'Follow symbolic links and directory junctions while walking the tree. Defaults to true; pass false to search the literal tree only.'

/** The one description used for both tools' `follow` field verbatim. */
const EXTRA_PROPERTIES: Record<string, Record<string, unknown>> = {
  glob: {
    follow: { type: 'boolean', description: FOLLOW_DESCRIPTION },
  },
  grep: {
    follow: { type: 'boolean', description: FOLLOW_DESCRIPTION },
    ignoreCase: { type: 'boolean', description: 'Match case-insensitively.' },
    after: {
      type: 'number',
      description: 'Also return this many lines after each match. Those lines are reported like matches.',
    },
    before: {
      type: 'number',
      description: 'Also return this many lines before each match. Those lines are reported like matches.',
    },
    context: {
      type: 'number',
      description: 'Also return this many lines before and after each match. Those lines are reported like matches.',
    },
    type: {
      type: 'string',
      description: 'Restrict the search to one ripgrep file type, e.g. "ts", "py", "rust".',
    },
  },
}

/**
 * Add this plugin's fields to the two built-in tool schemas.
 *
 * The result is a new tool object with new `parameters`; the original objects
 * are left untouched, because the same definition is shared by every other
 * assembly of the same process. `required` is never written: every field here
 * is optional, and the official `pattern` requirement must stay exactly as it is.
 * @param assembly - the assembled prompt.
 * @returns the same assembly when neither tool is present or already widened.
 */
function widenSchemas(assembly: PromptAssembly): PromptAssembly {
  let changed = false
  const tools = assembly.tools.map((tool) => {
    const extra = EXTRA_PROPERTIES[tool.name]
    if (extra === undefined) return tool
    const parameters = tool.parameters
    if (parameters === null || typeof parameters !== 'object') return tool
    const properties = parameters['properties']
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return tool
    const existing = properties as Record<string, unknown>
    const additions: Record<string, unknown> = {}
    let missing = false
    for (const [key, value] of Object.entries(extra)) {
      if (Object.hasOwn(existing, key)) continue
      additions[key] = value
      missing = true
    }
    if (!missing) return tool
    changed = true
    return { ...tool, parameters: { ...parameters, properties: { ...existing, ...additions } } }
  })
  return changed ? { ...assembly, tools } : assembly
}

/**
 * Validate every argument this plugin interprets, before any work starts.
 *
 * Called from the `tools/execute` wrapper rather than from the spawn patch: a
 * throw from there becomes the failed tool result verbatim, while a throw from
 * the spawn is replaced by the tool's own "could not start" message.
 *
 * Validation is complete BEFORE `patchSpawn` builds argv, so the spawn-side
 * readers can rely on the values already being well-typed.
 * @param tool - which search tool is running; `type` is `grep`-only.
 * @param args - the call's arguments as the model sent them.
 * @throws Error naming the offending argument when a supplied value has the wrong type.
 */
function validateArguments(tool: 'glob' | 'grep', args: Record<string, unknown>): void {
  optionalBoolean(args.follow, 'follow')
  if (tool !== 'grep') return
  optionalBoolean(args.ignoreCase, 'ignoreCase')
  optionalFileType(args.type)
  optionalCount(args.after, 'after')
  optionalCount(args.before, 'before')
  optionalCount(args.context, 'context')
}

export function apply(ctx: Context): void {
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const assembled = await next()
    return widenSchemas(assembled)
  })

  // Opens the async scope every spawn of this call inherits. Only the two search
  // tools are scoped, so an unrelated rg run (the bash tool) is never touched.
  //
  // Arguments are validated HERE, not at the spawn: `runRipgrep` wraps any spawn
  // failure as `could not start its search command (ripgrep launch failed)` and
  // keeps the real reason in `cause`, which the model never sees. Throwing from
  // this wrapper instead makes the run fail with the message intact.
  ctx.on('tools/execute', (exec, next) => {
    const tool = exec.name
    if (tool !== 'glob' && tool !== 'grep') return next()
    const raw = exec.arguments
    const args = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    // Throws synchronously: the waterfall turns a listener throw into a failed
    // tool result carrying this message, which is what the model reads.
    validateArguments(tool, args)
    const scope: CallScope = { tool, args }
    return currentCall.run(scope, () => next())
  })

  ctx.inject(['subprocess'], (scope) => {
    const sub = scope.subprocess as unknown as { spawn: (...args: never[]) => unknown }
    if (typeof sub?.spawn !== 'function') {
      ctx.logger?.warn?.(`${LOG} ctx.subprocess.spawn is missing; glob/grep arguments are not applied`)
      return
    }
    const restore = patchSpawn(sub)
    ctx.logger?.info?.(`${LOG} patched glob/grep argv`)
    return restore
  })
}
