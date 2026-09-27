mod apps;
mod icons;
mod launcher;
mod media;
mod model;
mod settings;
mod system;

use model::{AppInfo, AppTile, DirListing, Settings, SystemInfo, UsageStats};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use ts_rs::TS;

/// Shared runtime state for all commands.
///
/// The collections sit behind `Arc` so a command can hand out a snapshot
/// without deep-copying it: a 220-entry app list is ~109 kB of heap that used
/// to be cloned two or three times per scan.
pub struct AppState {
    pub apps: Mutex<Arc<Vec<AppInfo>>>,
    pub settings: Mutex<Settings>,
    pub usage: Mutex<UsageStats>,
    /// Cached IMDb catalogue used by the recommendation engine.
    pub catalog: Mutex<Arc<Vec<media::MediaItem>>>,
    /// Learned taste profile.
    pub profile: Mutex<Arc<media::UserProfile>>,
    pub scanning: AtomicBool,
    pub scanned_once: AtomicBool,
    /// Guards against two catalogue syncs at once.
    pub syncing: AtomicBool,
    /// Bumped by every completed scan so the UI can tell whether the tile list
    /// it already holds is stale.
    pub apps_revision: AtomicU64,
}

impl AppState {
    fn new() -> Self {
        Self {
            apps: Mutex::new(Arc::new(Vec::new())),
            settings: Mutex::new(settings::load_settings()),
            usage: Mutex::new(settings::load_usage()),
            catalog: Mutex::new(Arc::new(media::load_catalog())),
            profile: Mutex::new(Arc::new(media::load_profile())),
            scanning: AtomicBool::new(false),
            scanned_once: AtomicBool::new(false),
            syncing: AtomicBool::new(false),
            apps_revision: AtomicU64::new(0),
        }
    }

    fn settings_snapshot(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn apps_snapshot(&self) -> Arc<Vec<AppInfo>> {
        self.apps
            .lock()
            .map(|list| Arc::clone(&list))
            .unwrap_or_default()
    }

    fn catalog_snapshot(&self) -> Arc<Vec<media::MediaItem>> {
        self.catalog
            .lock()
            .map(|list| Arc::clone(&list))
            .unwrap_or_default()
    }

    fn profile_snapshot(&self) -> Arc<media::UserProfile> {
        self.profile
            .lock()
            .map(|profile| Arc::clone(&profile))
            .unwrap_or_default()
    }

    fn find_app(&self, id: &str) -> Option<AppInfo> {
        self.apps
            .lock()
            .ok()
            .and_then(|list| list.iter().find(|a| a.id == id).cloned())
    }
}

/// Result of a launch attempt, pushed to the UI through `launch-result`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct LaunchResult {
    id: String,
    name: String,
    ok: bool,
    method: String,
    message: String,
}

/// Payload for the `apps-scanned` event.
///
/// Only the revision and the count travel over IPC. The UI already has the
/// tile list from `list_apps`, so re-sending the full 109 kB snapshot would be
/// pure duplication; it re-fetches only when the revision moved on.
#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct AppsScanned {
    revision: u64,
    count: usize,
}

/// Scan the system and refresh every cached icon reference.
fn perform_scan(state: &AppState, refresh_icons: bool) -> Arc<Vec<AppInfo>> {
    if refresh_icons {
        icons::invalidate();
    }
    let mut list = apps::scan_apps();
    for app in list.iter_mut() {
        if let Some(name) = app.icon_name.clone() {
            app.icon_path = icons::resolve(&name);
        }
    }
    if let Ok(json) = serde_json::to_string(&list) {
        let _ = settings::write_atomic(&settings::apps_cache_path(), &json);
    }
    let snapshot = Arc::new(list);
    if let Ok(mut guard) = state.apps.lock() {
        *guard = Arc::clone(&snapshot);
    }
    state.scanned_once.store(true, Ordering::SeqCst);
    state.apps_revision.fetch_add(1, Ordering::SeqCst);
    snapshot
}

fn load_cached_apps() -> Arc<Vec<AppInfo>> {
    Arc::new(
        std::fs::read_to_string(settings::apps_cache_path())
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<AppInfo>>(&text).ok())
            .unwrap_or_default(),
    )
}

