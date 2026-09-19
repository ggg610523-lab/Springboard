use crate::model::AppInfo;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// All directories that may hold `.desktop` files, most specific first.
pub fn desktop_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(data) = dirs::data_dir() {
        dirs.push(data.join("applications"));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/applications"));
        dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
    }
    dirs.push(PathBuf::from("/usr/local/share/applications"));
    dirs.push(PathBuf::from("/usr/share/applications"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
    dirs
}

/// A parsed key/value group of a desktop entry file.
#[derive(Debug, Default, Clone)]
struct Group {
    values: HashMap<String, String>,
}

impl Group {
    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(|s| s.as_str())
    }

    fn bool(&self, key: &str) -> bool {
        matches!(
            self.values.get(key).map(|v| v.trim().to_ascii_lowercase()),
            Some(ref v) if v == "true" || v == "1" || v == "yes"
        )
    }

    fn list(&self, key: &str) -> Vec<String> {
        self.values
            .get(key)
            .map(|v| {
                v.split(';')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Look up a possibly localised key (`Name`, `Name[en_US]`, `Name[en]`).
    fn localized(&self, key: &str) -> Option<String> {
        for suffix in locale_suffixes() {
            if let Some(v) = self.values.get(&format!("{key}[{suffix}]")) {
                if !v.trim().is_empty() {
                    return Some(v.trim().to_string());
                }
            }
        }
        self.values
            .get(key)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
}

fn locale_suffixes() -> Vec<String> {
    let raw = std::env::var("LC_MESSAGES")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default();
    let cleaned = raw
        .split('.')
        .next()
        .unwrap_or("")
        .split('@')
        .next()
        .unwrap_or("");
    let mut out = Vec::new();
    if !cleaned.is_empty() && cleaned != "C" && cleaned != "POSIX" {
        out.push(cleaned.to_string());
        if let Some((lang, _)) = cleaned.split_once('_') {
            out.push(lang.to_string());
        }
    }
    out.push("en".into());
    out
}

/// Parse the `[Desktop Entry]` group (other groups are ignored).
fn parse_desktop_file(path: &Path) -> Option<Group> {
    let text = fs::read_to_string(path).ok()?;
    let mut in_entry = false;
    let mut group = Group::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            group
                .values
                .insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    if group.values.is_empty() {
        None
    } else {
        Some(group)
    }
}

/// The desktop file id: relative path with `/` replaced by `-`
/// (e.g. `kde4/kate.desktop` -> `kde4-kate.desktop`).
fn desktop_id(path: &Path, base: &Path) -> String {
    match path.strip_prefix(base) {
        Ok(rel) => rel.to_string_lossy().replace('/', "-"),
        Err(_) => path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

/// Walk a directory tree collecting `.desktop` files (depth limited).
fn collect_desktop_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 3 || !dir.is_dir() {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    for item in read.flatten() {
        let path = item.path();
        if path.is_dir() {
            collect_desktop_files(&path, out, depth + 1);
        } else if path.extension().map(|e| e == "desktop").unwrap_or(false) {
            out.push(path);
        }
    }
}

#[allow(dead_code)]
fn current_desktops() -> Vec<String> {
    let raw = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    raw.split(':')
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Map freedesktop `Categories` to a friendly row name.
pub fn categorize(categories: &[String]) -> String {
    let table: &[(&str, &str)] = &[
        ("WebBrowser", "Internet"),
        ("Email", "Social"),
        ("InstantMessaging", "Social"),
        ("IRCClient", "Social"),
        ("Feed", "Social"),
        ("VideoConference", "Social"),
        ("AudioVideo", "Entertainment"),
        ("Video", "Entertainment"),
        ("AudioPlayer", "Music"),
        ("Audio", "Music"),
        ("VideoPlayer", "Entertainment"),
        ("Player", "Entertainment"),
        ("Game", "Games"),
        ("Emulator", "Games"),
        ("Development", "Developer"),
        ("IDE", "Developer"),
        ("Graphics", "Graphics"),
        ("2DGraphics", "Graphics"),
        ("3DGraphics", "Graphics"),
        ("RasterGraphics", "Graphics"),
        ("VectorGraphics", "Graphics"),
        ("ImageViewer", "Graphics"),
        ("Photography", "Graphics"),
        ("Office", "Productivity"),
        ("TextEditor", "Productivity"),
        ("Spreadsheet", "Productivity"),
        ("WordProcessor", "Productivity"),
        ("Presentation", "Productivity"),
        ("Calculator", "Productivity"),
        ("ProjectManagement", "Productivity"),
        ("Network", "Internet"),
        ("FileTransfer", "Internet"),
        ("P2P", "Internet"),
        ("Education", "Education"),
        ("Science", "Science"),
        ("Math", "Science"),
        ("Settings", "System"),
        ("System", "System"),
        ("PackageManager", "System"),
        ("FileManager", "Utilities"),
        ("TerminalEmulator", "Utilities"),
        ("Utility", "Utilities"),
        ("Archiving", "Utilities"),
        ("Compression", "Utilities"),
        ("Printing", "Utilities"),
        ("Accessibility", "Utilities"),
        ("Core", "Utilities"),
    ];
    for cat in categories {
        for (needle, label) in table {
            if cat == needle {
                return (*label).to_string();
            }
        }
    }
    "Other".into()
}
/// Strip freedesktop field codes (`%U`, `%f`, `%i`, ...) and split an `Exec=`
/// value into an argv vector, honouring double quotes.
pub fn exec_argv(exec: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => in_quote = !in_quote,
            '\\' => {
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
            }
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    args.push(std::mem::take(&mut cur));
                }
            }
            '%' => match chars.peek() {
                Some('%') => {
                    chars.next();
                    cur.push('%');
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        args.push(cur);
    }
    args
}

/// Is `program` resolvable on `$PATH` (or an absolute path that exists)?
pub fn which(program: &str) -> bool {
    let program = program.split_whitespace().next().unwrap_or("");
    if program.is_empty() {
        return false;
    }
    let p = Path::new(program);
    if p.is_absolute() {
        return p.exists();
    }
    let path = std::env::var("PATH").unwrap_or_default();
    path.split(':')
        .any(|dir| !dir.is_empty() && Path::new(dir).join(program).exists())
}

/// Scan the system for launchable applications. Directories are visited
/// most-specific-first so user entries shadow system ones with the same id.
pub fn scan_apps() -> Vec<AppInfo> {
    let desktops = current_desktops();
    let mut seen: Vec<String> = Vec::new();
    let mut apps: Vec<AppInfo> = Vec::new();

    for dir in desktop_dirs() {
        if !dir.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_desktop_files(&dir, &mut files, 0);
        files.sort();
        for file in files {
            let id = desktop_id(&file, &dir);
            if seen.iter().any(|s| s == &id) {
                continue;
            }
            let Some(entry) = parse_desktop_file(&file) else {
                continue;
            };
            seen.push(id.clone());

            let kind = entry.get("Type").unwrap_or("Application");
            if kind != "Application" || entry.bool("Hidden") {
                continue;
            }
            let only = entry.list("OnlyShowIn");
            if !only.is_empty() && !only.iter().any(|d| desktops.iter().any(|c| c == d)) {
                continue;
            }
            let not_in = entry.list("NotShowIn");
            if !not_in.is_empty() && not_in.iter().any(|d| desktops.iter().any(|c| c == d)) {
                continue;
            }
            let Some(name) = entry.localized("Name") else {
                continue;
            };
            let exec = entry.get("Exec").unwrap_or("").to_string();

            // `TryExec` names the binary the entry needs; hide it when missing.
            if let Some(try_exec) = entry.get("TryExec") {
                if !try_exec.is_empty() && !which(try_exec) {
                    continue;
                }
            }

            let categories = entry.list("Categories");
            let group_name = categorize(&categories);
            let terminal = entry.bool("Terminal");
            apps.push(AppInfo {
                id,
                name,
                generic_name: entry.localized("GenericName"),
                comment: entry.localized("Comment"),
                is_flatpak: exec.contains("flatpak"),
                is_snap: exec.contains("/snap/") || exec.starts_with("snap "),
                terminal,
                startup_wm_class: entry.get("StartupWMClass").map(|s| s.to_string()),
                no_display: entry.bool("NoDisplay"),
                icon_name: entry.get("Icon").map(|s| s.to_string()),
                icon_path: None,
                keywords: entry.list("Keywords"),
                categories,
                desktop_file: file.to_string_lossy().to_string(),
                group: group_name,
                exec,
            });
        }
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps.dedup_by(|a, b| a.id == b.id);
    apps
}

