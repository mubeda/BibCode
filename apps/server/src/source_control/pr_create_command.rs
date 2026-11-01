//! Recognizes a shell command that creates a pull or merge request (`gh pr create`,
//! `glab mr create`) so a provider command that ran one can refresh the thread's request
//! right away instead of waiting for the next status cycle.
//!
//! Only command position counts: a mention inside a quoted argument (`echo "gh pr create"`),
//! a comment or a heredoc body is not a create. Shell wrappers (`bash -lc '…'`, `zsh -lc`,
//! `pwsh -Command`) are unwrapped. Loops, scripts and `gh api` calls are not recognized.
//! Callers keep the command text to themselves; only the answer leaves this module.

/// Whether `command` runs `gh pr create` or `glab mr create` at command position.
pub(crate) fn creates_pull_request(command: &str) -> bool {
    simple_commands(command)
        .iter()
        .any(|words| command_creates_pull_request(words))
}

fn command_creates_pull_request(words: &[String]) -> bool {
    let words = skip_prefixes(words);
    let Some(program) = words.first().map(|word| program_name(word)) else {
        return false;
    };
    match program.as_str() {
        "bash" | "sh" | "zsh" | "dash" | "ksh" => words[1..]
            .iter()
            .position(|word| word.starts_with('-') && !word.starts_with("--") && word.contains('c'))
            .and_then(|flag| words.get(flag + 2))
            .is_some_and(|script| creates_pull_request(script)),
        "pwsh" | "powershell" => words[1..]
            .iter()
            .position(|word| {
                word.eq_ignore_ascii_case("-c") || word.eq_ignore_ascii_case("-command")
            })
            .is_some_and(|flag| creates_pull_request(&words[flag + 2..].join(" "))),
        "gh" => matches!(words.get(1..3), Some([noun, verb]) if noun == "pr" && is_create(verb)),
        "glab" => matches!(words.get(1..3), Some([noun, verb]) if noun == "mr" && is_create(verb)),
        _ => false,
    }
}

fn is_create(verb: &str) -> bool {
    verb == "create" || verb == "new"
}

/// Drops environment assignments and the wrappers that run the next word as the program.
fn skip_prefixes(words: &[String]) -> &[String] {
    let skip = words
        .iter()
        .take_while(|word| {
            is_assignment(word)
                || matches!(
                    word.as_str(),
                    "env" | "command" | "exec" | "sudo" | "time" | "nohup" | "{" | "!"
                )
        })
        .count();
    &words[skip..]
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty()
            && !name.starts_with(|c: char| c.is_ascii_digit())
            && name.chars().all(|c| c == '_' || c.is_ascii_alphanumeric())
    })
}

/// `/usr/bin/gh` and `C:\…\gh.exe` both name `gh`.
fn program_name(word: &str) -> String {
    let name = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let lower = name.to_ascii_lowercase();
    lower
        .strip_suffix(".exe")
        .map_or(lower.clone(), str::to_owned)
}

