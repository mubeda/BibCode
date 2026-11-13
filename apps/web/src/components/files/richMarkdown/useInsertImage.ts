import type { EnvironmentId } from "@bibcode/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import {
  type ChangeEvent,
  type InputHTMLAttributes,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { filePreviewKind } from "../filePreviewMode";
import {
  interpretUploadResponse,
  nextFreeFileName,
  resolveTransferUrl,
  sendBrowserUpload,
} from "../fileTransfers";
import type { RichMarkdownEditor } from "./richMarkdownExtensions";

/** The numbered names tried after the picked one is taken (D8). */
const MAX_NAME_ATTEMPTS = 99;

type Send = (url: string) => Promise<{ status: number; body: string }>;

class InsertImageError extends Error {}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Insert image (R28): copies a picked image into the Markdown file's folder under a free name and
 * links it at the caret. An existing file is never replaced: a taken name moves to the next
 * numbered one. The link is inserted only if the same editor still shows the same file.
 */
export function useInsertImage(input: {
  cwd: string;
  environmentId: string;
  markdownPath: string;
  editor: RichMarkdownEditor | null;
}): {
  pick(): void;
  inputProps: InputHTMLAttributes<HTMLInputElement> & { ref: RefObject<HTMLInputElement | null> };
} {
  const { cwd, environmentId, markdownPath, editor } = input;
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId as EnvironmentId);
  const createUploadUrl = useAtomCommand(projectEnvironment.createUploadUrl, {
    reportFailure: false,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  // What the panel shows now, read when an upload finishes.
  const live = useRef({ editor, markdownPath });
  useEffect(() => {
    live.current = { editor, markdownPath };
  }, [editor, markdownPath]);

  const upload = useCallback(
    async (name: string, send: Send) => {
      const started = live.current;
      const report = (message: string) =>
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Image not inserted", description: message }),
        );
      try {
        if (!["image", "svg"].includes(filePreviewKind(name))) {
          throw new InsertImageError(`${name} is not an image.`);
        }
        if (!httpBaseUrl) throw new InsertImageError("There is no connection to the server.");
        const relativeDirectory = folderOf(started.markdownPath);
        for (let attempt = 0; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
          const fileName = attempt === 0 ? name : nextFreeFileName(name, attempt);
          // Each upload URL names one file, so every new name needs its own.
          const minted = await createUploadUrl({
            environmentId: environmentId as EnvironmentId,
            input: { cwd, relativeDirectory, fileName },
          });
          if (minted._tag === "Failure") {
            if (isAtomCommandInterrupted(minted)) return;
            const error = squashAtomCommandFailure(minted);
            throw new InsertImageError(
              error instanceof Error ? error.message : "The upload could not be prepared.",
            );
          }
          const url = resolveTransferUrl(httpBaseUrl, minted.value.relativeUrl);
          if (url === null)
            throw new InsertImageError("The server did not return a usable upload URL.");
          const response = await send(url);
          const step = interpretUploadResponse(response.status, response.body);
          if (step._tag === "Exists") continue;
          if (step._tag === "TooLarge")
            throw new InsertImageError("The image is larger than the server accepts.");
          if (step._tag === "Failed") throw new InsertImageError(step.message);
          const now = live.current;
          // The image went next to the file it was picked for; a moved or closed file gets no link.
          if (now.editor === started.editor && now.markdownPath === started.markdownPath) {
            started.editor?.insertImage(fileName);
          }
          return;
        }
        throw new InsertImageError(
          `Every name from ${name} to ${nextFreeFileName(name, MAX_NAME_ATTEMPTS)} is taken.`,
        );
      } catch (error) {
        report(
          error instanceof InsertImageError ? error.message : "The image could not be copied.",
        );
      }
    },
    [createUploadUrl, cwd, environmentId, httpBaseUrl],
  );

  const pick = useCallback(() => {
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    const pickFiles = bridge?.pickFiles;
    const uploadFile = bridge?.uploadFile;
    if (pickFiles === undefined || uploadFile === undefined) {
      inputRef.current?.click();
      return;
    }
    void (async () => {
      const [path] = await pickFiles({ title: "Choose an image" });
      if (path === undefined) return;
      await upload(path.split(/[\\/]/).pop() ?? path, (url) => uploadFile({ url, path }));
    })();
  }, [upload]);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      // Clear the picker so choosing the same image twice in a row fires another change event.
      event.currentTarget.value = "";
      if (file) void upload(file.name, (url) => sendBrowserUpload(url, file));
    },
    [upload],
  );

  return {
    pick,
    inputProps: { ref: inputRef, type: "file", accept: "image/*", hidden: true, onChange },
  };
}
