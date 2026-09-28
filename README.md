# Simple Issue Tracker

A simple self-hosted issue-and-resolution log for church production teams. It is intentionally not a helpdesk or ticketing system: volunteers can quickly record a production issue, leave the resolution blank, and update the entry after the fix is known.

## Features

- Single shared password, no user accounts
- Dark theme by default, with a light option
- Search, department filter, sorting, page-size controls, and pagination
- Submitter name, multi-department issue tagging, and pending/resolved status
- WYSIWYG issue and resolution editors with bold, italic, lists, and links
- Screenshot/file attachments for images and PDFs; paste a screenshot straight into the editor to attach it
- Edit conflict detection, and issues can be deleted from the edit page
- Files page with issue attachments grouped by department
- Settings for title, logo, departments, theme, and shared password
- Full zip backup export/import from Settings
- Automatic daily, weekly, or monthly server backups
- Footer with app version and branch metadata
- SQLite database with first-run migrations and seeded departments
- Docker Compose setup with persistent database, uploads, and logo storage

## Quick Start

Create a `docker-compose.yml` file:

```yaml
services:
  simple-issue-tracker:
    image: ghcr.io/thedinz/sit:latest
    container_name: simple-issue-tracker
    restart: unless-stopped
    ports:
      - "8080:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      DATA_DIR: /data
      TZ: America/Chicago # your local timezone, used for server-side dates
    volumes:
      - ./storage/db:/data/db
      - ./storage/uploads:/data/uploads
      - ./storage/logo:/data/logo
      - ./storage/backups:/data/backups
```

Start it:

```bash
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080).

Image tags:

```bash
docker pull ghcr.io/thedinz/sit:latest
docker pull ghcr.io/thedinz/sit:main
docker pull ghcr.io/thedinz/sit:dev
```

Default password:

```text
admin
```

After the first login the app sends you to **Settings** and blocks everything else until you choose a new shared password (at least 8 characters). Changing the password later signs out every other device, which is the way to cut off someone who should no longer have access.

After 10 wrong passwords from the same address, logins from that address are paused for 15 minutes.

## Persistent Data

Docker Compose stores app data in local folders:

```text
./storage/db       SQLite database
./storage/uploads  Uploaded screenshots/files
./storage/logo     Uploaded app logo
./storage/backups  Scheduled full zip backups
```

The app container uses `/data/db`, `/data/uploads`, `/data/logo`, and `/data/backups` internally.

Settings includes a full zip backup tool. The backup contains a SQLite snapshot, app settings, departments, issues, uploaded attachments, and logo files. Keep backup files private because they include the stored shared-password hash. Backups never include this server's session secret, so a leaked backup cannot be used to forge a login.

## Docker Compose Example

Use this `docker-compose.yml` as-is, or adjust the host port and storage paths for your server. To test the development branch image, change `latest` to `dev`.

```yaml
services:
  simple-issue-tracker:
    image: ghcr.io/thedinz/sit:latest
    container_name: simple-issue-tracker
    restart: unless-stopped
    ports:
      - "8080:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      DATA_DIR: /data
      TZ: America/Chicago # your local timezone, used for server-side dates
    volumes:
      - ./storage/db:/data/db
      - ./storage/uploads:/data/uploads
      - ./storage/logo:/data/logo
      - ./storage/backups:/data/backups
```

## Backups

From **Settings > Full Backups**, you can:

- Choose an automatic backup schedule: daily, weekly, or monthly
- Click Backup Now to create a stored server backup zip
- Download a fresh full backup zip
- Restore by uploading a Simple Issue Tracker backup zip. The current data is saved first as a "Before restore" backup, so a restore can be undone
- Download or delete any stored backup

Scheduled backups keep the newest 30 and "Before restore" backups keep the newest 5. Manual backups stay until you delete them.

Stored server backups are written to:

```text
./storage/backups
```

The backup zip includes:

```text
database/simple_issue_tracker.sqlite
uploads/
logo/
manifest.json
metadata/records.json
```

To back up the app outside the UI, back up the whole `storage` folder:

```bash
tar -czf simple-issue-tracker-backup.tgz storage
```

That includes the SQLite database, uploaded attachments, logo, and stored backup zips. To restore the whole folder manually, stop the container, replace the `storage` folder, then start it again.

```bash
docker compose down
tar -xzf simple-issue-tracker-backup.tgz
docker compose up -d
```

For a live SQLite backup, you can also run:

```bash
sqlite3 storage/db/simple_issue_tracker.sqlite ".backup 'simple_issue_tracker_backup.sqlite'"
```

## Configuration

Optional environment variables in `docker-compose.yml`:

```text
PORT=3000
DATA_DIR=/data
TZ=America/Chicago
SESSION_SECRET=change-this-to-a-long-random-string
COOKIE_SECURE=false
TRUST_PROXY=
RUN_AS_ROOT=false
```

- `TZ`: timezone for dates the server formats. Browsers show dates in the viewer's own timezone, so this mainly affects backup times and pages viewed without JavaScript.
- `SESSION_SECRET`: if not provided, the app creates and stores a persistent session secret in SQLite on first run.
- `COOKIE_SECURE`: set to `true` when the app is only reached over HTTPS, so the login cookie is never sent over plain HTTP.
- `TRUST_PROXY`: set when the app runs behind a reverse proxy (Nginx, Caddy, Traefik, Cloudflare Tunnel) so login logs and the login lockout see real visitor addresses. Use the number of proxies in front of the app, usually `1`. Leave it empty when the app is reached directly, otherwise visitors could fake their address.
- `RUN_AS_ROOT`: the container starts as root only to give the data folders to the unprivileged `node` user, then runs the app as that user. Set to `true` to skip that and keep running as root.

## Upgrading to 1.4

- Everyone is signed out once after the upgrade and needs to log in again.
- If the tracker still uses the default `admin` password, you will be asked to change it before continuing.
- The container now runs the app as the `node` user. On first start it changes ownership of the existing `storage` folders to that user automatically.
- Logout and "Download Fresh Zip" are now buttons that submit a form, so old bookmarks to `/logout` no longer work.

## Default Departments

Seeded on first run:

- Audio
- Visuals
- Lighting
- Streaming
- Stage
- Other

Departments can be added, renamed, and deleted from Settings. A department cannot be deleted while existing issues use it.

## Upload Rules

Allowed attachment types:

- jpg/jpeg
- png
- gif
- webp
- pdf

Logo uploads allow common image formats only.

## Local Development

```bash
npm install
npm run dev
```

Run the checks and tests:

```bash
npm run check
npm test
```

The development app runs on [http://localhost:3000](http://localhost:3000) by default and stores data in `./data`.

To build locally instead of using the published image:

```bash
docker build -t simple-issue-tracker:local .
```

## One-Command Production Start

```bash
docker compose up -d
```
