#![cfg_attr(test, allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAboutResult {
    pub version: Option<String>,
    pub status: String,
    pub auth: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorProviderModel {
    pub slug: String,
    pub name: String,
    pub is_custom: bool,
    pub capabilities: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorProviderSnapshot {
    pub installed: bool,
    pub status: String,
    pub version: Option<String>,
    pub auth: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub models: Vec<CursorProviderModel>,
}

pub fn parse_about_output(code: i32, stdout: &str, _stderr: &str) -> CursorAboutResult {
    if code != 0 {
        let version = stdout
            .lines()
            .find_map(|line| line.strip_prefix("grok-cli ").map(str::to_owned));
        return CursorAboutResult {
            version,
            status: "error".to_owned(),
            auth: json!({ "status": "unknown" }),
            message: Some("Cursor Agent is installed but failed to run.".to_owned()),
        };
    }

    if let Ok(value) = serde_json::from_str::<Value>(stdout) {
        let version = value
            .get("cliVersion")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let user_email = value.get("userEmail").and_then(Value::as_str);
        let tier = value
            .get("subscriptionTier")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if matches!(user_email, Some(email) if !email.trim().is_empty() && email != "Not logged in")
        {
            let mut auth = json!({
                "status": "authenticated",
                "email": user_email,
            });
            if let Some(tier) = tier {
                auth["type"] = json!(tier);
            }
            return CursorAboutResult {
                version,
                status: "ready".to_owned(),
                auth,
                message: None,
            };
        }
        return CursorAboutResult {
            version,
            status: "error".to_owned(),
            auth: json!({ "status": "unauthenticated" }),
            message: Some(
                "Cursor Agent is not authenticated. Run `agent login` and try again.".to_owned(),
            ),
        };
    }

    let version = stdout.lines().find_map(|line| {
        line.strip_prefix("CLI Version")
            .map(str::trim)
            .map(str::to_owned)
    });
    let user_email = stdout
        .lines()
        .find_map(|line| line.strip_prefix("User Email").map(str::trim));
    if matches!(user_email, Some(email) if !email.is_empty() && email != "Not logged in") {
        return CursorAboutResult {
            version,
            status: "ready".to_owned(),
            auth: json!({ "status": "authenticated", "email": user_email }),
            message: None,
        };
    }
    CursorAboutResult {
        version,
        status: "error".to_owned(),
        auth: json!({ "status": "unauthenticated" }),
        message: Some(
            "Cursor Agent is not authenticated. Run `agent login` and try again.".to_owned(),
        ),
    }
}

pub fn parse_version_date(version: &str) -> Option<u32> {
    let digits = version
        .split('-')
        .next()
        .unwrap_or(version)
        .split('.')
        .collect::<Vec<_>>();
    if digits.len() != 3 {
        return None;
    }
    Some(
        digits[0].parse::<u32>().ok()? * 10_000
            + digits[1].parse::<u32>().ok()? * 100
            + digits[2].parse::<u32>().ok()?,
    )
}

pub fn parse_cli_config_channel(content: &str) -> Option<String> {
    serde_json::from_str::<Value>(content)
        .ok()?
        .get("channel")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub fn resolve_acp_base_model_id(model_id: &str) -> String {
    model_id
        .split('[')
        .next()
        .unwrap_or(model_id)
        .trim()
        .to_owned()
}

pub fn build_capabilities_from_config_options(options: &Value) -> Value {
    let Some(options) = options.as_array() else {
        return json!({ "optionDescriptors": [] });
    };
    let mut descriptors = Vec::new();
    let reasoning_source = options
        .iter()
        .find(|option| {
            matches!(
                option.get("category").and_then(Value::as_str),
                Some("model_option")
            ) && option.get("id").and_then(Value::as_str) == Some("effort")
        })
        .or_else(|| {
            options.iter().find(|option| {
                matches!(
                    option.get("category").and_then(Value::as_str),
                    Some("thought_level")
                )
            })
        });
    if let Some(reasoning) = reasoning_source {
        descriptors.push(select_descriptor(
            "reasoning",
            reasoning
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Reasoning"),
            reasoning
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            reasoning.get("currentValue").and_then(Value::as_str),
        ));
    }
    for option in options {
        match (
            option.get("category").and_then(Value::as_str),
            option.get("id").and_then(Value::as_str),
        ) {
            (Some("model_config"), Some("context")) => descriptors.push(select_descriptor(
                "contextWindow",
                option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Context"),
                option
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                option.get("currentValue").and_then(Value::as_str),
            )),
            (Some("model_config"), Some("fast")) => descriptors.push(boolean_descriptor(
                "fastMode",
                option.get("name").and_then(Value::as_str).unwrap_or("Fast"),
                option.get("currentValue"),
            )),
            (Some("model_config"), Some("thinking")) => descriptors.push(boolean_descriptor(
                "thinking",
                option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Thinking"),
                option.get("currentValue"),
            )),
            _ => {}
        }
    }
    json!({ "optionDescriptors": descriptors })
}

pub fn resolve_acp_config_updates(options: &Value, updates: &Value) -> Result<Vec<Value>, String> {
    let Some(options) = options.as_array() else {
        return Err("Cursor session did not advertise config options".to_owned());
    };
    let Some(updates) = updates.as_array() else {
        return Err("Cursor option updates must be an array".to_owned());
    };
    let mut resolved = Vec::new();
    for update in updates {
        let (config_id, value) = match update.get("id").and_then(Value::as_str) {
            Some("reasoning") => {
                let (config_id, descriptor) = if let Some(descriptor) =
                    options.iter().find(|option| {
                        option.get("category").and_then(Value::as_str) == Some("model_option")
                            && option.get("id").and_then(Value::as_str) == Some("effort")
                    }) {
                    ("effort", descriptor)
                } else {
                    (
                        "reasoning",
                        expected_config_option(options, "reasoning", "thought_level")?,
                    )
                };
                ensure_select_config_option(descriptor, config_id)?;
                let value = match update.get("value") {
                    Some(Value::String(value)) if value == "xhigh" => json!("extra-high"),
                    Some(Value::String(value)) => json!(value),
                    None => return Err("Cursor reasoning option is missing a value".to_owned()),
                    _ => return Err("Cursor reasoning option must be a string".to_owned()),
                };
                ensure_advertised_value(descriptor, &value, config_id)?;
                (config_id, value)
            }
            Some("contextWindow") => {
                let descriptor = expected_config_option(options, "context", "model_config")?;
                ensure_select_config_option(descriptor, "context")?;
                let value = update
                    .get("value")
                    .and_then(Value::as_str)
                    .map(|value| json!(value))
                    .ok_or_else(|| "Cursor context window option is missing a value".to_owned())?;
                ensure_advertised_value(descriptor, &value, "context")?;
                ("context", value)
            }
            Some("fastMode") => {
                let descriptor = expected_config_option(options, "fast", "model_config")?;
                ensure_select_config_option(descriptor, "fast")?;
                let value = update
                    .get("value")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "Cursor fast mode must be boolean".to_owned())?;
                let value = json!(value.to_string());
                ensure_advertised_value(descriptor, &value, "fast")?;
                ("fast", value)
            }
            Some("thinking") => {
                let descriptor = expected_config_option(options, "thinking", "model_config")?;
                ensure_select_config_option(descriptor, "thinking")?;
                let value = update
                    .get("value")
                    .and_then(Value::as_bool)
                    .map(|value| json!(value.to_string()))
                    .ok_or_else(|| "Cursor thinking option is missing a value".to_owned())?;
                ensure_advertised_value(descriptor, &value, "thinking")?;
                ("thinking", value)
            }
            Some(id) => return Err(format!("Cursor does not support option {id}")),
            None => return Err("Cursor option is missing an id".to_owned()),
        };
        resolved.push(json!({ "configId": config_id, "value": value }));
    }
    Ok(resolved)
}

pub fn resolve_acp_config_updates_with_baseline(
    options: &Value,
    baseline: &Value,
    updates: &Value,
) -> Result<Vec<Value>, String> {
    let mut resolved = resolve_acp_config_updates(options, updates)?;
    let requested_config_ids = resolved
        .iter()
        .filter_map(|update| {
            update
                .get("configId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    let baseline = baseline
        .as_array()
        .ok_or_else(|| "Cursor session did not advertise baseline config options".to_owned())?;

    for (config_id, category) in supported_baseline_config_options(baseline) {
        if requested_config_ids
            .iter()
            .any(|requested| requested == config_id)
        {
            continue;
        }
        let descriptor = expected_config_option(baseline, config_id, category)?;
        ensure_select_config_option(descriptor, config_id)?;
        let baseline_value = acp_config_option_baseline_value(baseline, config_id)?;
        ensure_advertised_value(descriptor, &baseline_value, config_id)?;
        let current_value = acp_config_option_current_value(options, config_id)?;
        if current_value != baseline_value {
            resolved.push(json!({ "configId": config_id, "value": baseline_value }));
        }
    }

    Ok(resolved)
}

pub fn resolve_acp_default_model_config(options: &Value) -> Result<(String, Value), String> {
    let options = options
        .as_array()
        .ok_or_else(|| "Cursor session did not advertise config options".to_owned())?;
    let descriptor = options
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))
        .ok_or_else(|| "Cursor session did not advertise a model config option".to_owned())?;
    let config_id = descriptor
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Cursor model config option is missing an id".to_owned())?;
    let value = descriptor
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|option| option.get("isDefault") == Some(&Value::Bool(true)))
        .and_then(advertised_option_value)
        .filter(|value| !value.is_null())
        .or_else(|| {
            descriptor
                .get("currentValue")
                .filter(|value| !value.is_null())
                .cloned()
        })
        .ok_or_else(|| {
            format!(
                "Cursor model config option {config_id} has no advertised default or current value"
            )
        })?;
    Ok((config_id, value))
}

pub fn acp_config_option_current_value(options: &Value, config_id: &str) -> Result<Value, String> {
    let options = options
        .as_array()
        .ok_or_else(|| "Cursor session did not advertise config options".to_owned())?;
    let descriptor = options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
        .ok_or_else(|| format!("Cursor session did not advertise config option {config_id}"))?;
    descriptor
        .get("currentValue")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            descriptor
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|option| option.get("isDefault") == Some(&Value::Bool(true)))
                .and_then(advertised_option_value)
        })
        .ok_or_else(|| format!("Cursor config option {config_id} has no current or default value"))
}

