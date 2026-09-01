mod bridge;
mod handoff;
mod seccomp;
mod security;

use std::collections::HashMap;
use std::env;
use std::ffi::CString;
use std::fs;
use std::io::{self, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{self, Command};

const VERSION: &str = "0.0.1-phase0";
const PROTOCOL_VERSION: u32 = 0;
const HELPER_DATA_FD: RawFd = 3;
const WORKER_DATA_FD: RawFd = 4;
const HTTP_BOOTSTRAP_FD: RawFd = 10;
const SOCKS_BOOTSTRAP_FD: RawFd = 11;
const NAMESPACES: [&str; 6] = ["user", "mnt", "pid", "ipc", "uts", "net"];

fn main() {
    if let Err(error) = dispatch() {
        eprintln!("network-helper Phase 0 failure: {error}");
        process::exit(1);
    }
}

fn dispatch() -> io::Result<()> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("--version") if arguments.len() == 1 => {
            println!(
                "{{\"name\":\"chatwca-network-helper\",\"version\":\"{VERSION}\",\"protocol\":{PROTOCOL_VERSION},\"stage\":\"phase0\"}}"
            );
            Ok(())
        }
        Some("--phase0-outer") => run_outer(parse_options(&arguments[1..])?),
        Some("--phase0-inner") => run_inner(parse_options(&arguments[1..])?),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "closed Phase 0 command dispatch",
        )),
    }
}

fn parse_options(arguments: &[String]) -> io::Result<HashMap<String, String>> {
    if arguments.len() & 1 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "options require values",
        ));
    }
    let mut options = HashMap::new();
    for pair in arguments.chunks(2) {
        if !pair[0].starts_with("--") || pair[0] == "--phase0-outer" || pair[0] == "--phase0-inner"
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid option",
            ));
        }
        if options.insert(pair[0].clone(), pair[1].clone()).is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "duplicate option",
            ));
        }
    }
    Ok(options)
}

fn require_option(options: &HashMap<String, String>, name: &str) -> io::Result<String> {
    options
        .get(name)
        .cloned()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("missing {name}")))
}

fn reject_unknown(options: &HashMap<String, String>, allowed: &[&str]) -> io::Result<()> {
    if options.keys().all(|name| allowed.contains(&name.as_str())) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unknown option",
        ))
    }
}

fn validate_token(token: &str) -> io::Result<()> {
    if (32..=128).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid bootstrap token",
        ))
    }
}

fn validate_absolute(path: &str) -> io::Result<PathBuf> {
    let value = PathBuf::from(path);
    if value.is_absolute() {
        Ok(value)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must be absolute",
        ))
    }
}

