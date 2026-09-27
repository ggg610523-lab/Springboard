mod apps;
mod icons;
mod launcher;
mod media;
mod model;
mod settings;
mod system;

use model::{AppInfo, DirListing, Settings, SystemInfo, UsageStats};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// Shared runtime state for all commands.
pub struct AppState {
    pub apps: Mutex<Vec<AppInfo>>,
    pub settings: Mutex<Settings>,
    pub usage: Mutex<UsageStats>,
    /// Cached IMDb catalogue used by the recommendation engine.
    pub catalog: Mutex<Vec<media::MediaItem>>,
    /// Learned taste profile.
    pub profile: Mutex<media::UserProfile>,
    pub scanning: AtomicBool,
    pub scanned_once: AtomicBool,
    /// Guards against two catalogue syncs at once.
    pub syncing: AtomicBool,
}

impl AppState {
    fn new() -> Self {
        Self {
            apps: Mutex::new(Vec::new()),
            settings: Mutex::new(settings::load_settings()),
            usage: Mutex::new(settings::load_usage()),
            catalog: Mutex::new(media::load_catalog()),
            profile: Mutex::new(media::load_profile()),
            scanning: AtomicBool::new(false),
            scanned_once: AtomicBool::new(false),
            syncing: AtomicBool::new(false),
        }
    }

    fn settings_snapshot(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn find_app(&self, id: &str) -> Option<AppInfo> {
        self.apps
            .lock()
            .ok()
            .and_then(|list| list.iter().find(|a| a.id == id).cloned())
    }
}

/// Result of a launch attempt, pushed to the UI through `launch-result`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchResult {
    id: String,
    name: String,
    ok: bool,
    method: String,
    message: String,
}

/// Scan the system and refresh every cached icon reference.
fn perform_scan(state: &AppState, refresh_icons: bool) -> Vec<AppInfo> {
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
    if let Ok(mut guard) = state.apps.lock() {
        *guard = list.clone();
    }
    state.scanned_once.store(true, Ordering::SeqCst);
    list
}

