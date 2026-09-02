use crate::{capabilities, namespace};
use std::io;
use std::mem::{size_of, zeroed};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

const MAX_HANDOFF_BYTES: usize = 128;
const RELAY_BUFFER_BYTES: usize = 64 * 1024;
const MAX_BRIDGE_CONNECTIONS: usize = 128;

fn control_capacity(count: usize) -> usize {
    unsafe { libc::CMSG_SPACE((count * size_of::<RawFd>()) as libc::c_uint) as usize }
}
fn close_all(fds: &[RawFd]) {
    for fd in fds {
        unsafe { libc::close(*fd) };
    }
}

pub fn send_listener(socket: RawFd, token: &[u8], listener: RawFd) -> io::Result<()> {
    if token.len() != 64 {
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
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = control.len() * size_of::<usize>();
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        if header.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "SCM allocation failed",
            ));
        }
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as libc::c_uint) as usize;
        *(libc::CMSG_DATA(header) as *mut RawFd) = listener;
        message.msg_controllen = (*header).cmsg_len;
        if libc::sendmsg(socket, &message, libc::MSG_NOSIGNAL) != token.len() as isize {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn receive_listener(socket: RawFd, token: &[u8]) -> io::Result<RawFd> {
    let mut payload = [0u8; MAX_HANDOFF_BYTES + 1];
    let mut iovec = libc::iovec {
        iov_base: payload.as_mut_ptr().cast(),
        iov_len: payload.len(),
    };
    let mut control = vec![0usize; control_capacity(2).div_ceil(size_of::<usize>())];
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut iovec;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
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
            let bytes = (*header)
                .cmsg_len
                .saturating_sub(libc::CMSG_LEN(0) as usize);
            if bytes % size_of::<RawFd>() != 0 {
                close_all(&descriptors);
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "malformed SCM_RIGHTS",
                ));
            }
            let data = libc::CMSG_DATA(header) as *const RawFd;
            for index in 0..bytes / size_of::<RawFd>() {
                descriptors.push(*data.add(index));
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    if message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
        || received as usize != token.len()
        || &payload[..received as usize] != token
        || descriptors.len() != 1
    {
        close_all(&descriptors);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid listener handoff",
        ));
    }
    let fd = descriptors[0];
    if let Err(error) = namespace::validate_loopback_listener(fd) {
        unsafe { libc::close(fd) };
        return Err(error);
    }
    Ok(fd)
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct Direction {
    buffer: Box<[u8; RELAY_BUFFER_BYTES]>,
    start: usize,
    end: usize,
    eof: bool,
    shutdown: bool,
}
impl Direction {
    fn new() -> Self {
        Self {
            buffer: Box::new([0; RELAY_BUFFER_BYTES]),
            start: 0,
            end: 0,
            eof: false,
            shutdown: false,
        }
    }
}

fn transfer(read_fd: RawFd, write_fd: RawFd, direction: &mut Direction) -> io::Result<bool> {
    let mut progress = false;
    if direction.start == direction.end {
        direction.start = 0;
        direction.end = 0;
    }
    if !direction.eof && direction.end < direction.buffer.len() {
        let result = unsafe {
            libc::read(
                read_fd,
                direction.buffer[direction.end..].as_mut_ptr().cast(),
                direction.buffer.len() - direction.end,
            )
        };
        if result > 0 {
            direction.end += result as usize;
            progress = true;
        } else if result == 0 {
            direction.eof = true;
            progress = true;
        } else {
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::EAGAIN) | Some(libc::EINTR)) {
                return Err(error);
            }
        }
    }
    if direction.start < direction.end {
        let result = unsafe {
            libc::write(
                write_fd,
                direction.buffer[direction.start..direction.end]
                    .as_ptr()
                    .cast(),
                direction.end - direction.start,
            )
        };
        if result > 0 {
            direction.start += result as usize;
            progress = true;
        } else if result < 0 {
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::EAGAIN) | Some(libc::EINTR)) {
                return Err(error);
            }
        }
    }
    if direction.eof && direction.start == direction.end && !direction.shutdown {
        if unsafe { libc::shutdown(write_fd, libc::SHUT_WR) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENOTCONN) {
                return Err(error);
            }
        }
        direction.shutdown = true;
        progress = true;
    }
    Ok(progress)
}

