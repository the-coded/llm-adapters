import { spawn } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnOptionsWithStdioTuple,
  StdioNull,
  StdioPipe,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** Killing a spawned CLI has to reach its children, not just the process this
 *  package started.
 *
 *  `proc.kill()` signals the direct child alone. A CLI that spawns anything of
 *  its own — and the `claude` CLI does, running tools and MCP servers — leaves
 *  those grandchildren alive, **holding the inherited stdout open**. The `close`
 *  event then never fires and the call never resolves: not a slow call, a hung
 *  one. Measured with a stub that spawns a long `sleep`: four minutes and
 *  counting, until it was killed by hand.
 *
 *  That made `StreamOptions.signal` fail at the one thing its own comment says
 *  it exists for — a client disconnect killing the spawned CLI rather than
 *  leaking it. It leaked exactly what it was written not to leak. For `opencode`
 *  the consequence is worse than a hang: it starts a **server**, so an orphan
 *  holds the port and the next run finds somebody else's server on it.
 *
 *  The fix is a process group. `detached: true` makes the child a group leader,
 *  and a negative pid signals the whole group.
 *
 *  **The cost of `detached`, which is counter-intuitive and bit us.** A new
 *  process group means the child is no longer in the terminal's **foreground**
 *  group — so a Ctrl-C at the terminal reaches this process and **not** the
 *  child. Before `detached`, the child shared the group and received the
 *  interrupt for free; after it, the child is protected from it. Measured on the
 *  harness: orphans after Ctrl-C went from two to one, which looked like half a
 *  fix and was actually a swapped mechanism — "the signal arrives and the
 *  grandchild survives" became "the signal never arrives".
 *
 *  **So whoever owns the process now has to install a handler.** That is not
 *  something an adapter can do for its host: a library that trapped SIGINT would
 *  be deciding an application's shutdown. The package installs none; a host
 *  that traps SIGINT/SIGTERM calls `shutdown()` below, which stops every
 *  process group this module spawned (the CLIs of in-flight calls and the
 *  shared `opencode serve`). `examples/run.ts` and `demo/server.mjs` both do
 *  it, and the demo matters more, because it can be holding an
 *  `opencode serve` whose orphan keeps a port.
 *
 *  **Declared limit: Windows.** `detached` means a new console there rather than
 *  a new process group, and a negative pid is not a valid target — so this falls
 *  back to signalling the direct child, with the original defect intact. Nobody
 *  has validated this package on Windows, and saying so beats pretending the
 *  fix is universal.
 */

const POSIX = process.platform !== "win32";

/** Spawn options that make the child a process-group leader where that exists. */
const groupSpawnOptions: Pick<SpawnOptions, "detached"> = { detached: POSIX };

/** Signals the child's whole process group, falling back to the child alone.
 *
 *  Never throws: a process that has already exited is the ordinary case at an
 *  abort, and an `ESRCH` escaping from a cleanup handler would replace a tidy
 *  cancellation with a crash. */
export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  try {
    // Negative pid = the group. Requires the child to be a group leader, which
    // is what `detached` above arranges.
    if (POSIX) process.kill(-pid, signal);
    else proc.kill(signal);
  } catch {
    // Already gone, or the group no longer exists. Try the direct child once,
    // then give up quietly.
    try {
      proc.kill(signal);
    } catch {
      /* nothing left to signal */
    }
  }
}

/** Every process-group leader this package started and that has not exited. */
const owned = new Set<ChildProcess>();

/** Spawns a process-group leader the package owns, and remembers it until it
 *  exits. One wrapper rather than a `track(proc)` after each spawn: a future
 *  spawn site cannot forget a call it never had to make. */
// Typed like Node's own `spawn` overloads, for the stdio shapes this package
// uses: the return type follows the stdio the call site asked for, so a piped
// stream is never "possibly null" and needs no assertion.
export function spawnGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioNull, StdioPipe>,
): ChildProcessByStdio<null, null, Readable>;
export function spawnGroup(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
export function spawnGroup(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const proc = spawn(command, args, { ...options, ...groupSpawnOptions });
  owned.add(proc);
  // `close` as well as `exit`: a spawn that fails (ENOENT) emits `error` and
  // `close` but never `exit`, and its entry would otherwise stay forever.
  const forget = () => owned.delete(proc);
  proc.once("exit", forget);
  proc.once("close", forget);
  return proc;
}

const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;

/** Resolves on `exit`, or when `ms` runs out (timer unref'd). */
function waitExit(procs: ChildProcess[], ms: number): Promise<void> {
  const pending = procs.filter(alive);
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    for (const p of pending) {
      p.once("exit", () => {
        if (--left === 0) done();
      });
    }
  });
}

let inFlight: Promise<void> | null = null;

/** Stops every process this package started and is still running: SIGTERM to
 *  each group, then SIGKILL to every one of those groups once `graceMs` has
 *  passed. `graceMs` that is not a finite number >= 0 (Infinity, NaN, a
 *  negative) means the default, 3000. Concurrent calls share one promise;
 *  never rejects. The package installs no signal handler, so a host that traps
 *  SIGINT/SIGTERM calls this. Windows: signals the direct child only (see
 *  `killProcessTree`). */
export function shutdown(options: { graceMs?: number } = {}): Promise<void> {
  if (inFlight) return inFlight;
  const g = options.graceMs;
  const graceMs = typeof g === "number" && Number.isFinite(g) && g >= 0 ? g : 3000;
  const run = (async () => {
    try {
      const procs = [...owned].filter(alive);
      for (const p of procs) killProcessTree(p, "SIGTERM");
      await waitExit(procs, graceMs);
      // Every snapshotted group, not only leaders still alive: a leader can die
      // on SIGTERM while a member that ignores it lives on in the same group.
      // A group whose last member is gone answers ESRCH, which
      // `killProcessTree` swallows.
      for (const p of procs) killProcessTree(p, "SIGKILL");
      await waitExit(procs, 1000);
    } catch {
      /* shutdown never rejects */
    }
  })();
  const settled = run.finally(() => {
    if (inFlight === settled) inFlight = null;
  });
  inFlight = settled;
  return settled;
}
