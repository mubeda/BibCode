#![cfg_attr(test, allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::provider::{
    RefusedOption, model_unavailable_refusal, option_needs_value_refusal, option_on_or_off_refusal,
    option_without_id_refusal, unsupported_option_refusal,
};

/// BiBCode's labels for Cursor's options, used when the session gives an option no name of its
/// own. The option descriptors show them, and the refusal for an option names it the same way.
pub(crate) const REASONING_LABEL: &str = "Reasoning";
pub(crate) const CONTEXT_LABEL: &str = "Context";
pub(crate) const FAST_LABEL: &str = "Fast";
pub(crate) const THINKING_LABEL: &str = "Thinking";

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

/// A bracketed model value's base and its `key=value` parameters, such as
/// `gpt-5.4[context=272k,reasoning=medium]`; `None` for a plain value.
fn bracketed_model_value(value: &str) -> Option<(&str, Vec<(&str, &str)>)> {
    let (base, rest) = value.split_once('[')?;
    let params = rest
        .strip_suffix(']')?
        .split(',')
        .filter_map(|param| param.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect();
    Some((base.trim(), params))
}

/// The session's model config option.
pub fn acp_model_descriptor(options: &[Value]) -> Option<&Value> {
    options
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))
}

/// The model values a `session/new` or `session/load` answer advertises.
pub fn advertised_model_values(session: &Value) -> Vec<String> {
    session
        .get("configOptions")
        .and_then(Value::as_array)
        .and_then(|options| acp_model_descriptor(options))
        .map(|descriptor| {
            advertised_values(descriptor)
                .into_iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the session folds a model's options into its model values, as Cursor CLIs since
/// 2026.11 do (`gpt-5.4-nano[reasoning=medium]`), instead of advertising them as options.
pub fn acp_model_values_are_bracketed(options: &[Value]) -> bool {
    acp_model_descriptor(options).is_some_and(|descriptor| {
        advertised_values(descriptor)
            .iter()
            .any(|value| value.as_str().is_some_and(|value| value.contains('[')))
    })
}

/// The advertised model value for the chosen `model`: the value itself when advertised, otherwise
/// the value whose base is `model` (the inventory publishes bases), the session's current one
/// first. A model the session does not advertise is refused, so BiBCode never sends a value the
/// CLI did not offer; an option listing no values advertises only its current value.
pub fn resolve_advertised_model_value(
    descriptor: &Value,
    model: &str,
) -> Result<Value, RefusedOption> {
    let current = descriptor.get("currentValue");
    let mut advertised = advertised_values(descriptor);
    if advertised.is_empty() {
        advertised.extend(current.cloned());
    }
    let model = model.trim();
    if advertised.iter().any(|value| value.as_str() == Some(model)) {
        return Ok(json!(model));
    }
    let base_of = |value: &Value| value.as_str().map(resolve_acp_base_model_id);
    current
        .filter(|current| {
            advertised.contains(current) && base_of(current).as_deref() == Some(model)
        })
        .cloned()
        .or_else(|| {
            advertised
                .iter()
                .find(|value| base_of(value).as_deref() == Some(model))
                .cloned()
        })
        .ok_or_else(|| {
            RefusedOption::new(
                format!("Cursor session does not advertise model {model}"),
                model_unavailable_refusal(model, "Cursor"),
            )
        })
}

/// A turn's options checked against a session that folds options into its model values: the
/// advertised value with the current model's base whose parameters hold every requested option,
/// the current value first. `Ok(None)` when the current value already holds them, `Ok(Some)` with
/// the value to switch to otherwise. An option the turn leaves out goes back to the model's
/// `baseline` value, as a session with separate options resets it. An option no advertised value
/// of the model holds is refused: BiBCode never composes a value the CLI did not offer.
pub fn resolve_bracketed_model_options(
    descriptor: &Value,
    updates: &Value,
    baseline: Option<&str>,
) -> Result<Option<Value>, RefusedOption> {
    let Some(updates) = updates.as_array() else {
        return Err(RefusedOption::unusable(
            "Cursor option updates must be an array",
        ));
    };
    let current = descriptor
        .get("currentValue")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RefusedOption::unusable("Cursor model config option has no current value")
        })?;
    let base = resolve_acp_base_model_id(current);
    let mut wanted = Vec::new();
    for update in updates {
        let (keys, label, value): (&[&str], &str, String) =
            match update.get("id").and_then(Value::as_str) {
                Some("reasoning") => (
                    REASONING_KEYS,
                    REASONING_LABEL,
                    update
                        .get("value")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            RefusedOption::new(
                                "Cursor reasoning option must be a string",
                                option_needs_value_refusal(REASONING_LABEL),
                            )
                        })?
                        .to_owned(),
                ),
                Some("contextWindow") => (
                    &["context"],
                    CONTEXT_LABEL,
                    update
                        .get("value")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            RefusedOption::new(
                                "Cursor context window option is missing a value",
                                option_needs_value_refusal(CONTEXT_LABEL),
                            )
                        })?
                        .to_owned(),
                ),
                Some(id @ ("fastMode" | "thinking")) => {
                    let label = if id == "fastMode" {
                        FAST_LABEL
                    } else {
                        THINKING_LABEL
                    };
                    let value = update
                        .get("value")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| {
                            RefusedOption::new(
                                format!("Cursor {id} option must be boolean"),
                                option_on_or_off_refusal(label),
                            )
                        })?;
                    let keys: &[&str] = if id == "fastMode" {
                        &["fast"]
                    } else {
                        &["thinking"]
                    };
                    (keys, label, value.to_string())
                }
                Some(id) => {
                    return Err(RefusedOption::new(
                        format!("Cursor does not support option {id}"),
                        unsupported_option_refusal(id),
                    ));
                }
                None => {
                    return Err(RefusedOption::new(
                        "Cursor option is missing an id",
                        option_without_id_refusal(),
                    ));
                }
            };
        wanted.push((keys, label, value));
    }
    let baseline = baseline.filter(|baseline| resolve_acp_base_model_id(baseline) == base);
    let candidates = baseline
        .into_iter()
        .map(str::to_owned)
        .chain(std::iter::once(current.to_owned()))
        .chain(
            advertised_values(descriptor)
                .into_iter()
                .filter_map(|value| value.as_str().map(str::to_owned)),
        )
        .filter(|value| resolve_acp_base_model_id(value) == base)
        .collect::<Vec<_>>();
    let holds = |value: &str, (keys, _, wanted): &(&[&str], &str, String)| {
        bracketed_model_value(value).is_some_and(|(_, params)| {
            params.iter().any(|(key, value)| {
                keys.contains(key)
                    && (value == wanted || (wanted == "xhigh" && *value == "extra-high"))
            })
        })
    };
    // Every option the turn leaves out keeps the baseline's value, when an advertised value can.
    let keeps_baseline = |value: &str| {
        let (Some((_, own)), Some((_, base_params))) = (
            bracketed_model_value(value),
            baseline.and_then(bracketed_model_value),
        ) else {
            return true;
        };
        base_params.iter().all(|(key, base_value)| {
            wanted.iter().any(|(keys, _, _)| keys.contains(key))
                || own.contains(&(*key, *base_value))
        })
    };
    let holds_all = |value: &&String| wanted.iter().all(|option| holds(value, option));
    if let Some(value) = candidates
        .iter()
        .filter(holds_all)
        .find(|value| keeps_baseline(value))
        .or_else(|| candidates.iter().find(holds_all))
    {
        return Ok((value != current).then(|| json!(value)));
    }
    // Name the first option no value of the model holds: unknown to the model, or not this value.
    let (keys, label, value) = wanted
        .iter()
        .find(|option| !candidates.iter().any(|value| holds(value, option)))
        .unwrap_or(&wanted[0]);
    let known = candidates.iter().any(|candidate| {
        bracketed_model_value(candidate)
            .is_some_and(|(_, params)| params.iter().any(|(key, _)| keys.contains(key)))
    });
    let option = if !known || matches!(*label, FAST_LABEL | THINKING_LABEL) {
        (*label).to_owned()
    } else {
        format!("{label} {value}")
    };
    Err(RefusedOption::new(
        format!("Cursor session does not advertise {base} with {label} {value}"),
        unsupported_option_refusal(&option),
    ))
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
            // Cursor lists Thinking as a `thought_level` too; it is the on/off option below.
            options.iter().find(|option| {
                option.get("category").and_then(Value::as_str) == Some("thought_level")
                    && option.get("id").and_then(Value::as_str) != Some("thinking")
            })
        });
    if let Some(reasoning) = reasoning_source {
        descriptors.push(select_descriptor(
            "reasoning",
            reasoning
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(REASONING_LABEL),
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
                    .unwrap_or(CONTEXT_LABEL),
                option
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                option.get("currentValue").and_then(Value::as_str),
            )),
            (Some("model_config"), Some("fast")) => descriptors.push(boolean_descriptor(
                "fastMode",
                option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(FAST_LABEL),
                option.get("currentValue"),
            )),
            (Some("model_config" | "thought_level"), Some("thinking")) => {
                descriptors.push(boolean_descriptor(
                    "thinking",
                    option
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(THINKING_LABEL),
                    option.get("currentValue"),
                ))
            }
            _ => {}
        }
    }
    json!({ "optionDescriptors": descriptors })
}

