//! Stand-in for netsh in the Windows argument probe
//! (`firewall::tests::elevation_arguments_reach_a_stand_in_program_byte_for_byte`):
//! writes the arguments it received, as UTF-16 units, to `BIBCODE_ARGV_ECHO_OUT`.

#[cfg(windows)]
fn main() {
    use std::os::windows::ffi::OsStrExt;

    let arguments: Vec<Vec<u16>> = std::env::args_os()
        .skip(1)
        .map(|argument| argument.encode_wide().collect())
        .collect();
    let output = std::env::var_os("BIBCODE_ARGV_ECHO_OUT").expect("BIBCODE_ARGV_ECHO_OUT");
    std::fs::write(
        output,
        serde_json::to_vec(&arguments).expect("arguments serialize"),
    )
    .expect("argument echo written");
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This argument probe stand-in requires Windows.");
    std::process::exit(1);
}
