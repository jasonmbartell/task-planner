# Task Planner

A responsive task planning application with Gantt charts, calendar views, and spreadsheet input. Built for solo founders managing multiple projects with sprint-based workflows. Available as a web app, installable PWA, and native desktop app (via Tauri).

## How It Works

All data lives on your device in IndexedDB — no account required, no data leaves your machine unless you explicitly connect cloud sync. The app organizes work in a **Projects → Sprints → Tasks** hierarchy. Each task carries a date range, status (todo / in-progress / done / blocked), and scoring fields for urgency, project impact, and difficulty to help you prioritize.

You view and edit tasks through three lenses: a **Gantt chart** for timeline planning, a **calendar** for due-date awareness, and a **spreadsheet** for bulk editing. Click any project in the sidebar to open its **dashboard** — a split view with its Gantt chart and spreadsheet together.

Optionally, connect **Google Drive** to sync across devices. To get tasks *in* from outside sources — meeting notes, transcripts, ad-hoc spreadsheets, brain-dump paragraphs — use the in-app **Ingest** modal, which runs an LLM-backed extractor and lets you review candidates before they hit the store.

## Features

- **Gantt Chart** — Horizontal timeline with zoom (day/week/month), color-coded by project, due date markers, dependency arrows (typed: hard / soft / preempts / deadline-independent rendered with distinct edge styles), critical path highlighting
- **Calendar View** — Week starts Monday, month/week toggle, tasks shown by due date
- **Spreadsheet View** — Sortable/filterable table with inline editing, CSV import/export, JSON backup export
- **Project Dashboard** — Click a project in the sidebar to see its Gantt chart and spreadsheet side-by-side
- **Ingest** — One-way pipeline that turns prose, transcripts, brain-dumps, or ad-hoc xlsx/csv spreadsheets into reviewable task candidates via an LLM extractor. Duplicate titles are auto-flagged. Reachable from the in-app Ingest modal or the agent `prose.ingest` op.
- **Task Model** — Start/end/due dates with automatic enforcement (`endDate == dueDate`, difficulty → duration days, hard-blocks cascade), typed dependency edges with cycle detection, urgency (1-10), importance (1-10), difficulty (1-10)
- **Hierarchy** — Projects → Sprints → Tasks with velocity tracking
- **Themes** — Apple HIG Light by default, plus user-editable CSS snippets in the Appearance panel (Obsidian-style)
- **Claude agent channel** — File-based inbox/outbox so a Claude session can apply ops, queue risky changes for review, and post a daily digest of what it did
- **Local-first persistence** — IndexedDB via idb, works fully offline
- **Cloud sync** — Optional Google Drive sync via OAuth PKCE (no backend)
- **Installable PWA** — Add to your taskbar on desktop or home screen on mobile, works offline with cached assets
- **Native desktop app** — Tauri v2 wrapper with system tray, auto-start, and the agent file-watcher channel
- **Keyboard shortcuts** — Power-user shortcuts for common actions
- **Zero server cost** — Static site, auth happens entirely in the browser

## Quick Start

### Prerequisites