fn run_outer(options: HashMap<String, String>) -> io::Result<()> {
    reject_unknown(
        &options,
        &[
            "--bwrap",
            "--worker",
            "--http-socket",
            "--socks-socket",
            "--token",
        ],
    )?;
    let environment_count = env::vars_os().count();
    let bwrap = validate_absolute(&require_option(&options, "--bwrap")?)?;
    let worker = validate_absolute(&require_option(&options, "--worker")?)?;
    let http_socket = validate_absolute(&require_option(&options, "--http-socket")?)?;
    let socks_socket = validate_absolute(&require_option(&options, "--socks-socket")?)?;
    let token = require_option(&options, "--token")?;
    validate_token(&token)?;
    security::set_parent_death_signal()?;

    let parent_namespaces = namespace_links()?;
    let helper_artifact = sealed_artifact(Path::new("/proc/self/exe"), "chatwca-phase0-helper")?;
    let worker_artifact = sealed_artifact(&worker, "chatwca-phase0-worker")?;
    let (http_bridge_socket, http_inner_socket) = socket_pair()?;
    let (socks_bridge_socket, socks_inner_socket) = socket_pair()?;

    let http_pid = fork_bridge(
        http_bridge_socket.as_raw_fd(),
        http_inner_socket.as_raw_fd(),
        socks_bridge_socket.as_raw_fd(),
        socks_inner_socket.as_raw_fd(),
        format!("{token}:http").into_bytes(),
        http_socket,
    )?;
    let socks_pid = match fork_bridge(
        socks_bridge_socket.as_raw_fd(),
        socks_inner_socket.as_raw_fd(),
        http_bridge_socket.as_raw_fd(),
        http_inner_socket.as_raw_fd(),
        format!("{token}:socks").into_bytes(),
        socks_socket,
    ) {
        Ok(pid) => pid,
        Err(error) => {
            terminate_and_reap(http_pid);
            return Err(error);
        }
    };
    drop(http_bridge_socket);
    drop(socks_bridge_socket);

    // Park every source above the fixed range before replacing any low FD.
    // Newly-created memfds/socketpairs are otherwise allowed to occupy 3/4/10/11.
    let parked_helper = park_descriptor(helper_artifact.as_raw_fd())?;
    let parked_worker = park_descriptor(worker_artifact.as_raw_fd())?;
    let parked_http = park_descriptor(http_inner_socket.as_raw_fd())?;
    let parked_socks = park_descriptor(socks_inner_socket.as_raw_fd())?;
    drop(helper_artifact);
    drop(worker_artifact);
    drop(http_inner_socket);
    drop(socks_inner_socket);
    duplicate_to(parked_helper.as_raw_fd(), HELPER_DATA_FD)?;
    duplicate_to(parked_worker.as_raw_fd(), WORKER_DATA_FD)?;
    duplicate_to(parked_http.as_raw_fd(), HTTP_BOOTSTRAP_FD)?;
    duplicate_to(parked_socks.as_raw_fd(), SOCKS_BOOTSTRAP_FD)?;
    drop((parked_helper, parked_worker, parked_http, parked_socks));

    let mut arguments = vec![
        "--unshare-user".into(),
        "--unshare-pid".into(),
        "--unshare-ipc".into(),
        "--unshare-uts".into(),
        "--unshare-net".into(),
        "--hostname".into(),
        "chatwca-network-phase0".into(),
        "--cap-drop".into(),
        "ALL".into(),
        // CAP_SETPCAP is transition-only: it is needed to empty and lock the
        // bounding set after CAP_NET_ADMIN has raised loopback.
        "--cap-add".into(),
        "CAP_SETPCAP".into(),
        "--cap-add".into(),
        "CAP_NET_ADMIN".into(),
        "--new-session".into(),
        "--die-with-parent".into(),
        "--clearenv".into(),
        "--ro-bind".into(),
        "/usr".into(),
        "/usr".into(),
    ];
    for (source, target, destination) in [
        ("/usr/bin", "usr/bin", "/bin"),
        ("/usr/sbin", "usr/sbin", "/sbin"),
        ("/usr/lib", "usr/lib", "/lib"),
        ("/usr/lib64", "usr/lib64", "/lib64"),
    ] {
        if Path::new(source).exists() {
            arguments.extend(["--symlink".into(), target.into(), destination.into()]);
        }
    }
    arguments.extend([
        "--proc".into(),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--dir".into(),
        "/etc".into(),
        "--dir".into(),
        "/app".into(),
        "--perms".into(),
        "0500".into(),
        "--ro-bind-data".into(),
        HELPER_DATA_FD.to_string(),
        "/app/network-helper".into(),
        "--perms".into(),
        "0400".into(),
        "--ro-bind-data".into(),
        WORKER_DATA_FD.to_string(),
        "/app/worker.cjs".into(),
        "/app/network-helper".into(),
        "--phase0-inner".into(),
        "--token".into(),
        token,
    ]);
    for namespace in NAMESPACES {
        arguments.push(format!("--parent-{namespace}"));
        arguments.push(parent_namespaces[namespace].clone());
    }

    let mut command = Command::new(&bwrap);
    command.args(&arguments).env_clear();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            terminate_and_reap(http_pid);
            terminate_and_reap(socks_pid);
            return Err(error);
        }
    };
    close_fixed_descriptors();
    println!(
        "{{\"type\":\"phase0-processes\",\"outerPid\":{},\"bwrapPid\":{},\"bridgePids\":[{},{}],\"environmentCount\":{}}}",
        process::id(), child.id(), http_pid, socks_pid, environment_count,
    );
    io::stdout().flush()?;

    let status = child.wait()?;
    terminate_and_reap(http_pid);
    terminate_and_reap(socks_pid);
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("Bubblewrap exited with {status}")))
    }
}

fn namespace_links() -> io::Result<HashMap<&'static str, String>> {
    NAMESPACES
        .into_iter()
        .map(|name| {
            fs::read_link(format!("/proc/self/ns/{name}"))
                .map(|value| (name, value.to_string_lossy().into_owned()))
        })
        .collect()
}

fn sealed_artifact(path: &Path, name: &str) -> io::Result<OwnedFd> {
    let contents = fs::read(path)?;
    let name = CString::new(name).expect("fixed memfd name");
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        ) as RawFd
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
    file.write_all(&contents)?;
    file.seek(SeekFrom::Start(0))?;
    let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(file.into_raw_fd()) })
}

fn socket_pair() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut pair = [-1; 2];
    if unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
            0,
            pair.as_mut_ptr(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(pair[0]), OwnedFd::from_raw_fd(pair[1])) })
}