pub fn relay(guest: TcpStream, parent: UnixStream) -> io::Result<()> {
    set_nonblocking(guest.as_raw_fd())?;
    set_nonblocking(parent.as_raw_fd())?;
    let mut guest_to_parent = Direction::new();
    let mut parent_to_guest = Direction::new();
    loop {
        let progress = transfer(guest.as_raw_fd(), parent.as_raw_fd(), &mut guest_to_parent)?
            | transfer(parent.as_raw_fd(), guest.as_raw_fd(), &mut parent_to_guest)?;
        if guest_to_parent.shutdown && parent_to_guest.shutdown {
            return Ok(());
        }
        if !progress {
            let guest_events = (if !guest_to_parent.eof && guest_to_parent.end < RELAY_BUFFER_BYTES
            {
                libc::POLLIN
            } else {
                0
            }) | (if parent_to_guest.start < parent_to_guest.end {
                libc::POLLOUT
            } else {
                0
            });
            let parent_events = (if !parent_to_guest.eof && parent_to_guest.end < RELAY_BUFFER_BYTES
            {
                libc::POLLIN
            } else {
                0
            }) | (if guest_to_parent.start < guest_to_parent.end {
                libc::POLLOUT
            } else {
                0
            });
            let mut polls = [
                libc::pollfd {
                    fd: guest.as_raw_fd(),
                    events: guest_events,
                    revents: 0,
                },
                libc::pollfd {
                    fd: parent.as_raw_fd(),
                    events: parent_events,
                    revents: 0,
                },
            ];
            let result = unsafe { libc::poll(polls.as_mut_ptr(), polls.len() as _, -1) };
            if result < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return Err(io::Error::last_os_error());
            }
        }
    }
}

fn close_unrelated(kept: &[RawFd]) {
    let maximum = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) }.clamp(1024, 65_536) as RawFd;
    for fd in 0..maximum {
        if !kept.contains(&fd) {
            unsafe { libc::close(fd) };
        }
    }
}

