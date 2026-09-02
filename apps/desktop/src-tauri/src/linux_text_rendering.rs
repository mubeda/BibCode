//! WebKitGTK at `hintfull` disables subpixel positioning and fully hints glyphs,
//! making DM Sans body text show whole-pixel gaps; GNOME's `hintslight` default
//! renders every line evenly. This process-only GtkSettings override outranks
//! the session setting without changing the user's system preference. See
//! `docs/plans/2026-09-01-linux-webview-font-rendering-design.md` (Revision 3).

use gtk::prelude::GtkSettingsExt;

pub const FULL_HINT_STYLE: &str = "hintfull";
pub const OVERRIDE_HINT_STYLE: &str = "hintslight";

pub fn resolve_hint_style_override(
    hinting_enabled: bool,
    hint_style: Option<&str>,
) -> Option<&'static str> {
    if hinting_enabled && hint_style == Some(FULL_HINT_STYLE) {
        Some(OVERRIDE_HINT_STYLE)
    } else {
        None
    }
}

pub fn apply_webview_hinting_override() {
    let Some(settings) = gtk::Settings::default() else {
        tracing::debug!("GTK settings are unavailable; skipping WebKitGTK text hinting override");
        return;
    };

    let hinting: i32 = settings.gtk_xft_hinting();
    let hint_style = settings.gtk_xft_hintstyle();

    if let Some(style) = resolve_hint_style_override(hinting != 0, hint_style.as_deref()) {
        settings.set_gtk_xft_hintstyle(Some(style));
        tracing::info!(
            previous_hint_style = ?hint_style.as_deref(),
            new_hint_style = style,
            "pinned WebKitGTK text hinting to hintslight because the session requested hintfull"
        );
    } else {
        tracing::debug!(
            hinting,
            hint_style = ?hint_style.as_deref(),
            "WebKitGTK text hinting override is not required"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_hint_style_override;

    #[test]
    fn overrides_full_hinting_when_enabled() {
        assert_eq!(
            resolve_hint_style_override(true, Some("hintfull")),
            Some("hintslight")
        );
    }

    #[test]
    fn keeps_full_hinting_when_disabled() {
        assert_eq!(resolve_hint_style_override(false, Some("hintfull")), None);
    }

    #[test]
    fn keeps_non_full_hint_styles() {
        for hint_style in [
            Some("hintslight"),
            Some("hintmedium"),
            Some("hintnone"),
            None,
        ] {
            assert_eq!(resolve_hint_style_override(true, hint_style), None);
        }
    }
}
