use std::collections::HashSet;

use serde_json::{Value, json};

const MINIMUM_FABLE_5_VERSION: [u64; 3] = [2, 1, 169];
const MINIMUM_OPUS_4_8_VERSION: [u64; 3] = [2, 1, 154];
const MINIMUM_OPUS_4_7_VERSION: [u64; 3] = [2, 1, 111];

pub fn all_models(custom_models: &[String]) -> Vec<Value> {
    with_custom_models(built_in_models(), custom_models)
}

pub fn models_for_version(version: &str, custom_models: &[String]) -> Vec<Value> {
    let parsed = semantic_version(version);
    let models = built_in_models()
        .into_iter()
        .filter(|model| match model["slug"].as_str() {
            Some("claude-fable-5") => supports(parsed, MINIMUM_FABLE_5_VERSION),
            Some("claude-opus-4-8") => supports(parsed, MINIMUM_OPUS_4_8_VERSION),
            Some("claude-opus-4-7") => supports(parsed, MINIMUM_OPUS_4_7_VERSION),
            _ => true,
        })
        .collect();
    with_custom_models(models, custom_models)
}

pub fn models_from_initialization(
    response: &Value,
    custom_models: &[String],
) -> Option<Vec<Value>> {
    let models = response
        .get("models")?
        .as_array()?
        .iter()
        .filter_map(model_from_initialization)
        .collect::<Vec<_>>();
    (!models.is_empty()).then(|| with_custom_models(models, custom_models))
}

fn model_from_initialization(value: &Value) -> Option<Value> {
    let slug = value.get("value")?.as_str()?.trim();
    if slug.is_empty() {
        return None;
    }
    let display_name = value
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(slug);
    let discovered_name = value
        .get("description")
        .and_then(Value::as_str)
        .and_then(|description| description.split('·').next())
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let name = match discovered_name {
        Some(name) if slug.eq_ignore_ascii_case("default") => {
            format!("{display_name} — {name}")
        }
        Some(name) => name.to_owned(),
        None => display_name.to_owned(),
    };
    let mut descriptors = Vec::new();
    if value.get("supportsEffort").and_then(Value::as_bool) == Some(true) {
        let options = value
            .get("supportedEffortLevels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|level| !level.is_empty())
            .map(|level| {
                let label = match level {
                    "low" => "Low",
                    "medium" => "Medium",
                    "high" => "High",
                    "xhigh" => "Extra High",
                    "max" => "Max",
                    _ => level,
                };
                let mut option = json!({ "id": level, "label": label });
                if level == "high" {
                    option["isDefault"] = json!(true);
                }
                option
            })
            .collect::<Vec<_>>();
        if !options.is_empty() {
            descriptors.push(json!({
                "id": "effort",
                "label": "Reasoning",
                "type": "select",
                "options": options,
            }));
        }
    }
    if value.get("supportsFastMode").and_then(Value::as_bool) == Some(true) {
        descriptors.push(boolean_option("fastMode", "Fast Mode"));
    }
    Some(model(slug, &name, descriptors))
}

fn supports(version: Option<[u64; 3]>, minimum: [u64; 3]) -> bool {
    version.is_some_and(|version| version >= minimum)
}

fn semantic_version(value: &str) -> Option<[u64; 3]> {
    value
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .filter(|candidate| !candidate.is_empty())
        .find_map(|candidate| {
            let mut parts = candidate.split('.');
            let version = [
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
            ];
            parts.next().is_none().then_some(version)
        })
}

fn with_custom_models(mut models: Vec<Value>, custom_models: &[String]) -> Vec<Value> {
    let mut slugs = models
        .iter()
        .filter_map(|model| model["slug"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    for slug in custom_models.iter().map(|slug| slug.trim()) {
        if slug.is_empty() || !slugs.insert(slug.to_owned()) {
            continue;
        }
        models.push(json!({
            "slug": slug,
            "name": slug,
            "isCustom": true,
            "capabilities": { "optionDescriptors": [] },
        }));
    }
    models
}

fn built_in_models() -> Vec<Value> {
    vec![
        model(
            "claude-fable-5",
            "Claude Fable 5",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("xhigh", "Extra High", false),
                    ("max", "Max", false),
                    ("ultracode", "Ultracode", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                context_window(),
            ],
        ),
        model(
            "claude-opus-4-8",
            "Claude Opus 4.8",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("xhigh", "Extra High", false),
                    ("max", "Max", false),
                    ("ultracode", "Ultracode", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                boolean_option("fastMode", "Fast Mode"),
            ],
        ),
        model(
            "claude-opus-4-7",
            "Claude Opus 4.7",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", false),
                    ("xhigh", "Extra High", true),
                    ("max", "Max", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                boolean_option("fastMode", "Fast Mode"),
            ],
        ),
        model(
            "claude-opus-4-6",
            "Claude Opus 4.6",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("max", "Max", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                boolean_option("fastMode", "Fast Mode"),
                context_window(),
            ],
        ),
        model(
            "claude-opus-4-5",
            "Claude Opus 4.5",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("max", "Max", false),
                ]),
                boolean_option("fastMode", "Fast Mode"),
            ],
        ),
        model(
            "claude-sonnet-5",
            "Claude Sonnet 5",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("xhigh", "Extra High", false),
                    ("max", "Max", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                context_window(),
            ],
        ),
        model(
            "claude-sonnet-4-6",
            "Claude Sonnet 4.6",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("max", "Max", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                context_window(),
            ],
        ),
        model(
            "claude-haiku-4-5",
            "Claude Haiku 4.5",
            vec![boolean_option("thinking", "Thinking")],
        ),
    ]
}