/// Project a scan onto the lean wire type the tile grid needs.
///
/// `NoDisplay` entries are dropped here rather than in the frontend: they are
/// 72% of a typical scan and were previously serialised, shipped and thrown
/// away again on the UI thread.
fn tiles_from(apps: &[AppInfo], include_hidden: bool) -> Vec<AppTile> {
    apps.iter()
        .filter(|app| include_hidden || !app.no_display)
        .map(AppTile::from)
        .collect()
}

#[tauri::command]
fn list_apps(
    state: State<'_, AppState>,
    force: Option<bool>,
    include_hidden: Option<bool>,
) -> Vec<AppTile> {
    let snapshot = if force.unwrap_or(false) {
        perform_scan(&state, true)
    } else {
        let cached = state.apps_snapshot();
        if cached.is_empty() {
            perform_scan(&state, false)
        } else {
            cached
        }
    };
    tiles_from(&snapshot, include_hidden.unwrap_or(false))
}

#[tauri::command]
fn rescan_apps(state: State<'_, AppState>, include_hidden: Option<bool>) -> Vec<AppTile> {
    let snapshot = perform_scan(&state, true);
    tiles_from(&snapshot, include_hidden.unwrap_or(false))
}

/// Full desktop-entry record for the details sheet (`id`, `exec`, categories…).
#[tauri::command]
fn app_details(state: State<'_, AppState>, id: String) -> Option<AppInfo> {
    state.find_app(&id)
}

/// Current revision of the scanned app list.
#[tauri::command]
fn apps_revision(state: State<'_, AppState>) -> u64 {
    state.apps_revision.load(Ordering::SeqCst)
}

/// Detach a launch attempt so the UI never blocks on it; the outcome arrives
/// through the `launch-result` event.
fn spawn_launch(handle: tauri::AppHandle, entry: AppInfo) {
    std::thread::spawn(move || {
        let result = match launcher::launch(&entry) {
            Ok(method) => LaunchResult {
                id: entry.id.clone(),
                name: entry.name.clone(),
                ok: true,
                method,
                message: format!("Opening {}", entry.name),
            },
            Err(message) => LaunchResult {
                id: entry.id.clone(),
                name: entry.name.clone(),
                ok: false,
                method: "none".into(),
                message,
            },
        };
        let _ = handle.emit("launch-result", result);
    });
}

/// Start a real application. Returns immediately; the outcome is reported
/// through the `launch-result` event so the UI never blocks.
#[tauri::command]
fn launch_app(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<String, String> {
    let Some(entry) = state.find_app(&id) else {
        return Err(format!("Unknown application: {id}"));
    };
    // Record against the in-memory usage under one lock instead of re-reading
    // and re-parsing usage.json on every launch.
    if let Ok(mut usage) = state.usage.lock() {
        settings::record_launch(&mut usage, &id);
    }
    let display_name = entry.name.clone();
    spawn_launch(app, entry);
    Ok(display_name)
}

/// Launch any `.desktop` file on disk (used by the file browser).
#[tauri::command]
fn launch_desktop_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    // Look the entry up in the cached scan: a fresh `scan_apps()` would cost
    // hundreds of file reads and `$PATH` probes to find a single record.
    let entry = state
        .apps_snapshot()
        .iter()
        .find(|a| a.desktop_file == path)
        .cloned()
        .ok_or_else(|| format!("No launchable application at {path}"))?;
    if let Ok(mut usage) = state.usage.lock() {
        settings::record_launch(&mut usage, &entry.id);
    }
    let display_name = entry.name.clone();
    spawn_launch(app, entry);
    Ok(display_name)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings_snapshot()
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    let previous = state.settings_snapshot();
    settings::save_settings(&settings)?;
    if let Ok(mut guard) = state.settings.lock() {
        *guard = settings.clone();
    }
    if previous.autostart != settings.autostart {
        let _ = settings::set_autostart(settings.autostart);
    }
    apply_window_prefs(&app, &settings);
    Ok(settings)
}

#[tauri::command]
fn reset_settings(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Settings, String> {
    let fresh = Settings::default();
    settings::save_settings(&fresh)?;
    if let Ok(mut guard) = state.settings.lock() {
        *guard = fresh.clone();
    }
    let _ = settings::set_autostart(fresh.autostart);
    apply_window_prefs(&app, &fresh);
    Ok(fresh)
}

fn apply_window_prefs(app: &tauri::AppHandle, settings: &Settings) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(settings.always_on_top);
        if window.is_fullscreen().unwrap_or(false) != settings.fullscreen_on_start {
            let _ = window.set_fullscreen(settings.fullscreen_on_start);
        }
    }
}

