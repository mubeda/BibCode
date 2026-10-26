import { badgeFixture } from "./badge";
import { chatFixtures } from "./chat";
import { settingsFixtures } from "./settings";
import { chatFixtures as chatContextFixtures } from "./chat-context";
import { gitFixtures } from "./git";
import { mermaidFixtures } from "./mermaid";
import { remainingContextFixtures } from "./remaining-context";

export const typographyFixtures = [
  badgeFixture,
  ...chatFixtures,
  ...settingsFixtures,
  ...chatContextFixtures,
  ...mermaidFixtures,
  ...gitFixtures,
  ...remainingContextFixtures,
];