/// Resolves a turn's options into Cursor config updates, checked against what the session
/// advertises. A refusal names the option by the label the option descriptors show: the session's
/// own name for it, or BiBCode's default. A problem with the request, such as an option or value
/// the session does not advertise, gets its own sentence. A session configuration BiBCode can't
/// work with, such as an advertised option of an unexpected category or type, gets the generic
/// sentence of [`RefusedOption::unusable`]: a relaunch advertises the same configuration, and the
/// protocol detail is nothing the user can act on.
pub fn resolve_acp_config_updates(
    options: &Value,
    updates: &Value,
) -> Result<Vec<Value>, RefusedOption> {
    let Some(options) = options.as_array() else {
        return Err(RefusedOption::unusable(
            "Cursor session did not advertise config options",
        ));
    };
    let Some(updates) = updates.as_array() else {
        return Err(RefusedOption::unusable(
            "Cursor option updates must be an array",
        ));
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
                        requested_config_option(
                            options,
                            "reasoning",
                            "thought_level",
                            REASONING_LABEL,
                        )?,
                    )
                };
                let label = option_label(descriptor, REASONING_LABEL);
                ensure_select_config_option(descriptor, config_id)
                    .map_err(RefusedOption::unusable)?;
                let (requested, value) = match update.get("value") {
                    Some(Value::String(value)) if value == "xhigh" => (value, json!("extra-high")),
                    Some(Value::String(value)) => (value, json!(value)),
                    None => {
                        return Err(RefusedOption::new(
                            "Cursor reasoning option is missing a value",
                            option_needs_value_refusal(label),
                        ));
                    }
                    _ => {
                        return Err(RefusedOption::new(
                            "Cursor reasoning option must be a string",
                            option_needs_value_refusal(label),
                        ));
                    }
                };
                ensure_requested_value(
                    descriptor,
                    &value,
                    config_id,
                    &format!("{label} {requested}"),
                )?;
                (config_id, value)
            }
            Some("contextWindow") => {
                let descriptor =
                    requested_config_option(options, "context", "model_config", CONTEXT_LABEL)?;
                let label = option_label(descriptor, CONTEXT_LABEL);
                ensure_select_config_option(descriptor, "context")
                    .map_err(RefusedOption::unusable)?;
                let requested = update.get("value").and_then(Value::as_str).ok_or_else(|| {
                    RefusedOption::new(
                        "Cursor context window option is missing a value",
                        option_needs_value_refusal(label),
                    )
                })?;
                let value = json!(requested);
                ensure_requested_value(
                    descriptor,
                    &value,
                    "context",
                    &format!("{label} {requested}"),
                )?;
                ("context", value)
            }
            Some("fastMode") => {
                let descriptor =
                    requested_config_option(options, "fast", "model_config", FAST_LABEL)?;
                let label = option_label(descriptor, FAST_LABEL);
                ensure_select_config_option(descriptor, "fast").map_err(RefusedOption::unusable)?;
                let value = update
                    .get("value")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        RefusedOption::new(
                            "Cursor fast mode must be boolean",
                            option_on_or_off_refusal(label),
                        )
                    })?;
                let value = json!(value.to_string());
                ensure_requested_value(descriptor, &value, "fast", label)?;
                ("fast", value)
            }
            Some("thinking") => {
                let descriptor =
                    requested_config_option(options, "thinking", "model_config", THINKING_LABEL)?;
                let label = option_label(descriptor, THINKING_LABEL);
                ensure_select_config_option(descriptor, "thinking")
                    .map_err(RefusedOption::unusable)?;
                let value = update
                    .get("value")
                    .and_then(Value::as_bool)
                    .map(|value| json!(value.to_string()))
                    .ok_or_else(|| {
                        RefusedOption::new(
                            "Cursor thinking option is missing a value",
                            option_on_or_off_refusal(label),
                        )
                    })?;
                ensure_requested_value(descriptor, &value, "thinking", label)?;
                ("thinking", value)
            }
            Some(id) => {
                return Err(RefusedOption::new(
                    format!("Cursor does not support option {id}"),
                    unsupported_option_refusal(id),
                ));
            }
            None => {
                return Err(RefusedOption::new(
                    "Cursor option is missing an id",
                    option_without_id_refusal(),
                ));
            }
        };
        resolved.push(json!({ "configId": config_id, "value": value }));
    }
    Ok(resolved)
}