fn model(slug: &str, name: &str, option_descriptors: Vec<Value>) -> Value {
    json!({
        "slug": slug,
        "name": name,
        "isCustom": false,
        "capabilities": { "optionDescriptors": option_descriptors },
    })
}

fn effort(options: &[(&str, &str, bool)]) -> Value {
    let prompt_injected_values = options
        .iter()
        .any(|(id, _, _)| *id == "ultrathink")
        .then_some(&["ultrathink"][..]);
    select_option("effort", "Reasoning", options, prompt_injected_values)
}

fn context_window() -> Value {
    select_option(
        "contextWindow",
        "Context Window",
        &[("200k", "200k", true), ("1m", "1M", false)],
        None,
    )
}

fn select_option(
    id: &str,
    label: &str,
    options: &[(&str, &str, bool)],
    prompt_injected_values: Option<&[&str]>,
) -> Value {
    let mut descriptor = json!({
        "id": id,
        "label": label,
        "type": "select",
        "options": options
            .iter()
            .map(|(id, label, is_default)| {
                let mut option = json!({ "id": id, "label": label });
                if *is_default {
                    option["isDefault"] = json!(true);
                }
                option
            })
            .collect::<Vec<_>>(),
    });
    if let Some(values) = prompt_injected_values {
        descriptor["promptInjectedValues"] = json!(values);
    }
    descriptor
}

fn boolean_option(id: &str, label: &str) -> Value {
    json!({ "id": id, "label": label, "type": "boolean" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_version_from_claude_cli_output() {
        assert_eq!(semantic_version("2.1.207 (Claude Code)"), Some([2, 1, 207]));
    }

    #[test]
    fn custom_models_do_not_duplicate_built_ins() {
        let models = all_models(&["claude-sonnet-5".to_owned(), " custom-model ".to_owned()]);
        assert_eq!(models.len(), 9);
        assert_eq!(models.last().unwrap()["slug"], "custom-model");
    }

    #[test]
    fn initialization_models_are_authoritative() {
        let models = models_from_initialization(
            &json!({
                "models": [
                    {
                        "value": "opus",
                        "resolvedModel": "claude-opus-5",
                        "displayName": "Opus",
                        "description": "Opus 5 · Best for everyday, complex tasks",
                        "supportsEffort": true,
                        "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
                        "supportsFastMode": true
                    },
                    {
                        "value": "haiku",
                        "resolvedModel": "claude-haiku-4-5-20251001",
                        "displayName": "Haiku"
                    }
                ]
            }),
            &["custom-model".to_owned(), "opus".to_owned()],
        )
        .expect("discovered models");

        assert_eq!(
            models
                .iter()
                .map(|model| model["slug"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["opus", "haiku", "custom-model"]
        );
        assert_eq!(models[0]["name"], "Opus 5");
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"][0]["options"][2],
            json!({ "id": "high", "label": "High", "isDefault": true })
        );
        assert_eq!(
            models[0]["capabilities"]["optionDescriptors"][1],
            json!({ "id": "fastMode", "label": "Fast Mode", "type": "boolean" })
        );
    }

    #[test]
    fn initialization_without_valid_models_uses_the_fallback() {
        assert!(models_from_initialization(&json!({}), &[]).is_none());
        assert!(models_from_initialization(&json!({ "models": [] }), &[]).is_none());
        assert!(
            models_from_initialization(
                &json!({ "models": [{ "value": "", "displayName": "Invalid" }] }),
                &[],
            )
            .is_none()
        );
    }

    #[test]
    fn initialization_keeps_the_default_alias_distinct_from_its_resolved_model() {
        let models = models_from_initialization(
            &json!({
                "models": [{
                    "value": "default",
                    "resolvedModel": "claude-opus-5[1m]",
                    "displayName": "Default (recommended)",
                    "description": "Opus 5 with 1M context · Best for everyday, complex tasks"
                }]
            }),
            &[],
        )
        .expect("discovered models");

        assert_eq!(models[0]["slug"], "default");
        assert_eq!(
            models[0]["name"],
            "Default (recommended) — Opus 5 with 1M context"
        );
    }

    #[test]
    fn prompt_injected_ultrathink_is_exposed_only_by_models_that_offer_it() {
        let models = all_models(&[]);
        let effort = |slug: &str| {
            models
                .iter()
                .find(|model| model["slug"] == slug)
                .unwrap()["capabilities"]["optionDescriptors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| option["id"] == "effort")
                .cloned()
                .unwrap()
        };

        assert_eq!(
            effort("claude-sonnet-5")["promptInjectedValues"],
            json!(["ultrathink"])
        );
        assert!(
            effort("claude-opus-4-5")
                .get("promptInjectedValues")
                .is_none()
        );
    }
}
