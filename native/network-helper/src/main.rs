mod bridge;
mod capabilities;
mod namespace;
mod protocol;
mod seccomp;

use protocol::{ArtifactDescriptor, InnerDescriptor, LaunchDescriptor, OuterMessage};
use sha2::{Digest, Sha256};
use std::env;
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{self, Child, Command};
use std::time::{Duration, Instant};

fn main() {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    let outer = arguments.len() == 1 && arguments[0] == "--outer";
    if let Err(error) = dispatch(&arguments) {
        if outer {
            let _ = protocol::write_frame(
                protocol::READY_FD,
                &OuterMessage::Error {
                    protocol: protocol::PROTOCOL_VERSION,
                    code: "helper_setup_failed",
                },
                protocol::MAX_CONTROL_BYTES,
            );
        }
        eprintln!("chatwca-network-helper failed: {}", error.kind());
        process::exit(1);
    }
}

fn dispatch(arguments: &[std::ffi::OsString]) -> io::Result<()> {
    match arguments {
        [argument] if argument == "--version" => {
            let version = protocol::VersionMessage {
                name: "chatwca-network-helper",
                version: protocol::BUILD_VERSION,
                protocol: protocol::PROTOCOL_VERSION,
            };
            println!(
                "{}",
                serde_json::to_string(&version).expect("version message serializes")
            );
            Ok(())
        }
        [argument] if argument == "--outer" => run_outer(),
        [argument] if argument == "--inner" => run_inner(),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "closed helper command dispatch",
        )),
    }
}

fn descriptor_is_open(fd: RawFd) -> io::Result<libc::stat> {
    let mut status: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut status) } != 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(status)
    }
}

fn validate_parent_descriptors(value: &LaunchDescriptor) -> io::Result<()> {
    let mut identities = std::collections::HashSet::new();
    for fd in [
        protocol::READY_FD,
        protocol::WORKER_REQUEST_FD,
        protocol::WORKER_RESPONSE_FD,
    ]
    .into_iter()
    .chain(value.artifacts.iter().map(|artifact| artifact.fd))
    {
        let status = descriptor_is_open(fd)?;
        if !identities.insert((status.st_dev, status.st_ino)) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "parent descriptors are aliased",
            ));
        }
    }
    Ok(())
}

fn validate_bwrap(target: &Path) -> io::Result<()> {
    if fs::canonicalize(target)? != target {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Bubblewrap path is not canonical",
        ));
    }
    let metadata = fs::symlink_metadata(target)?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
        || unsafe {
            libc::access(
                CString::new(target.as_os_str().as_encoded_bytes())
                    .map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidInput, "invalid Bubblewrap path")
                    })?
                    .as_ptr(),
                libc::X_OK,
            )
        } != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Bubblewrap executable metadata is unsafe",
        ));
    }
    Ok(())
}

fn validate_proxy_socket(target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(target)?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "proxy socket metadata is unsafe",
        ));
    }
    Ok(())
}

fn set_cloexec(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
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

fn sealed_descriptor<T: serde::Serialize>(value: &T, name: &str) -> io::Result<OwnedFd> {
    let name = CString::new(name).expect("fixed memfd name");
    let fd = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        ) as RawFd
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    protocol::write_frame(file.as_raw_fd(), value, protocol::MAX_CONTROL_BYTES)?;
    file.seek(SeekFrom::Start(0))?;
    let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(file.into_raw_fd()) })
}

fn sealed_artifact(artifact: &ArtifactDescriptor) -> io::Result<OwnedFd> {
    let name = CString::new("chatwca-managed-artifact").expect("fixed memfd name");
    let fd = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        ) as RawFd
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut output = unsafe { File::from_raw_fd(fd) };
    let input_fd = unsafe { libc::dup(artifact.fd) };
    if input_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut input = unsafe { File::from_raw_fd(input_fd) };
    let mut remaining = artifact.bytes;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let take = remaining.min(buffer.len());
        let count = input.read(&mut buffer[..take])?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "artifact is truncated",
            ));
        }
        output.write_all(&buffer[..count])?;
        hash.update(&buffer[..count]);
        remaining -= count;
    }
    let mut extra = [0u8; 1];
    if input.read(&mut extra)? != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "artifact is oversized",
        ));
    }
    let actual = format!("{:x}", hash.finalize());
    if actual != artifact.sha256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "artifact hash differs",
        ));
    }
    output.seek(SeekFrom::Start(0))?;
    let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(output.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(output.into_raw_fd()) })
}

fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    let result = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if result != bytes.len() as isize {
        return Err(io::Error::last_os_error());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn fork_bridge(
    bootstrap: RawFd,
    close_bootstrap: RawFd,
    ready: *mut u8,
    token: Vec<u8>,
    target: PathBuf,
) -> io::Result<libc::pid_t> {
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        unsafe { libc::close(close_bootstrap) };
        let code = if bridge::run(bootstrap, ready, &token, &target).is_ok() {
            0
        } else {
            1
        };
        unsafe { libc::_exit(code) };
    }
    Ok(pid)
}

fn park(fd: RawFd) -> io::Result<OwnedFd> {
    let parked = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 64) };
    if parked < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(parked) })
    }
}

fn wait_bridges(child: &mut Child, ready: *mut u8) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if unsafe {
            std::ptr::read_volatile(ready) == 1 && std::ptr::read_volatile(ready.add(1)) == 1
        } {
            return Ok(());
        }
        if child.try_wait()?.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Bubblewrap exited during bridge setup",
            ));
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "bridge setup timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
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

fn run_outer() -> io::Result<()> {
    if env::vars_os().next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "outer helper environment is not empty",
        ));
    }
    capabilities::set_parent_death_signal()?;
    capabilities::own_process_group()?;
    descriptor_is_open(protocol::LAUNCH_FD)?;
    descriptor_is_open(protocol::READY_FD)?;
    let descriptor: LaunchDescriptor =
        protocol::read_frame(protocol::LAUNCH_FD, protocol::MAX_LAUNCH_BYTES)?;
    unsafe { libc::close(protocol::LAUNCH_FD) };
    let descriptor = protocol::validate_launch(descriptor)?;
    validate_parent_descriptors(&descriptor)?;
    validate_bwrap(Path::new(&descriptor.bwrap_path))?;
    validate_proxy_socket(Path::new(&descriptor.http_socket))?;
    validate_proxy_socket(Path::new(&descriptor.socks_socket))?;
    set_cloexec(protocol::READY_FD)?;
    let self_artifact = File::open("/proc/self/exe")?;
    let metadata = self_artifact.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "helper executable is not regular",
        ));
    }
    let sealed_artifacts: Vec<(OwnedFd, RawFd)> = descriptor
        .artifacts
        .iter()
        .map(|artifact| sealed_artifact(artifact).map(|fd| (fd, artifact.fd)))
        .collect::<io::Result<_>>()?;
    for artifact in &descriptor.artifacts {
        unsafe { libc::close(artifact.fd) };
    }
    let inner = InnerDescriptor {
        protocol: protocol::PROTOCOL_VERSION,
        build_version: protocol::BUILD_VERSION.into(),
        token: random_token()?,
        guest_path: descriptor.guest_path.clone(),
        parent_namespaces: namespace::identities()?,
    };
    let inner_artifact = sealed_descriptor(&inner, "chatwca-inner-config")?;
    let (http_bridge, http_inner) = socket_pair()?;
    let (socks_bridge, socks_inner) = socket_pair()?;
    let ready = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            2,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED | libc::MAP_ANONYMOUS,
            -1,
            0,
        )
    } as *mut u8;
    if ready.cast::<libc::c_void>() == libc::MAP_FAILED {
        return Err(io::Error::last_os_error());
    }
    let http_token = format!("H{}", &inner.token[1..]).into_bytes();
    let socks_token = format!("S{}", &inner.token[1..]).into_bytes();
    let http_pid = match fork_bridge(
        http_bridge.as_raw_fd(),
        http_inner.as_raw_fd(),
        ready,
        http_token,
        PathBuf::from(&descriptor.http_socket),
    ) {
        Ok(pid) => pid,
        Err(error) => {
            unsafe { libc::munmap(ready.cast(), 2) };
            return Err(error);
        }
    };
    let socks_pid = match fork_bridge(
        socks_bridge.as_raw_fd(),
        socks_inner.as_raw_fd(),
        unsafe { ready.add(1) },
        socks_token,
        PathBuf::from(&descriptor.socks_socket),
    ) {
        Ok(pid) => pid,
        Err(error) => {
            terminate_and_reap(http_pid);
            unsafe { libc::munmap(ready.cast(), 2) };
            return Err(error);
        }
    };
    drop((http_bridge, socks_bridge));
    let parked_inner = park(inner_artifact.as_raw_fd())?;
    let parked_self = park(self_artifact.as_raw_fd())?;
    let parked_http = park(http_inner.as_raw_fd())?;
    let parked_socks = park(socks_inner.as_raw_fd())?;
    let parked_artifacts: Vec<(OwnedFd, RawFd)> = sealed_artifacts
        .iter()
        .map(|(artifact, target)| park(artifact.as_raw_fd()).map(|parked| (parked, *target)))
        .collect::<io::Result<_>>()?;
    drop((inner_artifact, self_artifact, http_inner, socks_inner));
    let mut command = Command::new(&descriptor.bwrap_path);
    command.args(&descriptor.bwrap_args).args([
        "--perms",
        "0500",
        "--ro-bind-data",
        &protocol::SELF_ARTIFACT_FD.to_string(),
        "/app/network-helper",
        "/app/network-helper",
        "--inner",
    ]);
    command.env_clear();
    let mut parked_assignments = vec![
        (parked_inner.as_raw_fd(), protocol::INNER_CONFIG_FD),
        (parked_http.as_raw_fd(), protocol::HTTP_BOOTSTRAP_FD),
        (parked_socks.as_raw_fd(), protocol::SOCKS_BOOTSTRAP_FD),
        (parked_self.as_raw_fd(), protocol::SELF_ARTIFACT_FD),
    ];
    parked_assignments.extend(
        parked_artifacts
            .iter()
            .map(|(source, target)| (source.as_raw_fd(), *target)),
    );
    let inherited = [protocol::WORKER_REQUEST_FD, protocol::WORKER_RESPONSE_FD];
    let kept: Vec<RawFd> = inherited
        .into_iter()
        .chain(parked_assignments.iter().map(|(_, target)| *target))
        .collect();
    unsafe {
        command.pre_exec(move || {
            for (source, target) in &parked_assignments {
                if libc::dup2(*source, *target) != *target {
                    return Err(io::Error::last_os_error());
                }
            }
            for fd in &kept {
                let flags = libc::fcntl(*fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(*fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            let maximum = libc::sysconf(libc::_SC_OPEN_MAX).clamp(1024, 65_536) as RawFd;
            for fd in 3..maximum {
                if !kept.contains(&fd) {
                    let flags = libc::fcntl(fd, libc::F_GETFD);
                    if flags >= 0 {
                        libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
                    }
                }
            }
            Ok(())
        });
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            terminate_and_reap(http_pid);
            terminate_and_reap(socks_pid);
            unsafe { libc::munmap(ready.cast(), 2) };
            return Err(error);
        }
    };
    drop((
        parked_inner,
        parked_http,
        parked_socks,
        parked_self,
        parked_artifacts,
        sealed_artifacts,
    ));
    let setup = wait_bridges(&mut child, ready);
    unsafe { libc::munmap(ready.cast(), 2) };
    if let Err(error) = setup {
        let _ = child.kill();
        let _ = child.wait();
        terminate_and_reap(http_pid);
        terminate_and_reap(socks_pid);
        return Err(error);
    }
    protocol::write_frame(
        protocol::READY_FD,
        &OuterMessage::Ready {
            protocol: protocol::PROTOCOL_VERSION,
            helper_pid: process::id(),
            bwrap_pid: child.id(),
        },
        protocol::MAX_CONTROL_BYTES,
    )?;
    unsafe { libc::close(protocol::READY_FD) };
    let status = child.wait();
    terminate_and_reap(http_pid);
    terminate_and_reap(socks_pid);
    let status = status?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "Bubblewrap exited unsuccessfully",
        ))
    }
}