/// Splits a shell command into its simple commands, each as unquoted words. Operators
/// (`;`, `&&`, `||`, `|`, `&`, newlines, parentheses) end a command; comments and heredoc
/// bodies are dropped.
fn simple_commands(command: &str) -> Vec<Vec<String>> {
    let chars = command.chars().collect::<Vec<_>>();
    let mut commands = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut heredocs = Vec::<String>::new();
    let mut index = 0;
    macro_rules! end_word {
        () => {
            if in_word {
                words.push(std::mem::take(&mut word));
                in_word = false;
            }
        };
    }
    macro_rules! end_command {
        () => {
            end_word!();
            if !words.is_empty() {
                commands.push(std::mem::take(&mut words));
            }
        };
    }
    while index < chars.len() {
        let c = chars[index];
        index += 1;
        match c {
            '\'' => {
                in_word = true;
                while index < chars.len() && chars[index] != '\'' {
                    word.push(chars[index]);
                    index += 1;
                }
                index += 1;
            }
            '"' => {
                in_word = true;
                while index < chars.len() && chars[index] != '"' {
                    // Inside double quotes a backslash escapes only these.
                    if chars[index] == '\\'
                        && chars
                            .get(index + 1)
                            .is_some_and(|next| matches!(next, '"' | '\\' | '$' | '`'))
                    {
                        index += 1;
                    }
                    word.push(chars[index]);
                    index += 1;
                }
                index += 1;
            }
            '\\' => {
                match chars.get(index) {
                    Some('\n') => {}
                    Some(&next) => {
                        in_word = true;
                        word.push(next);
                    }
                    None => {}
                }
                index += 1;
            }
            '#' if !in_word => {
                while index < chars.len() && chars[index] != '\n' {
                    index += 1;
                }
            }
            '\n' => {
                end_command!();
                // Each pending heredoc body runs to its delimiter line.
                for delimiter in heredocs.drain(..) {
                    while index < chars.len() {
                        let end = chars[index..]
                            .iter()
                            .position(|&c| c == '\n')
                            .map_or(chars.len(), |offset| index + offset);
                        let line = chars[index..end].iter().collect::<String>();
                        index = end + 1;
                        if line.trim() == delimiter {
                            break;
                        }
                    }
                }
            }
            ';' | '&' | '|' | '(' | ')' => {
                end_command!();
            }
            '<' if chars.get(index) == Some(&'<') && chars.get(index + 1) != Some(&'<') => {
                end_word!();
                index += 1;
                if chars.get(index) == Some(&'-') {
                    index += 1;
                }
                while chars.get(index).is_some_and(|c| *c == ' ' || *c == '\t') {
                    index += 1;
                }
                let mut delimiter = String::new();
                while let Some(&c) = chars.get(index) {
                    if c.is_whitespace() || matches!(c, ';' | '&' | '|' | '<' | '>' | '(' | ')') {
                        break;
                    }
                    if c != '\'' && c != '"' && c != '\\' {
                        delimiter.push(c);
                    }
                    index += 1;
                }
                if !delimiter.is_empty() {
                    heredocs.push(delimiter);
                }
            }
            '<' | '>' => {
                end_word!();
            }
            c if c.is_whitespace() => {
                end_word!();
            }
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    if !words.is_empty() {
        commands.push(words);
    }
    commands
}

#[cfg(test)]
mod tests {
    use super::creates_pull_request;

    #[test]
    fn plain_creates_match() {
        for command in [
            "gh pr create --fill",
            "glab mr create --fill --yes",
            "gh pr create",
            "/usr/bin/gh pr create --title 'Fix' --body ''",
            r#""C:\Program Files\GitHub CLI\gh.exe" pr create --fill"#,
            "GH_PROMPT_DISABLED=1 gh pr create --fill",
            "gh pr new --fill",
        ] {
            assert!(creates_pull_request(command), "{command}");
        }
    }

    #[test]
    fn shell_wrapped_creates_match() {
        for command in [
            "bash -lc 'gh pr create --fill'",
            "/bin/zsh -lc 'git push -u origin HEAD && gh pr create --fill'",
            r#"zsh -lc "gh pr create --title \"Fix it\" --body x""#,
            "sh -c 'glab mr create --fill'",
            "bash -l -c 'gh pr create --fill'",
            "pwsh -Command gh pr create --fill",
        ] {
            assert!(creates_pull_request(command), "{command}");
        }
    }

    #[test]
    fn chained_creates_match() {
        for command in [
            "git push -u origin HEAD && gh pr create --fill",
            "git push; gh pr create --fill",
            "git push || true; glab mr create --fill",
            "gh pr create --fill | tee out.txt",
            "(cd repo && gh pr create --fill)",
            "git push\ngh pr create --fill",
        ] {
            assert!(creates_pull_request(command), "{command}");
        }
    }

    #[test]
    fn heredoc_body_creates_match() {
        let command = "gh pr create --title Fix --body-file - <<'EOF'\n## Summary\nFixes it.\nEOF";
        assert!(creates_pull_request(command));
        let wrapped = "bash -lc 'git push && glab mr create --description-file - <<EOF\nBody\nEOF'";
        assert!(creates_pull_request(wrapped));
    }

    #[test]
    fn mentions_are_not_creates() {
        for command in [
            r#"echo "gh pr create""#,
            "echo gh pr create",
            "grep 'gh pr create' notes.md",
            "rg -n \"glab mr create\" .",
            "# gh pr create --fill",
            "git push # then gh pr create",
            "cat <<EOF\ngh pr create --fill\nEOF",
            "bash -lc 'echo gh pr create'",
        ] {
            assert!(!creates_pull_request(command), "{command}");
        }
    }

    #[test]
    fn other_pull_request_commands_are_not_creates() {
        for command in [
            "gh pr view",
            "gh pr list --head feature",
            "glab mr list",
            "gh pr view 42 --json url",
            "gh api repos/o/r/pulls -f title=x",
            "gh issue create --title x",
            "gh",
            "",
        ] {
            assert!(!creates_pull_request(command), "{command}");
        }
    }

    #[test]
    fn non_command_position_is_not_a_create() {
        for command in [
            "git commit -m gh pr create",
            "xargs gh pr create",
            "man gh pr create",
            "git log --grep gh pr create",
        ] {
            assert!(!creates_pull_request(command), "{command}");
        }
    }
}
