import { expect, it } from "vite-plus/test";
import {
  openNativeFollowupUpdate,
  selectNativeFollowupTheme,
} from "./release-visual-native-followups-public.ts";
it("uses the current About updater owner and General theme owner through unique public controls", async () => {
  const actions: string[] = [];
  const browser = {
    url: async (url: string) => {
      actions.push(url);
    },
    $: (selector: string) => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      click: async () => {
        actions.push(selector);
      },
    }),
    $$: async () => [1],
  };
  await openNativeFollowupUpdate(browser as never, "tauri://localhost");
  await selectNativeFollowupTheme(browser as never, "System", "tauri://localhost");
  expect(actions).toEqual([
    "tauri://localhost/#/settings/about",
    '//button[normalize-space()="Install"]',
    "tauri://localhost/#/settings/general",
    '[aria-label="Theme preference"]',
    '//*[@role="option" and normalize-space()="System"]',
  ]);
});
