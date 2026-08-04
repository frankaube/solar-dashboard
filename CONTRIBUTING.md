# Contributing

## Getting it running

```bash
pnpm install
pnpm --dir apps/api exec prisma generate
```

Node 22+ and pnpm 9. Then two terminals:

```bash
pnpm --filter api dev     # API on :3001
pnpm --filter web dev     # UI on :5173, proxying /api to :3001
```

No hardware needed — **Settings → Data → Enter demo mode** fills the app with about two
years of generated data. Nothing is scanned and no real device is touched.

## Tests

```bash
pnpm --filter api test          # unit and integration
pnpm --filter web test
scripts/test-updater.sh         # the updater, in a container (needs Docker)
scripts/test-release-artifact.sh   # a packaged release, installed for real
```

The last two are not optional extras. The updater is a root-owned shell script that
downloads a binary and replaces a running service; it cannot be covered by the unit tests
and it is the one place where a bug is a security bug. It runs in a throwaway Debian
container against a real minisign keypair, forcing each failure path in turn.

## What the tests are for

Most of the test names in this repository describe a **failure that actually happened**
rather than a feature. That is deliberate, and it is the most useful convention here: a
test called `refuses to touch an unstamped build` tells the next person why the branch
exists, which `should handle stamped=false` does not.

If you fix a bug, the test should say what went wrong, in the terms someone hitting it
would recognise.

## Things worth knowing before changing them

**Timezones.** Daily totals are bucketed by local calendar day, not UTC. Tests use
`Atlantic/Bermuda` — UTC-4 going to UTC-3 in summer — because an offset that large turns
accidental UTC arithmetic into a visibly wrong day instead of a silent pass.

**The diagnostic report** (`apps/api/src/system/diagnostic-report.ts`) is built to be
pasted in public. It takes a named input for every field it prints, so there is no path
from the settings table to the output. Adding a field means adding an input, deliberately.

**The updater never deletes data.** `data/` and `backups/` are excluded from every file
operation in both directions, including rollback and including a schema change. The tests
fingerprint both before and after every scenario rather than trusting the exclude list.

**Line endings.** `.sh`, `.service` and `.timer` files are LF via `.gitattributes` and CI
rejects a CR in any of them. A shebang followed by a carriage return makes Linux report
"not found" for a file that is plainly there.

## Pull requests

Say what broke and how you know it is fixed. A reproduction beats a description.

For anything touching the updater, packaging or the report, expect questions about the
failure case rather than the happy path — those are the parts where being wrong is
expensive and invisible.
