use crate::apps;
use crate::model::{DirEntryInfo, DirListing, SystemInfo};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Run a program and capture its stdout (stderr is discarded).
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} exited with {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Fire-and-forget a command.
fn fire(program: &str, args: &[&str]) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{program}: {e}"))
}

/// First `NN%` occurrence in a tool's output.
fn parse_percent(text: &str) -> Option<u32> {
    let mut digits = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if ch == '%' && !digits.is_empty() {
            return digits.parse().ok();
        } else if !digits.is_empty() {
            digits.clear();
        }
    }
    None
}

pub fn get_volume() -> Option<u32> {
    if apps::which("pactl") {
        if let Ok(out) = run("pactl", &["get-sink-volume", "@DEFAULT_SINK@"]) {
            if let Some(v) = parse_percent(&out) {
                return Some(v.min(100));
            }
        }
    }
    if apps::which("wpctl") {
        if let Ok(out) = run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"]) {
            if let Some(v) = parse_percent(&out) {
                return Some(v.min(100));
            }
        }
    }
    if apps::which("amixer") {
        if let Ok(out) = run("amixer", &["get", "Master"]) {
            if let Some(open) = out.rfind('[') {
                if let Some(v) = parse_percent(&out[open..]) {
                    return Some(v.min(100));
                }
            }
        }
    }
    None
}

pub fn get_muted() -> Option<bool> {
    if apps::which("pactl") {
        if let Ok(out) = run("pactl", &["get-sink-mute", "@DEFAULT_SINK@"]) {
            let lower = out.to_ascii_lowercase();
            if lower.contains("yes") {
                return Some(true);
            }
            if lower.contains("no") {
                return Some(false);
            }
        }
    }
    None
}
pub fn set_volume(percent: u32) -> Result<String, String> {
    let percent = percent.min(150);
    if apps::which("pactl") {
        run(
            "pactl",
            &["set-sink-volume", "@DEFAULT_SINK@", &format!("{percent}%")],
        )?;
        return Ok(format!("Volume {percent}%"));
    }
    if apps::which("wpctl") {
        let value = format!("{:.2}", percent as f32 / 100.0);
        run("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", &value])?;
        return Ok(format!("Volume {percent}%"));
    }
    if apps::which("amixer") {
        run("amixer", &["set", "Master", &format!("{percent}%")])?;
        return Ok(format!("Volume {percent}%"));
    }
    Err("No volume control tool found (pactl / wpctl / amixer)".into())
}

pub fn toggle_mute() -> Result<bool, String> {
    if apps::which("pactl") {
        run("pactl", &["set-sink-mute", "@DEFAULT_SINK@", "toggle"])?;
        return Ok(get_muted().unwrap_or(false));
    }
    if apps::which("wpctl") {
        run("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"])?;
        return Ok(get_muted().unwrap_or(false));
    }
    Err("No mute control tool found".into())
}
/// Power / session / audio actions exposed in the Settings panel.
pub fn system_action(action: &str, value: Option<i64>) -> Result<String, String> {
    match action {
        "volume-up" | "volume-down" => {
            let current = get_volume().unwrap_or(50) as i64;
            let next = if action == "volume-up" {
                (current + 5).min(100)
            } else {
                (current - 5).max(0)
            };
            set_volume(next as u32)
        }
        "volume-set" => set_volume(value.unwrap_or(50).clamp(0, 100) as u32),
        "volume-mute" => {
            let muted = toggle_mute()?;
            Ok(if muted { "Muted".into() } else { "Unmuted".into() })
        }
        "suspend" => {
            if apps::which("systemctl") {
                run("systemctl", &["suspend"])?;
                Ok("Suspending".into())
            } else {
                Err("systemctl is not available".into())
            }
        }
        "lock" => {
            for (program, args) in [
                ("loginctl", vec!["lock-session"]),
                ("xdg-screensaver", vec!["lock"]),
                ("gnome-screensaver-command", vec!["-l"]),
            ] {
                if apps::which(program) && fire(program, &args).is_ok() {
                    return Ok("Screen locked".into());
                }
            }
            Err("No screen locker found".into())
        }
        "screen-off" => {
            if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("x11") && apps::which("xset") {
                run("xset", &["dpms", "force", "off"])?;
                Ok("Display off".into())
            } else {
                Err("Only supported on X11 sessions".into())
            }
        }
        "logout" => {
            if apps::which("qdbus6") {
                run("qdbus6", &["org.kde.Shutdown", "/Shutdown", "logout"])?;
                Ok("Logging out".into())
            } else if apps::which("qdbus") {
                run("qdbus", &["org.kde.ksmserver", "/KSMServer", "logout"])?;
                Ok("Logging out".into())
            } else if apps::which("loginctl") {
                run("loginctl", &["terminate-session", &session_id()])?;
                Ok("Logging out".into())
            } else {
                Err("No session manager available".into())
            }
        }
        "reboot" => {
            run("systemctl", &["reboot"])?;
            Ok("Rebooting".into())
        }
        "shutdown" => {
            run("systemctl", &["poweroff"])?;
            Ok("Shutting down".into())
        }
        other => Err(format!("Unknown action: {other}")),
    }
}