fn supported_baseline_config_options(options: &[Value]) -> Vec<(&'static str, &'static str)> {
    let mut supported = Vec::new();
    if options.iter().any(|option| {
        option.get("id").and_then(Value::as_str) == Some("effort")
            && option.get("category").and_then(Value::as_str) == Some("model_option")
    }) {
        supported.push(("effort", "model_option"));
    } else if options.iter().any(|option| {
        option.get("id").and_then(Value::as_str) == Some("reasoning")
            && option.get("category").and_then(Value::as_str) == Some("thought_level")
    }) {
        supported.push(("reasoning", "thought_level"));
    }
    for config_id in ["context", "fast", "thinking"] {
        if options.iter().any(|option| {
            option.get("id").and_then(Value::as_str) == Some(config_id)
                && option.get("category").and_then(Value::as_str) == Some("model_config")
        }) {
            supported.push((config_id, "model_config"));
        }
    }
    supported
}

fn acp_config_option_baseline_value(options: &[Value], config_id: &str) -> Result<Value, String> {
    let descriptor = options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
        .ok_or_else(|| format!("Cursor session did not advertise config option {config_id}"))?;
    descriptor
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|option| option.get("isDefault") == Some(&Value::Bool(true)))
        .and_then(advertised_option_value)
        .or_else(|| {
            descriptor
                .get("currentValue")
                .filter(|value| !value.is_null())
                .cloned()
        })
        .ok_or_else(|| {
            format!("Cursor config option {config_id} has no advertised default or current value")
        })
}

