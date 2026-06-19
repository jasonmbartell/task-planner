# Contributing to Task Planner

Thanks for your interest in contributing! This guide covers how to set up the project and submit changes.

## Development Setup

**Prerequisites:** [Node.js 18 or newer](https://nodejs.org/) (bundles `npm`). Working on the native desktop build additionally needs the Rust toolchain and Tauri CLI — see [Prerequisites in the README](README.md#prerequisites).

```bash
git clone <repo-url>
cd task-planner
npm install
npm run dev
```

The dev server runs at [http://localhost:5173](http://localhost:5173).

## Google OAuth Setup (Optional)

Cloud sync requires Google OAuth credentials. This is only needed if you're working on the sync features.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Drive API**: APIs & Services → Library → search "Google Drive API" → Enable
4. Create OAuth credentials: APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Authorized JavaScript origins: `http://localhost:5173`
   - Authorized redirect URIs: `http://localhost:5173/auth/callback`
5. Copy the **Client ID** and **Client Secret**
6. Create a `.env.local` file in the project root:
   ```
   VITE_GOOGLE_CLIENT_ID=your_client_id_here
   VITE_GOOGLE_CLIENT_SECRET=your_client_secret_here
   ```
7. Configure the OAuth consent screen: APIs & Services → OAuth consent screen
   - User type: **External**
   - Add scope: `https://www.googleapis.com/auth/drive.appdata`
   - Add your Google email as a test user

The `.env.local` file is gitignored and will not be committed.

## Project Structure

See the [README](README.md) for a full file tree. Key areas:

- `src/components/` — React view components (Gantt, Calendar, Spreadsheet)
- `src/store/useStore.js` — Zustand store with all state and actions
- `src/storage/` — IndexedDB and cloud sync adapters
- `src/auth/` — OAuth PKCE flows
- `src/utils/` — Date helpers, merge logic, Obsidian sync

## Conventions

- Functional components with hooks. No class components.
- Dates stored as ISO 8601 strings (`YYYY-MM-DD`).
- IDs use nanoid: `task-{nanoid(8)}`, `sprint-{nanoid(8)}`, `proj-{nanoid(8)}`.
- Tailwind CSS utility classes only — no custom CSS unless absolutely necessary.
- Keep dependencies minimal. Prefer custom SVG over heavy chart libraries.

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run build` to verify the production build succeeds
4. Open a pull request with a clear description of what changed and why

## Migrations

Migrations added to `src/storage/migrations.js` must be idempotent. There's a
vitest guard in `src/storage/__tests__/migrations-idempotency.test.js` — add a
case for your new migration via `expect(myMigration).toBeIdempotent(input)`.

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Browser and OS version
- Steps to reproduce
