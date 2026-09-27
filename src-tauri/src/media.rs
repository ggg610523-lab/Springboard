//! Recommendation engine + IMDb metadata / cover art.
//!
//! Metadata comes from IMDb's public "suggestion" endpoint
//! (`v3.sg.media-imdb.com/suggestion`), the same keyless endpoint the IMDb
//! website itself uses for its search box, and cover art is fetched from
//! `m.media-amazon.com` and cached on disk so shelves work offline afterwards.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use ts_rs::TS;

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
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct UserProfile {
    /// Learned affinity per genre (positive = liked, negative = disliked).
    #[ts(type = "Record<string, number>")]
    pub genres: HashMap<String, f64>,
    pub liked: Vec<String>,
    pub disliked: Vec<String>,
    pub watched: Vec<String>,
    /// How often a poster was opened.
    #[ts(type = "Record<string, number>")]
    pub clicks: HashMap<String, u64>,
    /// Recent search terms, most recent first.
    pub searches: Vec<String>,
    pub updated: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
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

/// How many genre seeds are fetched at once. Each request shells out to `curl`
/// with a 20 s timeout, so running all 17 seeds sequentially could stall the
/// first sync for minutes; a small pool keeps one slow seed from blocking the
/// rest without opening 17 connections.
const CATALOG_WORKERS: usize = 6;

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

    // Seeds are independent, so fan them out over scoped worker threads and
    // pull from a shared index counter instead of handing out fixed chunks
    // (a seed that times out must not stall a whole chunk).
    let next = AtomicUsize::new(0);
    let workers = CATALOG_WORKERS.min(seeds.len()).max(1);
    let mut chunks: Vec<(Vec<MediaItem>, Option<String>)> = Vec::with_capacity(workers);
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            let next = &next;
            let seeds = &seeds;
            handles.push(scope.spawn(move || {
                let mut mine: Vec<MediaItem> = Vec::new();
                let mut error: Option<String> = None;
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some((label, query)) = seeds.get(index) else {
                        break;
                    };
                    match search_imdb(query, label) {
                        Ok(mut list) => {
                            list.retain(|item| item.poster.is_some());
                            list.truncate(24);
                            mine.append(&mut list);
                        }
                        Err(err) => error = Some(err),
                    }
                }
                (mine, error)
            }));
        }
        for handle in handles {
            if let Ok(chunk) = handle.join() {
                chunks.push(chunk);
            }
        }
    });

    let mut items: Vec<MediaItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut last_error: Option<String> = None;
    for (mut chunk, error) in chunks {
        if error.is_some() {
            last_error = error;
        }
        for item in chunk.drain(..) {
            if seen.insert(item.id.clone()) {
                items.push(item);
            }
        }
    }
    if items.is_empty() {
        return Err(last_error.unwrap_or_else(|| "IMDb returned no usable titles".into()));
    }
    // Rank first, id second: the workers merge in completion order, so the
    // tie-breaker keeps the cached file byte-identical between runs.
    items.sort_unstable_by(|a, b| a.rank.total_cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
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
    // The profile lists are scanned once per catalogue item, so build the
    // membership sets up front instead of three linear scans per item.
    let disliked: HashSet<&str> = profile.disliked.iter().map(String::as_str).collect();
    let liked: HashSet<&str> = profile.liked.iter().map(String::as_str).collect();
    let watched: HashSet<&str> = profile.watched.iter().map(String::as_str).collect();

    let mut scored: Vec<(f64, &MediaItem)> = catalog
        .iter()
        .filter(|item| !disliked.contains(item.id.as_str()))
        .map(|item| {
            let id = item.id.as_str();
            let affinity = profile.genres.get(&item.genre).copied().unwrap_or(0.0);
            let mut score = 0.55 * popularity(item.rank) + 0.45 * (affinity / 3.0).tanh();
            if liked.contains(id) {
                score += 0.40;
            }
            if watched.contains(id) {
                score -= 0.15;
            }
            let clicks = profile.clicks.get(&item.id).copied().unwrap_or(0) as f64;
            score += (clicks * 0.04).min(0.25);
            score += hash_unit(&item.id, salt) * 0.14;
            (score, item)
        })
        .collect();

    scored.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));

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

/// Bounded cache of decoded cover art, keyed by IMDb id (~48 × 40 kB).
const POSTER_CACHE_LIMIT: usize = 48;

#[derive(Default)]
struct PosterCache {
    entries: HashMap<String, Arc<Vec<u8>>>,
    order: VecDeque<String>,
}

fn poster_cache() -> &'static Mutex<PosterCache> {
    static CACHE: OnceLock<Mutex<PosterCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(PosterCache::default()))
}

fn cache_get(id: &str) -> Option<Arc<Vec<u8>>> {
    poster_cache().lock().ok()?.entries.get(id).cloned()
}

