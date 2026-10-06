import { expect, it } from "vite-plus/test";
import {
  nativeFollowupPreviewHtml,
  respondNativeFollowupPreview,
} from "./release-visual-native-followups-preview.ts";
it("serves only its immutable loopback native-content path without claiming annotation evidence", () => {
  const response = respondNativeFollowupPreview("GET", "/native-preview-fixture", "127.0.0.1");
  expect(response.status).toBe(200);
  expect(response.bytes.toString()).toBe(nativeFollowupPreviewHtml);
  expect(response.sha256).toMatch(/^[a-f0-9]{64}$/);
  for (const [method, path, peer] of [
    ["POST", "/native-preview-fixture", "127.0.0.1"],
    ["GET", "/native-preview-fixture?secret=private", "127.0.0.1"],
    ["GET", "/native-preview-fixture", "10.0.0.1"],
  ])
    expect(respondNativeFollowupPreview(method!, path!, peer!).status).toBe(404);
});
