use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Extensions we can hand to the webview, best first.
const EXTS: &[(&str, u32)] = &[
    ("png", 60),
    ("svg", 50),
    ("svgz", 45),
    ("webp", 35),
    ("jpg", 30),
    ("jpeg", 30),
    ("xpm", 20),
    ("ico", 15),
];

/// Size directories that produce the sharpest tile, best first. Both the
/// freedesktop form (`256x256`) and the KDE form (`256`, `64@2x`) are covered.
const SIZES: &[&str] = &[
    "256x256",
    "256",
    "128x128",
    "128",
    "1024x1024",
    "1024",
    "512x512",
    "512",
    "192x192",
    "96x96",
    "64x64",
    "64",
    "64@2x",
    "64@3x",
    "48x48",
    "48",
    "scalable",
    "32x32",
    "32",
    "32@2x",
    "24x24",
    "24",
    "22x22",
    "22",
    "16x16",
    "16",
    "symbolic",
];

const CONTEXTS: &[&str] = &[
    "apps",
    "applications",
    "devices",
    "places",
    "categories",
    "mimetypes",
    "actions",
    "status",
    "stock",
];

fn index_store() -> &'static Mutex<Option<HashMap<String, (u32, String)>>> {
    static STORE: OnceLock<Mutex<Option<HashMap<String, (u32, String)>>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

/// Drop the cached index (called after an app rescan).
pub fn invalidate() {
    if let Ok(mut guard) = index_store().lock() {
        *guard = None;
    }
}

/// The icon theme KDE currently uses (`~/.config/kdeglobals` → `[Icons] Theme=`).
fn configured_theme() -> Option<String> {
    let path = dirs::config_dir()?.join("kdeglobals");
    let text = fs::read_to_string(path).ok()?;
    let mut in_icons = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_icons = line == "[Icons]";
            continue;
        }
        if in_icons {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "Theme" && !value.trim().is_empty() {
                    return Some(value.trim().to_string());
                }
            }
        }
    }
    None
}

/// Icon theme search order: the active theme first, then sane fallbacks.
fn theme_order() -> Vec<String> {
    let mut themes: Vec<String> = Vec::new();
    if let Some(theme) = configured_theme() {
        themes.push(theme);
    }
    if let Ok(env_theme) = std::env::var("QT_QPA_PLATFORMTHEME") {
        if !env_theme.trim().is_empty() {
            themes.push(env_theme);
        }
    }
    for fallback in [
        "breeze-dark",
        "breeze",
        "Adwaita",
        "AdwaitaLegacy",
        "gnome",
        "Papirus",
        "Papirus-Dark",
        "Oxygen",
        "Numix",
        "hicolor",
    ] {
        themes.push(fallback.to_string());
    }
    themes.dedup();
    themes
}

fn icon_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".local/share/icons"));
        roots.push(home.join(".icons"));
        roots.push(home.join(".local/share/flatpak/exports/share/icons"));
        roots.push(home.join(".local/share/flatpak/exports/share/pixmaps"));
    }
    roots.push(PathBuf::from("/var/lib/flatpak/exports/share/icons"));
    roots.push(PathBuf::from("/usr/share/icons"));
    roots.push(PathBuf::from("/usr/local/share/icons"));
    roots
}

fn pixmap_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/pixmaps"));
        dirs.push(home.join(".local/share/flatpak/exports/share/pixmaps"));
    }
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/pixmaps"));
    dirs.push(PathBuf::from("/usr/share/pixmaps"));
    dirs.push(PathBuf::from("/usr/local/share/pixmaps"));
    dirs
}

fn walk_icons(dir: &Path, depth: usize, out: &mut Vec<(String, String)>) {
    if depth > 5 {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    for item in read.flatten() {
        let path = item.path();
        if path.is_dir() {
            walk_icons(&path, depth + 1, out);
        } else {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if EXTS.iter().any(|(e, _)| *e == ext) {
                if let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) {
                    out.push((stem, path.to_string_lossy().to_string()));
                }
            }
        }
    }
}

fn ext_score(path: &Path) -> u32 {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    EXTS.iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, s)| *s)
        .unwrap_or(0)
}

