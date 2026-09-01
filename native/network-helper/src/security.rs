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

fn syscall_failed(result: libc::c_long) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn last_capability() -> io::Result<i32> {
    let value = fs::read_to_string("/proc/sys/kernel/cap_last_cap")?;
    value
        .trim()
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid cap_last_cap"))
}

pub fn drop_all_and_lock() -> io::Result<()> {
    let securebits = SECBIT_NOROOT
        | SECBIT_NOROOT_LOCKED
        | SECBIT_NO_SETUID_FIXUP
        | SECBIT_NO_SETUID_FIXUP_LOCKED
        | SECBIT_KEEP_CAPS_LOCKED
        | SECBIT_NO_CAP_AMBIENT_RAISE
        | SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED;
    syscall_failed(
        unsafe { libc::prctl(libc::PR_SET_SECUREBITS, securebits, 0, 0, 0) } as libc::c_long,
    )?;
    syscall_failed(
        unsafe { libc::prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) } as libc::c_long,
    )?;

    // CAP_SETPCAP is retained alongside CAP_NET_ADMIN solely for this
    // transition. Drop every bounding bit before clearing the live sets.
    let last = last_capability()?;
    for capability in 0..=last {
        syscall_failed(
            unsafe { libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) } as libc::c_long,
        )?;
    }

    let mut header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let empty = [CapabilityData::default(), CapabilityData::default()];
    syscall_failed(unsafe {
        libc::syscall(
            libc::SYS_capset,
            &mut header as *mut CapabilityHeader,
            empty.as_ptr(),
        )
    })?;

    verify_empty(last)?;
    syscall_failed(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } as libc::c_long)?;
    let no_new_privileges = unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) };
    if no_new_privileges != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "NoNewPrivs was not set",
        ));
    }
    Ok(())
}

fn verify_empty(last: i32) -> io::Result<()> {
    let mut header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut data = [CapabilityData::default(), CapabilityData::default()];
    syscall_failed(unsafe {
        libc::syscall(
            libc::SYS_capget,
            &mut header as *mut CapabilityHeader,
            data.as_mut_ptr(),
        )
    })?;
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
        let result = unsafe { libc::prctl(libc::PR_CAPBSET_READ, capability, 0, 0, 0) };
        if result != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "bounding capability remains",
            ));
        }
    }
    Ok(())
}

pub fn set_parent_death_signal() -> io::Result<()> {
    let parent = unsafe { libc::getppid() };
    syscall_failed(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } as libc::c_long,
    )?;
    if unsafe { libc::getppid() } != parent || parent == 1 {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "parent exited during setup",
        ));
    }
    Ok(())
}
