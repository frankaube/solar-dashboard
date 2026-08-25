import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  The shipped unit files, asserted as text. UPDATE_REPO lives in
  /etc/solar-dashboard/update.conf; if only the root-owned timer's unit reads it, the app
  reports "No update source configured" and stays up. No runtime test catches that, because
  the bug is in a unit file.
*/

const UNITS = join(__dirname, '../../../packaging/linux');
const read = (name: string): string => readFileSync(join(UNITS, name), 'utf8');

describe('solar-dashboard.service', () => {
  const unit = read('solar-dashboard.service');

  it('reads the same config file the updater reads', () => {
    // Both components resolve the release feed from UPDATE_REPO.
    expect(unit).toMatch(/^EnvironmentFile=-?\/etc\/solar-dashboard\/update\.conf$/m);
  });

  it('treats that file as optional', () => {
    // Docker and from-source installs have no /etc/solar-dashboard. Without the leading
    // dash systemd refuses to start the service at all.
    expect(unit).toMatch(/^EnvironmentFile=-\//m);
  });

  it('still runs unprivileged', () => {
    // Updates are a separate root oneshot precisely so this one need not be root.
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