/// [`resolve_acp_config_updates`], plus the updates that restore every supported option the turn
/// leaves out to the session's baseline. Restoring depends only on the session's configuration,
/// so a failure there is a configuration BiBCode can't work with.
pub fn resolve_acp_config_updates_with_baseline(
    options: &Value,
    baseline: &Value,
    updates: &Value,
) -> Result<Vec<Value>, RefusedOption> {
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
    let baseline = baseline.as_array().ok_or_else(|| {
        RefusedOption::unusable("Cursor session did not advertise baseline config options")
    })?;

    for (config_id, category) in supported_baseline_config_options(baseline) {
        if requested_config_ids
            .iter()
            .any(|requested| requested == config_id)
        {
            continue;
        }
        let descriptor = expected_config_option(baseline, config_id, category)
            .map_err(RefusedOption::unusable)?;
        ensure_select_config_option(descriptor, config_id).map_err(RefusedOption::unusable)?;
        let baseline_value = acp_config_option_baseline_value(baseline, config_id)
            .map_err(RefusedOption::unusable)?;
        ensure_advertised_value(descriptor, &baseline_value, config_id)
            .map_err(RefusedOption::unusable)?;
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
    let value = advertised_auto_model_value(descriptor)
        .or_else(|| {
            descriptor
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|option| option.get("isDefault") == Some(&Value::Bool(true)))
                .and_then(advertised_option_value)
        })
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

/// Cursor's own Auto model as the session advertises it (`default[]` since 2026.11), so Auto never
/// means the model the CLI last remembered as current.
pub fn advertised_auto_model_value(descriptor: &Value) -> Option<Value> {
    advertised_values(descriptor).into_iter().find(|value| {
        value
            .as_str()
            .is_some_and(|value| resolve_acp_base_model_id(value) == "default")
    })
}

/// The session's current value for an option it advertises, or its advertised default. Its
/// absence is a session configuration BiBCode can't work with.
pub fn acp_config_option_current_value(
    options: &Value,
    config_id: &str,
) -> Result<Value, RefusedOption> {
    let options = options.as_array().ok_or_else(|| {
        RefusedOption::unusable("Cursor session did not advertise config options")
    })?;
    let descriptor = options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
        .ok_or_else(|| {
            RefusedOption::unusable(format!(
                "Cursor session did not advertise config option {config_id}"
            ))
        })?;
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
        .ok_or_else(|| {
            RefusedOption::unusable(format!(
                "Cursor config option {config_id} has no current or default value"
            ))
        })
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

/// The descriptor of an option the turn requests. The session not advertising it refuses the
/// request, naming the option by `label`; an advertised option of another category is a
/// configuration BiBCode can't work with.
fn requested_config_option<'a>(
    options: &'a [Value],
    config_id: &str,
    category: &str,
    label: &str,
) -> Result<&'a Value, RefusedOption> {
    let descriptor = options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
        .ok_or_else(|| {
            RefusedOption::new(
                format!("Cursor session did not advertise config option {config_id}"),
                unsupported_option_refusal(label),
            )
        })?;
    if descriptor.get("category").and_then(Value::as_str) != Some(category) {
        return Err(RefusedOption::unusable(format!(
            "Cursor config option {config_id} has an unsupported category"
        )));
    }
    Ok(descriptor)
}

