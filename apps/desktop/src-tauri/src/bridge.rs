use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::backend::{BackendPlanError, BackendRunConfig, BackendSupervisor};
use crate::config::{
    app_branding, read_json_file, resolve_pick_folder_default_path, state_dir, write_json_file,
};
use crate::context_menu::{
    ContextMenuPosition, NativeContextMenuManager, context_menu_request_from_values,
    context_menu_request_has_selectable_items, show_native_context_menu,
};
use crate::data_safety;
use crate::secret_store::{
    DesktopSecretInput, DesktopSecretStore, SecretStoreError, SecretStoreIpcError,
};
use crate::security::{
    CONNECTION_CATALOG_PROTECTION_KIND, protect_string as protect_catalog_string,
    unprotect_string as unprotect_catalog_string,
};
use crate::ssh::{
    SshEnvironmentEnsureOptions, SshEnvironmentManager, SshEnvironmentTarget,
    SshPasswordPromptManager, SshPasswordPromptResolution, default_home_dir, discover_ssh_hosts,
};
use crate::tailscale::{
    TailscaleStatus, build_tailscale_https_base_url, probe_tailscale_https_endpoint,
    read_tailscale_status,
};
use crate::updates::{DesktopUpdateInstallInput, DesktopUpdateManager};
use crate::wsl::{WslDiscoveryHealth, WslDiscoveryService, WslDiscoverySnapshot, WslDistro};

#[cfg(test)]
pub(crate) type DesktopRuntime = tauri::test::MockRuntime;
#[cfg(not(test))]
pub(crate) type DesktopRuntime = tauri::Wry;

const AUTH_ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE: &str =
    "urn:bibcode:params:oauth:token-type:environment-bootstrap";
const AUTH_TOKEN_EXCHANGE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const CLIENT_SETTINGS_FILE_NAME: &str = "client-settings.json";
const CONNECTION_CATALOG_FILE_NAME: &str = "connection-catalog.tauri.json";
const DESKTOP_SETTINGS_FILE_NAME: &str = "desktop-settings.json";
const DEFAULT_TAILSCALE_SERVE_PORT: u16 = 443;
const REMOTE_API_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const TAURI_DESKTOP_BRIDGE_VERSION: u16 = 3;
const MAX_DIAGNOSTIC_ARCHIVE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopSettings {
    server_exposure_mode: String,
    tailscale_serve_enabled: bool,
    tailscale_serve_port: u16,
    wsl_backend_enabled: bool,
    wsl_distro: Option<String>,
    wsl_only: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettingsDocument {
    server_exposure_mode: Option<String>,
    tailscale_serve_enabled: Option<bool>,
    tailscale_serve_port: Option<u64>,
    wsl_backend_enabled: Option<bool>,
    wsl_mode: Option<String>,
    wsl_distro: Option<String>,
    wsl_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionCatalogDocument {
    version: Option<u64>,
    catalog: Option<String>,
    encrypted_catalog: Option<String>,
    protection: Option<String>,
}

pub(crate) struct ConnectionCatalogCoordinator {
    catalog: Mutex<()>,
}

impl ConnectionCatalogCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            catalog: Mutex::new(()),
        }
    }

    fn with_lock<T>(&self, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let _guard = self
            .catalog
            .lock()
            .map_err(|_| "The connection catalog coordinator is unavailable.".to_string())?;
        operation()
    }

    fn read_with(
        &self,
        read: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<Option<String>, String> {
        self.with_lock(read)
    }

    fn compare_with(
        &self,
        expected: Option<&str>,
        read: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<bool, String> {
        self.with_lock(|| Ok(read()?.as_deref() == expected))
    }

    fn compare_and_set_with(
        &self,
        expected: Option<&str>,
        next: &str,
        read: impl FnOnce() -> Result<Option<String>, String>,
        write: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<bool, String> {
        self.with_lock(|| {
            if read()?.as_deref() != expected {
                return Ok(false);
            }
            write(next)?;
            Ok(true)
        })
    }
}

fn connection_catalog_command_error(operation: &str) -> String {
    format!("Could not {operation} the protected connection catalog.")
}

fn bridge_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn environment_endpoint_url(http_base_url: &str, pathname: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(http_base_url)
        .map_err(|error| bridge_error("Could not parse the environment base URL", error))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "Environment base URL must use HTTP or HTTPS. Received {}:",
            url.scheme()
        ));
    }
    url.set_path(pathname);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn remote_api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REMOTE_API_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| bridge_error("Could not create the environment HTTP client", error))
}

async fn remote_json_response(
    operation: &str,
    response: reqwest::Response,
) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "[ssh_http:{}] SSH remote API request failed during {operation}.",
            status.as_u16()
        ));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| bridge_error("Could not decode the environment API response", error))
}

async fn remote_get_json(
    operation: &str,
    http_base_url: String,
    pathname: &str,
    bearer_token: Option<String>,
) -> Result<Value, String> {
    let client = remote_api_client()?;
    let mut request = client.get(environment_endpoint_url(&http_base_url, pathname)?);
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| bridge_error("Could not reach the environment API", error))?;
    remote_json_response(operation, response).await
}

async fn remote_post_json(
    operation: &str,
    http_base_url: String,
    pathname: &str,
    bearer_token: Option<String>,
) -> Result<Value, String> {
    let client = remote_api_client()?;
    let mut request = client.post(environment_endpoint_url(&http_base_url, pathname)?);
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| bridge_error("Could not reach the environment API", error))?;
    remote_json_response(operation, response).await
}

fn client_settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(CLIENT_SETTINGS_FILE_NAME))
}

fn connection_catalog_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(CONNECTION_CATALOG_FILE_NAME))
}

fn desktop_settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(DESKTOP_SETTINGS_FILE_NAME))
}

fn default_desktop_settings() -> DesktopSettings {
    DesktopSettings {
        server_exposure_mode: "local-only".to_string(),
        tailscale_serve_enabled: false,
        tailscale_serve_port: DEFAULT_TAILSCALE_SERVE_PORT,
        wsl_backend_enabled: false,
        wsl_distro: None,
        wsl_only: false,
    }
}

fn normalize_server_exposure_mode(value: Option<&str>) -> String {
    let _ = value;
    "local-only".to_string()
}

fn normalize_tailscale_serve_port(value: Option<u64>) -> u16 {
    match value {
        Some(value) if (1..=u16::MAX as u64).contains(&value) => value as u16,
        _ => DEFAULT_TAILSCALE_SERVE_PORT,
    }
}

fn is_valid_distro_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let Some(last) = value.chars().last() else {
        return false;
    };

    fn is_edge_char(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_'
    }

    is_edge_char(first)
        && is_edge_char(last)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ' ' || c == '-' || c == '.')
}

fn normalize_wsl_distro(value: Option<String>) -> Option<String> {
    value.filter(|name| is_valid_distro_name(name))
}

fn normalize_desktop_settings_document(document: DesktopSettingsDocument) -> DesktopSettings {
    let wsl_only = document.wsl_only.unwrap_or(false);
    let wsl_backend_enabled = wsl_only
        || document
            .wsl_backend_enabled
            .unwrap_or_else(|| document.wsl_mode.as_deref() == Some("wsl"));

    DesktopSettings {
        server_exposure_mode: normalize_server_exposure_mode(
            document.server_exposure_mode.as_deref(),
        ),
        tailscale_serve_enabled: document.tailscale_serve_enabled.unwrap_or(false),
        tailscale_serve_port: normalize_tailscale_serve_port(document.tailscale_serve_port),
        wsl_backend_enabled,
        wsl_distro: normalize_wsl_distro(document.wsl_distro),
        wsl_only,
    }
}

fn desktop_settings_to_value(settings: &DesktopSettings) -> Value {
    json!({
        "serverExposureMode": &settings.server_exposure_mode,
        "tailscaleServeEnabled": settings.tailscale_serve_enabled,
        "tailscaleServePort": settings.tailscale_serve_port,
        "wslOnly": settings.wsl_only,
    })
}

fn normalize_client_settings_document(value: Value) -> Value {
    match value {
        Value::Object(mut object) => match object.remove("settings") {
            Some(settings @ Value::Object(_)) => settings,
            _ => Value::Object(object),
        },
        other => other,
    }
}

fn connection_catalog_to_value(catalog: &str) -> Result<Value, String> {
    let encrypted_catalog = protect_catalog_string(catalog)?;
    Ok(json!({
        "version": 1,
        "protection": CONNECTION_CATALOG_PROTECTION_KIND,
        "encryptedCatalog": encrypted_catalog,
    }))
}

fn normalize_connection_catalog_document(value: Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(catalog) => Ok(Some(catalog)),
        value => {
            let document =
                serde_json::from_value::<ConnectionCatalogDocument>(value).map_err(|error| {
                    bridge_error(
                        "Could not decode the Tauri connection catalog document",
                        error,
                    )
                })?;
            match document.version.unwrap_or(1) {
                1 => {
                    if let Some(encrypted_catalog) = document.encrypted_catalog {
                        let Some(protection) = document.protection else {
                            return Ok(None);
                        };
                        if protection != CONNECTION_CATALOG_PROTECTION_KIND {
                            return Err(format!(
                                "Unsupported Tauri connection catalog protection: {protection}"
                            ));
                        }
                        return unprotect_catalog_string(&encrypted_catalog).map(Some);
                    }
                    Ok(document.catalog)
                }
                version => Err(format!(
                    "Unsupported Tauri connection catalog document version: {version}"
                )),
            }
        }
    }
}

fn read_connection_catalog_document(path: &Path) -> Result<Option<String>, String> {
    let Some(value) = read_json_file(path)? else {
        return Ok(None);
    };
    normalize_connection_catalog_document(value)
}

fn write_connection_catalog_document(path: &Path, catalog: &str) -> Result<bool, String> {
    write_json_file(path, &connection_catalog_to_value(catalog)?)?;
    Ok(true)
}

fn clear_connection_catalog_document(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(bridge_error(
            &format!("Could not remove {}", path.display()),
            error,
        )),
    }
}

fn read_desktop_settings<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopSettings, String> {
    let path = desktop_settings_path(app)?;
    let Some(value) = read_json_file(&path)? else {
        return Ok(default_desktop_settings());
    };
    let document = serde_json::from_value::<DesktopSettingsDocument>(value).unwrap_or_default();
    Ok(normalize_desktop_settings_document(document))
}

fn write_desktop_settings<R: Runtime>(
    app: &AppHandle<R>,
    settings: &DesktopSettings,
) -> Result<(), String> {
    let path = desktop_settings_path(app)?;
    write_json_file(&path, &desktop_settings_to_value(settings))
}

fn update_desktop_settings<R: Runtime>(
    app: &AppHandle<R>,
    update: impl FnOnce(&mut DesktopSettings),
) -> Result<DesktopSettings, String> {
    let mut settings = read_desktop_settings(app)?;
    update(&mut settings);
    write_desktop_settings(app, &settings)?;
    Ok(settings)
}

fn server_exposure_state(settings: &DesktopSettings, config: Option<&BackendRunConfig>) -> Value {
    if let Some(config) = config {
        return json!({
            "mode": "local-only",
            "endpointUrl": null,
            "advertisedHost": null,
            "tailscaleServeEnabled": config.tailscale_serve_enabled,
            "tailscaleServePort": config.tailscale_serve_port,
        });
    }

    json!({
        "mode": &settings.server_exposure_mode,
        "endpointUrl": null,
        "advertisedHost": null,
        "tailscaleServeEnabled": settings.tailscale_serve_enabled,
        "tailscaleServePort": settings.tailscale_serve_port,
    })
}

