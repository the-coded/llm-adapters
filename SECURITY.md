# Security

## Reporting a vulnerability

Email **gabriel@laplanta.com.br**. Please do not open a public issue for a
vulnerability; a private report gives a fix a chance to exist before the problem
is public.

Include what you did, what happened, and which runtime and version you saw it
on. A reproduction matters more than a severity rating.

## What this package touches, and where the risk is

Two of the four adapters **spawn a local binary** — the `claude` and `opencode`
CLIs — with the calling process's own privileges. That is the sharp edge, and
the mitigations are deliberate rather than incidental:

- The binary is never resolved through a shell. A caller-supplied override is
  accepted only when it is an absolute path, so it cannot smuggle shell syntax
  or PATH tricks, and the fixed candidates are probed on the filesystem.
- The spawn environment is a narrow allowlist, not a copy of the parent's. The
  host's own API keys are not handed to a subprocess that can run tools.
- `signal` is honoured end to end, so a client disconnect kills the child rather
  than leaving it running with whatever access it had.

A caller still decides which binary path to trust, and that decision is outside
this package.

## Two properties worth knowing about

**Nothing this package returns carries the machine it ran on.** Error details
and thrown messages pass through a redactor: absolute path forms are matched by
shape, the running user's home and username are scrubbed, and API keys handed to
the library are registered and removed from any string on its way out. An error
message is the most likely thing to end up in a log, an issue or an error
tracker, which makes it as public as a commit and far more frequent.

**A key-shaped value cannot reach a versioned file.** A test walks every text
file in the repository, dotfiles and extensionless files included, and fails the
build if one appears; the same patterns run over the contents of everything the
published tarball would contain. `.env*` and `.npmrc` are ignored so the
question does not arise.

Both have declared limits, written where they are implemented rather than
summarised here, because a summary of a limit is how a limit gets overstated.

## Keys

Keys belong in the environment or in `~/.llm-adapters/config.json`, which is
written mode `0600` and **refused** if it is readable by group or other. They do
not belong in a file inside a repository. Nothing in this package logs a key,
and a key it has been given is scrubbed from what it returns.

## Supported versions

Pre-1.0. Fixes land on the latest version; there are no maintained release
branches yet.