/// Score one candidate file: theme match dominates, then file type, then size.
fn score_candidate(path: &Path, theme_score: u32) -> u32 {
    let text = path.to_string_lossy().to_ascii_lowercase();
    let mut score = theme_score * 1_000_000 + ext_score(path) * 1_000;
    let parts: Vec<&str> = text.split('/').collect();
    let size_score = parts
        .iter()
        .filter_map(|part| SIZES.iter().position(|s| s == part))
        .map(|idx| 90u32.saturating_sub(idx as u32 * 4))
        .max()
        .unwrap_or(10);
    score += size_score * 10;
    let context_score = parts
        .iter()
        .filter_map(|part| CONTEXTS.iter().position(|c| c == part))
        .map(|idx| 30u32.saturating_sub(idx as u32 * 2))
        .max()
        .unwrap_or(0);
    score += context_score;
    // Monochrome symbolic icons make poor app tiles.
    if text.contains("symbolic") {
        score = score.saturating_sub(250_000);
    }
    score
}
fn build_index() -> HashMap<String, (u32, String)> {
    let themes = theme_order();
    let mut index: HashMap<String, (u32, String)> = HashMap::new();

    for root in icon_roots() {
        let Ok(read) = fs::read_dir(&root) else { continue };
        for item in read.flatten() {
            let path = item.path();
            if path.is_dir() {
                let theme_name = item.file_name().to_string_lossy().to_string();
                let theme_score = match themes
                    .iter()
                    .position(|t| t.eq_ignore_ascii_case(&theme_name))
                {
                    Some(idx) => 100u32.saturating_sub(idx as u32 * 2).max(70),
                    None => 80,
                };
                let mut files = Vec::new();
                walk_icons(&path, 0, &mut files);
                for (stem, file) in files {
                    insert_candidate(&mut index, stem, &PathBuf::from(file), theme_score);
                }
            } else if let Some(stem) = path.file_stem() {
                // Flat files sitting directly in an icon root.
                insert_candidate(
                    &mut index,
                    stem.to_string_lossy().to_string(),
                    &path,
                    (themes.len() as u32) + 100,
                );
            }
        }
    }

    for dir in pixmap_dirs() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for item in read.flatten() {
            let path = item.path();
            if let Some(stem) = path.file_stem() {
                insert_candidate(
                    &mut index,
                    stem.to_string_lossy().to_string(),
                    &path,
                    (themes.len() as u32) + 150,
                );
            }
        }
    }
    index
}

fn insert_candidate(
    index: &mut HashMap<String, (u32, String)>,
    stem: String,
    path: &Path,
    theme_score: u32,
) {
    let score = score_candidate(path, theme_score);
    let entry = index.entry(stem).or_insert((0, String::new()));
    if score > entry.0 {
        *entry = (score, path.to_string_lossy().to_string());
    }
}

fn with_index<T>(f: impl FnOnce(&HashMap<String, (u32, String)>) -> T) -> T {
    let mut guard = index_store().lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(build_index());
    }
    f(guard.as_ref().expect("index is built above"))
}

/// Resolve a desktop entry `Icon=` value to an absolute file path.
pub fn resolve(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    // Absolute paths are used verbatim (an extension may be absent).
    if name.starts_with('/') {
        let direct = PathBuf::from(name);
        if direct.is_file() {
            return Some(direct.to_string_lossy().to_string());
        }
        for (ext, _) in EXTS {
            let candidate = PathBuf::from(format!("{name}.{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        return None;
    }

    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());

    if let Some(path) = with_index(|idx| idx.get(&stem).map(|(_, p)| p.clone())) {
        return Some(path);
    }

    // Last resort: a generic "executable" icon from the active theme.
    for generic in [
        "application-x-executable",
        "exec",
        "application-default-icon",
    ] {
        if let Some(path) = with_index(|idx| idx.get(generic).map(|(_, p)| p.clone())) {
            return Some(path);
        }
    }
    None
}
pub(crate) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Extract the `n` / `name` query parameter from an `appicon://` URL.
pub fn name_from_uri(uri: &str) -> Option<String> {
    let query = uri.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            if key == "n" || key == "name" {
                let decoded = percent_decode(value);
                if !decoded.is_empty() {
                    return Some(decoded);
                }
            }
        }
    }
    None
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "svg" | "svgz" => "image/svg+xml",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "xpm" => "image/x-xpixmap",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Serves `appicon://localhost/?n=<icon-name>` requests for the webview.
pub fn protocol_response(uri: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .expect("static response")
    };

    let Some(name) = name_from_uri(uri) else {
        return not_found();
    };
    let Some(path) = resolve(&name) else {
        return not_found();
    };
    let Ok(bytes) = fs::read(&path) else {
        return not_found();
    };
    let mime = mime_for(&path);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap_or_else(|_| not_found())
}

/// Build the URL used by the frontend for a given icon name.
pub fn icon_uri(icon: &str) -> String {
    let mut encoded = String::new();
    for byte in icon.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                encoded.push(*byte as char)
            }
            b => encoded.push_str(&format!("%{b:02X}")),
        }
    }
    format!("appicon://localhost/?n={encoded}")
}