fn normalize_http_base_url(raw_value: &str) -> Result<String, String> {
    let mut url = url::Url::parse(raw_value)
        .map_err(|error| bridge_error("Could not parse advertised endpoint URL", error))?;
    match url.scheme() {
        "ws" => {
            url.set_scheme("http")
                .map_err(|_| "Could not normalize ws endpoint URL.".to_string())?;
        }
        "wss" => {
            url.set_scheme("https")
                .map_err(|_| "Could not normalize wss endpoint URL.".to_string())?;
        }
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Endpoint must use HTTP or HTTPS. Received {scheme}:"
            ));
        }
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn derive_ws_base_url(http_base_url: &str) -> Result<String, String> {
    let mut url = url::Url::parse(http_base_url).map_err(|error| {
        bridge_error("Could not derive advertised endpoint websocket URL", error)
    })?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        scheme => {
            return Err(format!(
                "Endpoint must use HTTP or HTTPS. Received {scheme}:"
            ));
        }
    };
    url.set_scheme(scheme)
        .map_err(|_| "Could not derive advertised endpoint websocket URL.".to_string())?;
    Ok(url.to_string())
}

fn hosted_https_compatibility(http_base_url: &str) -> Result<&'static str, String> {
    let url = url::Url::parse(http_base_url).map_err(|error| {
        bridge_error(
            "Could not inspect advertised endpoint HTTPS compatibility",
            error,
        )
    })?;
    Ok(if url.scheme() == "http" {
        "mixed-content-blocked"
    } else {
        "unknown"
    })
}

fn advertised_endpoint(
    id: String,
    label: &str,
    http_base_url: String,
    reachability: &str,
    is_default: Option<bool>,
    description: &str,
) -> Result<Value, String> {
    let http_base_url = normalize_http_base_url(&http_base_url)?;
    let ws_base_url = derive_ws_base_url(&http_base_url)?;
    let hosted_https_app = hosted_https_compatibility(&http_base_url)?;
    let mut endpoint = json!({
        "id": id,
        "label": label,
        "provider": {
            "id": "desktop-core",
            "label": "Desktop",
            "kind": "core",
            "isAddon": false,
        },
        "httpBaseUrl": http_base_url,
        "wsBaseUrl": ws_base_url,
        "reachability": reachability,
        "compatibility": {
            "hostedHttpsApp": hosted_https_app,
            "desktopApp": "compatible",
        },
        "source": "desktop-core",
        "status": "available",
        "description": description,
    });
    if let Some(is_default) = is_default {
        endpoint["isDefault"] = Value::Bool(is_default);
    }
    Ok(endpoint)
}

fn tailscale_advertised_endpoint(
    id: String,
    label: &str,
    http_base_url: String,
    status: &str,
    hosted_https_app: &str,
    description: &str,
) -> Result<Value, String> {
    let http_base_url = normalize_http_base_url(&http_base_url)?;
    let ws_base_url = derive_ws_base_url(&http_base_url)?;
    Ok(json!({
        "id": id,
        "label": label,
        "provider": {
            "id": "tailscale",
            "label": "Tailscale",
            "kind": "private-network",
            "isAddon": true,
        },
        "httpBaseUrl": http_base_url,
        "wsBaseUrl": ws_base_url,
        "reachability": "private-network",
        "compatibility": {
            "hostedHttpsApp": hosted_https_app,
            "desktopApp": "compatible",
        },
        "source": "desktop-addon",
        "status": status,
        "description": description,
    }))
}

fn advertised_endpoints_for_config(config: &BackendRunConfig) -> Result<Vec<Value>, String> {
    Ok(vec![advertised_endpoint(
        format!("desktop-loopback:{}", config.port),
        "This machine",
        config.http_base_url(),
        "loopback",
        None,
        "Loopback endpoint for this desktop app.",
    )?])
}

fn tailscale_endpoints_for_status(
    config: &BackendRunConfig,
    status: &TailscaleStatus,
    magic_dns_reachable: bool,
) -> Result<Vec<Value>, String> {
    let mut endpoints = Vec::new();

    let Some(magic_dns_name) = &status.magic_dns_name else {
        return Ok(endpoints);
    };
    let http_base_url =
        build_tailscale_https_base_url(magic_dns_name, config.tailscale_serve_port)?;
    endpoints.push(tailscale_advertised_endpoint(
        format!("tailscale-magicdns:{http_base_url}"),
        "Tailscale HTTPS",
        http_base_url,
        if magic_dns_reachable {
            "available"
        } else {
            "unavailable"
        },
        if magic_dns_reachable {
            "compatible"
        } else {
            "requires-configuration"
        },
        if magic_dns_reachable {
            "HTTPS endpoint served by Tailscale Serve."
        } else {
            "MagicDNS hostname. Configure Tailscale Serve for HTTPS access."
        },
    )?);

    Ok(endpoints)
}

async fn tailscale_advertised_endpoints_for_config(
    config: &BackendRunConfig,
) -> Result<Vec<Value>, String> {
    if !config.tailscale_serve_enabled {
        return Ok(Vec::new());
    }

    let status = match read_tailscale_status().await {
        Ok(status) => status,
        Err(error) => {
            tracing::debug!("Tailscale advertised endpoint discovery skipped: {error}");
            return Ok(Vec::new());
        }
    };
    let magic_dns_reachable = if config.tailscale_serve_enabled {
        match status.magic_dns_name.as_ref() {
            Some(magic_dns_name) => {
                let base_url =
                    build_tailscale_https_base_url(magic_dns_name, config.tailscale_serve_port)?;
                probe_tailscale_https_endpoint(&base_url).await
            }
            None => false,
        }
    } else {
        false
    };

    tailscale_endpoints_for_status(config, &status, magic_dns_reachable)
}

fn resolve_running_wsl_picker_distro(
    raw_options: Option<&Value>,
    discovery: &WslDiscoverySnapshot,
) -> Result<Option<String>, String> {
    let Some(requested) = raw_options
        .and_then(|options| options.get("targetWslDistro"))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    if !is_valid_distro_name(requested) {
        return Err("The WSL folder-picker locator is invalid.".to_string());
    }
    if discovery.health != WslDiscoveryHealth::Available {
        return Err("WSL discovery is not currently authoritative.".to_string());
    }
    discovery
        .distros
        .iter()
        .find(|distro| {
            distro.name.eq_ignore_ascii_case(requested)
                && distro.state == crate::wsl::WslDistroState::Running
        })
        .map(|distro| Some(distro.name.clone()))
        .ok_or_else(|| {
            "The selected WSL distribution is not currently Running; BiBCode will not start it automatically."
                .to_string()
        })
}

fn resolve_wsl_home_unc_path(config_distro: Option<&str>, distros: &[WslDistro]) -> Option<String> {
    let distro_name = config_distro.map(str::to_string).or_else(|| {
        distros
            .iter()
            .find(|distro| distro.is_default)
            .map(|distro| distro.name.clone())
    })?;
    Some(format!("\\\\wsl.localhost\\{distro_name}\\home"))
}

fn wsl_linux_path_to_unc_path(distro_name: &str, linux_path: &str) -> String {
    let path = linux_path.replace('/', "\\");
    format!("\\\\wsl.localhost\\{distro_name}{path}")
}

fn resolve_wsl_pick_folder_default_path(
    raw_options: Option<&Value>,
    config_distro: Option<&str>,
    distros: &[WslDistro],
    user_home: Option<&str>,
) -> Option<PathBuf> {
    let home_path = resolve_wsl_home_unc_path(config_distro, distros);
    let initial_path = raw_options
        .and_then(|options| options.get("initialPath"))
        .and_then(Value::as_str)
        .map(str::trim);
    let Some(initial_path) = initial_path else {
        return home_path.map(PathBuf::from);
    };
    if initial_path.is_empty() {
        return home_path.map(PathBuf::from);
    }
    if initial_path.starts_with("\\\\") {
        return Some(PathBuf::from(initial_path));
    }

    let distro_name = config_distro.map(str::to_string).or_else(|| {
        distros
            .iter()
            .find(|distro| distro.is_default)
            .map(|distro| distro.name.clone())
    })?;
    let normalized_user_home = user_home.filter(|home| home.starts_with('/'));

    if initial_path == "~" {
        return Some(PathBuf::from(match normalized_user_home {
            Some(home) => wsl_linux_path_to_unc_path(&distro_name, home),
            None => home_path?,
        }));
    }
    if let Some(remainder) = initial_path.strip_prefix("~/") {
        return Some(PathBuf::from(match normalized_user_home {
            Some(home) => wsl_linux_path_to_unc_path(&distro_name, &format!("{home}/{remainder}")),
            None => format!("{}\\{}", home_path?, remainder.replace('/', "\\")),
        }));
    }
    if initial_path.starts_with('/') {
        return Some(PathBuf::from(wsl_linux_path_to_unc_path(
            &distro_name,
            initial_path,
        )));
    }

    home_path.map(PathBuf::from)
}

fn wsl_unc_path_to_linux_path(windows_path: &str) -> Option<String> {
    let trimmed = windows_path.trim();
    let without_prefix = trimmed
        .strip_prefix("\\\\wsl.localhost\\")
        .or_else(|| trimmed.strip_prefix("\\\\WSL.LOCALHOST\\"))
        .or_else(|| trimmed.strip_prefix("\\\\wsl$\\"))
        .or_else(|| trimmed.strip_prefix("\\\\WSL$\\"))?;
    let mut parts = without_prefix.split('\\');
    let distro = parts.next()?;
    if !is_valid_distro_name(distro) {
        return None;
    }
    let rest = parts.filter(|part| !part.is_empty()).collect::<Vec<_>>();
    if rest.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", rest.join("/")))
    }
}

fn resolve_pick_folder_dialog_default_path<R: Runtime>(
    app: &AppHandle<R>,
    raw_options: Option<&Value>,
    target_wsl_distro: Option<&str>,
) -> Option<PathBuf> {
    if target_wsl_distro.is_none() {
        return resolve_pick_folder_default_path(app, raw_options);
    }

    let distros = app.state::<WslDiscoveryService>().last_good_distros();
    resolve_wsl_pick_folder_default_path(raw_options, target_wsl_distro, &distros, None)
}

fn wsl_state(
    settings: &DesktopSettings,
    backend: &BackendSupervisor,
    discovery: &WslDiscoverySnapshot,
) -> Value {
    let legacy_accepted_distro = settings
        .wsl_backend_enabled
        .then(|| {
            settings.wsl_distro.clone().or_else(|| {
                discovery
                    .distros
                    .iter()
                    .find(|distro| distro.is_default)
                    .map(|distro| distro.name.clone())
            })
        })
        .flatten();
    let preflight_error = match backend.primary_plan_error() {
        Some(BackendPlanError::WslPrimaryUnavailable { detail }) => Some(json!({
            "kind": "wsl-primary-unavailable",
            "detail": detail,
        })),
        Some(BackendPlanError::Other { .. }) => None,
        None => backend
            .secondary_unavailable_environment()
            .map(|unavailable| {
                json!({
                    "kind": "wsl-secondary-unavailable",
                    "detail": unavailable.detail,
                })
            }),
    };
    json!({
        "enabled": discovery
            .distros
            .iter()
            .any(|distro| distro.state == crate::wsl::WslDistroState::Running),
        "distro": &settings.wsl_distro,
        "legacyAcceptedDistro": legacy_accepted_distro,
        "available": discovery.health == WslDiscoveryHealth::Available,
        "wslOnly": settings.wsl_only,
        "distros": &discovery.distros,
        "discovery": discovery,
        "preflightError": preflight_error,
    })
}

fn desktop_theme_to_tauri_theme(theme: &str) -> Result<Option<tauri::Theme>, String> {
    match theme {
        "system" => Ok(None),
        "light" => Ok(Some(tauri::Theme::Light)),
        "dark" => Ok(Some(tauri::Theme::Dark)),
        _ => Err(format!("Unsupported desktop theme: {theme}")),
    }
}

