use crate::model::{Settings, UsageEntry, UsageStats};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `~/.config/appletv-launcher`
pub fn config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let dir = base.join("appletv-launcher");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn usage_path() -> PathBuf {
    config_dir().join("usage.json")
}

pub fn apps_cache_path() -> PathBuf {
    config_dir().join("apps-cache.json")
}

/// Write a file atomically (temp file + rename) so a crash cannot corrupt it.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

pub fn load_settings() -> Settings {
    let path = settings_path();
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Settings>(&text).unwrap_or_else(|err| {
            eprintln!("[settings] failed to parse {}: {err}", path.display());
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    write_atomic(&settings_path(), &json).map_err(|e| e.to_string())
}

pub fn load_usage() -> UsageStats {
    fs::read_to_string(usage_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_usage(usage: &UsageStats) {
    if let Ok(json) = serde_json::to_string_pretty(usage) {
        let _ = write_atomic(&usage_path(), &json);
    }
}

/// Record one launch of `id` so "Most Used" / "Recent" rows keep working.
pub fn record_launch(id: &str) -> UsageStats {
    let mut usage = load_usage();
    let entry = usage.apps.entry(id.to_string()).or_default();
    entry.count += 1;
    entry.last_used = now_secs();
    save_usage(&usage);
    usage
}

pub fn entry_count(usage: &UsageStats, id: &str) -> u64 {
    usage.apps.get(id).map(|e: &UsageEntry| e.count).unwrap_or(0)
}

pub fn entry_last_used(usage: &UsageStats, id: &str) -> u64 {
    usage
        .apps
        .get(id)
        .map(|e: &UsageEntry| e.last_used)
        .unwrap_or(0)
}

/// Enable/disable launching the app on login via a freedesktop autostart file.
pub fn set_autostart(enabled: bool) -> Result<String, String> {
    let dir = dirs::config_dir()
        .ok_or("no config dir")?
        .join("autostart");
    let path = dir.join("appletv-launcher.desktop");
    if !enabled {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok("Autostart disabled".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let body = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Apple TV Launcher\n\
         Comment=Start the tvOS style launcher with the session\n\
         Exec={}\n\
         Icon=video-display\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n\
         Categories=Utility;\n",
        exe.display()
    );
    write_atomic(&path, &body).map_err(|e| e.to_string())?;
    Ok(format!("Autostart enabled ({})", path.display()))
}
