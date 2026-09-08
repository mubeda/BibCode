use tauri::webview::PageLoadEvent;
use uuid::Uuid;

pub(crate) struct PageLoadTracker {
    navigation: Uuid,
}

impl PageLoadTracker {
    pub(crate) fn new() -> Self {
        Self {
            navigation: Uuid::new_v4(),
        }
    }

    pub(crate) fn message(&mut self, label: &str, event: PageLoadEvent) -> Option<String> {
        if label != "main" {
            return None;
        }
        let phase = match event {
            PageLoadEvent::Started => {
                self.navigation = Uuid::new_v4();
                "started"
            }
            PageLoadEvent::Finished => "finished",
        };
        Some(format!(
            "desktop_e2e_page_load_{phase} id={}",
            self.navigation
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_native_start_and_finish_and_distinguishes_reloads() {
        let mut tracker = PageLoadTracker::new();
        let start = tracker.message("main", PageLoadEvent::Started).unwrap();
        let finish = tracker.message("main", PageLoadEvent::Finished).unwrap();
        assert_eq!(start.split("id=").last(), finish.split("id=").last());
        assert_eq!(
            Some(finish),
            tracker.message("main", PageLoadEvent::Finished)
        );
        let next = tracker.message("main", PageLoadEvent::Started).unwrap();
        assert_ne!(start, next);
    }

    #[test]
    fn ignores_other_webviews_without_replacing_main_navigation() {
        let mut tracker = PageLoadTracker::new();
        let start = tracker.message("main", PageLoadEvent::Started).unwrap();
        assert_eq!(None, tracker.message("preview", PageLoadEvent::Started));
        assert_eq!(None, tracker.message("preview", PageLoadEvent::Finished));
        let finish = tracker.message("main", PageLoadEvent::Finished).unwrap();
        assert_eq!(start.split("id=").last(), finish.split("id=").last());
    }
}
