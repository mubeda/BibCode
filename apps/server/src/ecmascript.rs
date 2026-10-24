//! String rules the TypeScript contracts apply, for values the server must publish as the
//! client will decode them.

/// Whether `String.prototype.trim` removes `character`: ECMAScript's WhiteSpace and
/// LineTerminator. Unlike Rust's `char::is_whitespace`, it includes U+FEFF and excludes
/// U+0085.
fn is_trim_character(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `value` trimmed as `String.prototype.trim` trims it, which the contracts'
/// `TrimmedString` schemas apply on decode.
pub(crate) fn trim(value: &str) -> &str {
    value.trim_matches(is_trim_character)
}
