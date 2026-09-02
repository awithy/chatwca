use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::os::fd::RawFd;
use std::path::Path;

pub const BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LAUNCH_BYTES: usize = 64 * 1024;
pub const MAX_CONTROL_BYTES: usize = 4 * 1024;
pub const LAUNCH_FD: RawFd = 3;
pub const READY_FD: RawFd = 4;
pub const INNER_CONFIG_FD: RawFd = 7;
pub const WORKER_REQUEST_FD: RawFd = 8;
pub const WORKER_RESPONSE_FD: RawFd = 9;
pub const HTTP_BOOTSTRAP_FD: RawFd = 10;
pub const SOCKS_BOOTSTRAP_FD: RawFd = 11;
pub const SELF_ARTIFACT_FD: RawFd = 12;
pub const NAMESPACES: [&str; 6] = ["user", "mnt", "pid", "ipc", "uts", "net"];

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LaunchDescriptor {
    pub protocol: u32,
    pub build_version: String,
    pub bwrap_path: String,
    pub bwrap_args: Vec<String>,
    pub http_socket: String,
    pub socks_socket: String,
    pub inherited_fds: Vec<RawFd>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InnerDescriptor {
    pub protocol: u32,
    pub build_version: String,
    pub token: String,
    pub parent_namespaces: NamespaceIdentities,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NamespaceIdentities {
    pub user: String,
    pub mnt: String,
    pub pid: String,
    pub ipc: String,
    pub uts: String,
    pub net: String,
}

impl NamespaceIdentities {
    pub fn get(&self, name: &str) -> Option<&str> {
        match name {
            "user" => Some(&self.user),
            "mnt" => Some(&self.mnt),
            "pid" => Some(&self.pid),
            "ipc" => Some(&self.ipc),
            "uts" => Some(&self.uts),
            "net" => Some(&self.net),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VersionMessage<'a> {
    pub name: &'a str,
    pub version: &'a str,
    pub protocol: u32,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OuterMessage {
    Ready {
        protocol: u32,
        helper_pid: u32,
        bwrap_pid: u32,
    },
    Error {
        protocol: u32,
        code: &'static str,
    },
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn read_exact_fd(fd: RawFd, buffer: &mut [u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < buffer.len() {
        let result = unsafe {
            libc::read(
                fd,
                buffer[offset..].as_mut_ptr().cast(),
                buffer.len() - offset,
            )
        };
        if result == 0 {
            return Err(invalid("truncated protocol frame"));
        }
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        offset += result as usize;
    }
    Ok(())
}

fn write_all_fd(fd: RawFd, buffer: &[u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < buffer.len() {
        let result =
            unsafe { libc::write(fd, buffer[offset..].as_ptr().cast(), buffer.len() - offset) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        offset += result as usize;
    }
    Ok(())
}

pub fn read_frame<T: for<'de> Deserialize<'de>>(fd: RawFd, maximum: usize) -> io::Result<T> {
    let mut header = [0u8; 4];
    read_exact_fd(fd, &mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > maximum {
        return Err(invalid("protocol frame size is invalid"));
    }
    let mut payload = vec![0u8; length];
    read_exact_fd(fd, &mut payload)?;
    serde_json::from_slice(&payload).map_err(|_| invalid("protocol frame is invalid"))
}

pub fn write_frame<T: Serialize>(fd: RawFd, value: &T, maximum: usize) -> io::Result<()> {
    let payload =
        serde_json::to_vec(value).map_err(|_| invalid("protocol serialization failed"))?;
    if payload.is_empty() || payload.len() > maximum {
        return Err(invalid("protocol frame size is invalid"));
    }
    write_all_fd(fd, &(payload.len() as u32).to_be_bytes())?;
    write_all_fd(fd, &payload)
}

fn valid_absolute(value: &str) -> bool {
    !value.contains('\0') && value.len() <= 4096 && Path::new(value).is_absolute()
}

fn count_pair(arguments: &[String], first: &str, second: &str) -> usize {
    arguments
        .windows(2)
        .filter(|pair| pair[0] == first && pair[1] == second)
        .count()
}

fn validate_bwrap_option_grammar(arguments: &[String]) -> io::Result<()> {
    let mut index = 0;
    while index < arguments.len() {
        let arity = match arguments[index].as_str() {
            "--unshare-user" | "--unshare-pid" | "--unshare-ipc" | "--unshare-uts"
            | "--unshare-net" | "--new-session" | "--die-with-parent" | "--clearenv" => 0,
            "--hostname" | "--cap-drop" | "--cap-add" | "--proc" | "--dev" | "--tmpfs"
            | "--dir" | "--perms" | "--chdir" => 1,
            "--ro-bind" | "--bind" | "--symlink" | "--ro-bind-data" => 2,
            _ => {
                return Err(invalid(
                    "Bubblewrap argument is not in the closed launch grammar",
                ))
            }
        };
        if index + arity >= arguments.len() {
            return Err(invalid("Bubblewrap option value is missing"));
        }
        index += arity + 1;
    }
    Ok(())
}

pub fn validate_launch(value: LaunchDescriptor) -> io::Result<LaunchDescriptor> {
    if value.protocol != PROTOCOL_VERSION || value.build_version != BUILD_VERSION {
        return Err(invalid("unsupported helper protocol"));
    }
    if !valid_absolute(&value.bwrap_path)
        || !valid_absolute(&value.http_socket)
        || !valid_absolute(&value.socks_socket)
        || value.http_socket == value.socks_socket
        || value.http_socket.as_bytes().len() > 107
        || value.socks_socket.as_bytes().len() > 107
    {
        return Err(invalid("invalid launch path"));
    }
    if value.bwrap_args.is_empty()
        || value.bwrap_args.len() > 256
        || value
            .bwrap_args
            .iter()
            .any(|item| item.is_empty() || item.len() > 4096 || item.contains('\0'))
        || value.bwrap_args.iter().map(String::len).sum::<usize>() > 48 * 1024
    {
        return Err(invalid("invalid Bubblewrap arguments"));
    }
    validate_bwrap_option_grammar(&value.bwrap_args)?;
    for flag in [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--new-session",
        "--die-with-parent",
        "--clearenv",
    ] {
        if value
            .bwrap_args
            .iter()
            .filter(|entry| entry.as_str() == flag)
            .count()
            != 1
        {
            return Err(invalid(
                "required Bubblewrap isolation flag is missing or duplicated",
            ));
        }
    }
    if value.bwrap_args.iter().any(|entry| {
        ["--share-net", "--inner", "--outer", "/app/network-helper"].contains(&entry.as_str())
    }) || count_pair(&value.bwrap_args, "--cap-drop", "ALL") != 1
        || count_pair(&value.bwrap_args, "--cap-add", "CAP_NET_ADMIN") != 1
        || count_pair(&value.bwrap_args, "--cap-add", "CAP_SETPCAP") != 1
    {
        return Err(invalid("Bubblewrap capability profile is invalid"));
    }
    let mut seen = HashSet::new();
    if !value.inherited_fds.contains(&WORKER_REQUEST_FD)
        || !value.inherited_fds.contains(&WORKER_RESPONSE_FD)
        || value.inherited_fds.len() > 32
        || value.inherited_fds.iter().any(|fd| {
            *fd < WORKER_REQUEST_FD
                || *fd > 63
                || [HTTP_BOOTSTRAP_FD, SOCKS_BOOTSTRAP_FD, SELF_ARTIFACT_FD].contains(fd)
                || !seen.insert(*fd)
        })
    {
        return Err(invalid("inherited descriptor assignment is invalid"));
    }
    Ok(value)
}

pub fn validate_inner(value: InnerDescriptor) -> io::Result<InnerDescriptor> {
    if value.protocol != PROTOCOL_VERSION
        || value.build_version != BUILD_VERSION
        || value.token.len() != 64
        || !value.token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid("invalid inner descriptor"));
    }
    for name in NAMESPACES {
        let identity = value.parent_namespaces.get(name).unwrap_or("");
        if identity.len() > 128
            || !identity.starts_with(&format!("{name}:["))
            || !identity.ends_with(']')
        {
            return Err(invalid("invalid namespace identity"));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> LaunchDescriptor {
        LaunchDescriptor {
            protocol: PROTOCOL_VERSION,
            build_version: BUILD_VERSION.into(),
            bwrap_path: "/usr/bin/bwrap".into(),
            bwrap_args: [
                "--unshare-user",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--unshare-net",
                "--new-session",
                "--die-with-parent",
                "--clearenv",
                "--cap-drop",
                "ALL",
                "--cap-add",
                "CAP_NET_ADMIN",
                "--cap-add",
                "CAP_SETPCAP",
            ]
            .map(String::from)
            .to_vec(),
            http_socket: "/tmp/h.sock".into(),
            socks_socket: "/tmp/s.sock".into(),
            inherited_fds: vec![8, 9, 20],
        }
    }

    #[test]
    fn launch_protocol_is_closed_and_versioned() {
        let encoded = serde_json::to_value(launch()).unwrap();
        let decoded: LaunchDescriptor = serde_json::from_value(encoded.clone()).unwrap();
        validate_launch(decoded).unwrap();
        let mut unknown = encoded.as_object().unwrap().clone();
        unknown.insert("command".into(), serde_json::json!("sh"));
        assert!(serde_json::from_value::<LaunchDescriptor>(unknown.into()).is_err());
        let mut wrong = launch();
        wrong.protocol += 1;
        assert!(validate_launch(wrong).is_err());
        let duplicate = br#"{"protocol":1,"protocol":1,"buildVersion":"1.0.0","bwrapPath":"/b","bwrapArgs":[],"httpSocket":"/h","socksSocket":"/s","inheritedFds":[]}"#;
        assert!(serde_json::from_slice::<LaunchDescriptor>(duplicate).is_err());
    }

    #[test]
    fn launch_rejects_missing_isolation_and_fd_collisions() {
        let mut value = launch();
        value.bwrap_args.retain(|item| item != "--unshare-net");
        assert!(validate_launch(value).is_err());
        let mut value = launch();
        value.inherited_fds.push(10);
        assert!(validate_launch(value).is_err());
    }
}