fn expected_config_option<'a>(
    options: &'a [Value],
    config_id: &str,
    category: &str,
) -> Result<&'a Value, String> {
    let descriptor = options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
        .ok_or_else(|| format!("Cursor session did not advertise config option {config_id}"))?;
    if descriptor.get("category").and_then(Value::as_str) != Some(category) {
        return Err(format!(
            "Cursor config option {config_id} has an unsupported category"
        ));
    }
    Ok(descriptor)
}

fn ensure_select_config_option(descriptor: &Value, config_id: &str) -> Result<(), String> {
    if descriptor.get("type").and_then(Value::as_str) != Some("select") {
        return Err(format!(
            "Cursor config option {config_id} has an unsupported type"
        ));
    }
    if advertised_values(descriptor).is_empty() {
        return Err(format!(
            "Cursor config option {config_id} has no advertised values"
        ));
    }
    Ok(())
}

fn ensure_advertised_value(
    descriptor: &Value,
    value: &Value,
    config_id: &str,
) -> Result<(), String> {
    if advertised_values(descriptor)
        .iter()
        .any(|candidate| candidate == value)
    {
        Ok(())
    } else {
        Err(format!(
            "Cursor config option {config_id} does not advertise the requested value"
        ))
    }
}

fn advertised_values(descriptor: &Value) -> Vec<Value> {
    descriptor
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(advertised_option_value)
        .collect()
}

