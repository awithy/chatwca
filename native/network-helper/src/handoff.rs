use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::RawFd;

const MAX_MESSAGE_BYTES: usize = 256;
const MAX_HANDOFF_FDS: usize = 2;

fn control_capacity(fd_count: usize) -> usize {
    unsafe { libc::CMSG_SPACE((fd_count * size_of::<RawFd>()) as libc::c_uint) as usize }
}

pub fn send_listener(socket: RawFd, token: &[u8], listener: RawFd) -> io::Result<()> {
    if token.is_empty() || token.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid handoff token",
        ));
    }
    let mut iovec = libc::iovec {
        iov_base: token.as_ptr() as *mut libc::c_void,
        iov_len: token.len(),
    };
    let mut control = vec![0usize; control_capacity(1).div_ceil(size_of::<usize>())];
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut iovec;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    message.msg_controllen = control.len() * size_of::<usize>();
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        if header.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "SCM control allocation failed",
            ));
        }
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as libc::c_uint) as usize;
        *(libc::CMSG_DATA(header) as *mut RawFd) = listener;
        message.msg_controllen = (*header).cmsg_len;
        if libc::sendmsg(socket, &message, libc::MSG_NOSIGNAL) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn receive_listener(socket: RawFd, expected_token: &[u8]) -> io::Result<RawFd> {
    let mut payload = [0u8; MAX_MESSAGE_BYTES + 1];
    let mut iovec = libc::iovec {
        iov_base: payload.as_mut_ptr() as *mut libc::c_void,
        iov_len: payload.len(),
    };
    let mut control = vec![0usize; control_capacity(MAX_HANDOFF_FDS).div_ceil(size_of::<usize>())];
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut iovec;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    message.msg_controllen = control.len() * size_of::<usize>();
    let received = unsafe { libc::recvmsg(socket, &mut message, libc::MSG_CMSG_CLOEXEC) };
    if received < 0 {
        return Err(io::Error::last_os_error());
    }

    let mut descriptors = Vec::new();
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            if (*header).cmsg_level != libc::SOL_SOCKET || (*header).cmsg_type != libc::SCM_RIGHTS {
                close_all(&descriptors);
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unexpected control message",
                ));
            }
            let data_bytes = (*header)
                .cmsg_len
                .saturating_sub(libc::CMSG_LEN(0) as usize);
            if data_bytes.checked_rem(size_of::<RawFd>()) != Some(0) {
                close_all(&descriptors);
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "malformed SCM_RIGHTS",
                ));
            }
            let count = data_bytes / size_of::<RawFd>();
            let data = libc::CMSG_DATA(header) as *const RawFd;
            for index in 0..count {
                descriptors.push(*data.add(index));
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }

    let valid = message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) == 0
        && received as usize == expected_token.len()
        && &payload[..received as usize] == expected_token
        && descriptors.len() == 1;
    if !valid {
        close_all(&descriptors);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid listener handoff",
        ));
    }
    let descriptor = descriptors[0];
    if let Err(error) = validate_loopback_listener(descriptor) {
        unsafe { libc::close(descriptor) };
        return Err(error);
    }
    Ok(descriptor)
}

fn close_all(descriptors: &[RawFd]) {
    for descriptor in descriptors {
        unsafe { libc::close(*descriptor) };
    }
}

pub fn validate_loopback_listener(descriptor: RawFd) -> io::Result<()> {
    let mut socket_type = 0;
    let mut option_length = size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            &mut socket_type as *mut libc::c_int as *mut libc::c_void,
            &mut option_length,
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
    option_length = size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_SOCKET,
            libc::SO_ACCEPTCONN,
            &mut accepting as *mut libc::c_int as *mut libc::c_void,
            &mut option_length,
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
            descriptor,
            &mut address as *mut libc::sockaddr_in as *mut libc::sockaddr,
            &mut address_length,
        )
    } != 0
        || address.sin_family as libc::c_int != libc::AF_INET
        || u32::from_be(address.sin_addr.s_addr) != 0x7f00_0001
        || u16::from_be(address.sin_port) == 0
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "listener is not ephemeral IPv4 loopback",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    fn sockets() -> (OwnedFd, OwnedFd) {
        let mut pair = [-1; 2];
        assert_eq!(
            unsafe {
                libc::socketpair(
                    libc::AF_UNIX,
                    libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                    0,
                    pair.as_mut_ptr(),
                )
            },
            0
        );
        unsafe { (OwnedFd::from_raw_fd(pair[0]), OwnedFd::from_raw_fd(pair[1])) }
    }

    #[test]
    fn passes_exactly_one_valid_loopback_listener() {
        let (sender, receiver) = sockets();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        send_listener(sender.as_raw_fd(), b"phase0-token", listener.as_raw_fd()).unwrap();
        let received = receive_listener(receiver.as_raw_fd(), b"phase0-token").unwrap();
        validate_loopback_listener(received).unwrap();
        unsafe { libc::close(received) };
    }

    fn send_multiple(socket: RawFd, token: &[u8], descriptors: &[RawFd]) {
        let mut iovec = libc::iovec {
            iov_base: token.as_ptr() as *mut libc::c_void,
            iov_len: token.len(),
        };
        let bytes = std::mem::size_of_val(descriptors);
        let mut control =
            vec![0usize; control_capacity(descriptors.len()).div_ceil(size_of::<usize>())];
        let mut message: libc::msghdr = unsafe { zeroed() };
        message.msg_iov = &mut iovec;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = control.len() * size_of::<usize>();
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(bytes as libc::c_uint) as usize;
            std::ptr::copy_nonoverlapping(
                descriptors.as_ptr(),
                libc::CMSG_DATA(header).cast(),
                descriptors.len(),
            );
            message.msg_controllen = (*header).cmsg_len;
            assert_eq!(libc::sendmsg(socket, &message, 0), token.len() as isize);
        }
    }

    #[test]
    fn rejects_missing_wrong_duplicate_and_non_listener_handoffs() {
        let (sender, receiver) = sockets();
        assert_eq!(
            unsafe { libc::send(sender.as_raw_fd(), b"phase0-token".as_ptr().cast(), 12, 0) },
            12
        );
        assert!(receive_listener(receiver.as_raw_fd(), b"phase0-token").is_err());

        let (sender, receiver) = sockets();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        send_listener(sender.as_raw_fd(), b"wrong-token", listener.as_raw_fd()).unwrap();
        assert!(receive_listener(receiver.as_raw_fd(), b"phase0-token").is_err());

        let (sender, receiver) = sockets();
        let first = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let second = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        send_multiple(
            sender.as_raw_fd(),
            b"phase0-token",
            &[first.as_raw_fd(), second.as_raw_fd()],
        );
        assert!(receive_listener(receiver.as_raw_fd(), b"phase0-token").is_err());

        let (sender, receiver) = sockets();
        let file = std::fs::File::open("/dev/null").unwrap();
        send_listener(sender.as_raw_fd(), b"phase0-token", file.as_raw_fd()).unwrap();
        assert!(receive_listener(receiver.as_raw_fd(), b"phase0-token").is_err());
    }
}
