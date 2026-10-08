use std::{collections::BTreeMap, time::Duration};

#[cfg(target_os = "linux")]
use std::net::Ipv4Addr;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use crate::process::configure_background_command;

pub(crate) const SCAN_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(any(windows, target_os = "macos"))]
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_SERVERS: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Listener {
    host: String,
    port: u16,
    pid: Option<u32>,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    inode: Option<u64>,
}

/// One live terminal session and the pids of its process tree (root first).
pub(crate) struct TerminalProcessSet {
    pub thread_id: String,
    pub terminal_id: String,
    pub pids: Vec<u32>,
}

pub(crate) async fn discover(
    cancellation: &CancellationToken,
    terminals: &[TerminalProcessSet],
) -> Vec<Value> {
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut listeners = platform_listeners(cancellation).await;
    #[cfg(target_os = "linux")]
    attribute_socket_owners(cancellation, &mut listeners, terminals).await;
    let names = process_names(listeners.iter().filter_map(|listener| listener.pid));
    listeners
        .into_iter()
        .take(MAX_SERVERS)
        .map(|listener| {
            let process_name = listener.pid.and_then(|pid| names.get(&pid)).cloned();
            json!({
                "host": listener.host,
                "port": listener.port,
                "url": format!("http://{}:{}/", listener.host, listener.port),
                "processName": process_name,
                "pid": listener.pid,
                "terminal": terminal_for_pid(terminals, listener.pid),
            })
        })
        .collect()
}

fn terminal_for_pid(terminals: &[TerminalProcessSet], pid: Option<u32>) -> Option<Value> {
    let pid = pid?;
    terminals
        .iter()
        .find(|terminal| terminal.pids.contains(&pid))
        .map(|terminal| {
            json!({ "threadId": terminal.thread_id, "terminalId": terminal.terminal_id })
        })
}

/// `/proc/net/tcp` carries no pid, so resolve listener socket inodes through the
/// fd tables of terminal descendants only; the rest of the host is never scanned.
#[cfg(target_os = "linux")]
async fn attribute_socket_owners(
    cancellation: &CancellationToken,
    listeners: &mut [Listener],
    terminals: &[TerminalProcessSet],
) {
    if terminals.is_empty() || listeners.iter().all(|listener| listener.pid.is_some()) {
        return;
    }
    let pids = terminals
        .iter()
        .flat_map(|terminal| terminal.pids.iter().copied())
        .collect::<Vec<_>>();
    let owners = tokio::select! {
        () = cancellation.cancelled() => return,
        owners = tokio::task::spawn_blocking(move || {
            socket_inode_pids(std::path::Path::new("/proc"), &pids)
        }) => owners.unwrap_or_default(),
    };
    for listener in listeners {
        if listener.pid.is_none() {
            listener.pid = listener.inode.and_then(|inode| owners.get(&inode).copied());
        }
    }
}

#[cfg(target_os = "linux")]
fn socket_inode_pids(
    proc_root: &std::path::Path,
    pids: &[u32],
) -> std::collections::HashMap<u64, u32> {
    let mut map = std::collections::HashMap::new();
    for &pid in pids {
        // Processes exit and fd dirs can be unreadable; skip both.
        let Ok(entries) = std::fs::read_dir(proc_root.join(pid.to_string()).join("fd")) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(target) = std::fs::read_link(entry.path()) else {
                continue;
            };
            let target = target.to_string_lossy();
            if let Some(inode) = target
                .strip_prefix("socket:[")
                .and_then(|inode| inode.strip_suffix(']'))
                && let Ok(inode) = inode.parse()
            {
                map.insert(inode, pid);
            }
        }
    }
    map
}

