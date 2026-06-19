//! Agent inbox watcher.
//!
//! Watches `$PLANNER_DATA_DIR/agent-inbox/` for `*.json` files created or
//! modified by Claude (or any other agent), and emits an `agent-inbox:op`
//! Tauri event carrying the absolute path of the detected file. The frontend
//! (`src/agent/AgentSync.js`) subscribes to this event and handles the op.
//!
//! Protocol: see `CLAUDE_AGENT_PROTOCOL.md` §2 ("File layout").

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

/// Event name emitted to the frontend when a new op file is observed.
pub const EVENT_NAME: &str = "agent-inbox:op";

/// Resolves `$PLANNER_DATA_DIR/agent-inbox/` from the Tauri app data dir.
///
/// Mirrors the JS-side default (`src/utils/obsidianTauri.js` →
/// `resolvePlannerDataDir`). If the user has overridden `plannerDataPath`
/// in settings, the JS snapshot writer will write there anyway, but the
/// watcher currently only observes the default location. That's fine as
/// long as the user hasn't customized the path; if they have, they'll also need
/// to restart the app — documented in the design doc.
pub fn inbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("planner-data").join("agent-inbox"))
}

/// Decide whether a filesystem event path should trigger an `agent-inbox:op`
/// emission. Pure so it can be unit-tested without spinning up notify.
pub fn should_emit_for_path(path: &Path) -> bool {
    let ext_json = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("json"))
        .unwrap_or(false);
    if !ext_json {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    // Skip atomic-write temp files (`.json.tmp` from the JS snapshot writer
    // or any external tool using the same convention) and dotfiles.
    if name.ends_with(".tmp") || name.starts_with('.') {
        return false;
    }
    true
}

/// Spawns the watcher on a dedicated OS thread. Safe to call once during
/// `setup()`. Failures are logged and do not propagate: the app remains
/// usable even if the watcher can't start (e.g., on an unsupported FS).
pub fn spawn(app_handle: AppHandle) {
    thread::Builder::new()
        .name("agent-inbox-watcher".into())
        .spawn(move || run(app_handle))
        .expect("failed to spawn agent-inbox-watcher thread");
}

fn run(app_handle: AppHandle) {
    let inbox = match inbox_dir(&app_handle) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[agent-watcher] {e}");
            return;
        }
    };

    // Make sure the directory (and its siblings per protocol §2) exist so
    // the watcher has something to attach to even on first launch.
    if let Err(e) = std::fs::create_dir_all(&inbox) {
        eprintln!("[agent-watcher] failed to create {inbox:?}: {e:?}");
        return;
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[agent-watcher] failed to create watcher: {e:?}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&inbox, RecursiveMode::NonRecursive) {
        eprintln!("[agent-watcher] failed to watch {inbox:?}: {e:?}");
        return;
    }

    println!("[agent-watcher] watching {}", inbox.display());

    // `watcher` must stay alive for as long as we're listening; it drops
    // when this function returns.
    while let Ok(res) = rx.recv() {
        match res {
            Ok(event) => handle_event(&app_handle, &event),
            Err(e) => eprintln!("[agent-watcher] event error: {e:?}"),
        }
    }
}

fn handle_event(app_handle: &AppHandle, event: &Event) {
    // We only care about created or modified files. Rename-to events surface
    // as `Modify(Name(To))` on Linux and `Create` on Windows/macOS; either
    // way, `Create` + `Modify` covers the common paths.
    let relevant = matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_)
    );
    if !relevant {
        return;
    }

    for path in &event.paths {
        if !should_emit_for_path(path) {
            continue;
        }
        let payload = path.to_string_lossy().to_string();
        if let Err(e) = app_handle.emit(EVENT_NAME, payload) {
            eprintln!("[agent-watcher] emit failed: {e:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn accepts_plain_json() {
        assert!(should_emit_for_path(&PathBuf::from(
            "C:\\x\\planner-data\\agent-inbox\\op-1.json"
        )));
        assert!(should_emit_for_path(&PathBuf::from(
            "/home/x/planner-data/agent-inbox/op-1.json"
        )));
    }

    #[test]
    fn rejects_non_json() {
        assert!(!should_emit_for_path(&PathBuf::from("op-1.txt")));
        assert!(!should_emit_for_path(&PathBuf::from("op-1")));
        assert!(!should_emit_for_path(&PathBuf::from("README.md")));
    }

    #[test]
    fn rejects_tmp_and_dotfiles() {
        assert!(!should_emit_for_path(&PathBuf::from("op-1.json.tmp")));
        assert!(!should_emit_for_path(&PathBuf::from(".hidden.json")));
    }

    #[test]
    fn json_case_insensitive() {
        assert!(should_emit_for_path(&PathBuf::from("OP-1.JSON")));
    }
}
