export const projectLifecycleScenes = [
  "worktree-remove-busy",
  "project-clone-progress",
  "git-trust-refusal",
] as const;
export type ProjectLifecycleScene = (typeof projectLifecycleScenes)[number];

export interface ProjectLifecycleObservation {
  readonly scene: ProjectLifecycleScene;
  readonly theme: "light" | "dark";
  readonly origin: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly branch: string;
  readonly title: string;
  readonly cloneUrl: string;
  readonly cloneParent: string;
}

/** Serialized public read. Source/process proof is supplied separately around capture. */
export function readProjectLifecycleObservation(
  input: ProjectLifecycleObservation,
): Record<string, boolean> | null {
  if (
    !input ||
    !["worktree-remove-busy", "project-clone-progress", "git-trust-refusal"].includes(
      input.scene,
    ) ||
    !["light", "dark"].includes(input.theme) ||
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search !== "" ||
    location.hash !== "" ||
    ![input.projectId, input.threadId].every((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value)) ||
    ![input.cwd, input.cloneParent].every(
      (value) => typeof value === "string" && value.startsWith("/") && value.length <= 4096,
    ) ||
    typeof input.title !== "string" ||
    input.title.length < 1 ||
    input.title.length > 128 ||
    input.branch !==
      (input.scene === "worktree-remove-busy" ? "codex/delivery-retry-" + input.theme : "main") ||
    input.cloneUrl !== "https://visual.invalid/lifecycle-origin.git" ||
    document.querySelector(
      '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
    ) !== null ||
    document.getElementById("boot-shell") !== null ||
    document.querySelector("vite-error-overlay") !== null ||
    innerWidth !== 1280 ||
    innerHeight !== 960
  )
    return null;
  const visible = (node: Element | null): node is HTMLElement => {
    if (!node || node.closest("[hidden],[inert]")) return false;
    const box = node.getBoundingClientRect();
    if (
      ![box.x, box.y, box.width, box.height, box.right, box.bottom].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0
    )
      return false;
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const all = (selector: string, scope: ParentNode = document) =>
    Array.from(scope.querySelectorAll(selector)).filter(visible);
  const one = (selector: string, scope: ParentNode = document) => {
    const values = all(selector, scope);
    return values.length === 1 ? values[0]! : null;
  };
  const text = (node: Element | null) => node?.textContent?.trim() ?? "";
  const button = (label: string, scope: ParentNode = document) => {
    const values = all("button", scope).filter(
      (node) => text(node) === label || node.getAttribute("aria-label") === label,
    );
    return values.length === 1 && values[0] instanceof HTMLButtonElement ? values[0] : null;
  };
  const inView = (node: Element | null) => {
    if (!visible(node)) return false;
    const box = node.getBoundingClientRect();
    if (box.x < 0 || box.y < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    if (!hit) return false;
    if (
      hit !== node &&
      !node.contains(hit) &&
      !(
        node instanceof HTMLButtonElement &&
        node.disabled &&
        getComputedStyle(node).pointerEvents === "none" &&
        hit === node.parentElement
      )
    )
      return false;
    // Pointer-transparent toast/menu paint still obscures a disabled control's pixels.
    for (const overlay of all(
      '[data-slot="toast-root"],[role="menu"],[role="dialog"],[role="alertdialog"]',
    )) {
      if (overlay === node || overlay.contains(node) || node.contains(overlay)) continue;
      const other = overlay.getBoundingClientRect();
      if (
        other.x < box.right &&
        other.right > box.x &&
        other.y < box.bottom &&
        other.bottom > box.y
      )
        return false;
    }
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent),
        clip = parent.getBoundingClientRect();
      if (
        (["hidden", "clip", "auto", "scroll"].includes(style.overflowX) &&
          (box.x < clip.x || box.right > clip.right)) ||
        (["hidden", "clip", "auto", "scroll"].includes(style.overflowY) &&
          (box.y < clip.y || box.bottom > clip.bottom))
      )
        return false;
    }
    return true;
  };
  const rail = document.querySelectorAll(
    '[data-testid="environment-rail-local"][aria-checked="true"]',
  );
  if (
    rail.length !== 1 ||
    !visible(rail[0]!) ||
    rail[0]!.querySelector('[data-status="connected"]') === null
  )
    return null;
  const git = input.scene === "git-trust-refusal";
  if (
    location.pathname !==
    (git ? "/project/local/" + input.projectId + "/git" : "/local/" + input.threadId)
  )
    return null;
  const cardSelector =
    input.scene === "worktree-remove-busy"
      ? '[data-testid="thread-card-button-' + input.threadId + '"]'
      : '[data-testid="primary-card-button-' + input.projectId + '"]';
  const cards = document.querySelectorAll(cardSelector);
  if (
    cards.length !== 1 ||
    !visible(cards[0]!) ||
    (!git && cards[0]!.getAttribute("aria-current") !== "page")
  )
    return null;
  if (git) {
    const headers = document.querySelectorAll("header[data-environment-id][data-project-id]");
    const checkouts = document.querySelectorAll('[data-testid="git-manager-project"]');
    if (
      headers.length !== 1 ||
      headers[0]!.getAttribute("data-environment-id") !== "local" ||
      headers[0]!.getAttribute("data-project-id") !== input.projectId ||
      checkouts.length !== 1 ||
      checkouts[0]!.getAttribute("title") !== input.cwd ||
      !visible(headers[0]!) ||
      !visible(checkouts[0]!)
    )
      return null;
  }
  let facts: Record<string, boolean>,
    target: HTMLElement | null = null;
  const critical: Array<Element | null> = [];
  if (input.scene === "worktree-remove-busy") {
    target = one('[data-slot="dialog-popup"][role="dialog"]');
    if (!target || all('[role="dialog"]').length !== 1) return null;
    const headings = all("h2", target).filter((node) => text(node) === "Remove worktree");
    const reasons = all('p[role="status"]', target).filter(
      (node) => text(node) === "Stop the running session before deleting this worktree.",
    );
    const reason = reasons.length === 1 ? reasons[0]! : null;
    const destructive = button("Delete Git worktree and remove", target),
      cancel = button("Cancel", target),
      detach = button("Remove from BiBCode", target);
    const descriptions = (destructive?.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const values = all("dd", target);
    const matched = (value: string) => values.filter((node) => text(node) === value).length === 1;
    facts = {
      singleRemovalDialog: headings.length === 1,
      runningReason: reason !== null,
      destructiveDisabled: destructive?.disabled === true,
      reasonLinked:
        reason !== null &&
        reason.id !== "" &&
        descriptions.length === 1 &&
        descriptions[0] === reason.id &&
        document.querySelectorAll('[id="' + reason.id + '"]').length === 1,
      checkoutIdentityMatched: matched(input.title) && matched(input.branch) && matched(input.cwd),
    };
    if (!cancel || cancel.disabled || !detach || detach.disabled) return null;
    critical.push(...headings, reason, destructive, cancel, detach, ...values);
  } else if (input.scene === "project-clone-progress") {
    target = one('[data-slot="dialog-popup"][role="dialog"]');
    if (!target || all('[role="dialog"]').length !== 1) return null;
    const urls = target.querySelectorAll("#add-project-clone-url"),
      parents = target.querySelectorAll("#add-project-clone-parent");
    const url = urls.length === 1 && urls[0] instanceof HTMLInputElement ? urls[0] : null;
    const parent =
      parents.length === 1 && parents[0] instanceof HTMLInputElement ? parents[0] : null;
    const form = url?.form ?? null,
      submit = form ? button("Cloning…", form) : null,
      cancel = form ? button("Cancel clone", form) : null;
    const headings = all("h2", target).filter((node) => text(node) === "Clone from URL");
    facts = {
      singleCloneForm:
        headings.length === 1 &&
        !!form &&
        parent?.form === form &&
        all("form", target).length === 1,
      cloneRunning:
        !!form && form.getAttribute("aria-busy") === "true" && submit?.disabled === true,
      cancelEnabled: !!cancel && !cancel.disabled,
      inputsRetained: url?.value === input.cloneUrl && parent?.value === input.cloneParent,
      inputsDisabled: url?.disabled === true && parent?.disabled === true,
    };
    critical.push(...headings, url, parent, submit, cancel);
  } else {
    if (all('[role="dialog"]').length !== 0) return null;
    target = one('[role="alert"]');
    if (!target || !text(target).includes("Could not load changes")) return null;
    const command =
      "git config --global --add safe.directory '" + input.cwd.replaceAll("'", "'\\''") + "'";
    const message =
      "Git doesn't trust this repository because another user owns it. Run " +
      command +
      " to trust it.";
    const codes = all("code", target),
      retry = button("Retry", target);
    const labels = ["Choose branch", "Tags…", "Sync unavailable", "Stashes", "Merge…", "Rebase…"];
    const operations = labels.map((label) => button(label));
    facts = {
      singleTrustAlert: true,
      quotedTrustCommand:
        codes.length === 1 && text(codes[0]!) === command && text(target).includes(message),
      retryEnabled: !!retry && !retry.disabled,
      operationsDisabled: operations.every((node) => node?.disabled === true),
      disabledReasons: operations.every((node) => {
        const ids = (node?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
        return (
          node?.getAttribute("title") === message &&
          ids.length === 1 &&
          text(document.getElementById(ids[0]!)) === message
        );
      }),
    };
    critical.push(...codes, retry, ...operations);
  }
  if (
    !Object.values(facts).every((value) => value === true) ||
    !target ||
    !inView(target) ||
    !critical.every(inView)
  )
    return null;
  return {
    themeMatched: document.documentElement.classList.contains("dark") === (input.theme === "dark"),
    selectedMatched: true,
    expectedTextMatched: true,
    targetInView: true,
    credentialAbsent: true,
    bootShellAbsent: true,
    ...facts,
  };
}

const common = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
] as const;
const facts = {
  "worktree-remove-busy": [
    "singleRemovalDialog",
    "runningReason",
    "destructiveDisabled",
    "reasonLinked",
    "checkoutIdentityMatched",
  ],
  "project-clone-progress": [
    "singleCloneForm",
    "cloneRunning",
    "cancelEnabled",
    "inputsRetained",
    "inputsDisabled",
  ],
  "git-trust-refusal": [
    "singleTrustAlert",
    "quotedTrustCommand",
    "retryEnabled",
    "operationsDisabled",
    "disabledReasons",
  ],
} as const;
const refused = () => new Error("Owned project lifecycle capture refused.");

function scene(value: unknown): ProjectLifecycleScene {
  if (typeof value !== "string" || !projectLifecycleScenes.some((entry) => entry === value))
    throw refused();
  return value as ProjectLifecycleScene;
}

function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || NodeUtil.types.isProxy(input))
    throw refused();
  const own = Reflect.ownKeys(input);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    throw refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw refused();
    result[key] = descriptor.value;
  }
  return result;
}

