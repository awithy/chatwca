use crate::protocol::{NamespaceIdentities, NAMESPACES};
use std::fs;
use std::io;
use std::mem::{size_of, zeroed};
use std::net::{Ipv4Addr, TcpListener};
use std::os::fd::{AsRawFd, RawFd};

pub fn identities() -> io::Result<NamespaceIdentities> {
    let read = |name: &str| -> io::Result<String> {
        Ok(fs::read_link(format!("/proc/self/ns/{name}"))?
            .to_string_lossy()
            .into_owned())
    };
    Ok(NamespaceIdentities {
        user: read("user")?,
        mnt: read("mnt")?,
        pid: read("pid")?,
        ipc: read("ipc")?,
        uts: read("uts")?,
        net: read("net")?,
    })
}

pub fn verify_isolated(parent: &NamespaceIdentities) -> io::Result<()> {
    let current = identities()?;
    for name in NAMESPACES {
        if current.get(name) == parent.get(name) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "required namespace is shared",
            ));
        }
    }
    Ok(())
}

#[repr(C, align(8))]
struct InterfaceRequest {
    name: [libc::c_char; libc::IFNAMSIZ],
    data: [u8; 24],
}

pub fn bring_up_loopback_only() -> io::Result<()> {
    let devices = fs::read_to_string("/proc/net/dev")?;
    let interfaces: Vec<&str> = devices
        .lines()
        .skip(2)
        .filter_map(|line| line.split_once(':').map(|(name, _)| name.trim()))
        .collect();
    if interfaces != ["lo"] {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "network namespace contains an unexpected interface",
        ));
    }
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut request = InterfaceRequest {
        name: [0; libc::IFNAMSIZ],
        data: [0; 24],
    };
    for (destination, source) in request.name.iter_mut().zip(b"lo\0") {
        *destination = *source as libc::c_char;
    }
    let result = unsafe { libc::ioctl(fd, libc::SIOCGIFFLAGS as _, &mut request) };
    if result != 0 {
        let error = io::Error::last_os_error();
        unsafe { libc::close(fd) };
        return Err(error);
    }
    let flags = unsafe { *(request.data.as_ptr() as *const libc::c_short) };
    if flags & libc::IFF_UP as libc::c_short == 0 {
        unsafe {
            *(request.data.as_mut_ptr() as *mut libc::c_short) =
                flags | libc::IFF_UP as libc::c_short;
        }
        if unsafe { libc::ioctl(fd, libc::SIOCSIFFLAGS as _, &request) } != 0 {
            let error = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(error);
        }
    }
    unsafe { libc::close(fd) };
    Ok(())
}

pub fn create_loopback_listener() -> io::Result<TcpListener> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    validate_loopback_listener(listener.as_raw_fd())?;
    Ok(listener)
}

pub fn validate_bootstrap_socket(fd: RawFd) -> io::Result<()> {
    let mut socket_type = 0;
    let mut length = size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut socket_type as *mut libc::c_int).cast(),
            &mut length,
        )
    } != 0
        || socket_type != libc::SOCK_SEQPACKET
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid bootstrap descriptor",
        ));
    }
    Ok(())
}

pub fn validate_loopback_listener(fd: RawFd) -> io::Result<()> {
    let mut socket_type = 0;
    let mut length = size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut socket_type as *mut libc::c_int).cast(),
            &mut length,
        )
    } != 0
        || socket_type != libc::SOCK_STREAM
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "handoff is not a TCP socket",
        ));
    }
    let mut accepting = 0;
    length = size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_ACCEPTCONN,
            (&mut accepting as *mut libc::c_int).cast(),
            &mut length,
        )
    } != 0
        || accepting != 1
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "handoff socket is not listening",
        ));
    }
    let mut address: libc::sockaddr_in = unsafe { zeroed() };
    let mut address_length = size_of::<libc::sockaddr_in>() as libc::socklen_t;
    if unsafe {
        libc::getsockname(
            fd,
            (&mut address as *mut libc::sockaddr_in).cast(),
            &mut address_length,
        )
    } != 0
        || address_length as usize != size_of::<libc::sockaddr_in>()
        || address.sin_family as i32 != libc::AF_INET
        || u32::from_be(address.sin_addr.s_addr) != 0x7f00_0001
        || u16::from_be(address.sin_port) == 0
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "listener is not nonzero IPv4 loopback",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn accepts_only_listening_ipv4_loopback() {
        let listener = create_loopback_listener().unwrap();
        validate_loopback_listener(listener.as_raw_fd()).unwrap();
        let wildcard = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        assert!(validate_loopback_listener(wildcard.as_raw_fd()).is_err());
        let file = fs::File::open("/dev/null").unwrap();
        assert!(validate_loopback_listener(file.as_raw_fd()).is_err());
    }
}
