# Backups

Where a backup can go, how to restore one, and how to fill a gap in collection.

[← back to the README](../README.md)

---


Settings → Backup writes a consistent copy of the whole database — readings, panel
layout, rates, alert history — on a schedule, keeping the last N.

Frequency runs from every 6 hours to every 30 days. Daily and longer also take a
preferred hour, in your local time, and default to 03:00 — without one the
schedule drifts to whatever moment you happened to press Save, which for most
people is the middle of the afternoon. Shorter intervals just count elapsed time;
an hour would mean nothing to them.

Nothing is scheduled with cron. The app checks every 15 minutes whether the last
*successful* backup is older than the interval, so a reboot or a redeploy cannot
silently end the schedule — at worst it delays a run by a quarter hour. A failed
attempt does not count as a run, so a destination that was unreachable at 03:00
is retried rather than shelved until tomorrow.

Three destinations:

- **A folder** — a USB disk, a NAS, or any share the host has mounted. In Docker
  the folder must also be mounted *into* the container, which is what `BACKUP_DIR`
  in `.env` does; it lands on `/backups` inside, so enter `/backups` in the form.
- **S3-compatible** — Backblaze B2, Wasabi, Cloudflare R2, MinIO or AWS.
- **Google Drive** — a folder in your own Drive, via an OAuth client you create.

Your keys stay on this machine and are used only to upload. Restoring is a file
copy: stop the stack, replace `solar.db` in the `solardata` volume with a backup,
start it again.

## Cloudflare R2 (the cheap default)

Fourteen daily snapshots is well under 100 MB, which fits inside R2's free tier
and stays there. Backblaze B2 and Wasabi work identically — only the endpoint
changes.

1. Cloudflare dashboard → **R2** → **Create bucket**, e.g. `solar-backups`.
2. **Manage R2 API Tokens** → create a token with **Object Read & Write**,
   scoped to that bucket. Copy the access key ID and secret — the secret is
   shown once.
3. Note the S3 endpoint on the bucket page:
   `https://<account-id>.r2.cloudflarestorage.com`.
4. Settings → Backup → **S3-compatible**. Endpoint as above, your bucket, region
   `auto`, the two keys, and any folder name you like. **Test destination**
   writes and deletes a marker file, so a green result means the credentials
   really can write.

## Google Drive

More setup than R2, because Drive has no static keys — it needs an OAuth client
that only you can create.

1. [console.cloud.google.com](https://console.cloud.google.com) → new project →
   **APIs & Services** → enable the **Google Drive API**.
2. **OAuth consent screen** → External. Add yourself as the only user.
   **Publish it to Production.** While it sits in Testing, Google revokes the
   authorisation after 7 days and your backups stop — the app names this
   specifically if it happens, but publishing avoids it. The app asks only for
   the `drive.file` scope, which is non-sensitive, so publishing does not put you
   through Google's verification review.
3. **Credentials** → Create OAuth client ID → **Web application**. Under
   *Authorised redirect URIs*, paste the URI the Backup card displays —
   `http://localhost:8080/api/backup/oauth/google/callback`.
4. Paste the client ID and secret into Settings → Backup → Google Drive, press
   **Save**, then **Connect Google Drive**.

Two constraints worth knowing before you start. Google only permits an insecure
redirect back to `localhost`, so the connect step has to happen on the machine
running the dashboard — from elsewhere, forward the port first
(`ssh -L 8080:localhost:8080 user@host`) and use `http://localhost:8080/settings`.
And `drive.file` means the app can only ever see files it created itself, so it
cannot read, list or delete anything else in your Drive — including a folder of
the same name you made by hand.

Two things it does **not** cover. TeslaMate keeps its own Postgres database in a
separate container, so vehicle history is not in these snapshots. And a backup
written to a folder on the same disk as the database survives a bad deploy but not
a dead drive — point it somewhere else.

## Filling a collection gap

The dashboard only records what it managed to poll. If the machine sleeps through
a sunrise, the day's kWh total survives — the gateway's counter is cumulative and
lives on the gateway — but the five-minute power history has a hole.

A vendor cloud export can fill it:

```bash
node scripts/import-cloud-readings.mjs export.tsv --date 2026-07-29 --zone America/Toronto --dry-run
```

Imported rows are stored with `source = 'cloud'`, never blended silently into
your own readings — the power API tags them, so a chart or an audit can always
tell which points the app actually observed. The import refuses to write where a
real reading already exists, so re-running it is a no-op rather than a duplicate,
and `--undo --date <date>` removes exactly what it added.

Energy for imported points is integrated from the export rather than taken from
it (the export carries power only), so every imported value sits below the
gateway's own daily counter and importing cannot inflate the day's total.

---
