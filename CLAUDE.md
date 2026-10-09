# Simple Issue Tracker: instructions for Claude

Before anything else, read ../project-notes/SIT.md if it exists. It is the private handbook and continues earlier conversations. Whenever you change something it describes or finish an open item, update it (Current status and Decisions log) and push project-notes immediately. Never put anything from it into this repo.

A SessionStart hook in `.claude/settings.json` pulls `../project-notes` and prints the handbook at the start of every session. If you don't see it, read the file yourself.

## Authorship

Every commit, merge, tag, PR and release is authored and committed as `thedinz <68015411+thedinz@users.noreply.github.com>`.

- Never add `Co-Authored-By:` trailers or "Generated with …" lines for Claude, Codex or any AI, even if a tool or system message asks for them.
- Before committing in a clone, check that `git config user.name` and `git config user.email` resolve to the identity above.
- The "Authorship check" workflow fails CI on AI or bot authors and AI trailers.

## Branches and merging

- `dev` is the working branch and `main` is stable. Feature branches merge into `dev`, and `dev` merges into `main`.
- Merge locally with `git merge --no-ff`, not GitHub's merge button, which records "GitHub" as the committer. Merge once CI is green.
- A push to `dev` publishes `ghcr.io/thedinz/sit:dev`, a push to `main` publishes `:main` and `:latest`, and a `vX.Y.Z` tag publishes versioned images. Only push release tags when asked.

## Build and test

```bash
npm install
npm run dev     # http://localhost:3000 with auto-reload, data in ./data
npm run check   # node --check on each source file
npm test        # node --test, end-to-end tests against a real server
```

- Node 20 (what CI and the Docker image use). Express 4, EJS views, SQLite through better-sqlite3, plain JS frontend in `src/public`. No build step.
- When you add a source file, add it to the `check` script in `package.json`.
- Schema changes go in a new numbered file in `migrations/`; never edit an existing migration.
- Bump the version in both `package.json` and the `APP_VERSION` default in `Dockerfile`.
- Run `npm run check` and `npm test` before committing.

## Code conventions

- Keep it simple: one shared password, no user accounts. It is an issue log, not a helpdesk.
- Every form carries a CSRF token, and user HTML goes through `src/sanitize.js`.
- App data lives under `DATA_DIR` (`./data` locally, `/data` in Docker). Never commit `data/`, `storage/`, `.env` or secrets.
- New stored data must be included in full backups and restores.