fn require_ack(fd: RawFd) -> io::Result<()> {
    let mut bytes = [0u8; 3];
    let received = unsafe { libc::recv(fd, bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if received == 2 && &bytes[..2] == b"OK" {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bridge acknowledgement was invalid",
        ))
    }
}

fn close_unrelated_inner() {
    let maximum = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) }.clamp(1024, 65_536) as RawFd;
    for fd in 3..maximum {
        if ![protocol::WORKER_REQUEST_FD, protocol::WORKER_RESPONSE_FD].contains(&fd) {
            unsafe { libc::close(fd) };
        }
    }
}

fn proxy_environment(
    http_port: u16,
    socks_port: u16,
    guest_path: &str,
) -> Vec<(&'static str, String)> {
    let http = format!("http://127.0.0.1:{http_port}");
    let socks = format!("socks5h://127.0.0.1:{socks_port}");
    let mut values = vec![
        ("HOME", "/home/sandbox".into()),
        ("TMPDIR", "/tmp".into()),
        ("PATH", guest_path.into()),
        ("LANG", "C.UTF-8".into()),
        ("LC_ALL", "C.UTF-8".into()),
        ("TERM", "dumb".into()),
        ("NO_COLOR", "1".into()),
        ("CI", "1".into()),
        ("USER", "sandbox".into()),
        ("LOGNAME", "sandbox".into()),
        ("SHELL", "/bin/bash".into()),
        ("PWD", "/workspace".into()),
        ("HTTP_PROXY", http.clone()),
        ("HTTPS_PROXY", http.clone()),
        ("WS_PROXY", http.clone()),
        ("WSS_PROXY", http.clone()),
        ("ALL_PROXY", socks.clone()),
        ("NO_PROXY", String::new()),
        ("http_proxy", http.clone()),
        ("https_proxy", http.clone()),
        ("ws_proxy", http.clone()),
        ("wss_proxy", http.clone()),
        ("all_proxy", socks),
        ("no_proxy", String::new()),
        ("NODE_USE_ENV_PROXY", "1".into()),
        ("ELECTRON_GET_USE_PROXY", "true".into()),
        ("CHATWCA_MANAGED_EGRESS", "1".into()),
        (
            "CHATWCA_NETWORK_HELPER_VERSION_INTERNAL",
            protocol::BUILD_VERSION.into(),
        ),
    ];
    for name in [
        "npm_config_proxy",
        "npm_config_http_proxy",
        "npm_config_https_proxy",
        "yarn_proxy",
        "yarn_http_proxy",
        "yarn_https_proxy",
        "BUNDLE_HTTP_PROXY",
        "PIP_PROXY",
        "DOCKER_HTTP_PROXY",
        "DOCKER_HTTPS_PROXY",
    ] {
        values.push((name, http.clone()));
    }
    for name in [
        "npm_config_noproxy",
        "yarn_no_proxy",
        "PIP_NO_PROXY",
        "DOCKER_NO_PROXY",
    ] {
        values.push((name, String::new()));
    }
    values
}

