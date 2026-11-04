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
        || substitutions(command)
            .iter()
            .any(|inner| creates_pull_request(inner))
}

/// The text of every `$(...)` and backtick substitution that runs: outside quotes and inside
/// double quotes, but not inside single quotes or comments. A `)` inside a quoted string within
/// `$(...)` ends it early, and a heredoc with a quoted delimiter is still scanned; both only
/// risk a harmless extra refresh.
fn substitutions(command: &str) -> Vec<String> {
    let chars = command.chars().collect::<Vec<_>>();
    let mut found = Vec::new();
    let mut double_quoted = false;
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '\\' => index += 1,
            '\'' if !double_quoted => {
                index += 1;
                while index < chars.len() && chars[index] != '\'' {
                    index += 1;
                }
            }
            '"' => double_quoted = !double_quoted,
            '#' if !double_quoted
                && (index == 0
                    || chars[index - 1].is_whitespace()
                    || ";&|(".contains(chars[index - 1])) =>
            {
                while index < chars.len() && chars[index] != '\n' {
                    index += 1;
                }
            }
            '`' => {
                let start = index + 1;
                index = start;
                while index < chars.len() && chars[index] != '`' {
                    index += if chars[index] == '\\' { 2 } else { 1 };
                }
                found.push(chars[start..index.min(chars.len())].iter().collect());
            }
            '$' if chars.get(index + 1) == Some(&'(') => {
                let start = index + 2;
                let mut depth = 1;
                index = start;
                while index < chars.len() {
                    match chars[index] {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        _ => {}
                    }
                    if depth == 0 {
                        break;
                    }
                    index += 1;
                }
                found.push(chars[start..index.min(chars.len())].iter().collect());
            }
            _ => {}
        }
        index += 1;
    }
    found
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
        "gh" => matches!(leading_positionals(&words[1..])[..], ["pr", verb] if is_create(verb)),
        "glab" => matches!(leading_positionals(&words[1..])[..], ["mr", verb] if is_create(verb)),
        _ => false,
    }
}

/// The first two words that are not flags, so `gh -R o/r pr create` and `gh pr --repo o/r create`
/// read like `gh pr create`. Only the flags that name a repository or host take a value here.
fn leading_positionals(words: &[String]) -> Vec<&str> {
    let mut positionals = Vec::new();
    let mut words = words.iter();
    while let Some(word) = words.next() {
        if let Some(flag) = word.strip_prefix('-') {
            if !flag.contains('=') && matches!(flag, "R" | "-repo" | "H" | "-hostname") {
                words.next();
            }
        } else {
            positionals.push(word.as_str());
            if positionals.len() == 2 {
                break;
            }
        }
    }
    positionals
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
    let mut heredocs = Vec::<(String, bool)>::new();
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
                for (delimiter, tabs_allowed) in heredocs.drain(..) {
                    while index < chars.len() {
                        let end = chars[index..]
                            .iter()
                            .position(|&c| c == '\n')
                            .map_or(chars.len(), |offset| index + offset);
                        let line = chars[index..end].iter().collect::<String>();
                        index = end + 1;
                        // Only `<<-` lets the terminator lead with tabs; spaces never do.
                        let line = line.trim_end_matches('\r');
                        if (if tabs_allowed {
                            line.trim_start_matches('\t')
                        } else {
                            line
                        }) == delimiter
                        {
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
                let tabs_allowed = chars.get(index) == Some(&'-');
                if tabs_allowed {
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
                    heredocs.push((delimiter, tabs_allowed));
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
            "gh -R owner/repo pr create --fill",
            "gh --repo owner/repo pr create --fill",
            "gh pr --repo owner/repo create --fill",
            "gh pr -R=owner/repo create --fill",
            "glab -R owner/repo mr create --fill",
            "glab mr --repo owner/repo create --fill --yes",
            "glab mr create --fill",
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
    fn command_substitutions_run_their_contents() {
        for command in [
            r#"pr_url="$(gh pr create --fill)""#,
            "pr_url=$(gh pr create --fill)",
            "url=`gh pr create --fill`",
            r#"echo "created: $(glab mr create --fill --yes)""#,
            "echo $(git push && gh pr create --fill)",
            "bash -lc 'url=$(gh -R o/r pr create --fill)'",
            "echo $(echo $(gh pr create --fill))",
        ] {
            assert!(creates_pull_request(command), "{command}");
        }
        for command in [
            r#"echo "gh pr create""#,
            "echo '$(gh pr create)'",
            r#"echo "$(gh pr view)""#,
            "echo hi # $(gh pr create)",
            "echo '`gh pr create`'",
        ] {
            assert!(!creates_pull_request(command), "{command}");
        }
    }

    #[test]
    fn heredoc_terminators_must_start_the_line() {
        // Spaces never indent a `<<` terminator, so the create below is still heredoc text.
        for command in [
            "cat <<EOF\n  EOF\ngh pr create --fill\nEOF",
            "cat <<EOF\n\tEOF\ngh pr create --fill\nEOF",
            "cat <<-EOF\n  EOF\ngh pr create --fill\nEOF",
        ] {
            assert!(!creates_pull_request(command), "{command}");
        }
        // `<<-` strips leading tabs, so the create below runs.
        assert!(creates_pull_request(
            "cat <<-EOF\n\tEOF\ngh pr create --fill"
        ));
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
            "gh -R owner/repo pr view create",
            "glab -R owner/repo mr list",
            "gh pr --repo owner/repo view",
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