#[tauri::command]
fn icon_uri(icon: String) -> String {
    icons::icon_uri(&icon)
}

#[tauri::command]
fn get_usage(state: State<'_, AppState>) -> UsageStats {
    state.usage.lock().map(|u| u.clone()).unwrap_or_default()
}

#[tauri::command]
fn get_system_info(state: State<'_, AppState>) -> SystemInfo {
    let count = state.apps.lock().map(|a| a.len()).unwrap_or(0);
    system::system_info(count, &settings::config_dir())
}

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    launcher::open_target(&target)
}

#[tauri::command]
fn list_directory(path: String, show_hidden: bool) -> Result<DirListing, String> {
    system::list_dir(&path, show_hidden)
}

#[tauri::command]
fn home_directory() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Read the system volume / mute state and mirror it into the settings cache.
fn read_audio(state: &AppState) -> (Option<u32>, Option<bool>) {
    let volume = system::get_volume();
    let muted = system::get_muted();
    if let Some(v) = volume {
        if let Ok(mut guard) = state.settings.lock() {
            guard.volume = v;
        }
    }
    (volume, muted)
}

#[tauri::command]
fn get_audio(state: State<'_, AppState>) -> (Option<u32>, Option<bool>) {
    read_audio(&state)
}

/// Outcome of an audio action, including the resulting state.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct AudioCommandResult {
    volume: Option<u32>,
    muted: Option<bool>,
    message: String,
}

/// Apply an audio action and return the new `(volume, muted)` alongside the
/// message, so the UI does not need a follow-up `get_audio` (which itself
/// spawns two more mixer probes) just to learn what changed.
#[tauri::command]
fn audio_command(
    state: State<'_, AppState>,
    action: String,
    value: Option<i64>,
) -> Result<AudioCommandResult, String> {
    let message = system::system_action(&action, value)?;
    let (volume, muted) = read_audio(&state);
    Ok(AudioCommandResult {
        volume,
        muted,
        message,
    })
}

#[tauri::command]
fn quit_launcher(app: tauri::AppHandle) {
    app.exit(0);
}

// ── Recommendation engine (IMDb) ──────────────────────────────────────────

/// `None` means "every genre seed".
fn selected_genres(state: &AppState) -> Option<Vec<String>> {
    let settings = state.settings_snapshot();
    if settings.media_genres.is_empty() {
        None
    } else {
        Some(settings.media_genres)
    }
}

fn recall(state: &AppState, limit: usize, salt: f64) -> Vec<media::MediaItem> {
    // Both snapshots are refcount bumps, not deep copies.
    let catalog = state.catalog_snapshot();
    let profile = state.profile_snapshot();
    media::recommendations(&catalog, &profile, limit, salt)
}

/// Everything the home screen needs from the engine, in one round trip.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct MediaBootstrap {
    #[ts(as = "Vec<media::MediaItem>")]
    catalog: Arc<Vec<media::MediaItem>>,
    #[ts(as = "media::UserProfile")]
    profile: Arc<media::UserProfile>,
    recommendations: Vec<media::MediaItem>,
    status: media::MediaStatus,
}

/// Load the cached catalogue, optionally re-syncing it from IMDb.
async fn load_catalog(
    state: &AppState,
    refresh: bool,
) -> Result<Arc<Vec<media::MediaItem>>, String> {
    if !refresh {
        let cached = state.catalog_snapshot();
        if !cached.is_empty() {
            return Ok(cached);
        }
    }
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Ok(state.catalog_snapshot());
    }
    let genres = selected_genres(state);
    let result =
        tauri::async_runtime::spawn_blocking(move || media::build_catalog(genres.as_deref())).await;
    state.syncing.store(false, Ordering::SeqCst);
    let items = result.map_err(|e| e.to_string())??;
    media::mark_sync();
    let snapshot = Arc::new(items);
    if let Ok(mut guard) = state.catalog.lock() {
        *guard = Arc::clone(&snapshot);
    }
    Ok(snapshot)
}

/// Catalogue + profile + first ranking + engine status.
///
/// The UI used to issue four separate invokes for this, which meant four IPC
/// round trips and four lock acquisitions on the very first paint.
#[tauri::command]
async fn media_bootstrap(
    state: State<'_, AppState>,
    limit: Option<usize>,
    salt: Option<f64>,
) -> Result<MediaBootstrap, String> {
    let catalog = load_catalog(&state, false).await?;
    let profile = state.profile_snapshot();
    let status = media::status(catalog.len(), &profile);
    let recommendations =
        media::recommendations(&catalog, &profile, limit.unwrap_or(14), salt.unwrap_or(0.0));
    Ok(MediaBootstrap {
        catalog,
        profile,
        recommendations,
        status,
    })
}