fn run_inner() -> io::Result<()> {
    // Bubblewrap's PID namespace makes the inner helper PID 1; namespace and
    // process-group teardown are owned by Bubblewrap and the outer helper.
    let inner: InnerDescriptor =
        protocol::read_frame(protocol::INNER_CONFIG_FD, protocol::MAX_CONTROL_BYTES)?;
    let inner = protocol::validate_inner(inner)?;
    for fd in [
        protocol::WORKER_REQUEST_FD,
        protocol::WORKER_RESPONSE_FD,
        protocol::HTTP_BOOTSTRAP_FD,
        protocol::SOCKS_BOOTSTRAP_FD,
    ] {
        descriptor_is_open(fd)?;
    }
    namespace::validate_bootstrap_socket(protocol::HTTP_BOOTSTRAP_FD)?;
    namespace::validate_bootstrap_socket(protocol::SOCKS_BOOTSTRAP_FD)?;
    namespace::verify_isolated(&inner.parent_namespaces)?;
    capabilities::verify_transition_capabilities()?;
    namespace::bring_up_loopback_only()?;
    let http_listener = namespace::create_loopback_listener()?;
    let socks_listener = namespace::create_loopback_listener()?;
    let http_port = http_listener.local_addr()?.port();
    let socks_port = socks_listener.local_addr()?.port();
    bridge::send_listener(
        protocol::HTTP_BOOTSTRAP_FD,
        format!("H{}", &inner.token[1..]).as_bytes(),
        http_listener.as_raw_fd(),
    )?;
    bridge::send_listener(
        protocol::SOCKS_BOOTSTRAP_FD,
        format!("S{}", &inner.token[1..]).as_bytes(),
        socks_listener.as_raw_fd(),
    )?;
    require_ack(protocol::HTTP_BOOTSTRAP_FD)?;
    require_ack(protocol::SOCKS_BOOTSTRAP_FD)?;
    drop((http_listener, socks_listener));
    close_unrelated_inner();
    capabilities::drop_all_and_lock()?;
    seccomp::install()?;
    let error = Command::new("/usr/bin/node")
        .arg("/app/worker.mjs")
        .env_clear()
        .envs(proxy_environment(http_port, socks_port, &inner.guest_path))
        .current_dir("/workspace")
        .exec();
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dispatch_rejects_every_non_closed_form() {
        for args in [
            vec![],
            vec!["--outer".into(), "extra".into()],
            vec!["--phase0-outer".into()],
            vec!["--unknown".into()],
        ] {
            assert!(dispatch(&args).is_err());
        }
    }

    #[test]
    fn managed_artifact_is_hash_verified_and_immutably_sealed() {
        let mut source = [-1; 2];
        assert_eq!(
            unsafe { libc::pipe2(source.as_mut_ptr(), libc::O_CLOEXEC) },
            0
        );
        let payload = b"immutable worker artifact";
        assert_eq!(
            unsafe { libc::write(source[1], payload.as_ptr().cast(), payload.len()) },
            payload.len() as isize
        );
        unsafe { libc::close(source[1]) };
        let descriptor = ArtifactDescriptor {
            fd: source[0],
            destination: "/app/worker.mjs".into(),
            sha256: format!("{:x}", Sha256::digest(payload)),
            bytes: payload.len(),
            mode: "0444".into(),
        };
        let artifact = sealed_artifact(&descriptor).unwrap();
        let seals = unsafe { libc::fcntl(artifact.as_raw_fd(), libc::F_GET_SEALS) };
        assert_eq!(
            seals,
            libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE
        );
        assert_eq!(
            unsafe { libc::write(artifact.as_raw_fd(), b"x".as_ptr().cast(), 1) },
            -1
        );
        unsafe { libc::close(source[0]) };

        let mut bad_source = [-1; 2];
        assert_eq!(
            unsafe { libc::pipe2(bad_source.as_mut_ptr(), libc::O_CLOEXEC) },
            0
        );
        assert_eq!(
            unsafe { libc::write(bad_source[1], payload.as_ptr().cast(), payload.len()) },
            payload.len() as isize
        );
        unsafe { libc::close(bad_source[1]) };
        let bad = ArtifactDescriptor {
            fd: bad_source[0],
            sha256: "0".repeat(64),
            ..descriptor
        };
        assert!(sealed_artifact(&bad).is_err());
        unsafe { libc::close(bad_source[0]) };
    }

    #[test]
    fn parent_death_signal_kills_child() {
        let mut pipe_fds = [-1; 2];
        assert_eq!(
            unsafe { libc::pipe2(pipe_fds.as_mut_ptr(), libc::O_CLOEXEC) },
            0
        );
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            unsafe { libc::close(pipe_fds[0]) };
            let grandchild = unsafe { libc::fork() };
            if grandchild == 0 {
                capabilities::set_parent_death_signal().unwrap();
                unsafe {
                    libc::write(pipe_fds[1], b"R".as_ptr().cast(), 1);
                    libc::pause();
                    libc::_exit(2);
                }
            }
            unsafe {
                libc::_exit(0);
            }
        }
        unsafe { libc::close(pipe_fds[1]) };
        let mut byte = 0u8;
        assert_eq!(
            unsafe { libc::read(pipe_fds[0], (&mut byte as *mut u8).cast(), 1) },
            1
        );
        let mut status = 0;
        unsafe { libc::waitpid(child, &mut status, 0) };
        assert_eq!(byte, b'R');
        let mut poll = libc::pollfd {
            fd: pipe_fds[0],
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        assert!(unsafe { libc::poll(&mut poll, 1, 2_000) } > 0);
        assert_eq!(
            unsafe { libc::read(pipe_fds[0], (&mut byte as *mut u8).cast(), 1) },
            0
        );
    }
}
