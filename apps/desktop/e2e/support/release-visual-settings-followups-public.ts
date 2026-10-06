import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
export interface SettingsFollowupRenameInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  originalLabel: string;
  nextLabel: string;
  openDialog: () => Promise<void>;
  readLabel: () => Promise<string>;
  verifyIdentity: () => Promise<void>;
  captureDialog: () => Promise<void>;
  afterSave: () => Promise<void>;
  observeUnsafeCleanup: () => void;
}
export async function runSettingsFollowupRename(input: SettingsFollowupRenameInput) {
  const refused = () => new Error("Owned settings rename refused.");
  if (
    ![input.originalLabel, input.nextLabel].every(
      (value) => /^[A-Za-z0-9 -]{1,64}$/.test(value) && value.trim() === value,
    ) ||
    input.originalLabel === input.nextLabel
  )
    throw refused();
  const popup = '[data-slot="dialog-popup"][role="dialog"]',
    field = popup + ' input[aria-label="Server name"]';
  const click = async (selector: string) => {
    const element = input.browser.$(selector);
    await element.waitForDisplayed();
    if ((await input.browser.$$(selector).length) !== 1) throw refused();
    await element.waitForEnabled();
    await element.click();
  };
  const open = async (expected: string) => {
    await input.openDialog();
    await input.browser.$(field).waitForDisplayed();
    if (
      (await input.browser.$$(field).length) !== 1 ||
      (await input.browser.$(field).getValue()) !== expected
    )
      throw refused();
  };
  const save = async (label: string) => {
    await input.browser.$(field).setValue(label);
    if ((await input.browser.$(field).getValue()) !== label) throw refused();
    await click(
      '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Save"]',
    );
    await input.owner.until(async () => (await input.readLabel()) === label);
    await input.owner.until(async () => !(await input.browser.$(popup).isDisplayed()));
  };
  let failed = false,
    error: unknown;
  try {
    await input.verifyIdentity();
    if ((await input.readLabel()) !== input.originalLabel) throw refused();
    await open(input.originalLabel);
    await input.verifyIdentity();
    await input.captureDialog();
    await save(input.nextLabel);
    await input.verifyIdentity();
    await input.afterSave();
  } catch (cause) {
    failed = true;
    error = cause;
  }
  let cleanupFailed = false;
  try {
    if (await input.browser.$(popup).isDisplayed())
      await click(
        '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Cancel"]',
      );
    const label = await input.readLabel();
    if (label === input.nextLabel) {
      await open(input.nextLabel);
      await save(input.originalLabel);
    } else if (label !== input.originalLabel) throw refused();
    if ((await input.readLabel()) !== input.originalLabel) throw refused();
    await input.verifyIdentity();
  } catch {
    cleanupFailed = true;
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* Preserve original and cleanup outcomes. */
    }
  }
  if (failed) throw error;
  if (cleanupFailed) throw refused();
  return { originalLabelRestored: true };
}
export interface SettingsFollowupUsageInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  verifyIdentity: () => Promise<void>;
  verifyUsage: () => Promise<void>;
  capture: () => Promise<void>;
  observeUnsafeCleanup: () => void;
}
export async function runSettingsFollowupUsage(input: SettingsFollowupUsageInput) {
  const refused = () => new Error("Owned settings usage refused.");
  const trigger = '[data-testid="app-status-bar"] button[aria-label="Codex usage"]',
    detail =
      '[data-slot="popover-popup"][aria-label="Codex usage details"] [data-testid="provider-usage-detail"]';
  let attempted = false,
    failed = false,
    error: unknown;
  try {
    await input.verifyIdentity();
    await input.verifyUsage();
    if (await input.browser.$(detail).isDisplayed()) throw refused();
    const button = input.browser.$(trigger);
    await button.waitForDisplayed();
    if ((await input.browser.$$(trigger).length) !== 1) throw refused();
    await button.waitForEnabled();
    attempted = true;
    await button.click();
    await input.browser.$(detail).waitForDisplayed();
    if ((await input.browser.$$(detail).length) !== 1) throw refused();
    await input.verifyIdentity();
    await input.verifyUsage();
    await input.capture();
    await input.verifyIdentity();
    await input.verifyUsage();
  } catch (cause) {
    failed = true;
    error = cause;
  }
  let cleanupFailed = false;
  try {
    if (attempted) {
      if (await input.browser.$(detail).isDisplayed()) await input.browser.keys("Escape");
      await input.owner.until(
        async () =>
          !(await input.browser.$(detail).isDisplayed()) &&
          (await input.browser.$(trigger).isFocused()),
      );
      await input.verifyIdentity();
      await input.verifyUsage();
    }
  } catch {
    cleanupFailed = true;
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* Preserve original and cleanup outcomes. */
    }
  }
  if (failed) throw error;
  if (cleanupFailed) throw refused();
  return { usagePopoverClosed: true };
}
