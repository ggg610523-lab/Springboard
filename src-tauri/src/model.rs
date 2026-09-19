use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A single launchable application discovered on the system.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Stable identifier: the desktop file id (e.g. `firefox.desktop`).
    pub id: String,
    /// Human readable name (`Name=`).
    pub name: String,
    pub generic_name: Option<String>,
    pub comment: Option<String>,
    /// Raw `Exec=` value including field codes.
    pub exec: String,
    /// Absolute path of the icon file when it could be resolved.
    pub icon_path: Option<String>,
    /// Raw `Icon=` value from the desktop entry.
    pub icon_name: Option<String>,
    pub categories: Vec<String>,
    pub keywords: Vec<String>,
    pub terminal: bool,
    /// Absolute path of the `.desktop` file itself.
    pub desktop_file: String,
    pub is_flatpak: bool,
    pub is_snap: bool,
    pub startup_wm_class: Option<String>,
    /// `NoDisplay=true` entries are hidden unless the user opts in.
    pub no_display: bool,
    /// Best guess for the row the app belongs to.
    pub group: String,
}

/// A user defined row on the home screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDef {
    pub id: String,
    pub title: String,
    /// `all` | `favorites` | `recent` | `frequency` | `category:<Name>` | `manual`
    pub source: String,
    /// Explicit app order for manually curated rows.
    #[serde(default)]
    pub app_ids: Vec<String>,
}

impl RowDef {
    pub fn new(id: &str, title: &str, source: &str) -> Self {
        Self {
            id: id.to_string(),
            title: title.to_string(),
            source: source.to_string(),
            app_ids: Vec::new(),
        }
    }
}

/// Usage statistics used by the "Most Used" row and by sorting.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    #[serde(default)]
    pub count: u64,
    #[serde(default)]
    pub last_used: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    #[serde(default)]
    pub apps: HashMap<String, UsageEntry>,
}

fn yes() -> bool {
    true
}
fn d_accent() -> String {
    "#0a84ff".into()
}

/// Everything the launcher persists. Field names are camelCase on the wire so
/// the TypeScript side can consume them directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema: u32,

    // ── General ────────────────────────────────────────────────────────────
    pub confirm_launch: bool,
    pub hide_on_launch: bool,
    pub autostart: bool,
    pub sound_effects: bool,
    pub animations: bool,
    pub parallax: bool,
    pub double_click_to_open: bool,
    pub fullscreen_on_start: bool,
    pub always_on_top: bool,
    // ── Always-On Display ──────────────────────────────────────────────────
    /// Show the full screen ambient clock instead of just dimming.
    pub aod_enabled: bool,
    /// Minutes of inactivity before the AOD fades in.
    pub aod_timeout_mins: u32,
    /// Dim intensity 0–100 while the AOD is on screen.
    pub aod_dim: u32,
    /// `clock`, `clock+weather`, `poster-wall`
    pub aod_style: String,

    pub show_clock: bool,
    pub clock_24h: bool,
    pub show_labels: bool,
    pub show_hints: bool,
    pub escape_quits: bool,

    // ── Appearance ────────────────────────────────────────────────────────
    pub theme: String,
    pub accent: String,
    pub background_style: String,
    pub background_image: Option<String>,
    pub background_blur: u32,
    pub background_dim: u32,
    pub tile_size: String,
    pub icons_per_row: u32,
    pub rows_per_page: u32,
    pub corner_radius: u32,
    pub show_top_shelf: bool,
    pub top_shelf_interval: u32,
    pub row_spacing: u32,
    pub label_style: String,
    pub show_row_titles: bool,

    // ── Apps & layout ──────────────────────────────────────────────────────
    pub sort_mode: String,
    pub group_by_category: bool,
    pub hidden_apps: Vec<String>,
    pub favorites: Vec<String>,
    pub pinned_apps: Vec<String>,
    pub rows: Vec<RowDef>,
    pub max_recent: u32,
    pub show_no_display: bool,

    // ── System ────────────────────────────────────────────────────────────
    pub volume: u32,
    pub muted: bool,

    /// Reveal apps the user hid from the launcher.
    pub show_hidden: bool,

    // ── Recommendations (IMDb) ─────────────────────────────────────────────
    pub media_enabled: bool,
    /// Empty = every genre seed. Otherwise the labels the user opted into.
    pub media_genres: Vec<String>,
    pub media_hero: bool,
    pub media_refresh_hours: u32,
    pub media_shelf_size: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema: 1,
            confirm_launch: false,
            hide_on_launch: true,
            autostart: false,
            sound_effects: true,
            animations: true,
            parallax: true,
            double_click_to_open: false,
            fullscreen_on_start: false,
            always_on_top: false,
            // ── Always-On Display ─────────────────────────────────────────
            aod_enabled: yes(),
            aod_timeout_mins: 5,
            aod_dim: 65,
            aod_style: "clock".into(),

            show_clock: yes(),
            clock_24h: yes(),
            show_labels: yes(),
            show_hints: yes(),
            escape_quits: false,

            theme: "dark".into(),
            accent: d_accent(),
            background_style: "dynamic".into(),
            background_image: None,
            background_blur: 60,
            background_dim: 55,
            tile_size: "medium".into(),
            icons_per_row: 7,
            rows_per_page: 2,
            corner_radius: 14,
            show_top_shelf: yes(),
            top_shelf_interval: 9,
            row_spacing: 34,
            label_style: "auto".into(),
            show_row_titles: yes(),

            sort_mode: "category".into(),
            group_by_category: yes(),
            hidden_apps: Vec::new(),
            favorites: Vec::new(),
            pinned_apps: Vec::new(),
            rows: Vec::new(),
            max_recent: 24,
            show_no_display: false,

            volume: 50,
            muted: false,
            show_hidden: false,

            media_enabled: yes(),
            media_genres: Vec::new(),
            media_hero: yes(),
            media_refresh_hours: 24,
            media_shelf_size: 14,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub launcher_version: String,
    pub app_count: usize,
    pub config_path: String,
    pub hostname: String,
    pub os: String,
    pub desktop: String,
    pub session_type: String,
    pub icon_themes: Vec<String>,
    pub terminal: Option<String>,
    pub has_pactl: bool,
    pub has_gtk_launch: bool,
    pub has_flatpak: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntryInfo>,
}
