use std::fs;
use std::io;

const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
const SECBIT_NOROOT: libc::c_ulong = 1 << 0;
const SECBIT_NOROOT_LOCKED: libc::c_ulong = 1 << 1;
const SECBIT_NO_SETUID_FIXUP: libc::c_ulong = 1 << 2;
const SECBIT_NO_SETUID_FIXUP_LOCKED: libc::c_ulong = 1 << 3;
const SECBIT_KEEP_CAPS_LOCKED: libc::c_ulong = 1 << 5;
const SECBIT_NO_CAP_AMBIENT_RAISE: libc::c_ulong = 1 << 6;
const SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED: libc::c_ulong = 1 << 7;
const PR_CAP_AMBIENT: libc::c_int = 47;
const PR_CAP_AMBIENT_CLEAR_ALL: libc::c_ulong = 4;
const EXPECTED_SECUREBITS: libc::c_ulong = SECBIT_NOROOT
    | SECBIT_NOROOT_LOCKED
    | SECBIT_NO_SETUID_FIXUP
    | SECBIT_NO_SETUID_FIXUP_LOCKED
    | SECBIT_KEEP_CAPS_LOCKED
    | SECBIT_NO_CAP_AMBIENT_RAISE
    | SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED;

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

fn syscall_zero(result: libc::c_long) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
fn capability_status_is_empty(status: &str) -> bool {
    ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]
        .into_iter()
        .all(|name| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}:")))
                .and_then(|value| u64::from_str_radix(value.trim(), 16).ok())
                == Some(0)
        })
}

fn last_capability() -> io::Result<i32> {
    fs::read_to_string("/proc/sys/kernel/cap_last_cap")?
        .trim()
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid cap_last_cap"))
}

pub fn set_parent_death_signal() -> io::Result<()> {
    let parent = unsafe { libc::getppid() };
    syscall_zero(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } as libc::c_long,
    )?;
    if parent == 1 || unsafe { libc::getppid() } != parent {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "parent exited during setup",
        ));
    }
    Ok(())
}

pub fn own_process_group() -> io::Result<()> {
    if unsafe { libc::setpgid(0, 0) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    // A detached Node spawn makes the helper a session/process-group leader already.
    if error.raw_os_error() == Some(libc::EPERM)
        && unsafe { libc::getpgrp() } == unsafe { libc::getpid() }
    {
        Ok(())
    } else {
        Err(error)
    }
}

pub fn verify_transition_capabilities() -> io::Result<()> {
    let status = fs::read_to_string("/proc/self/status")?;
    let expected = (1u64 << 8) | (1u64 << 12); // CAP_SETPCAP and CAP_NET_ADMIN
    for name in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] {
        let value = status
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}:")))
            .and_then(|value| u64::from_str_radix(value.trim(), 16).ok());
        if value != Some(expected) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "transition capability set is not exact",
            ));
        }
    }
    Ok(())
}

pub fn drop_all_and_lock() -> io::Result<()> {
    syscall_zero(
        unsafe { libc::prctl(libc::PR_SET_SECUREBITS, EXPECTED_SECUREBITS, 0, 0, 0) }
            as libc::c_long,
    )?;
    syscall_zero(
        unsafe { libc::prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) } as libc::c_long,
    )?;
    let last = last_capability()?;
    for capability in 0..=last {
        syscall_zero(
            unsafe { libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) } as libc::c_long,
        )?;
    }
    let mut header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let empty = [CapabilityData::default(), CapabilityData::default()];
    syscall_zero(unsafe { libc::syscall(libc::SYS_capset, &mut header, empty.as_ptr()) })?;
    syscall_zero(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } as libc::c_long)?;
    verify_empty(last)
}

fn verify_empty(last: i32) -> io::Result<()> {
    let mut header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut data = [CapabilityData::default(), CapabilityData::default()];
    syscall_zero(unsafe { libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) })?;
    if data
        .iter()
        .any(|set| set.effective != 0 || set.permitted != 0 || set.inheritable != 0)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "capability sets remain",
        ));
    }
    for capability in 0..=last {
        if unsafe { libc::prctl(libc::PR_CAPBSET_READ, capability, 0, 0, 0) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "bounding capability remains",
            ));
        }
    }
    if !capability_status_is_empty(&fs::read_to_string("/proc/self/status")?)
        || unsafe { libc::prctl(libc::PR_GET_SECUREBITS, 0, 0, 0, 0) } as libc::c_ulong
            != EXPECTED_SECUREBITS
        || unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) } != 1
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "security state did not lock",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn capability_status_parser_requires_all_empty_sets() {
        let empty = "CapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\n";
        assert!(super::capability_status_is_empty(empty));
        assert!(!super::capability_status_is_empty(&empty.replace(
            "CapBnd:\t0000000000000000",
            "CapBnd:\t0000000000000100"
        )));
        assert!(!super::capability_status_is_empty(
            "CapEff:\t0000000000000000\n"
        ));
    }
}