fn advertised_option_value(option: &Value) -> Option<Value> {
    option
        .get("value")
        .or_else(|| option.get("id"))
        .cloned()
        .or_else(|| option.is_string().then(|| option.clone()))
}

pub fn discover_models_from_list_available_models(
    response: &Value,
    custom_models: &[String],
) -> Result<Vec<CursorProviderModel>, String> {
    let models = response
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "cursor/list_available_models response missing models".to_owned())?;
    let mut discovered = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for model in models {
        let slug = model
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| "cursor model missing value".to_owned())?;
        let name = model.get("name").and_then(Value::as_str).unwrap_or(slug);
        discovered.push(CursorProviderModel {
            slug: resolve_acp_base_model_id(slug),
            name: name.to_owned(),
            is_custom: false,
            capabilities: build_capabilities_from_config_options(&json!(
                model
                    .get("configOptions")
                    .cloned()
                    .unwrap_or(Value::Array(Vec::new()))
            )),
        });
        seen.insert(resolve_acp_base_model_id(slug));
    }
    for custom in custom_models {
        let trimmed = custom.trim();
        if trimmed.is_empty() || seen.contains(trimmed) {
            continue;
        }
        discovered.push(CursorProviderModel {
            slug: trimmed.to_owned(),
            name: trimmed.to_owned(),
            is_custom: true,
            capabilities: json!({ "optionDescriptors": [] }),
        });
    }
    Ok(discovered)
}

fn select_descriptor(id: &str, label: &str, options: Vec<Value>, current: Option<&str>) -> Value {
    json!({
        "id": id,
        "label": label,
        "type": "select",
        "options": options.into_iter().map(|option| {
            let value = option.get("value").and_then(Value::as_str).unwrap_or_default();
            let name = option.get("name").and_then(Value::as_str).unwrap_or(value);
            let normalized_id = match value {
                "extra-high" => "xhigh",
                other => other,
            };
            if Some(value) == current {
                json!({ "id": normalized_id, "label": name, "isDefault": true })
            } else {
                json!({ "id": normalized_id, "label": name })
            }
        }).collect::<Vec<_>>(),
    })
}

fn boolean_descriptor(id: &str, label: &str, current: Option<&Value>) -> Value {
    let current_value = match current {
        Some(Value::Bool(value)) => Some(*value),
        Some(Value::String(value)) => Some(value == "true"),
        _ => None,
    };
    match current_value {
        Some(value) => json!({
            "id": id,
            "label": label,
            "type": "boolean",
            "currentValue": value,
        }),
        None => json!({
            "id": id,
            "label": label,
            "type": "boolean",
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_and_model_fallbacks_cover_cursor_payload_boundaries() {
        let failed = parse_about_output(1, "grok-cli 1.2.3\n", "failure");
        assert_eq!(failed.version.as_deref(), Some("1.2.3"));
        assert_eq!(failed.status, "error");

        let authenticated = parse_about_output(
            0,
            r#"{"cliVersion":"2.0.0","userEmail":"user@example.test","subscriptionTier":"pro"}"#,
            "",
        );
        assert_eq!(authenticated.auth["type"], "pro");
        assert_eq!(authenticated.status, "ready");

        let unauthenticated = parse_about_output(
            0,
            r#"{"cliVersion":"2.0.0","userEmail":"Not logged in"}"#,
            "",
        );
        assert_eq!(unauthenticated.auth["status"], "unauthenticated");

        let text = parse_about_output(0, "CLI Version 3.0.0\nUser Email user@example.test\n", "");
        assert_eq!(text.version.as_deref(), Some("3.0.0"));
        assert_eq!(text.auth["email"], "user@example.test");

        assert!(discover_models_from_list_available_models(&json!({}), &[]).is_err());
        assert!(discover_models_from_list_available_models(&json!({"models":[{}]}), &[]).is_err());
        let models = discover_models_from_list_available_models(
            &json!({"models":[{"value":"model[fast]"}]}),
            &[" ".to_owned(), "model".to_owned(), "custom".to_owned()],
        )
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "model[fast]");
        assert_eq!(models[1].slug, "custom");
    }
}