/// The label the option descriptors show for an advertised option: the session's name for it, or
/// BiBCode's `default`.
fn option_label<'a>(descriptor: &'a Value, default: &'a str) -> &'a str {
    descriptor
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(default)
}

/// Refuses a requested value the session does not advertise, naming it as `option`.
fn ensure_requested_value(
    descriptor: &Value,
    value: &Value,
    config_id: &str,
    option: &str,
) -> Result<(), RefusedOption> {
    ensure_advertised_value(descriptor, value, config_id)
        .map_err(|detail| RefusedOption::new(detail, unsupported_option_refusal(option)))
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
    discover_models_with_advertised_values(response, custom_models, &[])
}

/// The models `cursor/list_available_models` lists, narrowed to what a session advertises.
/// When the session folds options into bracketed model values, a model is published only with
/// the option values some advertised value of its base carries, so the picker cannot offer a
/// combination the runtime refuses; a model or custom model the session does not offer is left
/// out. Plain advertised values, or none (the session could not be read), publish the list as is.
pub fn discover_models_with_advertised_values(
    response: &Value,
    custom_models: &[String],
    advertised: &[String],
) -> Result<Vec<CursorProviderModel>, String> {
    let models = response
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "cursor/list_available_models response missing models".to_owned())?;
    let bracketed = advertised
        .iter()
        .filter_map(|value| bracketed_model_value(value))
        .collect::<Vec<_>>();
    let mut discovered = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for model in models {
        let slug = model
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| "cursor model missing value".to_owned())?;
        let name = model.get("name").and_then(Value::as_str).unwrap_or(slug);
        let base = resolve_acp_base_model_id(slug);
        let config_options = model
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let config_options = if bracketed.is_empty() {
            config_options
        } else {
            let carriers = bracketed
                .iter()
                .filter(|(carrier, _)| *carrier == base)
                .map(|(_, params)| params.as_slice())
                .collect::<Vec<_>>();
            if carriers.is_empty() {
                // A plain advertised value keeps its model, with no option a bracketed session
                // could apply to it.
                if !advertised.contains(&base) {
                    continue;
                }
                Vec::new()
            } else {
                narrow_config_options(config_options, &carriers)
            }
        };
        discovered.push(CursorProviderModel {
            slug: base.clone(),
            name: name.to_owned(),
            is_custom: false,
            capabilities: build_capabilities_from_config_options(&Value::Array(config_options)),
        });
        seen.insert(base);
    }
    for custom in custom_models {
        let trimmed = custom.trim();
        if trimmed.is_empty() || seen.contains(trimmed) {
            continue;
        }
        let offered = bracketed.is_empty()
            || advertised
                .iter()
                .any(|value| value == trimmed || resolve_acp_base_model_id(value) == trimmed);
        if !offered {
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

/// Bracket keys that all mean Reasoning, as the runtime reads them.
const REASONING_KEYS: &[&str] = &["reasoning", "effort", "reasoning_effort"];

/// Whether a bracket parameter carries an option's value, with the aliases the runtime accepts.
fn carries(params: &[(&str, &str)], id: &str, value: &str) -> bool {
    params.iter().any(|(key, carried)| {
        (*key == id || (REASONING_KEYS.contains(key) && REASONING_KEYS.contains(&id)))
            && (*carried == value
                || matches!(
                    (*carried, value),
                    ("extra-high", "xhigh") | ("xhigh", "extra-high")
                ))
    })
}

/// A model's listed options, each keeping only the values one of its advertised bracketed values
/// carries under the option's id (the bracket keys are the CLI's option ids). An option no value
/// carries is dropped, as is an on/off option left with one state, which a toggle cannot show.
/// The picker sets each option on its own, so only the largest set of options whose every
/// combination some advertised value holds is published; the runtime reads an omitted option as
/// no constraint. A narrowed option's current value is one it keeps.
fn narrow_config_options(options: Vec<Value>, carriers: &[&[(&str, &str)]]) -> Vec<Value> {
    let narrowed = options
        .into_iter()
        .filter_map(|mut option| {
            let id = option.get("id").and_then(Value::as_str)?.to_owned();
            let carried = |value: &str| carriers.iter().any(|params| carries(params, &id, value));
            let kept = option
                .get("options")
                .and_then(Value::as_array)?
                .iter()
                .filter(|choice| {
                    choice
                        .get("value")
                        .and_then(Value::as_str)
                        .is_some_and(carried)
                })
                .cloned()
                .collect::<Vec<_>>();
            let on_off = kept.iter().all(|choice| {
                matches!(
                    choice.get("value").and_then(Value::as_str),
                    Some("true" | "false")
                )
            });
            if kept.is_empty() || (on_off && kept.len() < 2) {
                return None;
            }
            let current = option.get("currentValue").and_then(Value::as_str);
            if !current.is_some_and(carried) {
                option["currentValue"] = kept[0]["value"].clone();
            }
            option["options"] = Value::Array(kept);
            Some(option)
        })
        .collect::<Vec<_>>();
    let choices = |option: &Value| -> Vec<(String, String)> {
        let id = option["id"].as_str().unwrap_or_default().to_owned();
        option["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|choice| choice.get("value").and_then(Value::as_str))
            .map(|value| (id.clone(), value.to_owned()))
            .collect()
    };
    let every_combination_advertised = |subset: &[&Value]| {
        let mut combinations = vec![Vec::<(String, String)>::new()];
        for option in subset {
            combinations = combinations
                .into_iter()
                .flat_map(|combination| {
                    choices(option).into_iter().map(move |choice| {
                        let mut next = combination.clone();
                        next.push(choice);
                        next
                    })
                })
                .collect();
        }
        combinations.iter().all(|combination| {
            carriers.iter().any(|params| {
                combination
                    .iter()
                    .all(|(id, value)| carries(params, id, value))
            })
        })
    };
    // Largest first, earlier options first among sets of one size; a model has a handful.
    let count = narrowed.len();
    let mut masks = (0..1u32 << count).collect::<Vec<_>>();
    masks.sort_by_key(|mask| {
        (
            std::cmp::Reverse(mask.count_ones()),
            std::cmp::Reverse(mask.reverse_bits()),
        )
    });
    masks
        .into_iter()
        .map(|mask| {
            narrowed
                .iter()
                .enumerate()
                .filter(|(index, _)| mask & (1 << index) != 0)
                .map(|(_, option)| option)
                .collect::<Vec<_>>()
        })
        .find(|subset| every_combination_advertised(subset))
        .map(|subset| subset.into_iter().cloned().collect())
        .unwrap_or_default()
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

    /// `cursor/list_available_models` of `cursor-agent` 2026.11 lists Thinking as a
    /// `thought_level` beside the effort: it stays the on/off option, not the reasoning select.
    #[test]
    fn thinking_listed_as_a_thought_level_stays_an_on_off_option() {
        let capabilities = build_capabilities_from_config_options(&json!([
            { "id": "thinking", "category": "thought_level", "type": "select", "name": "Thinking",
              "currentValue": "true", "options": [{ "value": "false" }, { "value": "true" }] },
            { "id": "effort", "category": "thought_level", "type": "select", "name": "Effort",
              "currentValue": "high",
              "options": [{ "value": "low" }, { "value": "high" }, { "value": "xhigh" }] },
            { "id": "fast", "category": "model_config", "type": "select", "name": "Fast",
              "currentValue": "false", "options": [{ "value": "false" }, { "value": "true" }] }
        ]));
        let descriptors = capabilities["optionDescriptors"].as_array().unwrap();
        let ids = descriptors
            .iter()
            .map(|descriptor| {
                (
                    descriptor["id"].as_str().unwrap(),
                    descriptor["type"].as_str().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                ("reasoning", "select"),
                ("thinking", "boolean"),
                ("fastMode", "boolean")
            ]
        );
        assert_eq!(descriptors[0]["label"], "Effort");
        assert_eq!(descriptors[0]["options"][2]["id"], "xhigh");
        assert_eq!(descriptors[1]["currentValue"], true);
    }

    /// The shapes `cursor-agent` 2026.11 lists and advertises: the picker gets only the option
    /// values an advertised value carries, never a combination the runtime would refuse.
    #[test]
    fn bracketed_sessions_narrow_the_published_options_to_advertised_values() {
        let select = |id: &str, category: &str, current: &str, values: &[&str]| {
            json!({
                "id": id, "category": category, "type": "select", "currentValue": current,
                "options": values.iter().map(|value| json!({ "value": value, "name": value }))
                    .collect::<Vec<_>>()
            })
        };
        let list = json!({ "models": [
            { "value": "default", "name": "Auto", "configOptions": [] },
            { "value": "grok-4.7", "name": "Grok 4.7", "configOptions": [
                select("context", "model_config", "256k", &["256k", "500k"]),
                select("reasoning_effort", "thought_level", "high", &["low", "high", "xhigh"]),
                select("fast", "model_config", "true", &["false", "true"])
            ] },
            { "value": "claude-sonnet-4", "name": "Claude Sonnet 4", "configOptions": [
                select("thinking", "thought_level", "false", &["false", "true"])
            ] },
            { "value": "unadvertised", "name": "Unadvertised", "configOptions": [] }
        ] });
        let advertised = [
            "default[]",
            "grok-4.7[context=256k,reasoning_effort=high,fast=true]",
            "grok-4.7[context=256k,reasoning_effort=low,fast=false]",
            "claude-sonnet-4[thinking=false,context=200k]",
        ]
        .map(str::to_owned);
        let custom = [
            "claude-sonnet-4".to_owned(),
            "mine".to_owned(),
            "grok-4.7".to_owned(),
        ];
        let models = discover_models_with_advertised_values(&list, &custom, &advertised).unwrap();
        let summary = models
            .iter()
            .map(|model| {
                let options = model.capabilities["optionDescriptors"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|descriptor| {
                        let values = descriptor["options"]
                            .as_array()
                            .map(|options| {
                                options
                                    .iter()
                                    .map(|option| option["id"].as_str().unwrap().to_owned())
                                    .collect::<Vec<_>>()
                                    .join("|")
                            })
                            .unwrap_or_else(|| "on/off".to_owned());
                        format!("{}={values}", descriptor["id"].as_str().unwrap())
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("{} {options}", model.slug)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                "default ",
                "grok-4.7 reasoning=low|high contextWindow=256k",
                "claude-sonnet-4 ",
            ]
        );
        // The custom models the session offers are listed models already; `mine` is not offered.
        assert!(models.iter().all(|model| !model.is_custom));

        // A plain-value session, or none read, publishes the list as before.
        for advertised in [vec![], vec!["grok-4.7".to_owned(), "mine".to_owned()]] {
            let models =
                discover_models_with_advertised_values(&list, &custom, &advertised).unwrap();
            assert_eq!(models.len(), 5, "{advertised:?}");
            assert_eq!(
                models[1].capabilities["optionDescriptors"][0]["options"]
                    .as_array()
                    .unwrap()
                    .len(),
                3
            );
            assert!(models[4].is_custom);
        }
    }

    /// Every combination the picker can build from a bracketed catalog is one the runtime sends:
    /// from any advertised value of the model, each choice resolves to an advertised value.
    #[test]
    fn every_published_combination_resolves_to_an_advertised_value() {
        let select = |id: &str, category: &str, values: &[&str]| {
            json!({
                "id": id, "category": category, "type": "select", "currentValue": values[0],
                "options": values.iter().map(|value| json!({ "value": value })).collect::<Vec<_>>()
            })
        };
        let list = json!({ "models": [
            { "value": "default", "name": "Auto", "configOptions": [] },
            { "value": "m", "name": "M", "configOptions": [
                select("effort", "model_option", &["low", "high", "xhigh"]),
                select("fast", "model_config", &["false", "true"])
            ] },
            { "value": "n", "name": "N", "configOptions": [
                select("reasoning", "thought_level", &["low", "high"]),
                select("context", "model_config", &["200k", "1m"])
            ] }
        ] });
        let advertised = [
            "default",
            "m[effort=low,fast=false]",
            "m[effort=high,fast=true]",
            "m[effort=extra-high,fast=true]",
            "n[reasoning=low,context=200k]",
            "n[reasoning=low,context=1m]",
            "n[reasoning=high,context=200k]",
            "n[reasoning=high,context=1m]",
        ]
        .map(str::to_owned);
        let models = discover_models_with_advertised_values(&list, &[], &advertised).unwrap();
        // A mixed catalog keeps its plain model, with no options to refuse.
        assert_eq!(
            models
                .iter()
                .map(|model| model.slug.as_str())
                .collect::<Vec<_>>(),
            ["default", "m", "n"]
        );
        assert_eq!(models[0].capabilities["optionDescriptors"], json!([]));
        let descriptor = |current: &str| {
            json!({
                "id": "model", "category": "model", "currentValue": current,
                "options": advertised.iter().map(|value| json!({ "value": value })).collect::<Vec<_>>()
            })
        };
        let mut checked = 0;
        for model in &models {
            let mut combinations = vec![Vec::<Value>::new()];
            for option in model.capabilities["optionDescriptors"].as_array().unwrap() {
                let values = option["options"].as_array().map_or_else(
                    || vec![json!(true), json!(false)],
                    |choices| choices.iter().map(|choice| choice["id"].clone()).collect(),
                );
                combinations = combinations
                    .into_iter()
                    .flat_map(|combination| {
                        values.iter().map(move |value| {
                            let mut next = combination.clone();
                            next.push(json!({ "id": option["id"], "value": value }));
                            next
                        })
                    })
                    .collect();
            }
            for current in advertised
                .iter()
                .filter(|value| resolve_acp_base_model_id(value) == model.slug)
            {
                for combination in &combinations {
                    let resolved = resolve_bracketed_model_options(
                        &descriptor(current),
                        &Value::Array(combination.clone()),
                        None,
                    );
                    assert!(
                        resolved.is_ok(),
                        "{} from {current}: {combination:?} -> {resolved:?}",
                        model.slug
                    );
                    checked += 1;
                }
            }
        }
        // m keeps only Reasoning (Fast is not free of it); n keeps both, every pair advertised.
        assert_eq!(
            models[1].capabilities["optionDescriptors"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            models[2].capabilities["optionDescriptors"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(checked > 0);
    }

    #[test]
    fn a_bracketed_model_option_holds_its_folded_in_options() {
        let descriptor = json!({
            "id": "model", "category": "model", "type": "select",
            "currentValue": "m[effort=extra-high,fast=false]",
            "options": [
                { "value": "m[effort=extra-high,fast=false]" },
                { "value": "m[effort=low,fast=true]" },
                { "value": "other[]" }
            ]
        });
        let refusal = |updates: Value| {
            resolve_bracketed_model_options(&descriptor, &updates, None)
                .unwrap_err()
                .refusal
        };
        assert_eq!(
            resolve_bracketed_model_options(
                &descriptor,
                &json!([{ "id": "reasoning", "value": "xhigh" }]),
                None
            )
            .unwrap(),
            None
        );
        // A second advertised value of the same model is chosen when it holds every option.
        assert_eq!(
            resolve_bracketed_model_options(
                &descriptor,
                &json!([{ "id": "reasoning", "value": "low" }, { "id": "fastMode", "value": true }]),
                None
            )
            .unwrap(),
            Some(json!("m[effort=low,fast=true]"))
        );
        // Each option is advertised, but no single value holds both.
        assert_eq!(
            refusal(
                json!([{ "id": "reasoning", "value": "low" }, { "id": "fastMode", "value": false }])
            ),
            "Reasoning low is not supported by the selected model. Choose another option for this model."
        );
        assert_eq!(
            refusal(json!([{ "id": "thinking", "value": true }])),
            "Thinking is not supported by the selected model. Choose another option for this model."
        );
        assert_eq!(
            refusal(json!([{ "id": "unknown", "value": true }])),
            "unknown is not supported by the selected model. Choose another option for this model."
        );
        assert_eq!(
            resolve_advertised_model_value(&descriptor, "other").unwrap(),
            json!("other[]")
        );
        assert_eq!(
            resolve_advertised_model_value(&descriptor, "m").unwrap(),
            json!("m[effort=extra-high,fast=false]")
        );
    }

    /// An option listing no values offers only its current value: any other model is refused,
    /// never sent as typed.
    #[test]
    fn an_option_without_values_refuses_every_model_but_its_current_one() {
        let descriptor =
            json!({ "id": "model", "category": "model", "currentValue": "m", "options": [] });
        assert_eq!(
            resolve_advertised_model_value(&descriptor, "m").unwrap(),
            json!("m")
        );
        assert!(resolve_advertised_model_value(&descriptor, "other").is_err());
        assert!(
            resolve_advertised_model_value(&json!({ "id": "model", "category": "model" }), "x")
                .is_err()
        );
    }
}