fn fork_bridge(
    bootstrap: RawFd,
    close_one: RawFd,
    close_two: RawFd,
    close_three: RawFd,
    token: Vec<u8>,
    target: PathBuf,
) -> io::Result<libc::pid_t> {
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        for descriptor in [close_one, close_two, close_three] {
            unsafe { libc::close(descriptor) };
        }
        let code = if bridge::run(bootstrap, &token, &target).is_ok() {
            0
        } else {
            1
        };
        unsafe { libc::_exit(code) };
    }
    Ok(pid)
}

fn park_descriptor(source: RawFd) -> io::Result<OwnedFd> {
    let descriptor = unsafe { libc::fcntl(source, libc::F_DUPFD_CLOEXEC, 20) };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
    }
}

fn duplicate_to(source: RawFd, target: RawFd) -> io::Result<()> {
    let result = unsafe { libc::dup2(source, target) };
    if result == target {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn close_fixed_descriptors() {
    for descriptor in [
        HELPER_DATA_FD,
        WORKER_DATA_FD,
        HTTP_BOOTSTRAP_FD,
        SOCKS_BOOTSTRAP_FD,
    ] {
        unsafe { libc::close(descriptor) };
    }
}

fn terminate_and_reap(pid: libc::pid_t) {
    unsafe {
        libc::kill(pid, libc::SIGKILL);
        loop {
            let result = libc::waitpid(pid, std::ptr::null_mut(), 0);
            if result == pid
                || (result < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR))
            {
                break;
            }
        }
    }
}

fn run_inner(options: HashMap<String, String>) -> io::Result<()> {
    let mut allowed = vec!["--token"];
    for namespace in NAMESPACES {
        allowed.push(Box::leak(format!("--parent-{namespace}").into_boxed_str()));
    }
    reject_unknown(&options, &allowed)?;
    let token = require_option(&options, "--token")?;
    validate_token(&token)?;
    verify_namespaces(&options).map_err(|error| stage_error("namespace verification", error))?;
    validate_bootstrap_socket(HTTP_BOOTSTRAP_FD)
        .map_err(|error| stage_error("HTTP bootstrap validation", error))?;
    validate_bootstrap_socket(SOCKS_BOOTSTRAP_FD)
        .map_err(|error| stage_error("SOCKS bootstrap validation", error))?;
    verify_transition_capabilities()
        .map_err(|error| stage_error("transition capability check", error))?;
    bring_up_loopback().map_err(|error| stage_error("loopback setup", error))?;

    let http_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let socks_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let http_port = http_listener.local_addr()?.port();
    let socks_port = socks_listener.local_addr()?.port();
    handoff::send_listener(
        HTTP_BOOTSTRAP_FD,
        format!("{token}:http").as_bytes(),
        http_listener.as_raw_fd(),
    )?;
    handoff::send_listener(
        SOCKS_BOOTSTRAP_FD,
        format!("{token}:socks").as_bytes(),
        socks_listener.as_raw_fd(),
    )?;
    require_acknowledgement(HTTP_BOOTSTRAP_FD)
        .map_err(|error| stage_error("HTTP bridge acknowledgement", error))?;
    require_acknowledgement(SOCKS_BOOTSTRAP_FD)
        .map_err(|error| stage_error("SOCKS bridge acknowledgement", error))?;
    drop(http_listener);
    drop(socks_listener);
    unsafe {
        libc::close(HTTP_BOOTSTRAP_FD);
        libc::close(SOCKS_BOOTSTRAP_FD);
    }

    security::drop_all_and_lock().map_err(|error| stage_error("security transition", error))?;
    seccomp::install().map_err(|error| stage_error("seccomp install", error))?;
    verify_seccomp_behavior().map_err(|error| stage_error("seccomp behavior", error))?;
    close_descriptors_from(3);

    let environment = [
        ("HOME", "/tmp".to_string()),
        ("TMPDIR", "/tmp".to_string()),
        ("PATH", "/usr/bin:/bin".to_string()),
        ("LANG", "C.UTF-8".to_string()),
        ("LC_ALL", "C.UTF-8".to_string()),
        ("TERM", "dumb".to_string()),
        ("NO_COLOR", "1".to_string()),
        ("CI", "1".to_string()),
        ("USER", "sandbox".to_string()),
        ("LOGNAME", "sandbox".to_string()),
        ("SHELL", "/bin/bash".to_string()),
        ("PWD", "/tmp".to_string()),
        ("PHASE0_HTTP_PORT", http_port.to_string()),
        ("PHASE0_SOCKS_PORT", socks_port.to_string()),
        ("PHASE0_SECCOMP_CHECKED", "1".to_string()),
    ];
    let error = Command::new("/usr/bin/node")
        .arg("/app/worker.cjs")
        .env_clear()
        .envs(environment)
        .current_dir("/tmp")
        .exec();
    Err(error)
}

fn stage_error(stage: &str, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{stage}: {error}"))
}

fn verify_namespaces(options: &HashMap<String, String>) -> io::Result<()> {
    for namespace in NAMESPACES {
        let parent = require_option(options, &format!("--parent-{namespace}"))?;
        let current = fs::read_link(format!("/proc/self/ns/{namespace}"))?
            .to_string_lossy()
            .into_owned();
        if current == parent {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{namespace} namespace was not isolated"),
            ));
        }
    }
    Ok(())
}