export interface ProjectLifecycleFlowInput {
  readonly scene: ProjectLifecycleScene;
  readonly theme: "light" | "dark";
  readonly verifyOwnedIdentity: () => Promise<void>;
  readonly step: (phase: string) => void;
  readonly capture: () => Promise<unknown>;
  /** Root records only a fixed role and the existing closed error classifier. */
  readonly observeCleanupFailure?: (role: string, error: unknown) => void;
  readonly busy: {
    readonly openIdleRemovalDialog: () => Promise<void>;
    readonly startHeldTurn: () => Promise<void>;
    readonly verifyRunningAndRefused: () => Promise<void>;
    readonly closeRemovalDialog: () => Promise<void>;
    readonly stopAndJoinTurn: () => Promise<void>;
    readonly verifyCheckoutRetained: () => Promise<void>;
  };
  readonly clone: {
    readonly openAndSubmit: () => Promise<void>;
    readonly verifySingleHeldTransfer: () => Promise<void>;
    readonly cancelPublicly: () => Promise<void>;
    readonly verifyCancelledAndJoined: () => Promise<void>;
    readonly verifyInputsAndOriginRetained: () => Promise<void>;
  };
  readonly trust: {
    readonly selectOwnedGitManager: () => Promise<void>;
    readonly removeOwnedExemption: () => Promise<void>;
    readonly refreshAndVerifyUntrusted: () => Promise<void>;
    readonly restoreOwnedExemption: () => Promise<void>;
    readonly refreshAndVerifyReadable: () => Promise<void>;
  };
}