fn normalize(mut listeners: Vec<Listener>) -> Vec<Listener> {
    for listener in &mut listeners {
        if matches!(listener.host.as_str(), "0.0.0.0" | "::" | "::1" | "*") {
            listener.host = "127.0.0.1".to_owned();
        }
    }
    listeners
        .into_iter()
        .filter(|listener| listener.host == "127.0.0.1")
        .fold(BTreeMap::new(), |mut by_address, listener| {
            by_address
                .entry((listener.host.clone(), listener.port))
                .and_modify(|existing: &mut Listener| {
                    if existing.pid.is_none() {
                        existing.pid = listener.pid;
                    }
                    if existing.inode.is_none() {
                        existing.inode = listener.inode;
                    }
                })
                .or_insert(listener);
            by_address
        })
        .into_values()
        .collect()
}

#[cfg(windows)]
async fn platform_listeners(cancellation: &CancellationToken) -> Vec<Listener> {
    let mut command = tokio::process::Command::new("netstat.exe");
    configure_background_command(&mut command);
    command.args(["-ano", "-p", "tcp"]).kill_on_drop(true);
    let output = tokio::select! {
        () = cancellation.cancelled() => return Vec::new(),
        output = tokio::time::timeout(COMMAND_TIMEOUT, command.output()) => output,
    };
    let Ok(Ok(output)) = output else {
        return Vec::new();
    };
    normalize(parse_netstat(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(windows)]
fn parse_netstat(output: &str) -> Vec<Listener> {
    output
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 5
                || !fields[0].eq_ignore_ascii_case("TCP")
                || !fields[3].eq_ignore_ascii_case("LISTENING")
            {
                return None;
            }
            let (host, port) = split_address(fields[1])?;
            Some(Listener {
                host,
                port,
                pid: fields[4].parse().ok().filter(|pid| *pid > 0),
                inode: None,
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
async fn platform_listeners(cancellation: &CancellationToken) -> Vec<Listener> {
    tokio::select! {
        () = cancellation.cancelled() => Vec::new(),
        result = async {
            tokio::join!(
                tokio::fs::read_to_string("/proc/net/tcp"),
                tokio::fs::read_to_string("/proc/net/tcp6")
            )
        } => {
            let (ipv4, ipv6) = result;
            let mut listeners = ipv4.map_or_else(|_| Vec::new(), |content| parse_proc_tcp(&content));
            listeners.extend(ipv6.map_or_else(|_| Vec::new(), |content| parse_proc_tcp6(&content)));
            normalize(listeners)
        }
    }
}

#[cfg(target_os = "linux")]
fn parse_proc_tcp(input: &str) -> Vec<Listener> {
    input
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 10 || fields[3] != "0A" {
                return None;
            }
            let (address, port) = fields[1].split_once(':')?;
            let encoded = u32::from_str_radix(address, 16).ok()?;
            let host = Ipv4Addr::from(encoded.to_le_bytes()).to_string();
            Some(Listener {
                host,
                port: u16::from_str_radix(port, 16).ok()?,
                pid: None,
                inode: fields[9].parse().ok().filter(|inode| *inode != 0),
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn parse_proc_tcp6(input: &str) -> Vec<Listener> {
    input
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 10 || fields[3] != "0A" {
                return None;
            }
            let (address, port) = fields[1].split_once(':')?;
            let host = if address.chars().all(|character| character == '0') {
                "0.0.0.0"
            } else if address == "00000000000000000000000001000000" {
                "127.0.0.1"
            } else {
                return None;
            };
            Some(Listener {
                host: host.to_owned(),
                port: u16::from_str_radix(port, 16).ok()?,
                pid: None,
                inode: fields[9].parse().ok().filter(|inode| *inode != 0),
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
async fn platform_listeners(cancellation: &CancellationToken) -> Vec<Listener> {
    let mut command = tokio::process::Command::new("/usr/sbin/lsof");
    command
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
        .kill_on_drop(true);
    let output = tokio::select! {
        () = cancellation.cancelled() => return Vec::new(),
        output = tokio::time::timeout(COMMAND_TIMEOUT, command.output()) => output,
    };
    let Ok(Ok(output)) = output else {
        return Vec::new();
    };
    normalize(parse_lsof(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(target_os = "macos")]
fn parse_lsof(output: &str) -> Vec<Listener> {
    let mut pid = None;
    let mut listeners = Vec::new();
    for line in output.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse().ok();
        } else if let Some(value) = line.strip_prefix('n') {
            let address = value.split(" (LISTEN)").next().unwrap_or(value);
            if let Some((host, port)) = split_address(address) {
                listeners.push(Listener {
                    host,
                    port,
                    pid,
                    inode: None,
                });
            }
        }
    }
    listeners
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
async fn platform_listeners(_cancellation: &CancellationToken) -> Vec<Listener> {
    Vec::new()
}

#[cfg(any(windows, target_os = "macos"))]
fn split_address(input: &str) -> Option<(String, u16)> {
    if let Some(rest) = input.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        return Some((host.to_owned(), port.parse().ok()?));
    }
    let (host, port) = input.rsplit_once(':')?;
    Some((host.to_owned(), port.parse().ok()?))
}

fn process_names(pids: impl Iterator<Item = u32>) -> BTreeMap<u32, String> {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let pids = pids.collect::<std::collections::BTreeSet<_>>();
    if pids.is_empty() {
        return BTreeMap::new();
    }
    let sysinfo_pids = pids.iter().copied().map(Pid::from_u32).collect::<Vec<_>>();
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&sysinfo_pids), true);
    pids.into_iter()
        .filter_map(|pid| {
            system
                .process(Pid::from_u32(pid))
                .map(|process| (pid, process.name().to_string_lossy().into_owned()))
        })
        .filter(|(_, name)| !name.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_and_ipv6_loopback_listeners_normalize_to_loopback_http() {
        let listeners = normalize(vec![
            Listener {
                host: "*".to_owned(),
                port: 3000,
                pid: Some(1),
                inode: None,
            },
            Listener {
                host: "::1".to_owned(),
                port: 4000,
                pid: Some(2),
                inode: None,
            },
        ]);

        assert_eq!(listeners.len(), 2);
        assert!(
            listeners
                .iter()
                .all(|listener| listener.host == "127.0.0.1")
        );
    }

    #[test]
    fn listeners_are_attributed_to_the_terminal_owning_their_pid() {
        let terminals = vec![TerminalProcessSet {
            thread_id: "thread-1".into(),
            terminal_id: "term-1".into(),
            pids: vec![100, 101],
        }];
        assert_eq!(
            terminal_for_pid(&terminals, Some(101)),
            Some(json!({ "threadId": "thread-1", "terminalId": "term-1" }))
        );
        assert_eq!(terminal_for_pid(&terminals, Some(7)), None);
        assert_eq!(terminal_for_pid(&terminals, None), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn proc_tcp_rows_keep_the_socket_inode() {
        let input = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0\n";
        let listeners = parse_proc_tcp(input);
        assert_eq!(listeners[0].port, 5173);
        assert_eq!(listeners[0].inode, Some(424242));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn socket_inodes_map_to_pids_from_fd_links_and_skip_unreadable_dirs() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("100/fd")).unwrap();
        std::os::unix::fs::symlink("socket:[424242]", root.path().join("100/fd/3")).unwrap();
        // pid 101 has no fd dir (vanished process)
        let map = socket_inode_pids(root.path(), &[100, 101]);
        assert_eq!(map.get(&424242), Some(&100));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn discover_attributes_a_real_listener_to_the_terminal_owning_its_pid() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let terminals = vec![TerminalProcessSet {
            thread_id: "thread-1".into(),
            terminal_id: "term-1".into(),
            pids: vec![std::process::id()],
        }];

        let servers = discover(&CancellationToken::new(), &terminals).await;
        let server = servers
            .iter()
            .find(|server| server["port"] == port)
            .expect("listener is discovered");
        assert_eq!(server["pid"], std::process::id());
        assert!(server["processName"].is_string());
        assert_eq!(
            server["terminal"],
            json!({ "threadId": "thread-1", "terminalId": "term-1" })
        );

        let unattributed = discover(&CancellationToken::new(), &[]).await;
        let server = unattributed
            .iter()
            .find(|server| server["port"] == port)
            .expect("listener is discovered without terminals");
        assert_eq!(server["terminal"], Value::Null);
        assert_eq!(server["pid"], Value::Null);
    }
}