fn session_id() -> String {
    std::env::var("XDG_SESSION_ID").unwrap_or_else(|_| "self".into())
}
/// One level of directory listing for the in-app file browser.
pub fn list_dir(path: &str, show_hidden: bool) -> Result<DirListing, String> {
    let dir = if path.trim().is_empty() {
        dirs::home_dir().ok_or("No home directory")?
    } else {
        PathBuf::from(path)
    };
    let read = fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut entries: Vec<DirEntryInfo> = Vec::new();
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let meta = item.metadata();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        entries.push(DirEntryInfo {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir,
            size: meta
                .map(|m| if m.is_dir() { 0 } else { m.len() })
                .unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(DirListing {
        path: dir.to_string_lossy().to_string(),
        parent: dir.parent().map(|p| p.to_string_lossy().to_string()),
        entries,
    })
}

fn os_pretty_name() -> String {
    fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|l| l.starts_with("PRETTY_NAME="))
                .map(|l| {
                    l.trim_start_matches("PRETTY_NAME=")
                        .trim_matches('"')
                        .to_string()
                })
        })
        .unwrap_or_else(|| "Linux".into())
}

fn hostname() -> String {
    fs::read_to_string("/etc/hostname")
        .map(|h| h.trim().to_string())
        .unwrap_or_else(|_| "localhost".into())
}

fn icon_themes() -> Vec<String> {
    let mut themes: Vec<String> = Vec::new();
    let roots = [
        dirs::home_dir().map(|h| h.join(".local/share/icons")),
        dirs::home_dir().map(|h| h.join(".icons")),
        Some(PathBuf::from("/usr/share/icons")),
    ];
    for root in roots.into_iter().flatten() {
        let Ok(read) = fs::read_dir(&root) else { continue };
        for item in read.flatten() {
            if item.path().is_dir() {
                themes.push(item.file_name().to_string_lossy().to_string());
            }
        }
    }
    themes.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    themes.dedup();
    themes
}

fn terminal_name() -> Option<String> {
    for program in [
        "konsole",
        "gnome-terminal",
        "kitty",
        "alacritty",
        "xfce4-terminal",
        "foot",
        "wezterm",
        "xterm",
        "x-terminal-emulator",
    ] {
        if apps::which(program) {
            return Some(program.to_string());
        }
    }
    None
}

pub fn system_info(app_count: usize, config_path: &Path) -> SystemInfo {
    SystemInfo {
        launcher_version: env!("CARGO_PKG_VERSION").to_string(),
        app_count,
        config_path: config_path.to_string_lossy().to_string(),
        hostname: hostname(),
        os: os_pretty_name(),
        desktop: std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_else(|_| "unknown".into()),
        session_type: std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".into()),
        icon_themes: icon_themes(),
        terminal: terminal_name(),
        has_pactl: apps::which("pactl"),
        has_gtk_launch: apps::which("gtk-launch"),
        has_flatpak: apps::which("flatpak"),
    }
}