export function lifecycleScreenshotName(value: unknown, theme: unknown): string {
  const selected = scene(value);
  if (theme !== "light" && theme !== "dark") throw refused();
  return `${selected}-${theme}.png`;
}
export function validateProjectLifecycleWitness(value: ProjectLifecycleScene, input: unknown) {
  const selected = scene(value);
  const keys = [...common, ...facts[selected]];
  const row = data(input, keys);
  if (!keys.every((key) => row[key] === true)) throw refused();
  validateCaptureWitness(Object.fromEntries(common.map((key) => [key, row[key]])));
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, true] as const)));
}
export function projectLifecycleCapture(value: unknown) {
  const row = data(value, [
    "scene",
    "theme",
    "file",
    "witness",
    "width",
    "height",
    "nonBlank",
    "sha256",
  ]);
  const selected = scene(row.scene);
  if (
    row.file !== lifecycleScreenshotName(selected, row.theme) ||
    row.width !== 1280 ||
    row.height !== 960 ||
    row.nonBlank !== true ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.sha256)
  )
    throw refused();
  return Object.freeze({
    scene: selected,
    theme: row.theme,
    file: row.file,
    witness: validateProjectLifecycleWitness(selected, row.witness),
    width: 1280,
    height: 960,
    nonBlank: true,
    sha256: row.sha256,
  });
}

export function projectLifecycleAssertion(theme: unknown, input: unknown) {
  lifecycleScreenshotName(projectLifecycleScenes[0], theme);
  if (
    !Array.isArray(input) ||
    NodeUtil.types.isProxy(input) ||
    input.length !== projectLifecycleScenes.length
  )
    throw refused();
  const rows = projectLifecycleScenes.map((_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (!field || !Object.hasOwn(field, "value")) throw refused();
    const row = data(field.value, [
      "scene",
      "theme",
      "existingRowOnly",
      "completeGroup",
      "joinedCleanup",
    ]);
    scene(row.scene);
    if (
      row.theme !== theme ||
      row.existingRowOnly !== true ||
      row.completeGroup !== false ||
      row.joinedCleanup !== true
    )
      throw refused();
    return row;
  });
  if (new Set(rows.map((row) => row.scene)).size !== projectLifecycleScenes.length) throw refused();
  return Object.freeze({
    theme,
    rows: Object.freeze(
      projectLifecycleScenes.map((name) => Object.freeze(rows.find((row) => row.scene === name)!)),
    ),
  });
}
export function validateProjectLifecycleJoins(
  captures: readonly unknown[],
  assertions: readonly unknown[],
) {
  if (
    NodeUtil.types.isProxy(captures) ||
    NodeUtil.types.isProxy(assertions) ||
    captures.length !== 6 ||
    assertions.length !== 2
  )
    throw refused();
  const files = new Set<string>(),
    themes = new Set<unknown>();
  for (const value of captures) {
    const capture = projectLifecycleCapture(value);
    if (files.has(capture.file)) throw refused();
    files.add(capture.file);
  }
  for (const value of assertions) {
    const row = data(value, ["theme", "rows"]),
      projected = projectLifecycleAssertion(row.theme, row.rows);
    if (themes.has(projected.theme)) throw refused();
    themes.add(projected.theme);
  }
  if (
    !themes.has("light") ||
    !themes.has("dark") ||
    !["light", "dark"].every((theme) =>
      projectLifecycleScenes.every((name) => files.has(lifecycleScreenshotName(name, theme))),
    )
  )
    throw refused();
  return Object.freeze({ existingRowsOnly: true, completeGroup: false, originalCount: 6 });
}