- **Node.js 18 or newer** (20 LTS recommended) — bundles `npm`, which runs every script below. Install from [nodejs.org](https://nodejs.org/) or via [nvm](https://github.com/nvm-sh/nvm).
- **Desktop build only** — additionally:
  - the [Rust toolchain](https://rustup.rs/) (`rustup`),
  - the Tauri v2 CLI: `cargo install tauri-cli --version "^2"` (the `tauri` / `tauri:*` npm scripts call `cargo tauri`),
  - your platform's [Tauri system dependencies](https://tauri.app/start/prerequisites/) — e.g. **WebView2** + the MSVC C++ build tools on Windows, **webkit2gtk** on Linux.

### Web App

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The app works immediately with local-only storage. Sample data is loaded on first launch.

### Native Desktop App (Tauri)

```bash
npm install
npm run tauri:dev
```

This starts the Vite dev server and opens the app in a native window with system tray integration. (See the desktop prerequisites above if `npm run tauri:dev` reports that `tauri` is missing.)

### Install as a PWA

After opening it in your browser:

- **Desktop (Chrome/Edge):** Click the install icon in the address bar → the app gets its own window and taskbar icon.
- **Mobile (Android):** Tap the browser menu → "Add to Home Screen" or "Install app".
- **Mobile (iOS Safari):** Tap Share → "Add to Home Screen".

Once installed, the app launches instantly from cached assets and works fully offline.

## Architecture

The app runs in two modes from the same codebase: **browser** (PWA) and **native desktop** (Tauri v2). Platform-specific code is isolated behind adapters selected at runtime via `isTauri()`.

```
┌──────────────────────────────────────────────────┐
│                  React Frontend                   │
│  (Zustand store, views, components)              │
├──────────────────────────────────────────────────┤
│              Platform Adapters                    │
│  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ Browser           │  │ Tauri (native)       │  │
│  │ • File System     │  │ • tauri-plugin-fs    │  │
│  │   Access API      │  │ • tauri-plugin-dialog│  │
│  │ • sessionStorage  │  │ • localStorage PKCE  │  │
│  │ • window.location │  │ • deep-link callback │  │
│  │   OAuth redirect  │  │ • shell open (OAuth) │  │
│  │ • VitePWA         │  │ • system tray        │  │
│  └──────────────────┘  │ • auto-start          │  │
│                        └──────────────────────┘  │
├──────────────────────────────────────────────────┤
│          Shared Storage Layer                     │
│  IndexedDB (idb) ← local-first                   │
│  Cloud sync → Google Drive                        │
│  Ingest → markdown / prose / xlsx (one-way input) │
│  Agent file channel → planner-data/ inbox/outbox  │
└──────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Local-first**: All data is in IndexedDB. Cloud sync and the agent file channel are optional overlays.
- **One-way ingestion**: external markdown / prose / spreadsheets flow *in* through the Ingest modal or the `prose.ingest` agent op; the planner does not write back to outside files. Bidirectional Obsidian vault sync was removed in favour of this clearer model.
- **Adapter pattern for the agent file channel**: `obsidianAdapter.js` (kept under that name for legacy reasons) dynamically imports `obsidianBrowser.js` or `obsidianTauri.js` based on runtime. Tauri reads/writes `planner-data/{snapshot.json, agent-inbox/, agent-archive/, agent-log/}`; the browser build is a logged no-op for those paths.
- **OAuth in Tauri**: Opens the system browser (not the webview) for login, then receives the callback via the `com.taskplanner.app:` deep link. PKCE state is stored in `localStorage` (Tauri) vs `sessionStorage` (browser). Google uses an iOS-type client ID for the desktop build (no client secret).
- **Conditional PWA**: The VitePWA plugin is disabled when building for Tauri (`TAURI_ENV_PLATFORM` env var) to avoid service worker conflicts.
- **Close-to-tray**: The native app hides to the system tray on close instead of quitting.

## Development

### Commands

```bash
npm install          # Install dependencies
npm run dev          # Web dev server at localhost:5173
npm run build        # Production web build to dist/
npm run preview      # Preview production build
npm run tauri:dev    # Native dev (Vite + Tauri window)
npm run tauri:build  # Production native build (installer)
```

### Modifying the Web App

All React code is in `src/`. Changes are hot-reloaded by Vite in both `npm run dev` and `npm run tauri:dev`.

- **Views**: `src/components/GanttChart.jsx`, `CalendarView.jsx`, `SpreadsheetView.jsx`
- **State**: `src/store/useStore.js` (Zustand). `addTask`/`updateTask` automatically run `src/utils/dateEnforcement.js` to keep `endDate == dueDate` and cascade hard-blocks edges.
- **Storage**: `src/storage/` (IndexedDB, Google Drive adapters; migrations; agent snapshot exporter)
- **Auth**: `src/auth/` (OAuth PKCE flows; Tauri uses `com.taskplanner.app:` deep link)
- **Ingest pipeline**: `src/obsidian/` (deterministic markdown parser, prose/LLM extractor, xlsx → markdown converter), `src/ingest/` (modal-side bulk-envelope wrapper)
- **Agent integration**: `src/agent/` (apply pipeline, validate, trust matrix, inbox/digest/import services), `src/utils/obsidianAdapter.js` (platform routing for the file channel)
- **Themes**: `src/themes/` (built-ins as CSS snippets), `src/components/AppearanceSettings.jsx`, `src/hooks/useCustomCss.js`

### Modifying the Tauri Backend

The Rust backend is in `src-tauri/`. It handles the native window, system tray, and plugin registration.

- **Entry point**: `src-tauri/src/main.rs`
- **Config**: `src-tauri/tauri.conf.json` (window size, bundle settings, deep-link scheme)
- **Permissions**: `src-tauri/capabilities/default.json` (filesystem, dialog, shell, autostart access)
- **Dependencies**: `src-tauri/Cargo.toml`

After changing Rust code, `npm run tauri:dev` will recompile automatically.

### Adding a New Tauri Plugin

1. Add the Rust crate to `src-tauri/Cargo.toml`
2. Register it in `src-tauri/src/main.rs` (`.plugin(...)`)
3. Add permissions to `src-tauri/capabilities/default.json`
4. Install the npm wrapper: `npm install @tauri-apps/plugin-<name>`
5. Import and use in frontend code, gated behind `isTauri()` from `src/utils/platform.js`

## Deploying

### Web (Vercel / Netlify)

```bash
npm run build
```

Deploy the `dist/` folder. No server needed — it's a static site. Set environment variables for cloud sync:

- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GOOGLE_CLIENT_SECRET`

### Native Desktop Installers

```bash
npm run tauri:build
```

Produces installers in `src-tauri/target/release/bundle/`:
- **Windows**: `.msi` and `.exe` (NSIS) in `nsis/` and `msi/`
- **macOS**: `.dmg` in `dmg/`
- **Linux**: `.AppImage` and `.deb` in `appimage/` and `deb/`

### CI/CD (GitHub Actions)

The repo includes `.github/workflows/release.yml` which builds installers for all three platforms when you push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

This triggers a matrix build (Windows, macOS Intel + ARM, Linux) and creates a GitHub Release with all installer artifacts. Set these repository secrets for cloud sync support:

- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GOOGLE_CLIENT_SECRET`

## Tech Stack

| Layer       | Tool                          |
|-------------|-------------------------------|
| Framework   | React 18 + Vite               |
| State       | Zustand                       |
| Local DB    | IndexedDB via idb             |
| Styling     | Tailwind CSS                  |
| Dates       | date-fns                      |
| IDs         | nanoid                        |
| Drag & Drop | @dnd-kit/core + sortable      |
| Auth        | OAuth 2.0 PKCE (no backend)   |
| PWA         | vite-plugin-pwa + Workbox     |
| Desktop     | Tauri v2 (Rust backend)       |

## Project Structure

The high-level layout:

```
src/
├── App.jsx                  # Root component, view routing, agent service wiring
├── main.jsx                 # Entry point
├── index.css                # Tailwind + base styles
├── agent/                   # Claude agent integration (apply, validate, trust, inbox, digest, import)
├── auth/                    # OAuth PKCE flows (Google)
├── components/              # React views and dialogs (Gantt, Calendar, Spreadsheet, modals, AgentInbox, AgentDigest, AppearanceSettings, …)
├── hooks/                   # useSync, useCustomCss, useAgentInbox, keyboard shortcuts, gestures, hydration
├── ingest/                  # Modal-side bulk-envelope wrapper around the parser pipeline
├── obsidian/                # Markdown + prose + xlsx parsing + LLM extractor (one-way input)
├── storage/                 # IndexedDB / Drive adapters, migrations, agent snapshot exporter
├── store/useStore.js        # Zustand store (date enforcement and cascade applied inside addTask/updateTask)
├── themes/                  # Built-in CSS-snippet themes (Apple HIG Light)
├── utils/                   # dateEnforcement, depEdges, criticalPath, backup, csv, platform, dates, colors
└── data/sampleData.js       # Demo data

src-tauri/
├── Cargo.toml               # Rust dependencies (tauri, fs, dialog, shell, autostart, deep-link, single-instance, notify)
├── tauri.conf.json          # Window, bundle, plugin config
├── capabilities/default.json # Permission grants
└── src/
    ├── main.rs              # System tray, close-to-tray, plugin registration, deep-link routing
    └── agent_watcher.rs     # `notify`-based inbox watcher

scripts/
├── hooks/pre-push           # Refuses pushes from claude/* branches to main/master
├── install-hooks.mjs        # `npm run hooks:install`
└── agent-worklog.mjs        # `npm run agent:worklog -- <slug> <type>`
```

## Cloud Sync Setup (Optional)

Cloud sync lets you back up data to your own Google Drive and access it across devices. It's entirely optional — the app works fully offline without it.

### Google Drive

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Drive API**: APIs & Services → Library → search "Google Drive API" → click it → **Enable**. Wait a minute or two for it to propagate before testing.
4. Create OAuth credentials: APIs & Services → Credentials → Create Credentials → OAuth client ID
   - For the **web build** (dev server, self-hosted deployment): Application type **Web application**
     - Authorized JavaScript origins: `http://localhost:5173`
     - Authorized redirect URIs: `http://localhost:5173/auth/callback` (for dev) and your production URL + `/auth/callback`
   - For the **Tauri desktop build**: Google's web-app client type rejects custom URI schemes, so the desktop app uses `com.taskplanner.app:/auth/callback` and needs an OAuth client created as Application type **iOS** (the only desktop-friendly type that still accepts custom schemes). Set the **bundle ID** to `com.taskplanner.app` (must match `tauri.conf.json`'s `identifier` and the deep-link plugin's registered scheme). The iOS client is a public client, so Google issues only a Client ID — no secret. Use the resulting Client ID for the Tauri build's `VITE_GOOGLE_CLIENT_ID` (separate `.env.local` per build, or rebuild with the desktop ID); leave `VITE_GOOGLE_CLIENT_SECRET` unset.
     - Note: if you'd rather use the supported loopback flow instead of a custom scheme, that's a future TODO — the current desktop integration uses the deep-link scheme.
5. Copy the **Client ID** and **Client Secret** (both shown after creating the credentials)
6. Create a `.env.local` file in the project root:
   ```
   VITE_GOOGLE_CLIENT_ID=your_client_id_here
   VITE_GOOGLE_CLIENT_SECRET=your_client_secret_here
   ```
7. Configure the OAuth consent screen: APIs & Services → OAuth consent screen
   - User type: **External** → Create
   - Fill in app name, support email, and developer contact
   - Under **Scopes**, add `https://www.googleapis.com/auth/drive.appdata`
   - Under **Test users**, add your Google email address
   - For public use, you'll need to submit for Google verification

### Connecting in the app

1. Restart the dev server after adding env vars (`npm run dev`)
2. In the app, click **Cloud** in the sidebar
3. Click **Connect Google Drive**
4. Authorize the app in the OAuth popup
5. The sync status indicator in the header shows the current state (Saved / Syncing / Offline / Error)

Data is always saved locally first, then synced to the cloud in the background. If you go offline, changes queue up and sync when you're back online.

## Ingest (one-way input)

Open the **Ingest** entry from the sidebar to pull tasks in from outside the planner. Three input shapes share one pipeline:

- **Auto** — sniffs the input for markdown markers (checkboxes, pipe rows, `## Task:` blocks) and routes to either the deterministic parser or the LLM extractor.
- **Prose** — forces the LLM extractor. Use for transcripts, brain-dumps, Claude-chat fragments, or anything without explicit task structure.
- **Markdown** — forces the deterministic parser. Three flavours supported: pipe-delimited, indented metadata bullets, nested-checkbox subtasks.

Examples of the markdown shapes the deterministic parser accepts:

```markdown
## Project: Project Name

# Sprint Name
- [ ] Task title — Description text
    - Urgency: March 15 2027
    - Importance: 1
    - Difficulty: 3

- [x] Parent task — Description
    - [x] Subtask one
    - [ ] Subtask two
```

```markdown
- [ ] Task title | urg:2 | imp:1 | diff:4
```

### Behaviours

- **Spreadsheets**: drop a `.xlsx` or `.csv` and the modal converts it to a markdown table on the fly (lazy-loaded SheetJS), then routes to the prose extractor — column headers act as field hints, no fixed schema required.
- **Subtask flattening**: nested checkboxes become independent tasks with parent→child `hard-blocks` dependency edges.
- **LLM-powered interpretation**: ambiguous fields like "Critical for financial separation" can be turned into numeric ratings. Works with Anthropic and any OpenAI-compatible endpoint (Ollama, LM Studio). Configure the API key, model, and confidence threshold in the modal's Settings disclosure.
- **Duplicate detection**: candidates whose lowercased trimmed title already exists in the planner are flagged red and refuse to apply until you edit them.
- **Review-before-apply**: every candidate goes through a review pane with inline editors and per-row accept/reject toggles. Approved candidates are applied as one bulk envelope so a single Ctrl-Z reverts the whole import.
- **Single source of truth**: IndexedDB is authoritative; ingestion does not write back. Tasks edited in the planner stay in the planner.

The same pipeline is exposed to a Claude session via the `prose.ingest` agent op — the planner queues the extracted bulk for human review through the **Agent Inbox** sidebar entry.

## License

MIT
