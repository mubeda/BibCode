export async function sendTerminalText(text: string): Promise<void> {
  const terminalInput = browser.$(".xterm-helper-textarea");
  await terminalInput.waitForExist();
  await terminalInput.addValue(text);
}

export async function sendTerminalCommand(command: string): Promise<void> {
  await sendTerminalText(command);
  await browser.keys("Enter");
}

export async function openCenterTerminal(): Promise<void> {
  const newPanelSelector = '[aria-label="New panel"]';
  for (const candidate of await browser.$$(newPanelSelector)) {
    if ((await candidate.isDisplayed()) && (await candidate.isEnabled())) {
      await candidate.click();
      break;
    }
  }
  const openTerminal = browser.$('//*[@role="menuitem" and normalize-space()="Open Terminal"]');
  await openTerminal.waitForDisplayed();
  await openTerminal.waitForEnabled();
  await openTerminal.click();
}