/** Only public actions and genuine source joins; no canonical or renderer-state injection. */
export async function runProjectLifecycleScene(input: ProjectLifecycleFlowInput) {
  const selected = scene(input.scene);
  lifecycleScreenshotName(selected, input.theme);
  await input.verifyOwnedIdentity();
  let admitted = false;
  let originalFailed = false;
  const cleanup: Array<readonly [string, () => Promise<void>]> = [];
  const verify =
    selected === "worktree-remove-busy"
      ? () => input.busy.verifyRunningAndRefused()
      : selected === "project-clone-progress"
        ? () => input.clone.verifySingleHeldTransfer()
        : () => input.trust.refreshAndVerifyUntrusted();
  try {
    input.step(`visual-project-lifecycle-${selected}-prepare`);
    if (selected === "worktree-remove-busy") {
      cleanup.push(["lifecycle-busy-dialog", () => input.busy.closeRemovalDialog()]);
      await input.busy.openIdleRemovalDialog();
      cleanup.push(["lifecycle-busy-turn", () => input.busy.stopAndJoinTurn()]);
      cleanup.push(["lifecycle-busy-retained", () => input.busy.verifyCheckoutRetained()]);
      admitted = true;
      await input.busy.startHeldTurn();
      await input.busy.verifyCheckoutRetained();
    } else if (selected === "project-clone-progress") {
      cleanup.push(["lifecycle-clone-cancel", () => input.clone.cancelPublicly()]);
      cleanup.push(["lifecycle-clone-join", () => input.clone.verifyCancelledAndJoined()]);
      cleanup.push(["lifecycle-clone-retained", () => input.clone.verifyInputsAndOriginRetained()]);
      admitted = true;
      await input.clone.openAndSubmit();
    } else {
      await input.trust.selectOwnedGitManager();
      cleanup.push(["lifecycle-trust-restore", () => input.trust.restoreOwnedExemption()]);
      cleanup.push(["lifecycle-trust-readable", () => input.trust.refreshAndVerifyReadable()]);
      admitted = true;
      await input.trust.removeOwnedExemption();
    }
    await verify();
    input.step(`visual-project-lifecycle-${selected}-capture`);
    await input.verifyOwnedIdentity();
    await input.capture();
    await input.verifyOwnedIdentity();
    await verify();
  } catch (error) {
    originalFailed = true;
    throw error;
  } finally {
    const failures: unknown[] = [];
    for (const [role, close] of cleanup) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
        try {
          input.observeCleanupFailure?.(role, error);
        } catch {
          /* Observation does not replace an error. */
        }
      }
    }
    // Keep the original failure and its phase; restoration never publishes another step.
    if (!originalFailed && failures.length > 0) throw failures[0];
  }
  if (!admitted) throw refused();
  return Object.freeze({
    scene: selected,
    theme: input.theme,
    existingRowOnly: true,
    completeGroup: false,
    joinedCleanup: true,
  });
}

/** The existing public model picker may update only this decoded, untouched managed workspace. */
export async function selectLifecycleCodexWorkspace(input: {
  readonly browser: QualificationBrowser;
  readonly owner: Pick<QualificationOwner, "until">;
  readonly readSnapshot: () => Promise<unknown>;
  readonly projectPath: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly verifyOwnedIdentity: () => Promise<void>;
  readonly step: (phase: string) => void;
}) {
  const empty = async () => {
    const model: OrchestrationReadModel = Schema.decodeUnknownSync(OrchestrationReadModel)(
      await input.readSnapshot(),
    );
    const matching = model.threads.filter(
      (thread) =>
        thread.id === input.threadId &&
        thread.kind === "workspace" &&
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        thread.worktreePath === input.cwd &&
        thread.branch === input.branch,
    );
    if (matching.length !== 1) throw refused();
    const thread = matching[0]!,
      projects = model.projects.filter(
        (project) =>
          project.id === thread.projectId &&
          project.deletedAt === null &&
          project.workspaceRoot === input.projectPath,
      );
    if (
      projects.length !== 1 ||
      thread.session !== null ||
      thread.latestTurn !== null ||
      thread.messages.length !== 0 ||
      thread.activities.length !== 0 ||
      thread.checkpoints.length !== 0 ||
      thread.proposedPlans.length !== 0
    )
      throw refused();
    return thread;
  };
  await input.verifyOwnedIdentity();
  await empty();
  const form =
      '[data-center-surface-host="chat:host"][data-visible="true"] [data-chat-composer-form="true"]',
    picker = form + ' [data-chat-provider-model-picker="true"]';
  const click = async (selector: string) => {
    const element = input.browser.$(selector);
    await element.waitForDisplayed();
    if ((await (await input.browser.$$(selector)).length) !== 1) throw refused();
    await element.waitForEnabled();
    await element.click();
  };
  input.step("visual-project-lifecycle-codex-picker");
  await click(picker);
  input.step("visual-project-lifecycle-codex-select");
  await click(
    '[data-model-picker-content="true"] [data-model-picker-instance-id="codex"][data-model-picker-model-slug="gpt-5.4"]',
  );
  await input.owner.until(async () => {
    const thread = await empty();
    return (
      thread.modelSelection.instanceId === "codex" &&
      thread.modelSelection.model === "gpt-5.4" &&
      (await input.browser.$(picker).getAttribute("aria-label")) === "Codex · GPT-5.4"
    );
  });
  await input.verifyOwnedIdentity();
}