fn validate_bootstrap_socket(descriptor: RawFd) -> io::Result<()> {
    let mut socket_type = 0;
    let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            &mut socket_type as *mut libc::c_int as *mut libc::c_void,
            &mut length,
        )
    };
    if result == 0 && socket_type == libc::SOCK_SEQPACKET {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid bootstrap descriptor",
        ))
    }
}

#[repr(C, align(8))]
struct InterfaceRequest {
    name: [libc::c_char; libc::IFNAMSIZ],
    data: [u8; 24],
}

fn verify_transition_capabilities() -> io::Result<()> {
    let status = fs::read_to_string("/proc/self/status")?;
    const CAP_SETPCAP: u32 = 8;
    const CAP_NET_ADMIN: u32 = 12;
    let expected = (1u64 << CAP_NET_ADMIN) | (1u64 << CAP_SETPCAP);
    for name in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] {
        let value = status
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}:")))
            .and_then(|value| u64::from_str_radix(value.trim(), 16).ok());
        if value != Some(expected) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{name} was not the closed transition set"),
            ));
        }
    }
    Ok(())
}

fn bring_up_loopback() -> io::Result<()> {
    let descriptor =
        unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut request = InterfaceRequest {
        name: [0; libc::IFNAMSIZ],
        data: [0; 24],
    };
    for (destination, source) in request.name.iter_mut().zip(b"lo\0") {
        *destination = *source as libc::c_char;
    }
    let get_result = unsafe { libc::ioctl(descriptor, libc::SIOCGIFFLAGS as _, &mut request) };
    if get_result != 0 {
        let error = io::Error::last_os_error();
        unsafe { libc::close(descriptor) };
        return Err(error);
    }
    let flags = unsafe { *(request.data.as_ptr() as *const libc::c_short) };
    // Bubblewrap 0.6.1 currently raises lo while constructing --unshare-net.
    // Treat that as idempotent setup; otherwise the retained namespace
    // capability raises it here.
    if flags & libc::IFF_UP as libc::c_short != 0 {
        unsafe { libc::close(descriptor) };
        return Ok(());
    }
    unsafe {
        *(request.data.as_mut_ptr() as *mut libc::c_short) = flags | libc::IFF_UP as libc::c_short;
    }
    let set_result = unsafe { libc::ioctl(descriptor, libc::SIOCSIFFLAGS as _, &request) };
    let error = io::Error::last_os_error();
    unsafe { libc::close(descriptor) };
    if set_result == 0 {
        Ok(())
    } else {
        Err(error)
    }
}

fn require_acknowledgement(descriptor: RawFd) -> io::Result<()> {
    let mut acknowledgement = [0u8; 3];
    let received = unsafe {
        libc::recv(
            descriptor,
            acknowledgement.as_mut_ptr().cast(),
            acknowledgement.len(),
            0,
        )
    };
    if received == 2 && &acknowledgement[..2] == b"OK" {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bridge did not acknowledge listener",
        ))
    }
}

fn verify_seccomp_behavior() -> io::Result<()> {
    let ip = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if ip < 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe { libc::close(ip) };

    let unix = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if unix >= 0 || io::Error::last_os_error().raw_os_error() != Some(libc::EPERM) {
        if unix >= 0 {
            unsafe { libc::close(unix) };
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "AF_UNIX socket was not denied",
        ));
    }
    let mut pair = [-1; 2];
    if unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
            0,
            pair.as_mut_ptr(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    unsafe {
        libc::close(pair[0]);
        libc::close(pair[1]);
    }

    for syscall in [
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ] {
        let result = unsafe { libc::syscall(syscall, 0, 0, 0, 0, 0, 0) };
        if result != -1 || io::Error::last_os_error().raw_os_error() != Some(libc::EPERM) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sensitive syscall was not denied",
            ));
        }
    }
    Ok(())
}

fn close_descriptors_from(first: RawFd) {
    let maximum = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    let maximum = if maximum > 0 {
        maximum.min(65_536) as RawFd
    } else {
        1024
    };
    for descriptor in first..maximum {
        unsafe { libc::close(descriptor) };
    }
}
