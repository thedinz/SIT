# Simple Issue Tracker

A simple self-hosted issue-and-resolution log for church production teams. It is intentionally not a helpdesk or ticketing system: volunteers can quickly record a production issue, leave the resolution blank, and update the entry after the fix is known.

## Features

- Single shared password, no user accounts
- Dark theme by default, with a light option
- Search, department filter, sorting, page-size controls, and pagination
- WYSIWYG issue and resolution editors with bold, italic, lists, and links
- Screenshot/file attachments for images and PDFs
- Settings for logo, departments, theme, and shared password
- SQLite database with first-run migrations and seeded departments
- Docker Compose setup with persistent database, uploads, and logo storage

## Quick Start

```bash
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080).

If you are testing the current development branch:

```bash
git clone -b dev https://github.com/thedinz/SIT.git sit
cd sit
docker compose up -d
```

Default password:

```text
admin
```

Change the password from **Settings** after the first login.

## Persistent Data

Docker Compose stores app data in local folders:

```text
./storage/db       SQLite database
./storage/uploads  Uploaded screenshots/files
./storage/logo     Uploaded app logo
```

The app container uses `/data/db`, `/data/uploads`, and `/data/logo` internally.

## Docker Compose Example

Use this `docker-compose.yml` as-is, or adjust the host port and storage paths for your server:

```yaml
services:
  simple-issue-tracker:
    build: .
    container_name: simple-issue-tracker
    restart: unless-stopped
    ports:
      - "8080:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      DATA_DIR: /data
    volumes:
      - ./storage/db:/data/db
      - ./storage/uploads:/data/uploads
      - ./storage/logo:/data/logo
```

## Backups

To back up the app, back up the whole `storage` folder:

```bash
tar -czf simple-issue-tracker-backup.tgz storage
```

That includes the SQLite database, uploaded attachments, and logo. To restore, stop the container, replace the `storage` folder, then start it again.

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
SESSION_SECRET=change-this-to-a-long-random-string
COOKIE_SECURE=false
```

If `SESSION_SECRET` is not provided, the app creates and stores a persistent session secret in SQLite on first run.

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

The development app runs on [http://localhost:3000](http://localhost:3000) by default and stores data in `./data`.

## One-Command Production Start

```bash
docker compose up -d
```