export interface ProjectLifecycleSourceJoinInput {
  readonly owner: Pick<QualificationOwner, "until">;
  readonly binding: ProjectLifecycleObservation;
  readonly fixture: Awaited<ReturnType<typeof prepareProjectLifecycleFixture>>;
  readonly serverPid: number;
  readonly rpc: {
    readonly snapshot: () => Promise<unknown>;
    readonly dispatch: (input: ClientOrchestrationCommand) => Promise<unknown>;
    readonly removalPlan: (input: WorktreeGetRemovalPlanInput) => Promise<unknown>;
    readonly remove: (input: WorktreeRemoveInput) => Promise<unknown>;
    /** The supplied port must use the existing join-only typed public vcs.clone request. */
    readonly attachClone: (input: GitCloneInput) => Promise<unknown>;
    /** Existing vcs.refreshStatus publishes the genuine re-read to subscribed public UI. */
    readonly refreshStatus: (input: VcsStatusInput) => Promise<unknown>;
  };
  readonly newCommandId: () => string;
  readonly nowIsoDate: () => string;
  readonly readNativeInputs: () => readonly ProviderChatNativeInput[];
  readonly verifyProviderLive: (turnId: string) => Promise<void>;
  readonly verifyProviderReaped: () => Promise<void>;
  readonly verifyCheckoutRetained: () => Promise<void>;
  readonly verifyFixtureInputsRetained: () => Promise<void>;
  readonly verifyServerOwned: () => Promise<void>;
}

