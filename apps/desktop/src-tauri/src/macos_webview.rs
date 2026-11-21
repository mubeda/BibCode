//! Ownership of the objects a macOS `with_webview` callback receives (#410).

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_web_kit::WKWebView;

/// Takes back the three objects tauri-runtime-wry 2.11.4 hands a `with_webview` callback as
/// `Retained::into_raw` (+1 retains it never releases) and returns the WKWebView; the controller
/// and window are released when this returns. It consumes `platform`, so a second release cannot
/// compile. `window::tests::with_webview_ownership_matches_the_pinned_runtime` fails when that
/// runtime version changes. Call it on the main thread where Tauri runs the callback, and never
/// borrow `platform.inner()` instead: each borrow leaks three retains.
pub(crate) fn take_platform_webview(
    platform: tauri::webview::PlatformWebview,
) -> Option<Retained<WKWebView>> {
    // SAFETY: each pointer carries one retain the runtime gave up, adopted here once.
    unsafe {
        adopt(
            platform.inner(),
            platform.controller(),
            platform.ns_window(),
        )
    }
}

/// # Safety
/// Each non-null pointer must carry one retain the caller owns and gives up.
unsafe fn adopt(
    webview: *mut std::ffi::c_void,
    controller: *mut std::ffi::c_void,
    window: *mut std::ffi::c_void,
) -> Option<Retained<WKWebView>> {
    // SAFETY: the caller transfers one retain per pointer; from_raw adopts it once.
    unsafe {
        drop(Retained::<AnyObject>::from_raw(controller.cast()));
        drop(Retained::<AnyObject>::from_raw(window.cast()));
        Retained::<WKWebView>::from_raw(webview.cast())
    }
}

#[cfg(test)]
mod tests {
    use objc2::rc::Retained;
    use objc2::runtime::NSObject;

    fn retain_count(object: &NSObject) -> usize {
        // SAFETY: `retainCount` is implemented by every NSObject.
        unsafe { objc2::msg_send![object, retainCount] }
    }

    #[test]
    fn adopt_releases_every_retain_the_runtime_gave_up() {
        let objects = [NSObject::new(), NSObject::new(), NSObject::new()];
        let before: Vec<_> = objects.iter().map(|object| retain_count(object)).collect();
        // The runtime's side: one `Retained::into_raw` per object.
        let [webview, controller, window] = objects
            .each_ref()
            .map(|object| Retained::into_raw(object.clone()).cast());
        // SAFETY: each pointer carries the retain created just above.
        let adopted = unsafe { super::adopt(webview, controller, window) };
        let after_adopt: Vec<_> = objects.iter().map(|object| retain_count(object)).collect();
        assert_eq!(after_adopt, [before[0] + 1, before[1], before[2]]);
        drop(adopted);
        let after: Vec<_> = objects.iter().map(|object| retain_count(object)).collect();
        assert_eq!(after, before);
    }

    #[test]
    fn no_macos_with_webview_callback_borrows_the_platform_pointers() {
        // shortcut: only catches a callback parameter named `platform`; widen if one is renamed.
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut pending = vec![source];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|extension| extension == "rs")
                    && !path.ends_with("macos_webview.rs")
                    && std::fs::read_to_string(&path).unwrap().lines().any(|line| {
                        [
                            "platform.inner().cast",
                            "platform.controller().cast",
                            "platform.ns_window().cast",
                        ]
                        .iter()
                        .any(|needle| line.contains(needle))
                    })
                {
                    offenders.push(path);
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "use macos_webview::take_platform_webview instead of casting the pointers: {offenders:?}"
        );
    }
}