#[tauri::command]
async fn media_catalog(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Arc<Vec<media::MediaItem>>, String> {
    load_catalog(&state, refresh.unwrap_or(false)).await
}

/// Ranked recommendations for the shelves.
#[tauri::command]
fn media_recommendations(
    state: State<'_, AppState>,
    limit: Option<usize>,
    salt: Option<f64>,
) -> Vec<media::MediaItem> {
    recall(&state, limit.unwrap_or(14), salt.unwrap_or(0.0))
}

/// Search IMDb. Local catalogue hits come back instantly, remote results are
/// appended when the network answers.
#[tauri::command]
async fn media_search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<media::MediaItem>, String> {
    let limit = limit.unwrap_or(30);
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(Vec::new());
    }
    let catalog = state.catalog_snapshot();
    let mut results: Vec<media::MediaItem> = catalog
        .iter()
        .filter(|item| item.title.to_lowercase().contains(&needle))
        .cloned()
        .collect();
    let mut seen: std::collections::HashSet<String> =
        results.iter().map(|item| item.id.clone()).collect();

    let remote_query = query.clone();
    let remote = tauri::async_runtime::spawn_blocking(move || media::search_imdb(&remote_query, ""))
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(mut list) = remote {
        for item in list.drain(..) {
            if seen.insert(item.id.clone()) {
                results.push(item);
            }
        }
    }
    results.truncate(limit);
    if let Ok(mut profile) = state.profile.lock() {
        media::remember_search(Arc::make_mut(&mut profile), &query);
    }
    Ok(results)
}
    /// Result of one interaction with a poster.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct MediaFeedbackResult {
    recommendations: Vec<media::MediaItem>,
    profile: media::UserProfile,
    catalog_size: usize,
}

/// Teach the engine from a like / dislike / hide / watched / click.
#[tauri::command]
fn media_feedback(
    state: State<'_, AppState>,
    item: media::MediaItem,
    action: String,
    limit: Option<usize>,
    salt: Option<f64>,
) -> Result<MediaFeedbackResult, String> {
    // One lock, one mutation, one save: this used to take the profile lock
    // three times and the catalogue lock twice.
    {
        let mut profile = state
            .profile
            .lock()
            .map_err(|_| "profile lock poisoned".to_string())?;
        media::apply_feedback(Arc::make_mut(&mut profile), &item.id, &action, &item.genre)?;
        media::save_profile(&profile);
    }
    // A liked search result becomes part of the catalogue so it can resurface.
    if action == "like" {
        let mut catalog = state
            .catalog
            .lock()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        if !catalog.iter().any(|existing| existing.id == item.id) {
            let mut saved = item.clone();
            if saved.genre.trim().is_empty() {
                saved.genre = "Saved".into();
            }
            let list = Arc::make_mut(&mut catalog);
            list.push(saved);
            media::save_catalog(list);
        }
    }
    let catalog_size = state.catalog_snapshot().len();
    let recommendations = recall(&state, limit.unwrap_or(14), salt.unwrap_or(0.0));
    let profile = state.profile_snapshot();
    Ok(MediaFeedbackResult {
        recommendations,
        profile: profile.as_ref().clone(),
        catalog_size,
    })
}

#[tauri::command]
fn media_profile(state: State<'_, AppState>) -> Arc<media::UserProfile> {
    state.profile_snapshot()
}

#[tauri::command]
fn media_reset_profile(state: State<'_, AppState>) -> media::UserProfile {
    let fresh = media::reset_profile();
    if let Ok(mut guard) = state.profile.lock() {
        *guard = Arc::new(fresh.clone());
    }
    fresh
}

#[tauri::command]
fn media_status(state: State<'_, AppState>) -> media::MediaStatus {
    let catalog_len = state.catalog_snapshot().len();
    let profile = state.profile_snapshot();
    media::status(catalog_len, &profile)
}

#[tauri::command]
fn media_genre_seeds() -> Vec<String> {
    media::GENRE_SEEDS
        .iter()
        .map(|(label, _)| (*label).to_string())
        .collect()
}

#[tauri::command]
fn media_clear_posters() -> usize {
    media::clear_posters()
}