fn load_cached_apps() -> Vec<AppInfo> {
    std::fs::read_to_string(settings::apps_cache_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<AppInfo>>(&text).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn list_apps(state: State<'_, AppState>, force: Option<bool>) -> Vec<AppInfo> {
    if force.unwrap_or(false) {
        return perform_scan(&state, true);
    }
    let cached = state.apps.lock().map(|l| l.clone()).unwrap_or_default();
    if cached.is_empty() {
        perform_scan(&state, false)
    } else {
        cached
    }
}

#[tauri::command]
fn rescan_apps(state: State<'_, AppState>) -> Vec<AppInfo> {
    perform_scan(&state, true)
}

/// Start a real application. Returns immediately; the outcome is reported
/// through the `launch-result` event so the UI never blocks.
#[tauri::command]
fn launch_app(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<String, String> {
    let Some(entry) = state.find_app(&id) else {
        return Err(format!("Unknown application: {id}"));
    };
    let usage = settings::record_launch(&id);
    if let Ok(mut guard) = state.usage.lock() {
        *guard = usage;
    }
    let display_name = entry.name.clone();
    let handle = app.clone();
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
    Ok(display_name)
}

/// Launch any `.desktop` file on disk (used by the file browser).
#[tauri::command]
fn launch_desktop_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let list = apps::scan_apps();
    let entry = list
        .into_iter()
        .find(|a| a.desktop_file == path)
        .ok_or_else(|| format!("No launchable application at {path}"))?;
    let display_name = entry.name.clone();
    let handle = app.clone();
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

#[tauri::command]
fn get_audio(state: State<'_, AppState>) -> (Option<u32>, Option<bool>) {
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
fn audio_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    action: String,
    value: Option<i64>,
) -> Result<String, String> {
    let outcome = system::system_action(&action, value)?;
    if let Some(volume) = system::get_volume() {
        if let Ok(mut guard) = state.settings.lock() {
            guard.volume = volume;
        }
    }
    let _ = app;
    Ok(outcome)
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
    let catalog = state.catalog.lock().map(|c| c.clone()).unwrap_or_default();
    let profile = state.profile.lock().map(|p| p.clone()).unwrap_or_default();
    media::recommendations(&catalog, &profile, limit, salt)
}

/// Load the cached catalogue, optionally re-syncing it from IMDb.
#[tauri::command]
async fn media_catalog(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Vec<media::MediaItem>, String> {
    if !refresh.unwrap_or(false) {
        let cached = state.catalog.lock().map(|c| c.clone()).unwrap_or_default();
        if !cached.is_empty() {
            return Ok(cached);
        }
    }
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Ok(state.catalog.lock().map(|c| c.clone()).unwrap_or_default());
    }
    let genres = selected_genres(&state);
    let result =
        tauri::async_runtime::spawn_blocking(move || media::build_catalog(genres.as_deref())).await;
    state.syncing.store(false, Ordering::SeqCst);
    let items = result.map_err(|e| e.to_string())??;
    media::mark_sync();
    if let Ok(mut guard) = state.catalog.lock() {
        *guard = items.clone();
    }
    Ok(items)
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
    let mut results: Vec<media::MediaItem> = {
        let catalog = state.catalog.lock().map(|c| c.clone()).unwrap_or_default();
        catalog
            .into_iter()
            .filter(|item| item.title.to_lowercase().contains(&needle))
            .collect()
    };
    let remote_query = query.clone();
    let remote = tauri::async_runtime::spawn_blocking(move || media::search_imdb(&remote_query, ""))
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(mut list) = remote {
        for item in list.drain(..) {
            if !results.iter().any(|existing| existing.id == item.id) {
                results.push(item);
            }
        }
    }
    results.truncate(limit);
    if let Ok(mut profile) = state.profile.lock() {
        media::remember_search(&mut profile, &query);
    }
    Ok(results)
}
    /// Result of one interaction with a poster.
#[derive(Debug, Clone, Serialize)]
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
    {
        let mut profile = state
            .profile
            .lock()
            .map_err(|_| "profile lock poisoned".to_string())?;
        media::apply_feedback(&mut profile, &item.id, &action, &item.genre)?;
    }
    // A liked search result becomes part of the catalogue so it can resurface.
    if action == "like" {
        if let Ok(mut catalog) = state.catalog.lock() {
            if !catalog.iter().any(|existing| existing.id == item.id) {
                let mut saved = item.clone();
                if saved.genre.trim().is_empty() {
                    saved.genre = "Saved".into();
                }
                catalog.push(saved);
                media::save_catalog(&catalog);
            }
        }
    }
    let catalog_size = state.catalog.lock().map(|c| c.len()).unwrap_or(0);
    let profile = state.profile.lock().map(|p| p.clone()).unwrap_or_default();
    Ok(MediaFeedbackResult {
        recommendations: recall(&state, limit.unwrap_or(14), salt.unwrap_or(0.0)),
        profile,
        catalog_size,
    })
}

#[tauri::command]
fn media_profile(state: State<'_, AppState>) -> media::UserProfile {
    state.profile.lock().map(|p| p.clone()).unwrap_or_default()
}

#[tauri::command]
fn media_reset_profile(state: State<'_, AppState>) -> media::UserProfile {
    let fresh = media::reset_profile();
    if let Ok(mut guard) = state.profile.lock() {
        *guard = fresh.clone();
    }
    fresh
}

#[tauri::command]
fn media_status(state: State<'_, AppState>) -> media::MediaStatus {
    let catalog_len = state.catalog.lock().map(|c| c.len()).unwrap_or(0);
    let profile = state.profile.lock().map(|p| p.clone()).unwrap_or_default();
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
        .register_uri_scheme_protocol("appicon", |_ctx, request| {
            icons::protocol_response(&request.uri().to_string())
        })
        .register_asynchronous_uri_scheme_protocol("poster", |_ctx, request, responder| {
            let uri = request.uri().to_string();
            std::thread::spawn(move || responder.respond(media::poster_response(&uri)));
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

            tauri::async_runtime::spawn(async move {
                let list = {
                    let state = handle.state::<AppState>();
                    perform_scan(&state, true)
                };
                let _ = handle.emit("apps-scanned", list);
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