fn cache_insert(id: &str, arc: Arc<Vec<u8>>) -> Arc<Vec<u8>> {
    if let Ok(mut cache) = poster_cache().lock() {
        if cache
            .entries
            .insert(id.to_string(), arc.clone())
            .is_none()
        {
            cache.order.push_back(id.to_string());
            while cache.order.len() > POSTER_CACHE_LIMIT {
                if let Some(oldest) = cache.order.pop_front() {
                    cache.entries.remove(&oldest);
                }
            }
        }
    }
    arc
}

/// One in-flight fetch per id, so the hero, the shelf tile and the AOD poster
/// wall asking for the same title only trigger a single network request.
type Gate = Arc<(Mutex<bool>, Condvar)>;

fn in_flight() -> &'static Mutex<HashMap<String, Gate>> {
    static MAP: OnceLock<Mutex<HashMap<String, Gate>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_cached_file(file: &std::path::Path) -> Option<Arc<Vec<u8>>> {
    if let Ok(bytes) = fs::read(file) {
        if !bytes.is_empty() {
            return Some(Arc::new(bytes));
        }
    }
    None
}

/// Fetch a poster from IMDb and store it for offline use.
fn fetch_poster(file: &std::path::Path, remote: Option<&str>) -> Option<Arc<Vec<u8>>> {
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
    let _ = fs::write(file, &bytes);
    Some(Arc::new(bytes))
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

/// Serve a cover image: from the memory/disk cache when possible, otherwise
/// fetch it from IMDb once and store it for offline use.
pub fn poster_bytes(id: &str, remote: Option<&str>) -> Option<Arc<Vec<u8>>> {
    if id.is_empty() {
        return None;
    }
    let file = poster_file(id);
    if let Some(hit) = cache_get(id) {
        return Some(hit);
    }
    if let Some(bytes) = read_cached_file(&file) {
        return Some(cache_insert(id, bytes));
    }

    // Only one thread fetches a given title; duplicates wait for the leader
    // and are served from memory or from the file it just wrote.
    let (gate, is_leader) = {
        let mut map = in_flight().lock().ok()?;
        match map.get(id) {
            Some(gate) => (gate.clone(), false),
            None => {
                let gate: Gate = Arc::new((Mutex::new(false), Condvar::new()));
                map.insert(id.to_string(), gate.clone());
                (gate, true)
            }
        }
    };

    if !is_leader {
        let (lock, cvar) = &*gate;
        if let Ok(mut done) = lock.lock() {
            while !*done {
                match cvar.wait_timeout(done, Duration::from_secs(25)) {
                    Ok((guard, timeout)) => {
                        done = guard;
                        if timeout.timed_out() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        return cache_get(id).or_else(|| read_cached_file(&file).map(|bytes| cache_insert(id, bytes)));
    }

    let result = fetch_poster(&file, remote);
    {
        let (lock, cvar) = &*gate;
        if let Ok(mut done) = lock.lock() {
            *done = true;
        }
        cvar.notify_all();
        if let Ok(mut map) = in_flight().lock() {
            map.remove(id);
        }
    }
    result.map(|bytes| cache_insert(id, bytes))
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
        .body(bytes.as_ref().clone())
        .unwrap_or_else(|_| not_found())
}

/// Memoised cover-art statistics.
fn cache_stats_memo() -> &'static Mutex<Option<(Instant, usize, u64)>> {
    static MEMO: OnceLock<Mutex<Option<(Instant, usize, u64)>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(None))
}

/// Number of cached posters and their total size on disk.
///
/// The Recommendations settings panel asks for this on every open, and a
/// `read_dir` over a few hundred files is not free, so the answer is memoised
/// for a couple of seconds (invalidation happens on `clear_posters`).
pub fn cache_stats() -> (usize, u64) {
    const TTL: Duration = Duration::from_secs(2);
    if let Ok(memo) = cache_stats_memo().lock() {
        if let Some((at, count, bytes)) = *memo {
            if at.elapsed() < TTL {
                return (count, bytes);
            }
        }
    }
    let Ok(read) = fs::read_dir(poster_dir()) else {
        return (0, 0);
    };
    let stats = read.flatten().fold((0usize, 0u64), |(count, bytes), item| {
        let size = item.metadata().map(|m| m.len()).unwrap_or(0);
        (count + 1, bytes + size)
    });
    if let Ok(mut memo) = cache_stats_memo().lock() {
        *memo = Some((Instant::now(), stats.0, stats.1));
    }
    stats
}

/// Delete every cached cover image, returning how many were removed.
pub fn clear_posters() -> usize {
    if let Ok(mut memo) = cache_stats_memo().lock() {
        *memo = None;
    }
    if let Ok(mut cache) = poster_cache().lock() {
        cache.entries.clear();
        cache.order.clear();
    }
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