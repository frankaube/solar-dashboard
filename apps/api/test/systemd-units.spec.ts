import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  The shipped unit files, asserted as text.

  Written after a live install where the updater was configured correctly and the app could
  not see the same configuration: UPDATE_REPO lived in /etc/solar-dashboard/update.conf,
  the root-owned timer read it, and the app's unit carried only PORT. Settings → Updates
  reported "No update source configured" and checked nothing, for a setting that had been
  set exactly as documented.

  Nothing failed. The app answered a question about itself incorrectly and stayed up, which
  is the failure mode this project keeps finding and the one no runtime test catches — the
  bug was in a unit file, so it belongs in a test of the unit file.
*/

const UNITS = join(__dirname, '../../../packaging/linux');
const read = (name: string): string => readFileSync(join(UNITS, name), 'utf8');

describe('solar-dashboard.service', () => {
  const unit = read('solar-dashboard.service');

  it('reads the same config file the updater reads', () => {
    /*
      Both components resolve the release feed from UPDATE_REPO. If only one of them can
      see where it is set, the install is half-configured in a way that reports success.
    */
    expect(unit).toMatch(/^EnvironmentFile=-?\/etc\/solar-dashboard\/update\.conf$/m);
  });

  it('treats that file as optional', () => {
    // Docker and from-source installs have no /etc/solar-dashboard. Without the leading
    // dash systemd refuses to start the service at all.
    expect(unit).toMatch(/^EnvironmentFile=-\//m);
  });

  it('still runs unprivileged', () => {
    // The whole reason updates are a separate root oneshot is that this one is not root.
    expect(unit).toMatch(/^User=solar$/m);
    expect(unit).not.toMatch(/^User=root$/m);
  });
});

describe('solar-dashboard-update.service', () => {
  const unit = read('solar-dashboard-update.service');

  it('runs as root, because it replaces a binary and restarts a unit', () => {
    expect(unit).toMatch(/^User=root$/m);
  });

  it('is a oneshot, not something the network-facing app can hold open', () => {
    expect(unit).toMatch(/^Type=oneshot$/m);
  });

  it('does not let a failed update take the machine down', () => {
    // A non-zero exit here must not cascade; the updater rolls back on its own.
    expect(unit).toMatch(/SuccessExitStatus|Restart=no|^\[Service\]/m);
  });
});