pub fn run(bootstrap: RawFd, ready: *mut u8, token: &[u8], target: &Path) -> io::Result<()> {
    capabilities::set_parent_death_signal()?;
    close_unrelated(&[bootstrap]);
    let listener_fd = receive_listener(bootstrap, token)?;
    let listener = unsafe { TcpListener::from_raw_fd(listener_fd) };
    listener.set_nonblocking(true)?;
    if unsafe { libc::send(bootstrap, b"OK".as_ptr().cast(), 2, libc::MSG_NOSIGNAL) } != 2 {
        return Err(io::Error::last_os_error());
    }
    // Shared anonymous setup state avoids granting the bridge another descriptor.
    unsafe {
        std::ptr::write_volatile(ready, 1);
        libc::close(bootstrap)
    };
    let active = Arc::new(AtomicUsize::new(0));
    loop {
        match listener.accept() {
            Ok((guest, _)) => {
                if active.load(Ordering::Relaxed) >= MAX_BRIDGE_CONNECTIONS {
                    let _ = guest.shutdown(Shutdown::Both);
                    continue;
                }
                let parent = match UnixStream::connect(target) {
                    Ok(stream) => stream,
                    Err(_) => {
                        let _ = guest.shutdown(Shutdown::Both);
                        continue;
                    }
                };
                let counter = active.clone();
                counter.fetch_add(1, Ordering::Relaxed);
                thread::spawn(move || {
                    let _ = relay(guest, parent);
                    counter.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let mut poll = libc::pollfd {
                    fd: listener.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                if unsafe { libc::poll(&mut poll, 1, -1) } < 0
                    && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR)
                {
                    return Err(io::Error::last_os_error());
                }
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;

    fn pair() -> (OwnedFd, OwnedFd) {
        let mut fds = [-1; 2];
        assert_eq!(
            unsafe {
                libc::socketpair(
                    libc::AF_UNIX,
                    libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                    0,
                    fds.as_mut_ptr(),
                )
            },
            0
        );
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    fn send_duplicate_fds(socket: RawFd, token: &[u8], fd: RawFd) {
        let descriptors = [fd, fd];
        let mut iovec = libc::iovec {
            iov_base: token.as_ptr() as *mut libc::c_void,
            iov_len: token.len(),
        };
        let mut control = vec![0usize; control_capacity(2).div_ceil(size_of::<usize>())];
        let mut message: libc::msghdr = unsafe { zeroed() };
        message.msg_iov = &mut iovec;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = control.len() * size_of::<usize>();
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len =
                libc::CMSG_LEN(std::mem::size_of_val(&descriptors) as libc::c_uint) as usize;
            std::ptr::copy_nonoverlapping(descriptors.as_ptr(), libc::CMSG_DATA(header).cast(), 2);
            message.msg_controllen = (*header).cmsg_len;
            assert_eq!(libc::sendmsg(socket, &message, 0), token.len() as isize);
        }
    }

    #[test]
    fn authenticated_handoff_rejects_missing_wrong_and_unsolicited_extra_fds() {
        let (sender, receiver) = pair();
        assert_eq!(
            unsafe { libc::send(sender.as_raw_fd(), b"x".as_ptr().cast(), 1, 0) },
            1
        );
        assert!(receive_listener(receiver.as_raw_fd(), &[b'a'; 64]).is_err());
        let (sender, receiver) = pair();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        send_listener(sender.as_raw_fd(), &[b'b'; 64], listener.as_raw_fd()).unwrap();
        assert!(receive_listener(receiver.as_raw_fd(), &[b'a'; 64]).is_err());
        let (sender, receiver) = pair();
        send_duplicate_fds(sender.as_raw_fd(), &[b'a'; 64], listener.as_raw_fd());
        assert!(receive_listener(receiver.as_raw_fd(), &[b'a'; 64]).is_err());
    }

    #[test]
    fn bridge_child_closes_every_unrelated_descriptor() {
        let mut report = [-1; 2];
        assert_eq!(unsafe { libc::pipe(report.as_mut_ptr()) }, 0);
        let unrelated = std::fs::File::open("/dev/null").unwrap();
        let unrelated_fd = unrelated.as_raw_fd();
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            unsafe { libc::close(report[0]) };
            close_unrelated(&[report[1]]);
            let closed = unsafe { libc::fcntl(unrelated_fd, libc::F_GETFD) } < 0;
            let byte = if closed { b'Y' } else { b'N' };
            unsafe {
                libc::write(report[1], (&byte as *const u8).cast(), 1);
                libc::_exit(0);
            }
        }
        unsafe { libc::close(report[1]) };
        let mut byte = 0u8;
        assert_eq!(
            unsafe { libc::read(report[0], (&mut byte as *mut u8).cast(), 1) },
            1
        );
        assert_eq!(byte, b'Y');
        unsafe {
            libc::waitpid(child, std::ptr::null_mut(), 0);
            libc::close(report[0]);
        }
    }

    #[test]
    fn bounded_relay_propagates_half_closes_and_survives_a_stalled_peer() {
        let tcp_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = tcp_listener.local_addr().unwrap();
        let (unix_client, mut unix_server) = UnixStream::pair().unwrap();
        let relay_thread = thread::spawn(move || {
            let (guest, _) = tcp_listener.accept().unwrap();
            relay(guest, unix_client).unwrap();
        });
        let mut client = TcpStream::connect(address).unwrap();
        let mut writer = client.try_clone().unwrap();
        let payload = vec![7u8; RELAY_BUFFER_BYTES * 64];
        let expected = payload.clone();
        let writer_thread = thread::spawn(move || {
            writer.write_all(&payload).unwrap();
            writer.shutdown(Shutdown::Write).unwrap();
        });

        // Do not read the parent side initially. The bridge must apply kernel
        // backpressure with only its fixed Direction buffer, then resume once
        // the stalled peer drains.
        thread::sleep(std::time::Duration::from_millis(50));
        let mut received = Vec::new();
        unix_server.read_to_end(&mut received).unwrap();
        writer_thread.join().unwrap();
        assert_eq!(received, expected);
        unix_server.write_all(b"response").unwrap();
        unix_server.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        assert_eq!(response, b"response");
        relay_thread.join().unwrap();
    }
}
