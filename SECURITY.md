# Security

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/frankaube/solar-dashboard/security/advisories/new)
rather than opening an issue. It reaches me directly and stays private until there is a
fix to point at.

This is a spare-time project by one person, so a realistic expectation: I will
acknowledge within about a week, and I would rather hear about something small than not
hear about it. If a report needs coordination on timing, say so and I will work to it.

## Verifying a release

Releases are signed with [minisign](https://jedisct1.github.io/minisign/). The public key
is:

```
RWTibUSAShw1bHcENASYGsL+zLe5BUag5lmrrbKINGIoA12OuO35HjIF
```

```bash
minisign -Vm SHA256SUMS -P RWTibUSAShw1bHcENASYGsL+zLe5BUag5lmrrbKINGIoA12OuO35HjIF
sha256sum -c SHA256SUMS --ignore-missing
```

That is also the value for `MINISIGN_PUBKEY` in `/etc/solar-dashboard/update.conf`. The
private half is not on any build machine and is not reachable by CI — the release workflow
produces a draft, and signing is a separate manual step.

Release artifacts additionally carry GitHub build provenance, which ties the bytes to a
commit and a workflow run:

```bash
gh attestation verify solar-dashboard-arm64.tar.gz -R frankaube/solar-dashboard
```

Worth being precise about what each one proves: the attestation says CI built these bytes
from that commit; the signature says the maintainer chose to publish them. Neither is a
substitute for the other, and the build is not bit-for-bit reproducible, so rebuilding
locally cannot confirm a published artifact.

## What this software is

A local-first dashboard for home solar, EV charging and smart plugs. It runs on your own
machine, holds no account, and is designed to be reachable only from your own network. It
is not hardened for exposure to the public internet, and putting it there is outside what
the design assumes — see below.

## Where the interesting surfaces are

If you are looking for somewhere to start, these are the parts where a mistake matters
most, and where I would most like a second pair of eyes.

**The updater** (`packaging/linux/update.sh`) downloads a file from the internet and
executes it as root. It is deliberately not part of the web app: the dashboard runs as an
unprivileged user that cannot write `/opt` or call `systemctl`, and a root-owned systemd
timer does the install. The app may write a file naming a version; that file carries a
version and nothing else, and the updater resolves the feed from its own root-owned
config and refuses unless what it independently finds matches. Builds are accepted only
on a minisign signature over `SHA256SUMS` verified against a configured key. **With no
key configured, nothing installs.**

**The diagnostic report** (`apps/api/src/system/diagnostic-report.ts`) exists to be
pasted into a forum thread, so it must never carry an address, a coordinate, a serial
number, a device name, a MAC, a credential or a dollar figure. It is built from named
inputs rather than from the settings table, so there is no path from a secret to the
output — and `apps/api/test/diagnostic-report.spec.ts` asserts it.

**The device scan** (`apps/api/src/devices/`) sends unsolicited traffic to addresses on
your local network. It is one pass, it only reads, and it never writes to a device it
finds.

**Credentials** — cloud API keys, S3 secrets, an OAuth refresh token — live in the
settings table and in `.env`. They are never printed in the report, never included in a
backup destination's metadata, and never sent anywhere but the service they belong to.

## Things that are not vulnerabilities

- **It has no authentication by default.** Anyone who can reach the port can use it, by
  design, the same as a printer's web page. Set `API_TOKEN` to require a token on any
  request that changes something.
- **Exposing it to the internet is unsupported.** If you forward a port to it, the
  consequences are yours. Use a VPN or a reverse proxy that handles authentication.
- **The Windows build is not code-signed**, so Windows warns about an unknown publisher.

## Supported versions

The latest release. This is a single-maintainer project; there is no back-porting.
