// Guards the type chain this plugin depends on.
//
// The plugin patches `ctx.subprocess.spawn` and rewrites tool schemas inside a
// waterfall. Both are checked only while the relevant declarations are
// installed, so the assertions below fail the build when a type-only dependency
// disappears — the alternative is a wrapper that quietly operates on `any` and
// stops matching the runtime.
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** `'ANY'` when a type collapsed to `any` (its declaration is gone). */
type Verdict<T> = 0 extends 1 & T ? 'ANY' : 'TYPED'

// The two service seats this plugin hangs off must stay typed at the Context.
export const subprocessSeat: Verdict<Context['subprocess']> = 'TYPED'
export const systemPromptSeat: Verdict<Context['systemPrompt']> = 'TYPED'

// The seam shapes the wrapper reads: a change here is a change in what runs.
export const spawnArgv: keyof SubprocessSpawnSpec = 'argv'
export const spawnCwd: keyof SubprocessSpawnSpec = 'cwd'
export const handleCollected: keyof SubprocessHandle = 'collected'
export const readerOffset: keyof SubprocessOutputReader = 'readFrom'

// The assembly the schema layer rewrites, and the field it widens.
export const assemblyTools: keyof PromptAssembly = 'tools'
export const schemaParameters: keyof ToolSchema = 'parameters'

// The wrapper type itself must stay callable, not `any`.
export const spawnType: Verdict<SubprocessHandle> = 'TYPED'
