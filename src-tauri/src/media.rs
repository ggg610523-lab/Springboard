//! Recommendation engine + IMDb metadata / cover art.
//!
//! Metadata comes from IMDb's public "suggestion" endpoint
//! (`v3.sg.media-imdb.com/suggestion`), the same keyless endpoint the IMDb
//! website itself uses for its search box, and cover art is fetched from
//! `m.media-amazon.com` and cached on disk so shelves work offline afterwards.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// Sent with every request: the endpoint rejects empty user agents.
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Genre seeds used to build the offline catalogue. Each entry is
/// `(genre label, IMDb search phrasing)`.
pub const GENRE_SEEDS: &[(&str, &str)] = &[
    ("Action", "action movies"),
    ("Adventure", "adventure movies"),
    ("Animation", "animated family movies"),
    ("Comedy", "comedy movies"),
    ("Crime", "crime tv series"),
    ("Documentary", "documentary films"),
    ("Drama", "drama movies"),
    ("Family", "family movies"),
    ("Fantasy", "fantasy movies"),
    ("History", "historical drama movies"),
    ("Horror", "horror movies"),
    ("Mystery", "mystery tv series"),
    ("Romance", "romance movies"),
    ("Sci-Fi", "science fiction movies"),
    ("Thriller", "thriller movies"),
    ("War", "war movies"),
    ("Western", "western movies"),
];

/// One title that can be recommended and shown as a poster.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaItem {
    /// IMDb id, e.g. `tt1375666`.
    pub id: String,
    pub title: String,
    pub year: Option<String>,
    /// `Movie`, `TV Series`, ...
    pub kind: String,
    /// Top billed cast, as returned by IMDb.
    pub stars: Option<String>,
    /// Remote cover art URL.
    pub poster: Option<String>,
    /// Genre bucket the item was discovered through.
    pub genre: String,
    /// IMDb popularity rank (lower is more popular).
    pub rank: f64,
}

