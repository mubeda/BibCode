import { RetryButton } from "../ui/retry-button";
import {
  gitManagerRepositoryUnavailableCopy,
  type GitManagerRepositoryUnavailableReason,
} from "./gitManagerRepositoryAvailability";

interface GitManagerRepositoryUnavailableProps {
  readonly title: string;
  readonly reason: GitManagerRepositoryUnavailableReason;
  readonly cwd: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}

export function GitManagerRepositoryUnavailable({
  title,
  reason,
  cwd,
  retrying,
  onRetry,
}: GitManagerRepositoryUnavailableProps) {
  const copy = gitManagerRepositoryUnavailableCopy(reason, cwd);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6" role="alert">
      <div className="max-w-md text-center">
        <p className="font-medium text-sm text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {copy.beforeCommand}
          {copy.command === null ? null : <code className="break-words">{copy.command}</code>}
          {copy.afterCommand}
        </p>
        <RetryButton className="mt-3" retrying={retrying} onRetry={onRetry} />
      </div>
    </div>
  );
}