/** Decoded source joins. Public UI actions remain the existing caller/browser actions. */
export function createProjectLifecycleSourceJoins(input: ProjectLifecycleSourceJoinInput) {
  const activeFree = (value: unknown, depth = 0): void => {
    if (depth > 64) throw refused();
    if (value === null || typeof value !== "object") return;
    if (NodeUtil.types.isProxy(value) || Reflect.ownKeys(value).length > 20000) throw refused();
    for (const key of Reflect.ownKeys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !Object.hasOwn(field, "value")) throw refused();
      activeFree(field.value, depth + 1);
    }
  };
  const decode = <A>(schema: { readonly Type: A }, value: unknown): A => {
    activeFree(value);
    try {
      return Schema.decodeUnknownSync(schema)(value);
    } catch {
      throw refused();
    }
  };
  const binding = input.binding;
  if (
    binding.origin !== "http://127.0.0.1:4885" ||
    !["light", "dark"].includes(binding.theme) ||
    ![binding.projectId, binding.threadId].every((value) =>
      /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    ) ||
    binding.cloneUrl !== input.fixture.cloneUrl ||
    binding.cloneParent !== input.fixture.cloneParent
  )
    throw refused();
  const currentThread = async () => {
    await input.verifyServerOwned();
    const model = decode(OrchestrationReadModel, await input.rpc.snapshot());
    const threads = model.threads.filter(
      (thread) =>
        thread.id === binding.threadId &&
        thread.projectId === binding.projectId &&
        thread.deletedAt === null &&
        thread.archivedAt === null,
    );
    const projects = model.projects.filter(
      (project) => project.id === binding.projectId && project.deletedAt === null,
    );
    if (threads.length !== 1 || projects.length !== 1) throw refused();
    const thread = threads[0]!;
    if (binding.scene === "worktree-remove-busy") {
      if (
        thread.kind !== "workspace" ||
        thread.worktreePath !== binding.cwd ||
        thread.branch !== binding.branch ||
        projects[0]!.workspaceRoot !== input.fixture.primaryCheckout
      )
        throw refused();
    } else if (binding.scene === "git-trust-refusal") {
      if (
        binding.cwd !== input.fixture.trustCheckout ||
        projects[0]!.workspaceRoot !== binding.cwd ||
        thread.kind !== "default" ||
        thread.worktreePath !== null ||
        binding.branch !== "main" ||
        thread.branch !== null
      )
        throw refused();
    } else if (binding.scene === "project-clone-progress") {
      if (
        binding.cwd !== input.fixture.primaryCheckout ||
        projects[0]!.workspaceRoot !== binding.cwd ||
        thread.kind !== "default" ||
        thread.worktreePath !== null ||
        binding.branch !== "main" ||
        thread.branch !== null
      )
        throw refused();
    }
    return thread;
  };
  let before: OrchestrationThread | null = null,
    original: ProviderChatMessageBinding | null = null;
  let beforeInputCount = 0,
    started = false,
    removalRefused = false;
  const verifyIdleRemovalContext = async () => {
    if (binding.scene !== "worktree-remove-busy") throw refused();
    const thread = await currentThread();
    if (
      thread.session?.status === "running" ||
      thread.session?.status === "starting" ||
      thread.session?.activeTurnId != null ||
      thread.latestTurn?.state === "running"
    )
      throw refused();
    await input.verifyCheckoutRetained();
  };
  const command = (value: unknown) => decode(OrchestrationRpcSchemas.dispatchCommand.input, value);
  const dispatch = async (value: ClientOrchestrationCommand) =>
    decode(OrchestrationRpcSchemas.dispatchCommand.output, await input.rpc.dispatch(value));
  const startHeldTurn = async () => {
    if (binding.scene !== "worktree-remove-busy" || started) throw refused();
    before = await currentThread();
    if (before.modelSelection.instanceId !== "codex") throw refused();
    beforeInputCount = input.readNativeInputs().length;
    const request = command({
      type: "thread.turn.start",
      commandId: input.newCommandId(),
      threadId: binding.threadId,
      message: {
        messageId: input.newCommandId(),
        role: "user",
        text: lifecycleBusyPrompt,
        attachments: [],
      },
      modelSelection: before.modelSelection,
      runtimeMode: before.runtimeMode,
      interactionMode: before.interactionMode,
      createdAt: input.nowIsoDate(),
    });
    started = true;
    await dispatch(request);
    await input.owner.until(async () => {
      const thread = await currentThread();
      try {
        original = bindProviderChatMessage({
          before: before!,
          after: thread,
          prompt: lifecycleBusyPrompt,
          provider: "codex",
          state: "running",
          inputs: input.readNativeInputs(),
          beforeInputCount,
        });
      } catch {
        return false;
      }
      if (original.turnId === null) return false;
      await input.verifyProviderLive(original.turnId);
      await input.verifyCheckoutRetained();
      return true;
    });
  };
  const verifyRunningAndRefused = async () => {
    if (
      binding.scene !== "worktree-remove-busy" ||
      !original ||
      !before ||
      original.turnId === null
    )
      throw refused();
    const thread = await currentThread();
    const observed = bindProviderChatMessage({
      before,
      after: thread,
      prompt: lifecycleBusyPrompt,
      provider: "codex",
      state: "running",
      inputs: input.readNativeInputs(),
      beforeInputCount,
    });
    if (
      observed.turnId !== original.turnId ||
      observed.messageId !== original.messageId ||
      thread.session?.status !== "running"
    )
      throw refused();
    await input.verifyProviderLive(original.turnId);
    await input.verifyCheckoutRetained();
    if (!removalRefused) {
      const plan = decode(
        WorktreeRemovalPlan,
        await input.rpc.removalPlan(
          decode(WorktreeGetRemovalPlanInput, {
            projectId: binding.projectId,
            threadId: binding.threadId,
          }),
        ),
      );
      if (
        plan.availability !== "present" ||
        !plan.registered ||
        plan.locked ||
        plan.trackedChangeCount !== 0 ||
        plan.untrackedFileCount !== 0 ||
        plan.pruneImpact.length !== 0
      )
        throw refused();
      const request = decode(WorktreeRemoveInput, {
        commandId: input.newCommandId(),
        projectId: binding.projectId,
        threadId: binding.threadId,
        mode: "delete-git-worktree",
        expectedGeneration: plan.generation,
        planToken: plan.planToken,
        forceDirty: false,
        confirmRepositoryWidePrune: false,
      });
      let refusal: unknown;
      try {
        await input.rpc.remove(request);
      } catch (error) {
        refusal = error;
      }
      if (decode(WorktreeRemovalError, refusal).reason !== "session-running") throw refused();
      removalRefused = true;
    }
    await input.verifyCheckoutRetained();
  };
  const stopAndJoinTurn = async () => {
    if (!started) return;
    await dispatch(
      command({
        type: "thread.session.stop",
        commandId: input.newCommandId(),
        threadId: binding.threadId,
        createdAt: input.nowIsoDate(),
      }),
    );
    await input.owner.until(async () => {
      const thread = await currentThread();
      return (
        (thread.session === null || thread.session.status === "stopped") &&
        thread.session?.activeTurnId == null &&
        thread.latestTurn?.state !== "running"
      );
    });
    await input.verifyProviderReaped();
    await input.verifyCheckoutRetained();
    started = false;
  };
  let attached: Promise<void> | null = null,
    terminal: { ok: boolean; value: unknown } | null = null;
  let held: string | null = null;
  const verifySingleHeldTransfer = async () => {
    if (binding.scene !== "project-clone-progress") throw refused();
    await currentThread();
    await input.verifyServerOwned();
    await input.fixture.verifyCloneConfiguration();
    await input.verifyFixtureInputsRetained();
    await input.owner.until(() => input.fixture.heldTransferReady());
    const proof = await input.fixture.verifyHeldTransferOwner(input.serverPid),
      identity = JSON.stringify(proof);
    if (held !== null && held !== identity) throw refused();
    held = identity;
    if (!attached) {
      const payload = decode(GitCloneInput, {
        url: input.fixture.cloneUrl,
        parentDir: input.fixture.cloneParent,
        attach: true,
      });
      attached = input.rpc.attachClone(payload).then(
        (value) => {
          terminal = { ok: true, value };
        },
        (error) => {
          terminal = { ok: false, value: error };
        },
      );
    }
    await Promise.resolve();
    await Promise.resolve();
    if (terminal !== null) throw refused();
  };
  const verifyCancelledAndJoined = async () => {
    if (!attached || held === null) throw refused();
    await bounded(attached, 10000);
    const outcome = terminal as { ok: boolean; value: unknown } | null;
    if (!outcome || outcome.ok) throw refused();
    const error = decode(GitCloneOperationError, outcome.value);
    if (
      error.reason !== "cancelled" ||
      error.destination !== NodePath.join(input.fixture.cloneParent, "lifecycle-origin")
    )
      throw refused();
    await input.fixture.verifyHeldTransferReaped();
    await input.verifyFixtureInputsRetained();
  };
  const refreshAndVerifyUntrusted = async () => {
    if (binding.scene !== "git-trust-refusal") throw refused();
    await currentThread();
    await input.fixture.verifyTargetExemptionRemoved();
    const status = decode(
      VcsStatusResult,
      await input.rpc.refreshStatus(decode(VcsStatusInput, { cwd: input.fixture.trustCheckout })),
    );
    if (status.isRepo || status.repositoryUnavailableReason !== "untrusted") throw refused();
  };
  const refreshAndVerifyReadable = async () => {
    if (binding.scene !== "git-trust-refusal") throw refused();
    await currentThread();
    const status = decode(
      VcsStatusResult,
      await input.rpc.refreshStatus(decode(VcsStatusInput, { cwd: input.fixture.trustCheckout })),
    );
    if (!status.isRepo || status.repositoryUnavailableReason !== undefined) throw refused();
    await input.verifyFixtureInputsRetained();
  };
  return Object.freeze({
    verifyIdleRemovalContext,
    verifyCheckoutRetained: () => input.verifyCheckoutRetained(),
    verifyFixtureInputsRetained: () => input.verifyFixtureInputsRetained(),
    startHeldTurn,
    verifyRunningAndRefused,
    stopAndJoinTurn,
    verifySingleHeldTransfer,
    verifyCancelledAndJoined,
    refreshAndVerifyUntrusted,
    refreshAndVerifyReadable,
  });
}