#[tauri::command]
pub fn desktop_bridge_get_bridge_metadata(app: AppHandle<DesktopRuntime>) -> Value {
    json!({
        "host": "tauri",
        "bridgeVersion": TAURI_DESKTOP_BRIDGE_VERSION,
        "features": {
            "localBackend": true,
            "localBearerToken": true,
            "clientSettings": true,
            "serverExposure": true,
            "wslDiscovery": true,
            "sshRemoteHttp": true,
            "connectionCatalog": true,
            "protectedConnectionCatalog": cfg!(target_os = "windows"),
            "sshProvisioning": true,
            "preview": crate::preview::host::is_supported(),
            "updater": app.updater().is_ok(),
            "menuEvents": true,
        },
    })
}

#[tauri::command]
pub fn desktop_bridge_get_app_branding(app: AppHandle<DesktopRuntime>) -> Option<Value> {
    Some(app_branding(&app))
}

#[tauri::command]
pub fn desktop_bridge_get_local_environment_bootstraps(
    backend: State<'_, BackendSupervisor>,
) -> Vec<Value> {
    backend.local_environment_bootstraps()
}

#[tauri::command]
pub async fn desktop_bridge_get_project_data_statuses(
    backend: State<'_, BackendSupervisor>,
) -> Result<Value, String> {
    serde_json::to_value(data_safety::get_project_data_statuses(backend.inner()).await?)
        .map_err(|error| format!("Could not encode project-data status: {error}"))
}

#[tauri::command]
pub async fn desktop_bridge_restore_project_data(
    backend: State<'_, BackendSupervisor>,
    environment_id: String,
    backup_id: String,
) -> Result<Value, String> {
    serde_json::to_value(
        data_safety::restore_project_data(backend.inner(), &environment_id, &backup_id).await?,
    )
    .map_err(|error| format!("Could not encode project-data recovery: {error}"))
}

#[tauri::command]
pub async fn desktop_bridge_start_empty_project_data(
    backend: State<'_, BackendSupervisor>,
    environment_id: String,
) -> Result<Value, String> {
    serde_json::to_value(
        data_safety::start_empty_project_data(backend.inner(), &environment_id).await?,
    )
    .map_err(|error| format!("Could not encode project-data recovery: {error}"))
}

#[tauri::command]
pub async fn desktop_bridge_retry_project_data(
    backend: State<'_, BackendSupervisor>,
    environment_id: String,
) -> Result<(), String> {
    data_safety::retry_project_data(backend.inner(), &environment_id).await
}

#[tauri::command]
pub async fn desktop_bridge_open_project_data_path(
    app: AppHandle<DesktopRuntime>,
    backend: State<'_, BackendSupervisor>,
    environment_id: String,
) -> Result<(), String> {
    let root = data_safety::project_data_root(backend.inner(), &environment_id).await?;
    app.opener()
        .open_path(root, None::<&str>)
        .map_err(|error| format!("Could not open the project-data folder: {error}"))
}

