#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The open-url shim, or the Windows `bibcode-open-url.exe` alias: no Tauri, no window,
    // and the single-instance plugin never sees it.
    let args = std::env::args_os().collect::<Vec<_>>();
    if let Some(url) = bibcode_server::open_url::open_url_invocation(&args) {
        let code = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("open-url runtime")
            .block_on(bibcode_server::open_url::run_open_url(&url));
        std::process::exit(code);
    }
    bibcode_desktop_lib::run();
}