/// Open the IMDb page for a title in the desktop browser.
#[tauri::command]
fn media_open(id: String) -> Result<(), String> {
    if !id.starts_with("tt") || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("Not an IMDb id: {id}"));
    }
    launcher::open_target(&format!("https://www.imdb.com/title/{id}/"))
}

/// Entry point, also used by `main.rs`.
pub fn run() {
    tauri::Builder::default()
        // Both protocols read from disk (and `poster://` may shell out to curl),
        // so they run on the runtime's blocking pool: bounded, reused threads
        // instead of one new OS thread per image request.
        .register_asynchronous_uri_scheme_protocol("appicon", |_ctx, request, responder| {
            let uri = request.uri().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(icons::protocol_response(&uri));
            });
        })
        .register_asynchronous_uri_scheme_protocol("poster", |_ctx, request, responder| {
            let uri = request.uri().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(media::poster_response(&uri));
            });
        })
        .manage(AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();

            // Paint something immediately from the last scan, then rescan.
            {
                let state = handle.state::<AppState>();
                let cached = load_cached_apps();
                if !cached.is_empty() {
                    if let Ok(mut guard) = state.apps.lock() {
                        *guard = cached;
                    }
                }
                let settings = state.settings_snapshot();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.set_always_on_top(settings.always_on_top);
                    let _ = window.set_fullscreen(settings.fullscreen_on_start);
                }
            }

            // The scan reads hundreds of desktop files and probes `$PATH`;
            // running it on the async runtime would starve every other command.
            tauri::async_runtime::spawn_blocking(move || {
                let (revision, count) = {
                    let state = handle.state::<AppState>();
                    let snapshot = perform_scan(&state, true);
                    (
                        state.apps_revision.load(Ordering::SeqCst),
                        snapshot.len(),
                    )
                };
                let _ = handle.emit("apps-scanned", AppsScanned { revision, count });
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_apps,
            rescan_apps,
            app_details,
            apps_revision,
            launch_app,
            launch_desktop_file,
            get_settings,
            save_settings,
            reset_settings,
            icon_uri,
            get_usage,
            get_system_info,
            open_target,
            list_directory,
            home_directory,
            get_audio,
            audio_command,
            quit_launcher,
            media_bootstrap,
            media_catalog,
            media_recommendations,
            media_search,
            media_feedback,
            media_profile,
            media_reset_profile,
            media_status,
            media_genre_seeds,
            media_clear_posters,
            media_open
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Apple TV launcher");
}
/// Regenerates `src/generated.ts` — the TypeScript wire types the frontend
/// imports from `src/types.ts`.
///
/// Run `cargo test export_typescript` after changing any struct that crosses
/// IPC (or is emitted through the `appicon://` / `poster://` protocols). The
/// generated file is committed so the webview build never needs a Rust toolchain.
#[cfg(test)]
mod export_typescript {
    use ts_rs::TS;

    #[test]
    fn export() {
        let mut out = String::from(
            "/* AUTO-GENERATED from the Rust wire structs by\n\
             * `cargo test export_typescript` (src-tauri/src/lib.rs).\n\
             * Do not edit by hand — change the Rust struct instead. */\n\n",
        );

        macro_rules! emit {
            ($($t:ty),* $(,)?) => {
                $(
                    let decl = <$t as TS>::decl();
                    let decl = decl.trim();
                    if let Some(rest) = decl.strip_prefix("export ") {
                        out.push_str("export ");
                        out.push_str(rest);
                    } else {
                        out.push_str("export ");
                        out.push_str(decl);
                    }
                    out.push_str("\n\n");
                )*
            };
        }

        emit!(
            // IPC commands + events (crate root).
            crate::LaunchResult,
            crate::AppsScanned,
            crate::AudioCommandResult,
            crate::MediaBootstrap,
            crate::MediaFeedbackResult,
            // Application model.
            crate::model::AppInfo,
            crate::model::AppTile,
            crate::model::RowDef,
            crate::model::UsageEntry,
            crate::model::UsageStats,
            crate::model::Settings,
            crate::model::SystemInfo,
            crate::model::DirEntryInfo,
            crate::model::DirListing,
            // Recommendation engine.
            crate::media::MediaItem,
            crate::media::UserProfile,
            crate::media::MediaStatus,
        );

        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/generated.ts");
        std::fs::write(path, &out).expect("failed to write src/generated.ts");
    }
}
