use crate::handoff;
use crate::security;
use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::thread;

pub fn run(bootstrap: RawFd, token: &[u8], target: &Path) -> io::Result<()> {
    security::set_parent_death_signal()?;
    close_unrelated_descriptors(bootstrap);
    let listener_fd = handoff::receive_listener(bootstrap, token)?;
    let listener = unsafe { TcpListener::from_raw_fd(listener_fd) };
    let acknowledgement = b"OK";
    if unsafe {
        libc::send(
            bootstrap,
            acknowledgement.as_ptr().cast(),
            acknowledgement.len(),
            libc::MSG_NOSIGNAL,
        )
    } != acknowledgement.len() as isize
    {
        return Err(io::Error::last_os_error());
    }
    unsafe { libc::close(bootstrap) };

    for accepted in listener.incoming() {
        let guest = accepted?;
        let parent = UnixStream::connect(target)?;
        relay(guest, parent)?;
    }
    Ok(())
}

fn close_unrelated_descriptors(keep: RawFd) {
    let maximum = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    let maximum = if maximum > 0 {
        maximum.min(65_536) as RawFd
    } else {
        1024
    };
    for descriptor in 0..maximum {
        if descriptor != keep {
            unsafe { libc::close(descriptor) };
        }
    }
}

fn relay(guest: TcpStream, parent: UnixStream) -> io::Result<()> {
    let mut guest_read = guest.try_clone()?;
    let mut guest_write = guest;
    let mut parent_read = parent.try_clone()?;
    let mut parent_write = parent;
    let guest_to_parent = thread::spawn(move || -> io::Result<()> {
        io::copy(&mut guest_read, &mut parent_write)?;
        parent_write.shutdown(Shutdown::Write)
    });
    io::copy(&mut parent_read, &mut guest_write)?;
    guest_write.shutdown(Shutdown::Write)?;
    guest_to_parent
        .join()
        .map_err(|_| io::Error::other("relay thread panicked"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    #[test]
    fn relay_propagates_data_and_half_closes() {
        let tcp_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let tcp_address = tcp_listener.local_addr().unwrap();
        let (path_sender, path_receiver) = mpsc::channel();
        let temporary = std::env::temp_dir().join(format!("chatwca-relay-{}", std::process::id()));
        let _ = std::fs::remove_file(&temporary);
        let unix_listener = UnixListener::bind(&temporary).unwrap();
        let path = temporary.clone();
        let server = thread::spawn(move || {
            path_sender.send(()).unwrap();
            let (mut stream, _) = unix_listener.accept().unwrap();
            let mut request = String::new();
            stream.read_to_string(&mut request).unwrap();
            assert_eq!(request, "request");
            stream.write_all(b"response").unwrap();
        });
        path_receiver.recv().unwrap();
        let relay_thread = thread::spawn(move || {
            let (guest, _) = tcp_listener.accept().unwrap();
            relay(guest, UnixStream::connect(path).unwrap()).unwrap();
        });
        let mut client = TcpStream::connect(tcp_address).unwrap();
        client.write_all(b"request").unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert_eq!(response, "response");
        relay_thread.join().unwrap();
        server.join().unwrap();
        std::fs::remove_file(temporary).unwrap();
    }
}