/// Everything the engine learns from the user.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserProfile {
    /// Learned affinity per genre (positive = liked, negative = disliked).
    pub genres: HashMap<String, f64>,
    pub liked: Vec<String>,
    pub disliked: Vec<String>,
    pub watched: Vec<String>,
    /// How often a poster was opened.
    pub clicks: HashMap<String, u64>,
    /// Recent search terms, most recent first.
    pub searches: Vec<String>,
    pub updated: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    /// Whether the last network call succeeded.
    pub online: bool,
    pub catalog: usize,
    pub posters: usize,
    pub poster_bytes: u64,
    pub feedback_events: usize,
    pub last_sync: u64,
    pub provider: String,
    pub cache_dir: String,
    pub seeds: Vec<String>,
}
pub fn media_dir() -> PathBuf {
    let dir = crate::settings::config_dir().join("media");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn poster_dir() -> PathBuf {
    let dir = media_dir().join("posters");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn catalog_path() -> PathBuf {
    media_dir().join("catalog.json")
}

fn profile_path() -> PathBuf {
    media_dir().join("profile.json")
}

/// Blocking HTTP GET through the system `curl` (with a `wget` fallback).
/// Keeps the dependency tree small and reuses the system trust store.
pub fn http_get(url: &str, timeout_secs: u32) -> Result<Vec<u8>, String> {
    let result = http_get_inner(url, timeout_secs);
    record_online(result.is_ok());
    result
}

fn http_get_inner(url: &str, timeout_secs: u32) -> Result<Vec<u8>, String> {
    if crate::apps::which("curl") {
        let timeout = format!("{timeout_secs}");
        let output = Command::new("curl")
            .args([
                "-sSfL",
                "--compressed",
                "--max-time",
                &timeout,
                "-A",
                USER_AGENT,
                url,
            ])
            .output()
            .map_err(|e| format!("curl: {e}"))?;
        if output.status.success() {
            return Ok(output.stdout);
        }
        return Err(format!(
            "curl failed ({}) for {url}",
            output.status.code().unwrap_or(-1)
        ));
    }
    if crate::apps::which("wget") {
        let timeout = format!("{timeout_secs}");
        let output = Command::new("wget")
            .args([
                "-q",
                "-O",
                "-",
                "--timeout",
                &timeout,
                "--user-agent",
                USER_AGENT,
                url,
            ])
            .output()
            .map_err(|e| format!("wget: {e}"))?;
        if output.status.success() {
            return Ok(output.stdout);
        }
        return Err(format!("wget failed for {url}"));
    }
    Err("Neither curl nor wget is installed".into())
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// IMDb search paths use underscores for spaces (`sci-fi_movies`).
fn slugify(query: &str) -> String {
    query.trim().to_ascii_lowercase().replace(' ', "_")
}

pub fn search_url(query: &str) -> String {
    format!(
        "https://v3.sg.media-imdb.com/suggestion/x/{}.json?includeVideos=0",
        percent_encode(&slugify(query))
    )
}
/// Map IMDb's `q` / `qid` fields to a friendly kind. `None` filters out
/// videos, shorts, video games and name results.
fn kind_from(q: &str, qid: &str) -> Option<String> {
    match q {
        "feature" => Some("Movie".into()),
        "TV series" | "TV Series" | "tvSeries" => Some("TV Series".into()),
        "TV mini-series" | "TV Mini-Series" | "tvMiniSeries" => Some("TV Mini-Series".into()),
        "TV movie" | "TV Movie" | "tvMovie" => Some("TV Movie".into()),
        _ => match qid {
            "movie" => Some("Movie".into()),
            "tvSeries" => Some("TV Series".into()),
            "tvMiniSeries" => Some("TV Mini-Series".into()),
            _ => None,
        },
    }
}

fn cast_from(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        serde_json::Value::Array(items) => {
            let names: Vec<String> = items
                .iter()
                .filter_map(|item| item.get("name").and_then(|n| n.as_str()))
                .map(|n| n.to_string())
                .collect();
            if names.is_empty() {
                None
            } else {
                Some(names.join(", "))
            }
        }
        _ => None,
    }
}

/// Parse an IMDb suggestion response into recommendable titles.
pub fn parse_suggestions(bytes: &[u8], genre: &str) -> Vec<MediaItem> {
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Vec::new();
    };
    let Some(entries) = json.get("d").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<MediaItem> = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if !id.starts_with("tt") {
            continue;
        }
        let Some(title) = entry.get("l").and_then(|v| v.as_str()) else {
            continue;
        };
        let kind = kind_from(
            entry.get("q").and_then(|v| v.as_str()).unwrap_or(""),
            entry.get("qid").and_then(|v| v.as_str()).unwrap_or(""),
        );
        let Some(kind) = kind else { continue };
        let poster = entry
            .get("i")
            .and_then(|i| i.get("imageUrl"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        out.push(MediaItem {
            id: id.to_string(),
            title: title.to_string(),
            year: entry
                .get("y")
                .and_then(|v| v.as_i64())
                .map(|y| y.to_string())
                .or_else(|| entry.get("tl").and_then(|v| v.as_str()).map(String::from)),
            kind,
            stars: cast_from(entry.get("s")),
            poster,
            genre: genre.to_string(),
            rank: entry
                .get("rank")
                .and_then(|v| v.as_f64())
                .unwrap_or(1_000_000.0),
        });
    }
    out
}

/// Live IMDb search (used by the search overlay).
pub fn search_imdb(query: &str, genre: &str) -> Result<Vec<MediaItem>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let bytes = http_get(&search_url(query), 12)?;
    Ok(parse_suggestions(&bytes, genre))
}

pub fn load_catalog() -> Vec<MediaItem> {
    fs::read_to_string(catalog_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_catalog(items: &[MediaItem]) {
    if let Ok(json) = serde_json::to_string(items) {
        let _ = crate::settings::write_atomic(&catalog_path(), &json);
    }
}

pub fn load_profile() -> UserProfile {
    fs::read_to_string(profile_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_profile(profile: &UserProfile) {
    if let Ok(json) = serde_json::to_string_pretty(profile) {
        let _ = crate::settings::write_atomic(&profile_path(), &json);
    }
}

/// Fetch every genre seed and merge into a ranked catalogue.
/// `genres` restricts the seeds (None = all of them).
pub fn build_catalog(genres: Option<&[String]>) -> Result<Vec<MediaItem>, String> {
    let seeds: Vec<(String, String)> = GENRE_SEEDS
        .iter()
        .filter(|(label, _)| match genres {
            Some(selected) => selected.iter().any(|g| g.eq_ignore_ascii_case(label)),
            None => true,
        })
        .map(|(label, query)| ((*label).to_string(), (*query).to_string()))
        .collect();

    let mut items: Vec<MediaItem> = Vec::new();
    let mut last_error: Option<String> = None;
    for (label, query) in &seeds {
        match search_imdb(query, label) {
            Ok(mut list) => {
                list.retain(|item| item.poster.is_some());
                list.truncate(24);
                for item in list {
                    if !items.iter().any(|existing| existing.id == item.id) {
                        items.push(item);
                    }
                }
            }
            Err(err) => last_error = Some(err),
        }
    }
    if items.is_empty() {
        return Err(last_error.unwrap_or_else(|| "IMDb returned no usable titles".into()));
    }
    items.sort_by(|a, b| a.rank.partial_cmp(&b.rank).unwrap_or(std::cmp::Ordering::Equal));
    save_catalog(&items);
    Ok(items)
}
/// IMDb popularity rank → 0..1 (lower rank is more popular).
fn popularity(rank: f64) -> f64 {
    let r = rank.max(1.0);
    (1.0 - (r.log10() - 2.0) / 4.0).clamp(0.0, 1.0)
}

/// Cheap deterministic hash so "shuffle" reorders shelves reproducibly.
fn hash_unit(seed: &str, salt: f64) -> f64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in seed.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash ^= salt.to_bits();
    hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    ((hash >> 11) as f64) / ((1u64 << 53) as f64)
}

/// Rank the catalogue for a user. Combines IMDb popularity with the learned
/// genre affinity, then enforces genre diversity so a shelf never becomes
/// monotone. `salt` re-rolls the tie-breaking jitter ("Shuffle").
pub fn recommendations(
    catalog: &[MediaItem],
    profile: &UserProfile,
    limit: usize,
    salt: f64,
) -> Vec<MediaItem> {
    let mut scored: Vec<(f64, &MediaItem)> = catalog
        .iter()
        .filter(|item| !profile.disliked.iter().any(|id| id == &item.id))
        .map(|item| {
            let affinity = profile.genres.get(&item.genre).copied().unwrap_or(0.0);
            let mut score = 0.55 * popularity(item.rank) + 0.45 * (affinity / 3.0).tanh();
            if profile.liked.iter().any(|id| id == &item.id) {
                score += 0.40;
            }
            if profile.watched.iter().any(|id| id == &item.id) {
                score -= 0.15;
            }
            let clicks = profile.clicks.get(&item.id).copied().unwrap_or(0) as f64;
            score += (clicks * 0.04).min(0.25);
            score += hash_unit(&item.id, salt) * 0.14;
            (score, item)
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let per_genre_cap = (limit / 3).max(2);
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut picked: Vec<MediaItem> = Vec::with_capacity(limit);
    let mut skipped: Vec<MediaItem> = Vec::new();
    for (_, item) in scored {
        if picked.len() >= limit {
            break;
        }
        let used = counts.entry(item.genre.clone()).or_insert(0);
        if *used >= per_genre_cap {
            skipped.push(item.clone());
            continue;
        }
        *used += 1;
        picked.push(item.clone());
    }
    // Top up with the skipped items if diversity starved the shelf.
    for item in skipped {
        if picked.len() >= limit {
            break;
        }
        picked.push(item);
    }
    picked
}

/// Learn from one interaction. `genre` is the item's genre bucket.
pub fn apply_feedback(
    profile: &mut UserProfile,
    id: &str,
    action: &str,
    genre: &str,
) -> Result<(), String> {
    let weight: f64 = match action {
        "like" => 1.5,
        "dislike" => -2.0,
        "hide" => -0.75,
        "watched" => 0.6,
        "click" => 0.15,
        other => return Err(format!("Unknown feedback action: {other}")),
    };
    if !genre.is_empty() {
        let entry = profile.genres.entry(genre.to_string()).or_insert(0.0);
        *entry = (*entry + weight).clamp(-8.0, 8.0);
    }
    match action {
        "like" => {
            if !profile.liked.iter().any(|x| x == id) {
                profile.liked.push(id.to_string());
            }
            profile.disliked.retain(|x| x != id);
        }
        "dislike" | "hide" => {
            if !profile.disliked.iter().any(|x| x == id) {
                profile.disliked.push(id.to_string());
            }
            profile.liked.retain(|x| x != id);
        }
        "watched" => {
            if !profile.watched.iter().any(|x| x == id) {
                profile.watched.push(id.to_string());
            }
        }
        "click" => {
            *profile.clicks.entry(id.to_string()).or_insert(0) += 1;
        }
        _ => {}
    }
    profile.updated = crate::settings::now_secs();
    save_profile(profile);
    Ok(())
}

/// Remember a search term so the Settings panel can show what drives the feed.
pub fn remember_search(profile: &mut UserProfile, query: &str) {
    let query = query.trim().to_lowercase();
    if query.len() < 2 {
        return;
    }
    profile.searches.retain(|s| s != &query);
    profile.searches.insert(0, query);
    profile.searches.truncate(12);
    save_profile(profile);
}

pub fn reset_profile() -> UserProfile {
    let fresh = UserProfile::default();
    save_profile(&fresh);
    fresh
}

/// Feedback events currently stored (used by the status panel).
pub fn feedback_events(profile: &UserProfile) -> usize {
    profile.liked.len()
        + profile.disliked.len()
        + profile.watched.len()
        + profile.clicks.values().filter(|c| **c > 0).count()
}
/// Tracks whether the last network call succeeded, for the status panel.
static ONLINE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static LAST_SYNC: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn record_online(success: bool) {
    use std::sync::atomic::Ordering;
    ONLINE.store(success, Ordering::SeqCst);
}

pub fn is_online() -> bool {
    ONLINE.load(std::sync::atomic::Ordering::SeqCst)
}

pub fn mark_sync() {
    LAST_SYNC.store(crate::settings::now_secs(), std::sync::atomic::Ordering::SeqCst);
}

pub fn last_sync() -> u64 {
    LAST_SYNC.load(std::sync::atomic::Ordering::SeqCst)
}

pub fn status(catalog_len: usize, profile: &UserProfile) -> MediaStatus {
    let (posters, poster_bytes) = cache_stats();
    MediaStatus {
        online: is_online(),
        catalog: catalog_len,
        posters,
        poster_bytes,
        feedback_events: feedback_events(profile),
        last_sync: last_sync(),
        provider: "IMDb (keyless suggestion API) + Amazon cover art".into(),
        cache_dir: poster_dir().to_string_lossy().to_string(),
        seeds: GENRE_SEEDS.iter().map(|(label, _)| (*label).to_string()).collect(),
    }
}

/// Only Amazon/IMDb image hosts may be proxied (guards against SSRF).
const ALLOWED_HOSTS: &[&str] = &[
    "m.media-amazon.com",
    "ia.media-imdb.com",
    "images-na.ssl-images-amazon.com",
    "media-amazon.com",
];

/// Poster width requested from IMDb. One canonical size is cached per title.
pub const POSTER_WIDTH: u32 = 420;

/// Rewrite an IMDb cover URL to a smaller variant
/// (`..._V1_.jpg` → `..._V1_QL75_UX420_CR0,0,420,622_.jpg`).
pub fn thumb_url(url: &str, width: u32) -> String {
    match url.find("._V1_") {
        Some(idx) => {
            let base = &url[..idx];
            let height = (width * 148) / 100;
            format!("{base}._V1_QL75_UX{width}_CR0,0,{width},{height}_.jpg")
        }
        None => url.to_string(),
    }
}

fn poster_allowed(url: &str) -> bool {
    if !url.starts_with("https://") {
        return false;
    }
    let rest = &url[8..];
    let host = rest.split('/').next().unwrap_or("");
    ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

fn safe_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect()
}

pub fn poster_file(id: &str) -> PathBuf {
    poster_dir().join(format!("{}.jpg", safe_id(id)))
}

/// The URL the webview should use for a proxy-cached cover image.
pub fn poster_proxy_url(id: &str, remote: &str) -> String {
    format!(
        "poster://localhost/?id={}&u={}",
        percent_encode(id),
        percent_encode(remote)
    )
}

fn query_param(uri: &str, key: &str) -> Option<String> {
    let query = uri.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            let decoded = crate::icons::percent_decode(value);
            if decoded.is_empty() {
                None
            } else {
                Some(decoded)
            }
        } else {
            None
        }
    })
}

/// Serve a cover image: from the disk cache when possible, otherwise fetch it
/// from IMDb once and store it for offline use.
pub fn poster_bytes(id: &str, remote: Option<&str>) -> Option<Vec<u8>> {
    if id.is_empty() {
        return None;
    }
    let file = poster_file(id);
    if let Ok(bytes) = fs::read(&file) {
        if !bytes.is_empty() {
            return Some(bytes);
        }
    }
    let remote = remote?;
    if !poster_allowed(remote) {
        return None;
    }
    let sized = thumb_url(remote, POSTER_WIDTH);
    let bytes = http_get(&sized, 20).ok()?;
    // Sanity check: JPEG/PNG magic and a plausible size.
    let looks_like_image = bytes.len() > 512
        && (bytes.starts_with(&[0xFF, 0xD8]) || bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]));
    if !looks_like_image {
        return None;
    }
    let _ = fs::write(&file, &bytes);
    Some(bytes)
}

/// Response for `poster://localhost/?id=<tt>&u=<remote url>`.
pub fn poster_response(uri: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .expect("static response")
    };

    let id = query_param(uri, "id").unwrap_or_default();
    let remote = query_param(uri, "u");
    let Some(bytes) = poster_bytes(&id, remote.as_deref()) else {
        return not_found();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CACHE_CONTROL, "public, max-age=604800")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap_or_else(|_| not_found())
}

/// (number of cached posters, total bytes on disk)
pub fn cache_stats() -> (usize, u64) {
    let Ok(read) = fs::read_dir(poster_dir()) else {
        return (0, 0);
    };
    read.flatten().fold((0usize, 0u64), |(count, bytes), item| {
        let size = item.metadata().map(|m| m.len()).unwrap_or(0);
        (count + 1, bytes + size)
    })
}

/// Delete every cached cover image, returning how many were removed.
pub fn clear_posters() -> usize {
    let Ok(read) = fs::read_dir(poster_dir()) else {
        return 0;
    };
    let mut removed = 0;
    for item in read.flatten() {
        if fs::remove_file(item.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}