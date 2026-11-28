import type {
  UserInputQuestion,
  UserInputQuestionOption,
  UserInputResponseDisposition,
} from "@bibcode/contracts";

const RECOMMENDED_MARKER_PATTERN = /\(\s*recommended\s*\)/i;
const TRAILING_RECOMMENDED_PATTERN = /\s*\(\s*recommended\s*\)\s*$/i;
const DRAFT_STORAGE_KEY = "bibcode:pending-user-input-drafts:v1";
const MAX_STORED_DRAFTS = 40;

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

export interface PendingUserInputSubmission {
  readonly answers: Record<string, string | string[]>;
  readonly disposition: UserInputResponseDisposition;
}

export function isRecommendedUserInputOption(option: UserInputQuestionOption): boolean {
  return (
    RECOMMENDED_MARKER_PATTERN.test(option.label) ||
    RECOMMENDED_MARKER_PATTERN.test(option.description)
  );
}

export function formatUserInputOptionLabel(option: UserInputQuestionOption): string {
  const stripped = option.label.replace(TRAILING_RECOMMENDED_PATTERN, "").trim();
  return stripped.length > 0 ? stripped : option.label;
}

export function providerSupportsPendingUserInputCancel(
  provider: string | null | undefined,
): boolean {
  return provider === "antigravity" || provider === "cursor" || provider === "opencode";
}

export function providerRequiresExplicitUserInputSubmit(
  provider: string | null | undefined,
): boolean {
  return provider === "antigravity";
}

export function buildPartialPendingUserInputSubmission(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  mode: "submit" | "skip",
): PendingUserInputSubmission {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const resolved = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (resolved !== null) {
      answers[question.id] = resolved;
    }
  }
  const hasAnswers = Object.keys(answers).length > 0;
  const allAnswered = questions.length > 0 && Object.keys(answers).length === questions.length;
  if (allAnswered) {
    return { answers, disposition: "answered" };
  }
  if (mode === "skip") {
    return { answers, disposition: "skipped" };
  }
  return {
    answers,
    disposition: hasAnswers ? "answered" : "skipped",
  };
}

interface PersistedDraftEntry {
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly updatedAt: number;
}

function draftStorageKey(threadKey: string, requestId: string): string {
  return `${threadKey}::${requestId}`;
}

function getBrowserLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readDraftStore(): Record<string, PersistedDraftEntry> {
  const storage = getBrowserLocalStorage();
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, PersistedDraftEntry> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (!record.answers || typeof record.answers !== "object" || Array.isArray(record.answers)) {
        continue;
      }
      const sanitizedAnswers: Record<string, PendingUserInputDraftAnswer> = {};
      for (const [qId, rawDraft] of Object.entries(record.answers as Record<string, unknown>)) {
        if (!rawDraft || typeof rawDraft !== "object" || Array.isArray(rawDraft)) continue;
        const draftRecord = rawDraft as Record<string, unknown>;
        const selectedOptionLabels = Array.isArray(draftRecord.selectedOptionLabels)
          ? draftRecord.selectedOptionLabels.filter((v): v is string => typeof v === "string")
          : undefined;
        const customAnswer =
          typeof draftRecord.customAnswer === "string" ? draftRecord.customAnswer : undefined;
        sanitizedAnswers[qId] = {
          ...(selectedOptionLabels && selectedOptionLabels.length > 0
            ? { selectedOptionLabels }
            : {}),
          ...(customAnswer !== undefined ? { customAnswer } : {}),
        };
      }
      result[key] = {
        answers: sanitizedAnswers,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function writeDraftStore(store: Record<string, PersistedDraftEntry>): void {
  const storage = getBrowserLocalStorage();
  if (!storage) {
    return;
  }
  try {
    const entries = Object.entries(store);
    if (entries.length === 0) {
      storage.removeItem(DRAFT_STORAGE_KEY);
      return;
    }
    const trimmed =
      entries.length > MAX_STORED_DRAFTS
        ? Object.fromEntries(
            entries
              .toSorted((left, right) => right[1].updatedAt - left[1].updatedAt)
              .slice(0, MAX_STORED_DRAFTS),
          )
        : store;
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota or private-mode failures.
  }
}

export function loadPendingUserInputDraft(
  threadKey: string,
  requestId: string,
): Record<string, PendingUserInputDraftAnswer> | null {
  const store = readDraftStore();
  return store[draftStorageKey(threadKey, requestId)]?.answers ?? null;
}

export function savePendingUserInputDraft(
  threadKey: string,
  requestId: string,
  answers: Record<string, PendingUserInputDraftAnswer>,
  secretQuestionIds?: ReadonlySet<string>,
): void {
  const store = readDraftStore();
  const key = draftStorageKey(threadKey, requestId);
  const filteredAnswers: Record<string, PendingUserInputDraftAnswer> = {};
  for (const [questionId, entry] of Object.entries(answers)) {
    if (secretQuestionIds?.has(questionId)) {
      continue;
    }
    filteredAnswers[questionId] = entry;
  }
  const hasContent = Object.values(filteredAnswers).some(
    (entry) =>
      (entry.customAnswer?.trim().length ?? 0) > 0 || (entry.selectedOptionLabels?.length ?? 0) > 0,
  );
  if (!hasContent) {
    if (key in store) {
      delete store[key];
      writeDraftStore(store);
    }
    return;
  }
  store[key] = { answers: filteredAnswers, updatedAt: Date.now() };
  writeDraftStore(store);
}

export function clearPendingUserInputDraft(threadKey: string, requestId: string): void {
  const store = readDraftStore();
  const key = draftStorageKey(threadKey, requestId);
  if (key in store) {
    delete store[key];
    writeDraftStore(store);
  }
}

export function prunePendingUserInputDraftsForThread(
  threadKey: string,
  openRequestIds: ReadonlySet<string>,
): void {
  const store = readDraftStore();
  const prefix = `${threadKey}::`;
  let changed = false;
  for (const key of Object.keys(store)) {
    if (!key.startsWith(prefix)) continue;
    const requestId = key.slice(prefix.length);
    if (!openRequestIds.has(requestId)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) {
    writeDraftStore(store);
  }
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      normalized.push(trimmed);
    }
  }

  return Array.from(new Set(normalized));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  if (question.multiSelect) {
    const combined = customAnswer
      ? Array.from(new Set([...selectedOptionLabels, customAnswer]))
      : selectedOptionLabels;
    return combined.length > 0 ? combined : null;
  }

  if (customAnswer) {
    return customAnswer;
  }

  return selectedOptionLabels[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
  options?: { readonly multiSelect?: boolean },
): PendingUserInputDraftAnswer {
  const preserveSelections = options?.multiSelect === true || customAnswer.trim().length === 0;
  const selectedOptionLabels = preserveSelections
    ? normalizeSelectedOptionLabels(draft?.selectedOptionLabels)
    : undefined;

  return {
    customAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
    const nextSelectedOptionLabels = selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel];

    return {
      customAnswer: draft?.customAnswer ?? "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionLabels: [optionLabel],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (!answer) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(question, draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer = activeDraft?.customAnswer ?? "";
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabels: normalizeSelectedOptionLabels(activeDraft?.selectedOptionLabels),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer),
  };
}
