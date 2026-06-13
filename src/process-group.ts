import type { ChildProcess, SpawnOptions } from "node:child_process";

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
 *  be deciding an application's shutdown. `examples/run.ts` and
 *  `demo/server.mjs` both do it, and the demo matters more, because it can be
 *  holding an `opencode serve` whose orphan keeps a port.
 *
 *  **Declared limit: Windows.** `detached` means a new console there rather than
 *  a new process group, and a negative pid is not a valid target — so this falls
 *  back to signalling the direct child, with the original defect intact. Nobody
 *  has validated this package on Windows, and saying so beats pretending the
 *  fix is universal.
 */

const POSIX = process.platform !== "win32";

/** Spawn options that make the child a process-group leader where that exists. */
export const groupSpawnOptions: Pick<SpawnOptions, "detached"> = { detached: POSIX };

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