export interface ProjectLifecycleBrowserFlowInput {
  readonly browser: QualificationBrowser;
  readonly owner: Pick<QualificationOwner, "until">;
  readonly binding: ProjectLifecycleObservation;
  readonly fixture: Awaited<ReturnType<typeof prepareProjectLifecycleFixture>>;
  readonly source: ReturnType<typeof createProjectLifecycleSourceJoins>;
  readonly verifyOwnedIdentity: () => Promise<void>;
  /** Existing public import and schema-bound context selection, never renderer state. */
  readonly selectTrustProject: () => Promise<void>;
}

export function createProjectLifecycleBrowserFlows(input: ProjectLifecycleBrowserFlowInput) {
  const browser = input.browser,
    binding = input.binding;
  lifecycleScreenshotName(binding.scene, binding.theme);
  const row = (expected: ProjectLifecycleScene) => {
    if (binding.scene !== expected) throw refused();
  };
  const popup = '[data-slot="dialog-popup"][role="dialog"]';
  const click = async (selector: string) => {
    const control = browser.$(selector);
    await control.waitForDisplayed();
    if ((await (await browser.$$(selector)).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.click();
  };
  const inputsRetained = async () => {
    if (
      (await browser.$("#add-project-clone-url").getValue()) !== input.fixture.cloneUrl ||
      (await browser.$("#add-project-clone-parent").getValue()) !== input.fixture.cloneParent
    )
      throw refused();
    await input.source.verifyFixtureInputsRetained();
  };
  return {
    busy: {
      openIdleRemovalDialog: async () => {
        row("worktree-remove-busy");
        await input.verifyOwnedIdentity();
        await input.source.verifyIdleRemovalContext();
        const selector = '[data-testid="thread-card-button-' + binding.threadId + '"]';
        await click(selector);
        await input.verifyOwnedIdentity();
        await browser.$(selector).click({ button: "right" });
        await click(
          '//*[@role="menuitem" and not(@aria-disabled="true")][.//span[normalize-space()="Delete Worktree…"]]',
        );
        const destructive = browser.$(
          '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Delete Git worktree and remove"]',
        );
        await destructive.waitForDisplayed();
        await destructive.waitForEnabled();
        await input.source.verifyIdleRemovalContext();
      },
      startHeldTurn: () => input.source.startHeldTurn(),
      verifyRunningAndRefused: () => input.source.verifyRunningAndRefused(),
      closeRemovalDialog: async () => {
        row("worktree-remove-busy");
        if (!(await browser.$(popup).isExisting())) return;
        await click(
          '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Cancel"]',
        );
        await browser.$(popup).waitForDisplayed({ reverse: true });
      },
      stopAndJoinTurn: () => input.source.stopAndJoinTurn(),
      verifyCheckoutRetained: () => input.source.verifyCheckoutRetained(),
    },
    clone: {
      openAndSubmit: async () => {
        row("project-clone-progress");
        await input.verifyOwnedIdentity();
        await input.fixture.verifyCloneConfiguration();
        await input.source.verifyFixtureInputsRetained();
        await click('[data-testid="sidebar-add-project-trigger"]');
        await click(
          '//button[@data-add-project-action="true"][.//span[normalize-space()="Clone from URL"]]',
        );
        await browser.$("#add-project-clone-url").setValue(input.fixture.cloneUrl);
        await browser.$("#add-project-clone-parent").setValue(input.fixture.cloneParent);
        await inputsRetained();
        await click(
          '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Clone"]',
        );
      },
      verifySingleHeldTransfer: () => input.source.verifySingleHeldTransfer(),
      cancelPublicly: async () => {
        row("project-clone-progress");
        const cancel =
          '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Cancel clone"]';
        if (await browser.$(cancel).isExisting()) await click(cancel);
      },
      verifyCancelledAndJoined: () => input.source.verifyCancelledAndJoined(),
      verifyInputsAndOriginRetained: inputsRetained,
    },
    trust: {
      selectOwnedGitManager: async () => {
        row("git-trust-refusal");
        await input.selectTrustProject();
        await input.verifyOwnedIdentity();
        if (binding.title !== NodePath.basename(input.fixture.trustCheckout)) throw refused();
        const selector = 'button[aria-label="Git Manager for ' + binding.title + '"]',
          control = browser.$(selector);
        await control.waitForExist();
        if ((await (await browser.$$(selector)).length) !== 1) throw refused();
        await input.owner.until(async () => {
          if (await control.isFocused()) return true;
          await browser.keys("Tab");
          return control.isFocused();
        });
        await control.waitForDisplayed();
        await control.waitForEnabled();
        await browser.keys("Enter");
        await input.verifyOwnedIdentity();
      },
      removeOwnedExemption: () => input.fixture.setTargetTrust(input.fixture.trustCheckout, false),
      refreshAndVerifyUntrusted: async () => {
        await input.source.refreshAndVerifyUntrusted();
      },
      restoreOwnedExemption: () => input.fixture.setTargetTrust(input.fixture.trustCheckout, true),
      refreshAndVerifyReadable: async () => {
        await click('//*[@role="alert"]//button[normalize-space()="Retry"]');
        await input.source.refreshAndVerifyReadable();
      },
    },
  };
}

export function captureProjectLifecycleScene(
  input: ProjectLifecycleObservation & {
    readonly browser: QualificationBrowser;
    readonly owner: Pick<QualificationOwner, "until">;
    readonly evidence: string;
    readonly captured: Set<string>;
    readonly verifyOwnedIdentity: () => Promise<void>;
    readonly verifySource: () => Promise<void>;
  },
) {
  return captureOwnedVisualScene({
    browser: input.browser,
    owner: input.owner,
    evidence: input.evidence,
    file: lifecycleScreenshotName(input.scene, input.theme),
    captured: input.captured,
    observation: () => ({
      scene: input.scene,
      theme: input.theme,
      origin: input.origin,
      projectId: input.projectId,
      threadId: input.threadId,
      cwd: input.cwd,
      branch: input.branch,
      title: input.title,
      cloneUrl: input.cloneUrl,
      cloneParent: input.cloneParent,
    }),
    read: (value) => input.browser.execute(readProjectLifecycleObservation, value),
    verifyOwnedIdentity: async () => {
      await input.verifyOwnedIdentity();
      await input.verifySource();
    },
    validate: (value) => validateProjectLifecycleWitness(input.scene, value),
    project: (value) =>
      projectLifecycleCapture({ scene: input.scene, theme: input.theme, ...value }),
    refused,
  });
}
// @effect-diagnostics nodeBuiltinImport:off - Closed QA witnesses reject proxies and active fields.
import * as NodeUtil from "node:util";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  ClientOrchestrationCommand,
  OrchestrationReadModel,
  OrchestrationRpcSchemas,
  type OrchestrationThread,
} from "../../../../packages/contracts/src/orchestration.ts";
import {
  GitCloneInput,
  GitCloneOperationError,
  VcsStatusInput,
  VcsStatusResult,
} from "../../../../packages/contracts/src/git.ts";
import {
  WorktreeGetRemovalPlanInput,
  WorktreeRemoveInput,
} from "../../../../packages/contracts/src/rpc.ts";
import {
  WorktreeRemovalPlan,
  WorktreeRemovalError,
} from "../../../../packages/contracts/src/worktree.ts";
import type { prepareProjectLifecycleFixture } from "./release-visual-project-lifecycle-fixture.ts";
import {
  bindProviderChatMessage,
  type ProviderChatNativeInput,
  type ProviderChatMessageBinding,
} from "./release-visual-provider-chat-turns.ts";
import { captureOwnedVisualScene } from "./owned-visual-capture.ts";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { validateCaptureWitness } from "./remote-ui-evidence.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
export const lifecycleBusyPrompt = "Owned lifecycle busy [[slow]]";
