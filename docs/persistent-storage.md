# Keeping the data: the disk and DATA_DIR

Everything the site stores — rooms, the property details, bookings, guest
accounts, 2FA enrolment, and every uploaded photo — lives in one SQLite file.
Photos are BLOBs in the `images` table, not separate files, so that single file
is the whole site's state.

Keeping it needs **three** things, and missing any one of them loses data in a
way that looks identical from the outside:

| # | Requirement | Why |
| --- | --- | --- |
| 1 | A paid instance type | Free instances cannot attach a disk at all |
| 2 | A disk attached to the service | The container filesystem is rebuilt from the image on every deploy and restart |
| 3 | `DATA_DIR` pointing at the mount path | Otherwise the app writes to `<repo>/data` and never touches the disk |

Paying for a bigger plan is only step 1. A Starter service with no disk loses
data exactly as a free one does — and a Starter service *with* a disk but
without `DATA_DIR` loses it too, while the disk sits mounted and empty.

## What the blueprint sets

`render.yaml` now declares all three:

```yaml
    plan: starter
    disk:
      name: booking-data
      mountPath: /data
      sizeGB: 1
    envVars:
      - key: DATA_DIR
        value: /data
```

## Applying it to an existing service

Render does not always re-sync an existing service from a changed blueprint. If
the service was created before this change, set it up by hand and the two must
agree:

1. Service → **Settings** → **Disks** → **Add Disk**
   - Name: `booking-data`
   - Mount path: `/data`
   - Size: 1 GB
2. Service → **Environment** → add `DATA_DIR` = `/data`
3. **Manual Deploy** → *Deploy latest commit*

The mount path and `DATA_DIR` must be the same string. If the disk is mounted
at `/data` and `DATA_DIR` says `/var/data`, the app writes to a directory on the
container and everything is lost on the next deploy — with no error anywhere,
because writing there succeeds.

## Confirming it worked

After the deploy, add a room through the dashboard, then trigger a **Manual
Deploy** and reload. The room is still there if storage is set up correctly.

That check matters because the failure is silent: the app recreates its schema
and re-seeds demo rooms on an empty database, so a site that has lost everything
looks like a working site rather than a broken one.

For a direct look, Render's shell (paid instances have one) shows the database
on the disk:

```bash
ls -la /data          # booking.db, booking.db-wal, booking.db-shm
```

If `booking.db` is somewhere else, `DATA_DIR` is not pointing at the mount.

## Things worth knowing

- **A disk means deploys have brief downtime.** A Render disk attaches to one
  instance at a time, so the old instance stops before the new one starts rather
  than overlapping. A few seconds per deploy.
- **Nothing migrates.** Data written before the disk existed is already gone;
  attaching one starts from empty. The owner account comes back automatically
  from `OWNER_EMAIL` / `OWNER_PASSWORD`, and the demo rooms re-seed once.
- **1 GB is generous.** Photos are capped at 2 MB each and are the only large
  content. Render can grow a disk later, but never shrink it.
- **A disk is not a backup.** It survives deploys and restarts, not an
  accidental delete. `sqlite3 /data/booking.db ".backup /tmp/backup.db"` from the
  Render shell, downloaded periodically, is worth doing before real bookings
  start arriving.
