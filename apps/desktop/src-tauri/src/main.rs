#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(url) = bibcode_desktop_lib::open_url_argument(std::env::args_os()) {
        let code = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("open-url runtime")
            .block_on(bibcode_server::open_url::run_open_url(&url));
        std::process::exit(code);
    }
    bibcode_desktop_lib::run();
}
