fn main() {
    // The frontend is embedded by tauri-build, but lives outside this Cargo
    // package. Without this dependency Cargo can reuse an executable that
    // contains stale web assets after a successful Vite build.
    println!("cargo:rerun-if-changed=../../web/dist");
    tauri_build::build();
}