#[tauri::command]
pub async fn desktop_bridge_export_project_data_diagnostics(
    app: AppHandle<DesktopRuntime>,
    backend: State<'_, BackendSupervisor>,
    environment_id: String,
) -> Result<String, String> {
    let diagnostics =
        data_safety::project_data_diagnostics(backend.inner(), &environment_id).await?;
    let directory = state_dir(&app)?.join("diagnostics");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the diagnostics directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect the diagnostics directory: {error}"))?;
    }
    let path = directory.join(format!("project-data-{}.json", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(&diagnostics)
        .map_err(|error| format!("Could not encode project-data diagnostics: {error}"))?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Could not create project-data diagnostics: {error}"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Could not write project-data diagnostics: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn desktop_bridge_get_client_settings(
    app: AppHandle<DesktopRuntime>,
) -> Result<Option<Value>, String> {
    let path = client_settings_path(&app)?;
    read_json_file(&path).map(|value| value.map(normalize_client_settings_document))
}

#[tauri::command]
pub fn desktop_bridge_set_client_settings(
    app: AppHandle<DesktopRuntime>,
    settings: Value,
) -> Result<(), String> {
    let path = client_settings_path(&app)?;
    write_json_file(&path, &settings)
}

#[tauri::command]
pub fn desktop_bridge_get_connection_catalog(
    app: AppHandle<DesktopRuntime>,
    catalogs: State<'_, ConnectionCatalogCoordinator>,
) -> Result<Option<String>, String> {
    let path =
        connection_catalog_path(&app).map_err(|_| connection_catalog_command_error("load"))?;
    catalogs
        .read_with(|| read_connection_catalog_document(&path))
        .map_err(|_| connection_catalog_command_error("load"))
}

#[tauri::command]
pub fn desktop_bridge_set_connection_catalog(
    app: AppHandle<DesktopRuntime>,
    catalogs: State<'_, ConnectionCatalogCoordinator>,
    catalog: String,
) -> Result<bool, String> {
    let path =
        connection_catalog_path(&app).map_err(|_| connection_catalog_command_error("save"))?;
    catalogs
        .with_lock(|| write_connection_catalog_document(&path, &catalog))
        .map_err(|_| connection_catalog_command_error("save"))
}

#[tauri::command]
pub fn desktop_bridge_compare_and_set_connection_catalog(
    app: AppHandle<DesktopRuntime>,
    catalogs: State<'_, ConnectionCatalogCoordinator>,
    expected_catalog: Option<String>,
    next_catalog: String,
) -> Result<bool, String> {
    let path =
        connection_catalog_path(&app).map_err(|_| connection_catalog_command_error("update"))?;
    catalogs
        .compare_and_set_with(
            expected_catalog.as_deref(),
            &next_catalog,
            || read_connection_catalog_document(&path),
            |catalog| write_connection_catalog_document(&path, catalog).map(|_| ()),
        )
        .map_err(|_| connection_catalog_command_error("update"))
}

#[tauri::command]
pub fn desktop_bridge_compare_connection_catalog(
    app: AppHandle<DesktopRuntime>,
    catalogs: State<'_, ConnectionCatalogCoordinator>,
    expected_catalog: Option<String>,
) -> Result<bool, String> {
    let path =
        connection_catalog_path(&app).map_err(|_| connection_catalog_command_error("compare"))?;
    catalogs
        .compare_with(expected_catalog.as_deref(), || {
            read_connection_catalog_document(&path)
        })
        .map_err(|_| connection_catalog_command_error("compare"))
}

#[tauri::command]
pub fn desktop_bridge_clear_connection_catalog(
    app: AppHandle<DesktopRuntime>,
    catalogs: State<'_, ConnectionCatalogCoordinator>,
) -> Result<(), String> {
    let path =
        connection_catalog_path(&app).map_err(|_| connection_catalog_command_error("clear"))?;
    catalogs
        .with_lock(|| clear_connection_catalog_document(&path))
        .map_err(|_| connection_catalog_command_error("clear"))
}

#[tauri::command]
pub(crate) async fn desktop_bridge_put_secret(
    secrets: State<'_, DesktopSecretStore>,
    input: DesktopSecretInput,
) -> Result<String, SecretStoreIpcError> {
    let store = secrets.inner().clone();
    tokio::task::spawn_blocking(move || store.put(input.purpose, input.value.as_bytes()))
        .await
        .map_err(|_| SecretStoreIpcError::from(SecretStoreError::Failed))?
        .map_err(SecretStoreIpcError::from)
}

#[tauri::command]
pub(crate) async fn desktop_bridge_get_secret(
    secrets: State<'_, DesktopSecretStore>,
    secret_ref: String,
) -> Result<Option<String>, SecretStoreIpcError> {
    let store = secrets.inner().clone();
    tokio::task::spawn_blocking(move || {
        store.get(&secret_ref).and_then(|value| {
            value
                .map(String::from_utf8)
                .transpose()
                .map_err(|_| SecretStoreError::Failed)
        })
    })
    .await
    .map_err(|_| SecretStoreIpcError::from(SecretStoreError::Failed))?
    .map_err(SecretStoreIpcError::from)
}

#[tauri::command]
pub(crate) async fn desktop_bridge_delete_secret(
    secrets: State<'_, DesktopSecretStore>,
    secret_ref: String,
) -> Result<(), SecretStoreIpcError> {
    let store = secrets.inner().clone();
    tokio::task::spawn_blocking(move || store.delete(&secret_ref))
        .await
        .map_err(|_| SecretStoreIpcError::from(SecretStoreError::Failed))?
        .map_err(SecretStoreIpcError::from)
}

#[tauri::command]
pub async fn desktop_bridge_fetch_environment_descriptor(
    http_base_url: String,
) -> Result<Value, String> {
    remote_get_json(
        "fetch-environment-descriptor",
        http_base_url,
        "/.well-known/bibcode/environment",
        None,
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_bootstrap_ssh_bearer_session(
    http_base_url: String,
    credential: String,
) -> Result<Value, String> {
    let client = remote_api_client()?;
    let response = client
        .post(environment_endpoint_url(&http_base_url, "/oauth/token")?)
        .form(&[
            ("grant_type", AUTH_TOKEN_EXCHANGE_GRANT_TYPE.to_string()),
            ("subject_token", credential),
            (
                "subject_token_type",
                AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE.to_string(),
            ),
            ("requested_token_type", AUTH_ACCESS_TOKEN_TYPE.to_string()),
            ("client_label", "BiBCode Tauri Desktop".to_string()),
            ("client_device_type", "desktop".to_string()),
        ])
        .send()
        .await
        .map_err(|error| bridge_error("Could not reach the environment API", error))?;
    remote_json_response("bootstrap-bearer-session", response).await
}

#[tauri::command]
pub async fn desktop_bridge_fetch_ssh_session_state(
    http_base_url: String,
    bearer_token: String,
) -> Result<Value, String> {
    remote_get_json(
        "fetch-session-state",
        http_base_url,
        "/api/auth/session",
        Some(bearer_token),
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_issue_ssh_web_socket_ticket(
    http_base_url: String,
    bearer_token: String,
) -> Result<Value, String> {
    remote_post_json(
        "issue-websocket-ticket",
        http_base_url,
        "/api/auth/websocket-ticket",
        Some(bearer_token),
    )
    .await
}

#[tauri::command]
pub fn desktop_bridge_get_server_exposure_state(
    app: AppHandle<DesktopRuntime>,
    backend: State<'_, BackendSupervisor>,
) -> Result<Value, String> {
    read_desktop_settings(&app)
        .map(|settings| server_exposure_state(&settings, backend.current_run_config().as_ref()))
}

#[tauri::command]
pub async fn desktop_bridge_set_tailscale_serve_enabled(
    app: AppHandle<DesktopRuntime>,
    backend: State<'_, BackendSupervisor>,
    input: Value,
) -> Result<Value, String> {
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let requested_port = input.get("port").and_then(Value::as_u64);
    let settings = update_desktop_settings(&app, |settings| {
        settings.tailscale_serve_enabled = enabled;
        settings.tailscale_serve_port = normalize_tailscale_serve_port(
            requested_port.or(Some(settings.tailscale_serve_port as u64)),
        );
    })?;
    let restarted_config = backend.restart_default_if_active(app.clone()).await?;
    let current_config = restarted_config.or_else(|| backend.current_run_config());
    Ok(server_exposure_state(&settings, current_config.as_ref()))
}

#[tauri::command]
pub async fn desktop_bridge_get_wsl_state(
    app: AppHandle<DesktopRuntime>,
    backend: State<'_, BackendSupervisor>,
) -> Result<Value, String> {
    let settings = read_desktop_settings(&app)?;
    let discovery = app.state::<WslDiscoveryService>().inner().clone();
    let snapshot = discovery
        .refresh_and_emit(&app, "manual refresh")
        .await
        .unwrap_or_else(|| discovery.snapshot());
    Ok(wsl_state(&settings, &backend, &snapshot))
}

#[tauri::command]
pub async fn desktop_bridge_set_wsl_backend_enabled(
    app: AppHandle<DesktopRuntime>,
    backend: State<'_, BackendSupervisor>,
    enabled: bool,
) -> Result<Value, String> {
    let _ = enabled;
    let settings = read_desktop_settings(&app)?;
    let discovery = app.state::<WslDiscoveryService>().inner().clone();
    let snapshot = discovery
        .refresh_and_emit(&app, "backend lifecycle")
        .await
        .unwrap_or_else(|| discovery.snapshot());
    Ok(wsl_state(&settings, &backend, &snapshot))
}

#[tauri::command]
pub async fn desktop_bridge_set_wsl_distro(
    app: AppHandle<DesktopRuntime>,
    backend: State<'_, BackendSupervisor>,
    distro: Option<String>,
) -> Result<Value, String> {
    let _ = distro;
    let settings = read_desktop_settings(&app)?;
    let discovery = app.state::<WslDiscoveryService>().inner().clone();
    let snapshot = discovery
        .refresh_and_emit(&app, "accepted binding change")
        .await
        .unwrap_or_else(|| discovery.snapshot());
    Ok(wsl_state(&settings, &backend, &snapshot))
}

#[tauri::command]
pub async fn desktop_bridge_set_wsl_only(
    app: AppHandle<DesktopRuntime>,
    backend: State<'_, BackendSupervisor>,
    enabled: bool,
) -> Result<Value, String> {
    let settings = update_desktop_settings(&app, |settings| {
        settings.wsl_only = enabled;
    })?;
    backend.restart_default_if_active(app.clone()).await?;
    let discovery = app.state::<WslDiscoveryService>().inner().clone();
    let snapshot = discovery
        .refresh_and_emit(&app, "backend lifecycle")
        .await
        .unwrap_or_else(|| discovery.snapshot());
    Ok(wsl_state(&settings, &backend, &snapshot))
}

#[tauri::command]
pub fn desktop_bridge_get_update_state(
    app: AppHandle<DesktopRuntime>,
    updates: State<'_, DesktopUpdateManager>,
) -> Result<Value, String> {
    Ok(updates.state(&app))
}

fn dialog_file_path_to_string(path: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    path.simplified()
        .into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| bridge_error("Could not normalize the selected path", error))
}

#[tauri::command]
pub async fn desktop_bridge_pick_folder(
    app: AppHandle<DesktopRuntime>,
    options: Option<Value>,
) -> Result<Option<String>, String> {
    let title = options
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Select Folder");

    let discovery = app.state::<WslDiscoveryService>().snapshot();
    let target_wsl_distro = resolve_running_wsl_picker_distro(options.as_ref(), &discovery)?;
    let use_wsl = target_wsl_distro.is_some();
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(default_path) = resolve_pick_folder_dialog_default_path(
        &app,
        options.as_ref(),
        target_wsl_distro.as_deref(),
    ) {
        dialog = dialog.set_directory(default_path);
    }

    let selected = dialog
        .blocking_pick_folder()
        .map(dialog_file_path_to_string)
        .transpose()?;

    Ok(selected.map(|path| {
        if use_wsl {
            wsl_unc_path_to_linux_path(&path).unwrap_or(path)
        } else {
            path
        }
    }))
}

fn validate_diagnostic_archive_filename(filename: &str) -> Result<(), String> {
    let is_plain_name = !filename.is_empty()
        && filename.len() <= 255
        && !filename.contains(['/', '\\'])
        && Path::new(filename)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"));
    if is_plain_name {
        Ok(())
    } else {
        Err("Diagnostic archive filename must be a plain .zip filename.".to_owned())
    }
}

fn validate_diagnostic_archive_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_DIAGNOSTIC_ARCHIVE_BYTES {
        return Err("Diagnostic archive exceeds the desktop save limit.".to_owned());
    }
    if !bytes.starts_with(b"PK") {
        return Err("Diagnostic archive is not a ZIP file.".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_bridge_save_diagnostic_logs(
    app: AppHandle<DesktopRuntime>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    validate_diagnostic_archive_filename(&filename)?;
    validate_diagnostic_archive_bytes(&bytes)?;

    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save diagnostic logs")
        .set_file_name(filename)
        .add_filter("ZIP archive", &["zip"]);
    if let Ok(download_dir) = app.path().download_dir() {
        dialog = dialog.set_directory(download_dir);
    }

    let Some(selected) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = selected
        .simplified()
        .into_path()
        .map_err(|error| bridge_error("Could not normalize the diagnostic archive path", error))?;
    fs::write(&path, bytes)
        .map_err(|error| bridge_error("Could not save diagnostic logs", error))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn desktop_bridge_confirm(app: AppHandle<DesktopRuntime>, message: String) -> bool {
    app.dialog()
        .message(message)
        .title("BiBCode")
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}

#[tauri::command]
pub fn desktop_bridge_open_external(
    app: AppHandle<DesktopRuntime>,
    url: String,
) -> Result<bool, String> {
    let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
    match parsed.scheme() {
        "http" | "https" => app
            .opener()
            .open_url(parsed.as_str(), None::<&str>)
            .map(|_| true)
            .map_err(|error| error.to_string()),
        _ => Ok(false),
    }
}

#[tauri::command]
pub fn desktop_bridge_open_in_file_manager(
    app: AppHandle<DesktopRuntime>,
    path: String,
    is_directory: bool,
) -> Result<(), String> {
    if is_directory {
        app.opener().open_path(path, None::<&str>)
    } else {
        app.opener().reveal_item_in_dir(path)
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_bridge_discover_ssh_hosts(
    app: AppHandle<DesktopRuntime>,
) -> Result<Vec<Value>, String> {
    let home_dir = app.path().home_dir().ok().or_else(default_home_dir);
    discover_ssh_hosts(home_dir)
        .map(|hosts| hosts.into_iter().map(|host| host.to_value()).collect())
}

#[tauri::command]
pub async fn desktop_bridge_ensure_ssh_environment(
    app: AppHandle<DesktopRuntime>,
    ssh: State<'_, SshEnvironmentManager>,
    prompts: State<'_, SshPasswordPromptManager>,
    target: SshEnvironmentTarget,
    options: Option<SshEnvironmentEnsureOptions>,
) -> Result<Value, String> {
    let bootstrap = ssh
        .ensure_environment(&app, &prompts, target, options)
        .await?;
    serde_json::to_value(bootstrap)
        .map_err(|error| bridge_error("Could not encode SSH environment bootstrap", error))
}

#[tauri::command]
pub async fn desktop_bridge_disconnect_ssh_environment(
    app: AppHandle<DesktopRuntime>,
    ssh: State<'_, SshEnvironmentManager>,
    prompts: State<'_, SshPasswordPromptManager>,
    target: SshEnvironmentTarget,
) -> Result<(), String> {
    ssh.disconnect_environment(&app, &prompts, target).await
}

#[tauri::command]
pub fn desktop_bridge_resolve_ssh_password_prompt(
    prompts: State<'_, SshPasswordPromptManager>,
    request_id: String,
    password: Option<String>,
) -> Result<(), String> {
    prompts
        .resolve(SshPasswordPromptResolution {
            request_id,
            password,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_bridge_get_advertised_endpoints(
    backend: State<'_, BackendSupervisor>,
) -> Result<Vec<Value>, String> {
    let Some(config) = backend.current_run_config() else {
        return Ok(Vec::new());
    };
    let mut endpoints = advertised_endpoints_for_config(&config)?;
    endpoints.extend(tailscale_advertised_endpoints_for_config(&config).await?);
    Ok(endpoints)
}

#[tauri::command]
pub fn desktop_bridge_set_theme(
    app: AppHandle<DesktopRuntime>,
    theme: String,
) -> Result<(), String> {
    let native_theme = desktop_theme_to_tauri_theme(&theme)?;
    for window in app.webview_windows().values() {
        window
            .set_theme(native_theme)
            .map_err(|error| bridge_error("Could not update the Tauri window theme", error))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_bridge_show_context_menu(
    app: AppHandle<DesktopRuntime>,
    context_menus: State<'_, NativeContextMenuManager>,
    items: Vec<Value>,
    position: Option<ContextMenuPosition>,
) -> Result<Option<String>, String> {
    let request = context_menu_request_from_values(items);
    if !context_menu_request_has_selectable_items(&request) {
        return Ok(None);
    }

    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    let ticket = context_menus.begin(&request)?;
    if let Err(error) = show_native_context_menu(&window, &request, position) {
        context_menus.cancel(&ticket.request_id);
        return Err(error);
    }

    Ok(context_menus.finish_after_popup(ticket).await)
}

#[tauri::command]
pub async fn desktop_bridge_check_for_update(
    app: AppHandle<DesktopRuntime>,
    updates: State<'_, DesktopUpdateManager>,
) -> Result<Value, String> {
    Ok(updates.check_for_update(app).await)
}

#[tauri::command]
pub async fn desktop_bridge_download_update(
    app: AppHandle<DesktopRuntime>,
    updates: State<'_, DesktopUpdateManager>,
) -> Result<Value, String> {
    Ok(updates.download_update(app).await)
}

#[tauri::command]
pub async fn desktop_bridge_install_update(
    app: AppHandle<DesktopRuntime>,
    updates: State<'_, DesktopUpdateManager>,
    backend: State<'_, BackendSupervisor>,
    input: Option<DesktopUpdateInstallInput>,
) -> Result<Value, String> {
    Ok(updates
        .install_update(&app, backend.inner(), input.unwrap_or_default())
        .await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::BackendUnavailableEnvironment;
    use crate::wsl::WslDistroState;
    use std::future::Future;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Barrier, Mutex, mpsc};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn pick_folder_command_is_async() {
        fn assert_async_command<Command, CommandFuture>(_: Command)
        where
            Command: Fn(AppHandle<DesktopRuntime>, Option<Value>) -> CommandFuture,
            CommandFuture: Future<Output = Result<Option<String>, String>> + Send,
        {
        }

        assert_async_command(desktop_bridge_pick_folder);
    }

    #[test]
    fn diagnostic_archive_filename_accepts_only_plain_zip_names() {
        assert!(validate_diagnostic_archive_filename("bibcode-diagnostics-20260716.zip").is_ok());
        assert!(validate_diagnostic_archive_filename("../diagnostics.zip").is_err());
        assert!(validate_diagnostic_archive_filename("diagnostics.txt").is_err());
    }

    #[test]
    fn diagnostic_archive_bytes_require_a_bounded_zip_payload() {
        assert!(validate_diagnostic_archive_bytes(b"PK\x03\x04archive").is_ok());
        assert!(validate_diagnostic_archive_bytes(b"not a zip").is_err());
        assert!(
            validate_diagnostic_archive_bytes(&vec![0_u8; MAX_DIAGNOSTIC_ARCHIVE_BYTES + 1])
                .is_err()
        );
    }

    fn read_test_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout should be configured");
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1024];

        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    bytes.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&bytes);
                    let Some(header_end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let content_length = text
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    let body_start = header_end + 4;
                    if bytes.len().saturating_sub(body_start) >= content_length {
                        break;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Err(error) => panic!("test server failed to read request: {error}"),
            }
        }

        String::from_utf8(bytes).expect("request should be valid utf-8")
    }

    fn spawn_http_test_server(
        status: u16,
        reason: &'static str,
        body: &'static str,
    ) -> (String, mpsc::Receiver<String>) {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind loopback");
        let address = listener
            .local_addr()
            .expect("test server address should resolve");
        let (sender, receiver) = mpsc::channel();

        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test server should accept");
            let request = read_test_http_request(&mut stream);
            sender.send(request).expect("request should be observed");
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("test server should respond");
        });

        (format!("http://{address}"), receiver)
    }

    fn spawn_json_test_server(body: &'static str) -> (String, mpsc::Receiver<String>) {
        spawn_http_test_server(200, "OK", body)
    }

    fn test_run_config() -> BackendRunConfig {
        BackendRunConfig {
            environment_id: "primary".to_string(),
            label: "Local".to_string(),
            running_distro: None,
            port: 13773,
            bind_host: "127.0.0.1".to_string(),
            local_host: "127.0.0.1".to_string(),
            desktop_bootstrap_token: "desktop-token".to_string(),
            server_exposure_mode: "local-only".to_string(),
            endpoint_url: None,
            advertised_host: None,
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
        }
    }

    fn unavailable_wsl_discovery() -> WslDiscoverySnapshot {
        WslDiscoverySnapshot {
            generation: 1,
            observed_at: "2026-08-25T00:00:00Z".to_string(),
            health: WslDiscoveryHealth::Missing,
            detail: Some("wsl.exe was not found on this computer.".to_string()),
            distros: Vec::new(),
        }
    }

    fn unique_test_path(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "bibcode-tauri-bridge-{name}-{}-{suffix}.json",
            std::process::id()
        ))
    }

    #[test]
    fn normalizes_legacy_client_settings_documents() {
        let value = serde_json::json!({
            "settings": {
                "wordWrap": false
            }
        });

        assert_eq!(
            normalize_client_settings_document(value),
            serde_json::json!({
                "wordWrap": false
            })
        );
    }

    #[test]
    fn leaves_plain_client_settings_documents_unchanged() {
        let value = serde_json::json!({
            "wordWrap": true,
            "timestampFormat": "24-hour"
        });

        assert_eq!(normalize_client_settings_document(value.clone()), value);
    }

    #[test]
    fn writes_and_reads_json_files() {
        let path = unique_test_path("settings");
        let value = serde_json::json!({
            "wordWrap": false,
            "timestampFormat": "12-hour"
        });

        write_json_file(&path, &value).expect("settings should write");
        let read = read_json_file(&path).expect("settings should read");

        assert_eq!(read, Some(value));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn missing_json_files_return_none() {
        let path = unique_test_path("missing");
        assert_eq!(read_json_file(&path).expect("read should not fail"), None);
    }

    #[test]
    fn environment_endpoint_urls_reject_non_http_schemes() {
        let error = environment_endpoint_url("file:///tmp/bibcode", "/api/auth/session")
            .expect_err("file URLs must not reach the remote API client");

        assert_eq!(
            error,
            "Environment base URL must use HTTP or HTTPS. Received file:"
        );
    }

    #[test]
    fn environment_endpoint_urls_replace_untrusted_base_components() {
        let endpoint = environment_endpoint_url(
            "https://example.test:8443/stale/path?token=secret#fragment",
            "/api/auth/session",
        )
        .expect("HTTPS environment URL should normalize");

        assert_eq!(
            endpoint.as_str(),
            "https://example.test:8443/api/auth/session"
        );
        assert!(
            environment_endpoint_url("not a URL", "/api/auth/session")
                .expect_err("malformed URLs should fail")
                .starts_with("Could not parse the environment base URL:")
        );
    }

    #[test]
    fn normalizes_connection_catalog_documents() {
        assert_eq!(
            normalize_connection_catalog_document(serde_json::json!({
                "version": 1,
                "catalog": "{\"connections\":[]}"
            }))
            .expect("document should decode"),
            Some("{\"connections\":[]}".to_string())
        );
        assert_eq!(
            normalize_connection_catalog_document(Value::String("legacy-catalog".to_string()))
                .expect("string document should decode"),
            Some("legacy-catalog".to_string())
        );
        assert_eq!(
            normalize_connection_catalog_document(serde_json::json!({
                "version": 1,
                "encryptedCatalog": "unsupported-host-owned"
            }))
            .expect("unsupported protected document should not be imported"),
            None
        );
    }

    fn compare_test_catalog(
        catalogs: &ConnectionCatalogCoordinator,
        value: &Mutex<Option<String>>,
        expected: Option<&str>,
        next: &str,
    ) -> Result<bool, String> {
        catalogs.compare_and_set_with(
            expected,
            next,
            || Ok(value.lock().expect("test catalog lock").clone()),
            |catalog| {
                *value.lock().expect("test catalog lock") = Some(catalog.to_string());
                Ok(())
            },
        )
    }

    #[test]
    fn connection_catalog_compare_and_set_preserves_conflicting_values() {
        let catalogs = ConnectionCatalogCoordinator::new();
        let value = Mutex::new(Some("before".to_string()));

        assert!(compare_test_catalog(&catalogs, &value, Some("before"), "winner").unwrap());
        assert!(!compare_test_catalog(&catalogs, &value, Some("before"), "loser").unwrap());
        assert_eq!(
            catalogs
                .read_with(|| Ok(value.lock().expect("test catalog lock").clone()))
                .unwrap(),
            Some("winner".to_string())
        );
    }

    #[test]
    fn connection_catalog_compare_only_matches_without_a_writer() {
        let catalogs = ConnectionCatalogCoordinator::new();
        let value = Mutex::new(Some("current".to_string()));

        assert!(
            catalogs
                .compare_with(Some("current"), || {
                    Ok(value.lock().expect("test catalog lock").clone())
                })
                .unwrap()
        );
        assert!(
            !catalogs
                .compare_with(Some("stale"), || {
                    Ok(value.lock().expect("test catalog lock").clone())
                })
                .unwrap()
        );
        assert_eq!(
            value.lock().expect("test catalog lock").as_deref(),
            Some("current")
        );

        let missing = tempfile::tempdir().expect("tempdir");
        let path = missing.path().join("catalog.json");
        assert!(
            catalogs
                .compare_with(None, || read_connection_catalog_document(&path))
                .unwrap()
        );
        assert!(!path.exists());
    }

    #[test]
    fn connection_catalog_compare_only_holds_the_shared_writer_lock() {
        let catalogs = Arc::new(ConnectionCatalogCoordinator::new());
        let value = Arc::new(Mutex::new(Some("before".to_string())));
        let (compare_entered, compare_entered_rx) = mpsc::channel();
        let (release_compare, release_compare_rx) = mpsc::channel();
        let compare_catalogs = Arc::clone(&catalogs);
        let compare_value = Arc::clone(&value);
        let comparison = std::thread::spawn(move || {
            compare_catalogs.compare_with(Some("before"), || {
                compare_entered
                    .send(())
                    .expect("comparison should report entry");
                release_compare_rx
                    .recv()
                    .expect("comparison should be released");
                Ok(compare_value.lock().expect("test catalog lock").clone())
            })
        });
        compare_entered_rx
            .recv()
            .expect("comparison should enter the coordinator");

        let writer_catalogs = Arc::clone(&catalogs);
        let writer_value = Arc::clone(&value);
        let (writer_done, writer_done_rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let result =
                compare_test_catalog(&writer_catalogs, &writer_value, Some("before"), "after");
            writer_done
                .send(())
                .expect("writer should report completion");
            result
        });

        assert!(
            writer_done_rx
                .recv_timeout(Duration::from_millis(50))
                .is_err(),
            "writer must wait while compare-only owns the coordinator"
        );
        release_compare
            .send(())
            .expect("comparison should be released");
        assert!(comparison.join().expect("comparison should join").unwrap());
        assert!(writer.join().expect("writer should join").unwrap());
        assert_eq!(
            value.lock().expect("test catalog lock").as_deref(),
            Some("after")
        );
    }

    #[test]
    fn concurrent_connection_catalog_compare_and_set_has_exactly_one_winner() {
        let catalogs = Arc::new(ConnectionCatalogCoordinator::new());
        let value = Arc::new(Mutex::new(Some("before".to_string())));
        let start = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for next in ["first", "second"] {
            let catalogs = Arc::clone(&catalogs);
            let value = Arc::clone(&value);
            let start = Arc::clone(&start);
            workers.push(std::thread::spawn(move || {
                start.wait();
                compare_test_catalog(&catalogs, &value, Some("before"), next).unwrap()
            }));
        }
        start.wait();

        let results = workers
            .into_iter()
            .map(|worker| worker.join().expect("catalog worker should finish"))
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| **result).count(), 1);
        assert!(matches!(
            value.lock().expect("test catalog lock").as_deref(),
            Some("first" | "second")
        ));
    }

    #[test]
    fn rejects_unsupported_connection_catalog_documents() {
        assert_eq!(
            normalize_connection_catalog_document(Value::Null).expect("null is an empty catalog"),
            None
        );

        let version_error = normalize_connection_catalog_document(json!({
            "version": 2,
            "catalog": "{}"
        }))
        .expect_err("unknown versions must fail closed");
        assert_eq!(
            version_error,
            "Unsupported Tauri connection catalog document version: 2"
        );

        let protection_error = normalize_connection_catalog_document(json!({
            "version": 1,
            "encryptedCatalog": "ciphertext",
            "protection": "unknown"
        }))
        .expect_err("unknown protection must fail closed");
        assert_eq!(
            protection_error,
            "Unsupported Tauri connection catalog protection: unknown"
        );

        assert!(
            normalize_connection_catalog_document(json!([]))
                .expect_err("non-document values must fail")
                .starts_with("Could not decode the Tauri connection catalog document:")
        );
    }

    #[test]
    fn clearing_connection_catalogs_is_idempotent_and_maps_io_errors() {
        let directory = tempfile::tempdir().expect("temporary directory should create");
        let missing = directory.path().join("missing.json");
        clear_connection_catalog_document(&missing)
            .expect("missing catalog should already be clear");

        let error = clear_connection_catalog_document(directory.path())
            .expect_err("directories cannot be cleared as catalog files");
        assert!(error.starts_with(&format!("Could not remove {}:", directory.path().display())));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn connection_catalog_storage_fails_closed_without_platform_protection() {
        let directory = tempfile::tempdir().expect("temporary directory should create");
        let path = directory.path().join("catalog.json");

        assert!(
            connection_catalog_to_value("{\"connections\":[]}")
                .expect_err("catalog protection should be unavailable")
                .contains("not implemented")
        );
        assert!(
            write_connection_catalog_document(&path, "{\"connections\":[]}")
                .expect_err("unprotected catalog should not write")
                .contains("not implemented")
        );
        assert_eq!(
            read_connection_catalog_document(&path).expect("missing catalog should read"),
            None,
        );
    }

    #[tokio::test]
    async fn platform_state_helpers_cover_non_wsl_and_disabled_tailscale_paths() {
        let settings = default_desktop_settings();
        let state = wsl_state(
            &settings,
            &BackendSupervisor::new(),
            &unavailable_wsl_discovery(),
        );
        if !cfg!(target_os = "windows") {
            assert_eq!(state["available"], false);
            assert_eq!(state["distros"], json!([]));
        }

        let mut config = test_run_config();
        config.server_exposure_mode = "local-only".to_string();
        config.tailscale_serve_enabled = false;
        assert!(
            tailscale_advertised_endpoints_for_config(&config)
                .await
                .expect("disabled Tailscale discovery should succeed")
                .is_empty()
        );
    }

    #[test]
    fn wsl_state_exposes_a_tagged_primary_failure_without_a_fallback_bootstrap() {
        let settings = DesktopSettings {
            wsl_backend_enabled: true,
            wsl_only: true,
            wsl_distro: Some("Ubuntu".to_string()),
            ..default_desktop_settings()
        };
        let backend = BackendSupervisor::new();
        backend.record_planning_error(BackendPlanError::WslPrimaryUnavailable {
            detail: "the selected distribution could not start".to_string(),
        });

        let state = wsl_state(&settings, &backend, &unavailable_wsl_discovery());

        assert_eq!(
            state["preflightError"],
            json!({
                "kind": "wsl-primary-unavailable",
                "detail": "the selected distribution could not start",
            })
        );
        assert!(backend.local_environment_bootstraps().is_empty());
    }

    #[test]
    fn wsl_state_exposes_a_tagged_secondary_failure_without_removing_it_from_topology() {
        let settings = DesktopSettings {
            wsl_backend_enabled: true,
            wsl_only: false,
            wsl_distro: Some("Ubuntu".to_string()),
            ..default_desktop_settings()
        };
        let backend = BackendSupervisor::new();
        backend.record_unavailable_environment(BackendUnavailableEnvironment {
            environment_id: "desktop-wsl-runtime:test".to_string(),
            label: "WSL (Ubuntu)".to_string(),
            configured_distro: Some("Ubuntu".to_string()),
            detail: "the selected distribution could not start".to_string(),
        });

        let state = wsl_state(&settings, &backend, &unavailable_wsl_discovery());

        assert_eq!(
            state["preflightError"],
            json!({
                "kind": "wsl-secondary-unavailable",
                "detail": "the selected distribution could not start",
            })
        );
        assert_eq!(
            backend.local_environment_bootstraps(),
            vec![json!({
                "id": "desktop-wsl-runtime:test",
                "label": "WSL (Ubuntu)",
                "configuredDistro": "Ubuntu",
                "runningDistro": null,
                "httpBaseUrl": null,
                "wsBaseUrl": null,
                "preflightError": {
                    "kind": "wsl-secondary-unavailable",
                    "detail": "the selected distribution could not start",
                },
            })]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn protects_connection_catalog_documents() {
        let catalog = "{\"connections\":[{\"id\":\"local\"}]}";
        let value = connection_catalog_to_value(catalog).expect("catalog should protect");

        assert_eq!(value["version"], 1);
        assert_eq!(value["protection"], CONNECTION_CATALOG_PROTECTION_KIND);
        assert!(value["encryptedCatalog"].as_str().is_some());
        assert!(value.get("catalog").is_none());
        assert_eq!(
            normalize_connection_catalog_document(value).expect("catalog should unprotect"),
            Some(catalog.to_string())
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn writes_reads_and_clears_protected_connection_catalog_documents() {
        let path = unique_test_path("catalog");
        let catalog = "{\"connections\":[{\"id\":\"local\"}]}";

        assert!(write_connection_catalog_document(&path, catalog).expect("catalog should write"));
        assert_eq!(
            read_connection_catalog_document(&path).expect("catalog should read"),
            Some(catalog.to_string())
        );

        clear_connection_catalog_document(&path).expect("catalog should clear");
        assert_eq!(
            read_connection_catalog_document(&path).expect("cleared catalog should read"),
            None
        );
    }

    #[test]
    fn normalizes_desktop_settings_with_legacy_wsl_mode() {
        let settings = normalize_desktop_settings_document(DesktopSettingsDocument {
            server_exposure_mode: Some("network-accessible".to_string()),
            tailscale_serve_enabled: Some(true),
            tailscale_serve_port: Some(8443),
            wsl_backend_enabled: None,
            wsl_mode: Some("wsl".to_string()),
            wsl_distro: Some("Ubuntu-24.04".to_string()),
            wsl_only: Some(true),
        });

        assert_eq!(
            settings,
            DesktopSettings {
                server_exposure_mode: "local-only".to_string(),
                tailscale_serve_enabled: true,
                tailscale_serve_port: 8443,
                wsl_backend_enabled: true,
                wsl_distro: Some("Ubuntu-24.04".to_string()),
                wsl_only: true,
            }
        );
    }

    #[test]
    fn persisted_wsl_only_intent_normalizes_the_backend_to_enabled() {
        let settings = normalize_desktop_settings_document(DesktopSettingsDocument {
            wsl_backend_enabled: Some(false),
            wsl_only: Some(true),
            ..DesktopSettingsDocument::default()
        });

        assert!(settings.wsl_only);
        assert!(settings.wsl_backend_enabled);
    }

    #[test]
    fn legacy_update_channel_settings_are_discarded_on_write() {
        let document: DesktopSettingsDocument = serde_json::from_value(json!({
            "updateChannel": "nightly",
            "updateChannelConfiguredByUser": true,
            "wslOnly": false,
        }))
        .expect("legacy settings should decode");
        let value = desktop_settings_to_value(&normalize_desktop_settings_document(document));

        assert!(value.get("updateChannel").is_none());
        assert!(value.get("updateChannelConfiguredByUser").is_none());
    }

    #[test]
    fn invalid_desktop_settings_fall_back_to_safe_defaults() {
        let settings = normalize_desktop_settings_document(DesktopSettingsDocument {
            server_exposure_mode: Some("public-internet".to_string()),
            tailscale_serve_enabled: Some(true),
            tailscale_serve_port: Some(70_000),
            wsl_backend_enabled: Some(false),
            wsl_mode: Some("wsl".to_string()),
            wsl_distro: Some(" Ubuntu ".to_string()),
            wsl_only: Some(false),
        });

        assert_eq!(
            settings,
            DesktopSettings {
                server_exposure_mode: "local-only".to_string(),
                tailscale_serve_enabled: true,
                tailscale_serve_port: DEFAULT_TAILSCALE_SERVE_PORT,
                wsl_backend_enabled: false,
                wsl_distro: None,
                wsl_only: false,
            }
        );
    }

    #[test]
    fn desktop_settings_write_omits_retired_wsl_selection_fields() {
        let settings = default_desktop_settings();

        assert_eq!(
            desktop_settings_to_value(&settings),
            json!({
                "serverExposureMode": "local-only",
                "tailscaleServeEnabled": false,
                "tailscaleServePort": 443,
                "wslOnly": false,
            })
        );
        assert_eq!(normalize_tailscale_serve_port(Some(1)), 1);
        assert_eq!(
            normalize_tailscale_serve_port(Some(u16::MAX as u64)),
            u16::MAX
        );
        assert_eq!(normalize_tailscale_serve_port(Some(0)), 443);
        assert_eq!(normalize_tailscale_serve_port(None), 443);
        assert_eq!(normalize_server_exposure_mode(None), "local-only");
    }

    #[test]
    fn server_exposure_state_never_publishes_legacy_plaintext_exposure() {
        let mut settings = default_desktop_settings();
        settings.tailscale_serve_enabled = true;
        settings.tailscale_serve_port = 8443;

        assert_eq!(
            server_exposure_state(&settings, None),
            json!({
                "mode": "local-only",
                "endpointUrl": null,
                "advertisedHost": null,
                "tailscaleServeEnabled": true,
                "tailscaleServePort": 8443,
            })
        );

        let mut config = test_run_config();
        config.server_exposure_mode = "network-accessible".to_string();
        config.endpoint_url = Some("http://192.168.1.20:13773".to_string());
        config.advertised_host = Some("192.168.1.20".to_string());
        assert_eq!(
            server_exposure_state(&settings, Some(&config)),
            json!({
                "mode": "local-only",
                "endpointUrl": null,
                "advertisedHost": null,
                "tailscaleServeEnabled": false,
                "tailscaleServePort": 443,
            })
        );
    }

    #[test]
    fn advertised_endpoint_urls_normalize_supported_schemes() {
        assert_eq!(
            normalize_http_base_url("ws://example.test:13773/path?q=1#fragment")
                .expect("WebSocket URL should normalize"),
            "http://example.test:13773/"
        );
        assert_eq!(
            normalize_http_base_url("wss://example.test/path")
                .expect("secure WebSocket URL should normalize"),
            "https://example.test/"
        );
        assert_eq!(
            derive_ws_base_url("http://example.test/").expect("HTTP should derive WS"),
            "ws://example.test/"
        );
        assert_eq!(
            derive_ws_base_url("https://example.test/").expect("HTTPS should derive WSS"),
            "wss://example.test/"
        );
        assert_eq!(
            hosted_https_compatibility("http://example.test/").expect("HTTP should inspect"),
            "mixed-content-blocked"
        );
        assert_eq!(
            hosted_https_compatibility("https://example.test/").expect("HTTPS should inspect"),
            "unknown"
        );
        assert!(normalize_http_base_url("ssh://example.test").is_err());
        assert!(normalize_http_base_url("not a URL").is_err());
        assert!(derive_ws_base_url("ssh://example.test/").is_err());
        assert!(derive_ws_base_url("not a URL").is_err());
        assert!(hosted_https_compatibility("not a URL").is_err());
    }

    #[test]
    fn advertised_endpoints_never_publish_injected_plaintext_lan_routes() {
        let config = test_run_config();
        let loopback =
            advertised_endpoints_for_config(&config).expect("loopback endpoint should build");
        assert_eq!(loopback.len(), 1);
        assert_eq!(loopback[0]["id"], "desktop-loopback:13773");
        assert!(loopback[0].get("isDefault").is_none());

        let mut network_config = config;
        network_config.endpoint_url = Some("http://192.168.1.20:13773/path".to_string());
        let endpoints = advertised_endpoints_for_config(&network_config)
            .expect("legacy LAN metadata should be ignored");
        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0]["httpBaseUrl"], "http://127.0.0.1:13773/");
    }

    #[test]
    fn validates_wsl_distro_locators() {
        assert!(is_valid_distro_name("Ubuntu 24.04-LTS"));
        assert!(!is_valid_distro_name(""));
        assert!(!is_valid_distro_name("-Ubuntu"));
        assert!(!is_valid_distro_name("Ubuntu!"));
    }

    #[test]
    fn resolves_wsl_pick_folder_default_paths() {
        let distros = vec![WslDistro {
            name: "Debian".to_string(),
            is_default: true,
            state: WslDistroState::Running,
            version: 2,
        }];

        assert_eq!(
            resolve_wsl_pick_folder_default_path(None, None, &distros, None)
                .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Debian\\home".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "/home/josh/project" })),
                None,
                &distros,
                None,
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Debian\\home\\josh\\project".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "~/project" })),
                None,
                &distros,
                Some("/home/josh"),
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Debian\\home\\josh\\project".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "\\\\wsl.localhost\\Ubuntu\\home\\josh" })),
                None,
                &distros,
                None,
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\josh".to_string())
        );
    }

    #[test]
    fn resolves_wsl_picker_fallback_and_home_paths() {
        let distros = vec![WslDistro {
            name: "Debian".to_string(),
            is_default: true,
            state: WslDistroState::Stopped,
            version: 2,
        }];

        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "~" })),
                None,
                &distros,
                Some("/home/mauro"),
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Debian\\home\\mauro".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "relative/project" })),
                None,
                &distros,
                None,
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Debian\\home".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "/home/project" })),
                Some("Ubuntu"),
                &[],
                None,
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\project".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(None, None, &[], None),
            None
        );
    }

    #[test]
    fn maps_wsl_unc_paths_back_to_linux_paths() {
        assert_eq!(
            wsl_unc_path_to_linux_path("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh\\repo"),
            Some("/home/josh/repo".to_string())
        );
        assert_eq!(
            wsl_unc_path_to_linux_path("\\\\wsl$\\Debian"),
            Some("/".to_string())
        );
        assert_eq!(
            wsl_unc_path_to_linux_path("\\\\wsl.localhost\\bad!name\\home"),
            None
        );
        assert_eq!(wsl_unc_path_to_linux_path("C:\\Users\\Mauro\\repo"), None);
    }

    #[test]
    fn validates_wsl_picker_targets_against_running_discovery() {
        let running = WslDiscoverySnapshot {
            generation: 2,
            observed_at: "2026-08-25T00:00:00Z".to_string(),
            health: WslDiscoveryHealth::Available,
            detail: None,
            distros: vec![WslDistro {
                name: "Ubuntu".to_string(),
                is_default: true,
                state: WslDistroState::Running,
                version: 2,
            }],
        };
        assert_eq!(
            resolve_running_wsl_picker_distro(
                Some(&json!({"targetWslDistro": "ubuntu"})),
                &running,
            ),
            Ok(Some("Ubuntu".to_string())),
        );
        let mut stopped = running.clone();
        stopped.distros[0].state = WslDistroState::Stopped;
        assert!(
            resolve_running_wsl_picker_distro(
                Some(&json!({"targetWslDistro": "Ubuntu"})),
                &stopped,
            )
            .expect_err("a stopped distro must not be opened")
            .contains("will not start it automatically")
        );
        assert!(
            resolve_running_wsl_picker_distro(
                Some(&json!({"targetWslDistro": "bad!name"})),
                &running,
            )
            .is_err()
        );
        assert_eq!(resolve_running_wsl_picker_distro(None, &running), Ok(None));
    }

    #[test]
    fn bridge_metadata_reports_version_and_feature_flags() {
        let mut base_context = tauri::test::mock_context(tauri::test::noop_assets());
        base_context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            json!({"pubkey": "", "endpoints": [], "windows": null}),
        );
        let base_app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(base_context)
            .expect("base mock Tauri app");
        let mut release_context = tauri::test::mock_context(tauri::test::noop_assets());
        let release_config: Value =
            serde_json::from_str(include_str!("../tauri.release.conf.json"))
                .expect("release Tauri configuration");
        release_context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            release_config["plugins"]["updater"].clone(),
        );
        let release_app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(release_context)
            .expect("release mock Tauri app");

        let metadata = desktop_bridge_get_bridge_metadata(base_app.handle().clone());

        assert_eq!(metadata["host"], "tauri");
        assert_eq!(metadata["bridgeVersion"], 3);
        assert_eq!(metadata["features"]["localBackend"], true);
        assert_eq!(metadata["features"]["connectionCatalog"], true);
        assert_eq!(
            metadata["features"]["protectedConnectionCatalog"],
            cfg!(target_os = "windows")
        );
        assert_eq!(
            metadata["features"]["preview"],
            crate::preview::host::is_supported()
        );
        assert_eq!(metadata["features"]["sshProvisioning"], true);
        assert_eq!(metadata["features"]["menuEvents"], true);
        assert_eq!(metadata["features"]["updater"], false);
        assert_eq!(
            desktop_bridge_get_bridge_metadata(release_app.handle().clone())["features"]["updater"],
            true
        );
    }

    #[test]
    fn builds_tailscale_advertised_endpoints_from_status() {
        let config = BackendRunConfig {
            environment_id: "primary".to_string(),
            label: "Local".to_string(),
            running_distro: None,
            port: 13773,
            bind_host: "0.0.0.0".to_string(),
            local_host: "127.0.0.1".to_string(),
            desktop_bootstrap_token: "desktop-token".to_string(),
            server_exposure_mode: "network-accessible".to_string(),
            endpoint_url: Some("http://192.168.1.20:13773".to_string()),
            advertised_host: Some("192.168.1.20".to_string()),
            tailscale_serve_enabled: true,
            tailscale_serve_port: 8443,
        };
        let status = TailscaleStatus {
            magic_dns_name: Some("desktop.tail.ts.net".to_string()),
            tailnet_ipv4_addresses: vec!["100.100.100.100".to_string()],
        };

        let endpoints =
            tailscale_endpoints_for_status(&config, &status, true).expect("endpoints should build");

        assert_eq!(endpoints.len(), 1);
        assert_eq!(
            endpoints[0]["id"],
            "tailscale-magicdns:https://desktop.tail.ts.net:8443/"
        );
        assert_eq!(endpoints[0]["provider"]["id"], "tailscale");
        assert_eq!(endpoints[0]["provider"]["kind"], "private-network");
        assert_eq!(endpoints[0]["source"], "desktop-addon");
        assert_eq!(endpoints[0]["status"], "available");
        assert_eq!(
            endpoints[0]["httpBaseUrl"],
            "https://desktop.tail.ts.net:8443/"
        );
        assert_eq!(endpoints[0]["wsBaseUrl"], "wss://desktop.tail.ts.net:8443/");
        assert_eq!(
            endpoints[0]["compatibility"]["hostedHttpsApp"],
            "compatible"
        );
    }

    #[test]
    fn marks_unprobed_tailscale_magic_dns_as_requires_configuration() {
        let config = BackendRunConfig {
            environment_id: "primary".to_string(),
            label: "Local".to_string(),
            running_distro: None,
            port: 13773,
            bind_host: "127.0.0.1".to_string(),
            local_host: "127.0.0.1".to_string(),
            desktop_bootstrap_token: "desktop-token".to_string(),
            server_exposure_mode: "local-only".to_string(),
            endpoint_url: None,
            advertised_host: None,
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
        };
        let status = TailscaleStatus {
            magic_dns_name: Some("desktop.tail.ts.net".to_string()),
            tailnet_ipv4_addresses: Vec::new(),
        };

        let endpoints =
            tailscale_endpoints_for_status(&config, &status, false).expect("endpoint should build");

        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0]["httpBaseUrl"], "https://desktop.tail.ts.net/");
        assert_eq!(endpoints[0]["status"], "unavailable");
        assert_eq!(
            endpoints[0]["compatibility"]["hostedHttpsApp"],
            "requires-configuration"
        );
    }

    #[test]
    fn maps_desktop_theme_values_to_tauri_theme() {
        assert_eq!(
            desktop_theme_to_tauri_theme("system").expect("system theme"),
            None
        );
        assert_eq!(
            desktop_theme_to_tauri_theme("light").expect("light theme"),
            Some(tauri::Theme::Light)
        );
        assert_eq!(
            desktop_theme_to_tauri_theme("dark").expect("dark theme"),
            Some(tauri::Theme::Dark)
        );

        let error = desktop_theme_to_tauri_theme("sepia").expect_err("invalid theme");
        assert!(error.contains("Unsupported desktop theme"));
    }

    #[tokio::test]
    async fn fetch_environment_descriptor_requests_well_known_endpoint() {
        let (base_url, requests) = spawn_json_test_server(r#"{"environmentId":"env-tauri"}"#);

        let descriptor = desktop_bridge_fetch_environment_descriptor(base_url)
            .await
            .expect("descriptor request should succeed");

        assert_eq!(
            descriptor,
            serde_json::json!({ "environmentId": "env-tauri" })
        );
        let request = requests.recv().expect("request should be captured");
        assert!(request.starts_with("GET /.well-known/bibcode/environment HTTP/1.1"));
    }

    #[tokio::test]
    async fn remote_environment_requests_map_status_and_json_errors() {
        let (base_url, requests) =
            spawn_http_test_server(503, "Unavailable", r#"{"error":"down"}"#);
        let error = desktop_bridge_fetch_environment_descriptor(base_url)
            .await
            .expect_err("non-success status should fail");
        assert_eq!(
            error,
            "[ssh_http:503] SSH remote API request failed during fetch-environment-descriptor."
        );
        assert!(
            requests
                .recv()
                .expect("failed request should be captured")
                .starts_with("GET /.well-known/bibcode/environment HTTP/1.1")
        );

        let (base_url, requests) = spawn_json_test_server("not-json");
        let error = desktop_bridge_fetch_environment_descriptor(base_url)
            .await
            .expect_err("malformed JSON should fail");
        assert!(error.starts_with("Could not decode the environment API response:"));
        requests
            .recv()
            .expect("malformed response request should be captured");

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("closed endpoint fixture");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("closed endpoint address")
        );
        drop(listener);
        assert!(
            desktop_bridge_fetch_environment_descriptor(base_url.clone())
                .await
                .is_err()
        );
        assert!(
            desktop_bridge_issue_ssh_web_socket_ticket(base_url.clone(), "token".to_string(),)
                .await
                .is_err()
        );
        assert!(
            desktop_bridge_bootstrap_ssh_bearer_session(base_url, "credential".to_string())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn fetch_ssh_session_state_routes_with_bearer_authorization() {
        let (base_url, requests) = spawn_json_test_server(r#"{"status":"authenticated"}"#);

        let state =
            desktop_bridge_fetch_ssh_session_state(base_url, "session-bearer-token".to_string())
                .await
                .expect("session state should load");

        assert_eq!(state, json!({ "status": "authenticated" }));
        let request = requests.recv().expect("request should be captured");
        assert!(request.starts_with("GET /api/auth/session HTTP/1.1"));
        assert!(request.contains("authorization: Bearer session-bearer-token"));
    }

    #[tokio::test]
    async fn bootstrap_ssh_bearer_session_posts_oauth_token_exchange() {
        let (base_url, requests) =
            spawn_json_test_server(r#"{"access_token":"bearer-token","token_type":"Bearer"}"#);

        let session =
            desktop_bridge_bootstrap_ssh_bearer_session(base_url, "bootstrap-token".to_string())
                .await
                .expect("bootstrap request should succeed");

        assert_eq!(
            session,
            serde_json::json!({ "access_token": "bearer-token", "token_type": "Bearer" })
        );
        let request = requests.recv().expect("request should be captured");
        assert!(request.starts_with("POST /oauth/token HTTP/1.1"));
        assert!(request.contains("subject_token=bootstrap-token"));
        assert!(
            request
                .contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange")
        );
        assert!(request.contains("client_label=BiBCode+Tauri+Desktop"));
    }

    #[tokio::test]
    async fn issue_web_socket_ticket_sends_bearer_authorization() {
        let (base_url, requests) =
            spawn_json_test_server(r#"{"ticket":"ticket-1","expiresAt":"2026-07-08T00:00:00Z"}"#);

        let ticket =
            desktop_bridge_issue_ssh_web_socket_ticket(base_url, "bearer-token".to_string())
                .await
                .expect("ticket request should succeed");

        assert_eq!(
            ticket,
            serde_json::json!({ "ticket": "ticket-1", "expiresAt": "2026-07-08T00:00:00Z" })
        );
        let request = requests.recv().expect("request should be captured");
        assert!(request.starts_with("POST /api/auth/websocket-ticket HTTP/1.1"));
        assert!(request.contains("authorization: Bearer bearer-token"));
    }

    #[test]
    fn tauri_ipc_handlers_preserve_runtime_agnostic_bridge_contracts() {
        use crate::config::IsolatedTestDataRoot;
        use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};

        let temp = tempfile::tempdir().expect("isolated desktop data root");
        // Use the generated application context so IPC exercises the same command
        // permissions as the production desktop shell.
        let mut context = crate::desktop_context();
        context.config_mut().identifier =
            format!("com.bibcode.bridge-tests-{}", std::process::id());
        let app = mock_builder()
            .manage(IsolatedTestDataRoot::new(temp.path().join("data-root")))
            .manage(BackendSupervisor::new())
            .manage(WslDiscoveryService::new())
            .manage(ConnectionCatalogCoordinator::new())
            .manage(DesktopSecretStore::new())
            .manage(NativeContextMenuManager::new())
            .manage(SshEnvironmentManager::new())
            .manage(SshPasswordPromptManager::new())
            .manage(DesktopUpdateManager::new())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .invoke_handler(tauri::generate_handler![
                desktop_bridge_get_bridge_metadata,
                desktop_bridge_get_app_branding,
                desktop_bridge_get_local_environment_bootstraps,
                desktop_bridge_get_project_data_statuses,
                desktop_bridge_restore_project_data,
                desktop_bridge_start_empty_project_data,
                desktop_bridge_retry_project_data,
                desktop_bridge_open_project_data_path,
                desktop_bridge_export_project_data_diagnostics,
                desktop_bridge_get_client_settings,
                desktop_bridge_set_client_settings,
                desktop_bridge_get_connection_catalog,
                desktop_bridge_set_connection_catalog,
                desktop_bridge_compare_connection_catalog,
                desktop_bridge_compare_and_set_connection_catalog,
                desktop_bridge_clear_connection_catalog,
                desktop_bridge_put_secret,
                desktop_bridge_get_secret,
                desktop_bridge_delete_secret,
                desktop_bridge_discover_ssh_hosts,
                desktop_bridge_ensure_ssh_environment,
                desktop_bridge_disconnect_ssh_environment,
                desktop_bridge_fetch_environment_descriptor,
                desktop_bridge_bootstrap_ssh_bearer_session,
                desktop_bridge_fetch_ssh_session_state,
                desktop_bridge_issue_ssh_web_socket_ticket,
                desktop_bridge_resolve_ssh_password_prompt,
                desktop_bridge_get_server_exposure_state,
                desktop_bridge_set_tailscale_serve_enabled,
                desktop_bridge_get_advertised_endpoints,
                desktop_bridge_get_wsl_state,
                desktop_bridge_set_wsl_backend_enabled,
                desktop_bridge_set_wsl_distro,
                desktop_bridge_set_wsl_only,
                desktop_bridge_set_theme,
                desktop_bridge_show_context_menu,
                desktop_bridge_get_update_state,
                desktop_bridge_check_for_update,
                desktop_bridge_download_update,
                desktop_bridge_install_update,
                desktop_bridge_pick_folder,
                desktop_bridge_save_diagnostic_logs,
                desktop_bridge_confirm,
                desktop_bridge_open_external,
                desktop_bridge_open_in_file_manager,
            ])
            .build(context)
            .expect("mock Tauri app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");
        let invoke = |cmd: &str, body: Value| {
            get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: cmd.to_owned(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_owned(),
                },
            )
            .map(|body| body.deserialize::<Value>().unwrap())
        };
        let test_state_dir = state_dir(app.handle()).expect("isolated mock state directory");
        let metadata = invoke("desktop_bridge_get_bridge_metadata", json!({})).unwrap();
        assert_eq!(metadata["host"], "tauri");
        assert_eq!(
            invoke("desktop_bridge_get_local_environment_bootstraps", json!({})).unwrap(),
            json!([])
        );
        assert_eq!(
            invoke("desktop_bridge_get_project_data_statuses", json!({})).unwrap(),
            json!([])
        );
        assert!(
            invoke("desktop_bridge_get_app_branding", json!({})).unwrap()["displayName"]
                .is_string()
        );
        let client_settings = invoke("desktop_bridge_get_client_settings", json!({})).unwrap();
        assert!(client_settings.is_null() || client_settings.is_object());
        let catalog = invoke("desktop_bridge_get_connection_catalog", json!({})).unwrap();
        assert!(catalog.is_null() || catalog.is_string());
        assert_eq!(
            invoke(
                "desktop_bridge_get_secret",
                json!({"secretRef":"not-an-opaque-reference"}),
            )
            .expect_err("invalid secret references must fail before provider access"),
            json!({"code":"invalid-reference"})
        );
        assert_eq!(
            invoke(
                "desktop_bridge_compare_connection_catalog",
                json!({"expectedCatalog": catalog.clone()}),
            )
            .unwrap(),
            true
        );
        assert_eq!(
            invoke(
                "desktop_bridge_compare_and_set_connection_catalog",
                json!({"expectedCatalog":"stale-catalog","nextCatalog":"ignored-catalog"}),
            )
            .unwrap(),
            false
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            invoke(
                "desktop_bridge_compare_and_set_connection_catalog",
                json!({"expectedCatalog":null,"nextCatalog":"must-not-persist"}),
            )
            .expect_err("unprotected native catalog writes must fail closed"),
            "Could not update the protected connection catalog."
        );
        let _ = invoke("desktop_bridge_discover_ssh_hosts", json!({}));
        assert!(invoke("desktop_bridge_get_wsl_state", json!({})).unwrap()["enabled"].is_boolean());
        assert!(
            invoke("desktop_bridge_get_server_exposure_state", json!({}))
                .unwrap()
                .is_object()
        );
        assert_eq!(
            invoke("desktop_bridge_get_advertised_endpoints", json!({})).unwrap(),
            json!([])
        );
        assert_eq!(
            invoke(
                "desktop_bridge_show_context_menu",
                json!({"items":[],"position":null}),
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(
            invoke(
                "desktop_bridge_open_external",
                json!({"url":"file:///tmp/blocked"}),
            )
            .unwrap(),
            false
        );
        assert!(invoke("desktop_bridge_set_theme", json!({"theme":"unsupported"}),).is_err());
        assert!(invoke("desktop_bridge_set_theme", json!({"theme":"dark"})).is_ok());
        for command in [
            "desktop_bridge_get_update_state",
            "desktop_bridge_check_for_update",
            "desktop_bridge_download_update",
            "desktop_bridge_install_update",
        ] {
            assert!(
                invoke(command, json!({})).unwrap().is_object(),
                "{command} should return its update state",
            );
        }
        assert!(
            invoke(
                "desktop_bridge_set_client_settings",
                json!({"settings":{"theme":"dark"}}),
            )
            .is_ok()
        );
        assert_eq!(
            invoke("desktop_bridge_get_client_settings", json!({})).unwrap()["theme"],
            "dark"
        );
        let set_catalog = invoke(
            "desktop_bridge_set_connection_catalog",
            json!({"catalog":"test-catalog"}),
        );
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                set_catalog.expect("Windows DPAPI should protect the catalog"),
                true
            );
            assert_eq!(
                invoke(
                    "desktop_bridge_compare_and_set_connection_catalog",
                    json!({"expectedCatalog":"test-catalog","nextCatalog":"winner-catalog"}),
                )
                .unwrap(),
                true
            );
            assert_eq!(
                invoke("desktop_bridge_get_connection_catalog", json!({})).unwrap(),
                "winner-catalog"
            );
            assert_eq!(
                invoke(
                    "desktop_bridge_compare_and_set_connection_catalog",
                    json!({"expectedCatalog":"test-catalog","nextCatalog":"loser-catalog"}),
                )
                .unwrap(),
                false
            );
        }
        #[cfg(not(target_os = "windows"))]
        assert!(
            set_catalog.is_err(),
            "catalog persistence must fail closed without platform protection",
        );
        assert!(invoke("desktop_bridge_clear_connection_catalog", json!({})).is_ok());
        assert!(
            invoke(
                "desktop_bridge_set_tailscale_serve_enabled",
                json!({"input":{"enabled":false,"port":443}}),
            )
            .is_ok()
        );
        assert!(
            invoke(
                "desktop_bridge_set_wsl_backend_enabled",
                json!({"enabled":false}),
            )
            .is_ok()
        );
        assert!(
            invoke(
                "desktop_bridge_set_wsl_distro",
                json!({"distro":"Ubuntu-24.04"}),
            )
            .is_ok()
        );
        assert!(invoke("desktop_bridge_set_wsl_only", json!({"enabled":true}),).is_ok());
        let invalid_target = json!({
            "target": {"alias":"","hostname":"","username":null,"port":null},
            "options": null,
        });
        assert!(invoke("desktop_bridge_ensure_ssh_environment", invalid_target).is_err());
        assert!(
            invoke(
                "desktop_bridge_disconnect_ssh_environment",
                json!({
                    "target": {"alias":"","hostname":"","username":null,"port":null},
                }),
            )
            .is_err()
        );
        let unreachable_target = json!({
            "alias":"unreachable-localhost",
            "hostname":"127.0.0.1",
            "username":null,
            "port":1,
        });
        assert!(
            invoke(
                "desktop_bridge_ensure_ssh_environment",
                json!({"target":unreachable_target,"options":null}),
            )
            .is_err()
        );
        assert!(
            invoke(
                "desktop_bridge_disconnect_ssh_environment",
                json!({"target":unreachable_target}),
            )
            .is_err()
        );
        assert!(
            invoke(
                "desktop_bridge_save_diagnostic_logs",
                json!({"filename":"../blocked.zip","bytes":[80,75]}),
            )
            .is_err()
        );
        let handle = app.handle();
        assert!(app_branding(handle)["displayName"].is_string());
        assert!(
            client_settings_path(handle)
                .unwrap()
                .ends_with(CLIENT_SETTINGS_FILE_NAME)
        );
        assert!(
            connection_catalog_path(handle)
                .unwrap()
                .ends_with(CONNECTION_CATALOG_FILE_NAME)
        );
        assert!(
            desktop_settings_path(handle)
                .unwrap()
                .ends_with(DESKTOP_SETTINGS_FILE_NAME)
        );
        assert!(
            resolve_pick_folder_dialog_default_path(
                handle,
                Some(&json!({"initialPath":test_state_dir})),
                None,
            )
            .is_some()
        );
        assert!(
            resolve_pick_folder_dialog_default_path(
                handle,
                Some(&json!({"targetWslDistro":"Ubuntu-24.04"})),
                Some("Ubuntu-24.04"),
            )
            .is_some()
        );
        assert!(
            dialog_file_path_to_string(tauri_plugin_dialog::FilePath::Path(
                test_state_dir.join("selected"),
            ))
            .expect("filesystem dialog path should normalize")
            .ends_with("selected")
        );
        assert!(
            dialog_file_path_to_string(tauri_plugin_dialog::FilePath::Url(
                url::Url::parse("https://example.test/not-a-file").unwrap(),
            ))
            .is_err()
        );
        assert!(invoke("desktop_bridge_open_external", json!({"url":"not a URL"}),).is_err());

        for (command, arguments) in [
            (
                "desktop_bridge_fetch_environment_descriptor",
                json!({"httpBaseUrl":"file:///tmp/blocked"}),
            ),
            (
                "desktop_bridge_bootstrap_ssh_bearer_session",
                json!({
                    "httpBaseUrl":"file:///tmp/blocked",
                    "credential":"credential",
                }),
            ),
            (
                "desktop_bridge_fetch_ssh_session_state",
                json!({
                    "httpBaseUrl":"file:///tmp/blocked",
                    "bearerToken":"bearer-token",
                }),
            ),
            (
                "desktop_bridge_issue_ssh_web_socket_ticket",
                json!({
                    "httpBaseUrl":"file:///tmp/blocked",
                    "bearerToken":"bearer-token",
                }),
            ),
        ] {
            let error = invoke(command, arguments).unwrap_err();
            assert!(
                error
                    .as_str()
                    .is_some_and(|error| error.contains("must use HTTP or HTTPS")),
                "unexpected validation result for {command}: {error}",
            );
        }

        assert!(
            invoke(
                "desktop_bridge_resolve_ssh_password_prompt",
                json!({"requestId":"missing","password":null}),
            )
            .is_err()
        );
        for command in [
            "desktop_bridge_set_client_settings",
            "desktop_bridge_set_connection_catalog",
            "desktop_bridge_ensure_ssh_environment",
            "desktop_bridge_disconnect_ssh_environment",
            "desktop_bridge_set_tailscale_serve_enabled",
            "desktop_bridge_set_wsl_backend_enabled",
            "desktop_bridge_set_wsl_only",
            "desktop_bridge_confirm",
        ] {
            assert!(
                invoke(command, json!({})).is_err(),
                "{command} should reject missing command arguments",
            );
        }
    }
}
