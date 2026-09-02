use std::io;

pub const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
pub const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
pub const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_SET_MODE_FILTER: libc::c_uint = 1;
const SECCOMP_FILTER_FLAG_TSYNC: libc::c_uint = 1;
const SECCOMP_DATA_NR_OFFSET: u32 = 0;
const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;
const SECCOMP_DATA_ARG0_OFFSET: u32 = 16;
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

const BPF_LD: u16 = 0x00;
const BPF_W: u16 = 0x00;
const BPF_ABS: u16 = 0x20;
const BPF_JMP: u16 = 0x05;
const BPF_JEQ: u16 = 0x10;
const BPF_JSET: u16 = 0x40;
const BPF_K: u16 = 0x00;
const BPF_RET: u16 = 0x06;

#[allow(dead_code)] // Both variants are exercised by host-independent tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FilterArchitecture {
    X86_64,
    Aarch64,
}

impl FilterArchitecture {
    pub const fn audit_arch(self) -> u32 {
        match self {
            Self::X86_64 => 0xc000_003e,
            Self::Aarch64 => 0xc000_00b7,
        }
    }

    const fn socket_syscall(self) -> u32 {
        match self {
            Self::X86_64 => 41,
            Self::Aarch64 => 198,
        }
    }

    const fn socketpair_syscall(self) -> u32 {
        match self {
            Self::X86_64 => 53,
            Self::Aarch64 => 199,
        }
    }

