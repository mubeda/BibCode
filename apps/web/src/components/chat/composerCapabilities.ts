import type {
  ServerProvider,
  ServerProviderAgent,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@bibcode/contracts";
import type { ComposerTriggerProfile } from "@bibcode/shared/composerTrigger";

export interface ComposerCapabilityProfile {
  readonly signature: string;
  readonly trigger: ComposerTriggerProfile;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly slashSkills: ReadonlyArray<ServerProviderSkill>;
  readonly dollarSkills: ReadonlyArray<ServerProviderSkill>;
  readonly enabledSlashSkillNames: ReadonlySet<string>;
  readonly enabledDollarSkillNames: ReadonlySet<string>;
  readonly mentionableAgents: ReadonlyArray<ServerProviderAgent>;
  readonly mentionableAgentNames: ReadonlySet<string>;
}

export function deriveComposerCapabilityProfile(
  provider: Pick<ServerProvider, "slashCommands" | "skills" | "agents"> | null,
  nativeSkillInvocation?: "dollar" | "slash",
): ComposerCapabilityProfile {
  const slashCommands = provider?.slashCommands ?? [];
  const commandNames = new Set(slashCommands.map((command) => command.name.toLowerCase()));
  const slashSkills: ServerProviderSkill[] = [];
  const dollarSkills: ServerProviderSkill[] = [];
  const enabledSlashSkillNames = new Set<string>();
  const enabledDollarSkillNames = new Set<string>();

  for (const skill of provider?.skills ?? []) {
    if (!skill.enabled) {
      continue;
    }
    if (skill.invocation === "slash") {
      const normalizedName = skill.name.trim().toLowerCase();
      enabledSlashSkillNames.add(normalizedName);
      if (!commandNames.has(normalizedName)) {
        slashSkills.push(skill);
      }
      continue;
    }
    if (skill.invocation === "dollar") {
      enabledDollarSkillNames.add(skill.name.trim().toLowerCase());
      dollarSkills.push(skill);
    }
  }

  const mentionableAgents = (provider?.agents ?? []).filter(
    (agent) => agent.invocation === "mention",
  );
  const providerSlash =
    slashCommands.length > 0 ||
    enabledSlashSkillNames.size > 0 ||
    nativeSkillInvocation === "slash";
  const providerDollarSkill = dollarSkills.length > 0 || nativeSkillInvocation === "dollar";

  return {
    signature: `${providerSlash ? "slash" : ""}:${providerDollarSkill ? "dollar" : ""}`,
    trigger: {
      providerSlash,
      providerDollarSkill,
    },
    slashCommands,
    slashSkills,
    dollarSkills,
    enabledSlashSkillNames,
    enabledDollarSkillNames,
    mentionableAgents,
    mentionableAgentNames: new Set(mentionableAgents.map((agent) => agent.name)),
  };
}
