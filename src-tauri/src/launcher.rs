use crate::apps::{exec_argv, which};
use crate::model::AppInfo;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Terminal emulators with the flag used to run a command inside them.
const TERMINALS: &[(&str, &[&str])] = &[
    ("konsole", &["-e"]),
    ("gnome-terminal", &["--"]),
    ("kgx", &["--"]),
    ("xfce4-terminal", &["-x"]),
    ("tilix", &["-e"]),
    ("terminator", &["-x"]),
    ("alacritty", &["-e"]),
    ("kitty", &[]),
    ("wezterm", &["start", "--"]),
    ("foot", &[]),
    ("ghostty", &["-e"]),
    ("urxvt", &["-e"]),
    ("xterm", &["-e"]),
    ("lxterminal", &["-e"]),
    ("x-terminal-emulator", &["-e"]),
];

/// Fully detach a child process and reap it on a helper thread.
fn detach(mut cmd: Command) -> std::io::Result<Child> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn()?;
    Ok(child)
}

/// Run a probe command: succeeds only if it is still alive after `grace`.
fn probe(cmd: Command, grace: Duration) -> bool {
    let Ok(mut child) = detach(cmd) else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if started.elapsed() >= grace {
                    reap(child);
                    return true;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return false,
        }
    }
}

fn reap(mut child: Child) {
    thread::spawn(move || {
        let _ = child.wait();
    });
}

fn try_exec(argv: &[String], grace: Duration) -> bool {
    let Some((program, args)) = argv.split_first() else {
        return false;
    };
    let mut cmd = Command::new(program);
    cmd.args(args);
    probe(cmd, grace)
}

fn terminal_argv(cmdline: &str) -> Option<Vec<String>> {
    for (program, flags) in TERMINALS {
        if !which(program) {
            continue;
        }
        let mut argv: Vec<String> = vec![(*program).to_string()];
        argv.extend(flags.iter().map(|f| (*f).to_string()));
        argv.push("bash".into());
        argv.push("-c".into());
        argv.push(format!("{cmdline}; exec bash"));
        return Some(argv);
    }
    None
}

/// The desktop file id without its `.desktop` suffix (`gtk-launch` wants this).
fn gtk_launch_id(app: &AppInfo) -> String {
    app.id
        .strip_suffix(".desktop")
        .unwrap_or(&app.id)
        .to_string()
}

/// Launch a real application, trying the most reliable strategy first.
/// Returns the name of the strategy that worked.
pub fn launch(app: &AppInfo) -> Result<String, String> {
    let grace = Duration::from_millis(450);
    let argv = exec_argv(&app.exec);

    // 1. Flatpak / snap entries are best launched through their own runner.
    if app.is_flatpak && which("flatpak") {
        let args: Vec<String> = argv
            .iter()
            .skip_while(|a| *a != "run")
            .skip(1)
            .cloned()
            .collect();
        if !args.is_empty() {
            let mut full = vec!["flatpak".to_string(), "run".to_string()];
            full.extend(args);
            if try_exec(&full, grace) {
                return Ok("flatpak run".into());
            }
        }
    }

    // 2. gtk-launch handles StartupNotify, DBus activation and Terminal=true.
    if which("gtk-launch") {
        let mut cmd = Command::new("gtk-launch");
        cmd.arg(gtk_launch_id(app));
        cmd.current_dir(dirs::home_dir().unwrap_or_else(|| "/".into()));
        if probe(cmd, grace) {
            return Ok("gtk-launch".into());
        }
    }

    // 3. gio launch understands the desktop file itself.
    if which("gio") {
        let mut cmd = Command::new("gio");
        cmd.arg("launch").arg(&app.desktop_file);
        if probe(cmd, grace) {
            return Ok("gio launch".into());
        }
    }

    // 4. Run the Exec= line directly (with field codes stripped).
    if !argv.is_empty() {
        let cmdline = argv
            .iter()
            .map(|a| shell_quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        if app.terminal {
            if let Some(term_argv) = terminal_argv(&cmdline) {
                if try_exec(&term_argv, grace) {
                    return Ok("terminal".into());
                }
            }
        }
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(&cmdline);
        if probe(cmd, grace) {
            return Ok("exec".into());
        }
    }

    // 5. Absolute last resort: ask the session to open the desktop file.
    if which("xdg-open") {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&app.desktop_file);
        if probe(cmd, grace) {
            return Ok("xdg-open".into());
        }
    }

    Err(format!(
        "Could not start \"{}\". Tried gtk-launch, gio launch, direct exec and xdg-open.\nExec={}",
        app.name, app.exec
    ))
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_alphanumeric() || "._-/:@+=,%^".contains(c))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// Open a file, folder or URL with the desktop's default handler.
pub fn open_target(target: &str) -> Result<(), String> {
    let program = if which("gio") { "gio" } else { "xdg-open" };
    let mut cmd = Command::new(program);
    if program == "gio" {
        cmd.arg("open");
    }
    cmd.arg(target);
    detach(cmd).map_err(|e| format!("Failed to open {target}: {e}"))?;
    Ok(())
}