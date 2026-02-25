// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: thechat [OPTIONS] [PROJECT_DIR]");
        println!();
        println!("Arguments:");
        println!("  [PROJECT_DIR]    Directory to open as project");
        println!();
        println!("Options:");
        println!("  --foreground     Stay attached to the terminal");
        println!("  -h, --help       Print this help message");
        std::process::exit(0);
    }

    #[cfg(all(unix, not(debug_assertions)))]
    if !args.iter().any(|a| a == "--foreground") {
        detach_from_terminal();
    }

    thechat_lib::run()
}

/// Fork the process so the parent (holding the terminal) exits immediately
/// and the child continues running the GUI in a new session.
/// Only compiled on Unix release builds.
#[cfg(all(unix, not(debug_assertions)))]
fn detach_from_terminal() {
    use std::os::unix::io::AsRawFd;

    // Don't fork if stdin isn't a TTY — we're already detached
    // (e.g. launched from a .desktop file or already backgrounded).
    unsafe {
        if libc::isatty(libc::STDIN_FILENO) == 0 {
            return;
        }

        match libc::fork() {
            -1 => eprintln!("Warning: fork() failed, running in foreground"),
            0 => {
                // Child: new session, redirect stdio to /dev/null
                libc::setsid();
                if let Ok(devnull) = std::fs::File::open("/dev/null") {
                    let fd = devnull.as_raw_fd();
                    libc::dup2(fd, libc::STDIN_FILENO);
                    libc::dup2(fd, libc::STDOUT_FILENO);
                    libc::dup2(fd, libc::STDERR_FILENO);
                }
            }
            _ => std::process::exit(0), // Parent exits, frees terminal
        }
    }
}
