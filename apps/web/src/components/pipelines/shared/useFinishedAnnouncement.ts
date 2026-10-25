import { useState } from "react";

/** What is announced when it finishes: a pipeline or a job. */
export interface FinishedSubject {
  readonly id: number;
  readonly status: string;
  /** The host says nothing more will run. */
  readonly terminal: boolean;
  /** The announcement, for example "Pipeline #4821 failed." */
  readonly message: string;
}

interface Shown {
  readonly id: number;
  readonly status: string;
  readonly terminal: boolean;
  readonly settled: boolean;
}

/**
 * Announces a pipeline or job that finished while it was on screen, once. The first
 * copy shown, and a stored copy shown before this mount's own live read answered,
 * never announce. Tracked during render, as the views track their painted copies, so
 * no effect re-renders for it. Shared by the merge request's pipeline summary and
 * the Pipelines module.
 */
export function useFinishedAnnouncement(subject: FinishedSubject | null, settled: boolean): string {
  const [announcement, setAnnouncement] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const current: Shown | null = subject
    ? { id: subject.id, status: subject.status, terminal: subject.terminal, settled }
    : null;
  if (
    shown?.id !== current?.id ||
    shown?.status !== current?.status ||
    shown?.terminal !== current?.terminal ||
    shown?.settled !== current?.settled
  ) {
    if (
      shown !== null &&
      current !== null &&
      subject !== null &&
      shown.settled &&
      shown.id === current.id &&
      !shown.terminal &&
      current.terminal
    )
      setAnnouncement(subject.message);
    setShown(current);
  }
  return announcement;
}