    const fn denied_syscalls(self) -> [u32; 6] {
        match self {
            Self::X86_64 => [101, 310, 311, 425, 426, 427],
            Self::Aarch64 => [117, 270, 271, 425, 426, 427],
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BpfInstruction {
    pub code: u16,
    pub jump_true: u8,
    pub jump_false: u8,
    pub value: u32,
}

const fn statement(code: u16, value: u32) -> BpfInstruction {
    BpfInstruction {
        code,
        jump_true: 0,
        jump_false: 0,
        value,
    }
}

const fn jump(code: u16, value: u32, jump_true: u8, jump_false: u8) -> BpfInstruction {
    BpfInstruction {
        code,
        jump_true,
        jump_false,
        value,
    }
}

const fn errno_action() -> u32 {
    SECCOMP_RET_ERRNO | libc::EPERM as u32
}

/// Build the same logical filter for either release architecture without
/// compiling or executing code for that architecture.
pub fn generate_filter(architecture: FilterArchitecture) -> Vec<BpfInstruction> {
    let mut filter = vec![
        statement(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARCH_OFFSET),
        jump(BPF_JMP | BPF_JEQ | BPF_K, architecture.audit_arch(), 1, 0),
        statement(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        statement(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR_OFFSET),
    ];

    // x32 shares AUDIT_ARCH_X86_64 but has a separate syscall-number space.
    if architecture == FilterArchitecture::X86_64 {
        filter.push(jump(BPF_JMP | BPF_JSET | BPF_K, X32_SYSCALL_BIT, 0, 1));
        filter.push(statement(BPF_RET | BPF_K, errno_action()));
    }

    for syscall in architecture.denied_syscalls() {
        filter.push(jump(BPF_JMP | BPF_JEQ | BPF_K, syscall, 0, 1));
        filter.push(statement(BPF_RET | BPF_K, errno_action()));
    }

    // socket(AF_INET/AF_INET6, ...) is allowed; every other family is denied.
    filter.extend([
        jump(
            BPF_JMP | BPF_JEQ | BPF_K,
            architecture.socket_syscall(),
            0,
            6,
        ),
        statement(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARG0_OFFSET),
        jump(BPF_JMP | BPF_JEQ | BPF_K, libc::AF_INET as u32, 0, 1),
        statement(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        jump(BPF_JMP | BPF_JEQ | BPF_K, libc::AF_INET6 as u32, 0, 1),
        statement(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        statement(BPF_RET | BPF_K, errno_action()),
    ]);

    // socketpair(AF_UNIX, ...) remains available for process-local IPC.
    filter.extend([
        jump(
            BPF_JMP | BPF_JEQ | BPF_K,
            architecture.socketpair_syscall(),
            0,
            4,
        ),
        statement(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARG0_OFFSET),
        jump(BPF_JMP | BPF_JEQ | BPF_K, libc::AF_UNIX as u32, 0, 1),
        statement(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        statement(BPF_RET | BPF_K, errno_action()),
        statement(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    ]);
    filter
}

#[cfg(target_arch = "x86_64")]
const HOST_ARCHITECTURE: FilterArchitecture = FilterArchitecture::X86_64;
#[cfg(target_arch = "aarch64")]
const HOST_ARCHITECTURE: FilterArchitecture = FilterArchitecture::Aarch64;

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("chatwca-network-helper supports only x86_64 and aarch64");

pub fn install() -> io::Result<()> {
    let generated = generate_filter(HOST_ARCHITECTURE);
    let native: Vec<libc::sock_filter> = generated
        .iter()
        .map(|instruction| libc::sock_filter {
            code: instruction.code,
            jt: instruction.jump_true,
            jf: instruction.jump_false,
            k: instruction.value,
        })
        .collect();
    let program = libc::sock_fprog {
        len: native
            .len()
            .try_into()
            .expect("seccomp program length fits u16"),
        filter: native.as_ptr() as *mut libc::sock_filter,
    };
    let result = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            SECCOMP_SET_MODE_FILTER,
            SECCOMP_FILTER_FLAG_TSYNC,
            &program as *const libc::sock_fprog,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evaluate(filter: &[BpfInstruction], audit_arch: u32, syscall: u32, argument0: u32) -> u32 {
        let mut accumulator = 0;
        let mut pc = 0usize;
        while pc < filter.len() {
            let instruction = filter[pc];
            match instruction.code {
                code if code == BPF_LD | BPF_W | BPF_ABS => {
                    accumulator = match instruction.value {
                        SECCOMP_DATA_ARCH_OFFSET => audit_arch,
                        SECCOMP_DATA_NR_OFFSET => syscall,
                        SECCOMP_DATA_ARG0_OFFSET => argument0,
                        offset => panic!("unexpected load offset {offset}"),
                    };
                    pc += 1;
                }
                code if code == BPF_JMP | BPF_JEQ | BPF_K => {
                    pc += 1 + if accumulator == instruction.value {
                        instruction.jump_true as usize
                    } else {
                        instruction.jump_false as usize
                    };
                }
                code if code == BPF_JMP | BPF_JSET | BPF_K => {
                    pc += 1 + if accumulator & instruction.value != 0 {
                        instruction.jump_true as usize
                    } else {
                        instruction.jump_false as usize
                    };
                }
                code if code == BPF_RET | BPF_K => return instruction.value,
                code => panic!("unexpected BPF opcode {code:#x}"),
            }
        }
        panic!("filter did not return")
    }

    fn logical_results(architecture: FilterArchitecture) -> Vec<u32> {
        let filter = generate_filter(architecture);
        let arch = architecture.audit_arch();
        let [ptrace, process_read, process_write, uring_setup, uring_enter, uring_register] =
            architecture.denied_syscalls();
        [
            (architecture.socket_syscall(), libc::AF_INET as u32),
            (architecture.socket_syscall(), libc::AF_INET6 as u32),
            (architecture.socket_syscall(), libc::AF_UNIX as u32),
            (architecture.socketpair_syscall(), libc::AF_UNIX as u32),
            (architecture.socketpair_syscall(), libc::AF_INET as u32),
            (ptrace, 0),
            (process_read, 0),
            (process_write, 0),
            (uring_setup, 0),
            (uring_enter, 0),
            (uring_register, 0),
            (1, 0),
        ]
        .map(|(syscall, argument0)| evaluate(&filter, arch, syscall, argument0))
        .to_vec()
    }

    #[test]
    fn x86_64_and_aarch64_have_equivalent_policy_results() {
        let expected = vec![
            SECCOMP_RET_ALLOW,
            SECCOMP_RET_ALLOW,
            errno_action(),
            SECCOMP_RET_ALLOW,
            errno_action(),
            errno_action(),
            errno_action(),
            errno_action(),
            errno_action(),
            errno_action(),
            errno_action(),
            SECCOMP_RET_ALLOW,
        ];
        assert_eq!(logical_results(FilterArchitecture::X86_64), expected);
        assert_eq!(logical_results(FilterArchitecture::Aarch64), expected);
    }

    #[test]
    fn architecture_mismatch_is_fatal_and_x32_is_denied() {
        let x86 = generate_filter(FilterArchitecture::X86_64);
        assert_eq!(
            evaluate(&x86, FilterArchitecture::Aarch64.audit_arch(), 1, 0),
            SECCOMP_RET_KILL_PROCESS
        );
        assert_eq!(
            evaluate(
                &x86,
                FilterArchitecture::X86_64.audit_arch(),
                X32_SYSCALL_BIT | 41,
                libc::AF_INET as u32,
            ),
            errno_action()
        );
    }
}
