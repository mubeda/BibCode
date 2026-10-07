"use client";

import { ArrowLeftIcon } from "lucide-react";

import { RemoteDirectoryBrowser } from "./RemoteDirectoryBrowser";
import {
  AddProjectCloneStep,
  AddProjectCreateStep,
  AddProjectHostPathStep,
  AddProjectRemoteBrowseStep,
  AddProjectStartStep,
} from "./add-project/AddProjectSteps";
import { useAddProjectWorkflow } from "./add-project/useAddProjectWorkflow";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "./ui/dialog";

export interface AddProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProjectDialog({ open, onOpenChange }: AddProjectDialogProps) {
  const workflow = useAddProjectWorkflow({ open, onOpenChange });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (workflow.dismissible) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-lg overflow-hidden" showCloseButton={workflow.dismissible}>
        <DialogTitle className="sr-only">Add a project</DialogTitle>
        <DialogDescription className="sr-only">Choose how to add a project.</DialogDescription>
        <div
          className="max-h-[min(80vh,40rem)] overflow-y-auto px-6 py-5"
          data-add-project-content="true"
        >
          {workflow.step !== "start" ? (
            <button
              type="button"
              className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              disabled={workflow.busy}
              onClick={workflow.back}
            >
              <ArrowLeftIcon className="size-4" />
              Back
            </button>
          ) : null}

          {workflow.step === "start" ? (
            <AddProjectStartStep
              hosts={workflow.hosts}
              locationLabel={workflow.locationLabel}
              selectedEnvironmentId={workflow.selectedHost.environmentId}
              busy={workflow.busy}
              error={workflow.error}
              onSelectHost={workflow.selectHost}
              onBrowse={() => void workflow.browse()}
              onOpenClone={workflow.openClone}
              onOpenCreate={workflow.openCreate}
            />
          ) : null}
          {workflow.step === "host-path" ? (
            <AddProjectHostPathStep
              hostLabel={workflow.selectedHost.label}
              path={workflow.hostPath}
              platform={workflow.selectedHost.platform}
              error={workflow.error}
              busy={workflow.busy}
              onPathChange={workflow.setHostPath}
              onSubmit={() => void workflow.submitHostPath()}
            />
          ) : null}
          {workflow.step === "remote-browse" ? (
            <AddProjectRemoteBrowseStep
              hostLabel={workflow.selectedHost.label}
              environmentId={workflow.selectedHost.environmentId}
              initialPath={workflow.selectedHost.baseDirectory}
              busy={workflow.busy}
              error={workflow.error}
              onSelect={(path) => void workflow.selectBrowsedFolder(path)}
              onTypePath={workflow.openHostPath}
            />
          ) : null}
          {workflow.step === "clone" ? (
            <AddProjectCloneStep
              url={workflow.cloneUrl}
              parentDir={workflow.cloneParent}
              platform={workflow.selectedHost.platform}
              error={workflow.error}
              notice={workflow.notice}
              busy={workflow.busy}
              progress={workflow.cloneProgress}
              canPickParent
              onUrlChange={workflow.setCloneUrl}
              onParentDirChange={workflow.setCloneParent}
              onPickParent={() => void workflow.pickCloneParent()}
              onClone={() => void workflow.submitClone()}
              onCancel={workflow.cancelClone}
            />
          ) : null}
          {workflow.step === "clone-parent-browse" || workflow.step === "create-parent-browse" ? (
            <div className="space-y-5">
              <header className="space-y-1">
                <h2 className="font-semibold text-2xl">
                  Choose parent folder on {workflow.selectedHost.label}
                </h2>
                <p className="text-muted-foreground text-sm">
                  {workflow.step === "clone-parent-browse"
                    ? "The repository will be cloned inside this folder."
                    : "The new project folder will be created inside this folder."}
                </p>
              </header>
              <RemoteDirectoryBrowser
                environmentId={workflow.selectedHost.environmentId}
                initialPath={
                  workflow.step === "clone-parent-browse"
                    ? workflow.cloneParent
                    : workflow.createParent
                }
                resetKey={workflow.selectedHost.environmentId}
                onSelect={(path) => void workflow.selectBrowsedFolder(path)}
                onCancel={workflow.back}
                selectLabel="Choose parent folder"
              />
            </div>
          ) : null}
          {workflow.step === "create" ? (
            <AddProjectCreateStep
              name={workflow.createName}
              parentDir={workflow.createParent}
              platform={workflow.selectedHost.platform}
              error={workflow.error}
              busy={workflow.busy}
              canPickParent
              onNameChange={workflow.setCreateName}
              onParentDirChange={workflow.setCreateParent}
              onPickParent={() => void workflow.pickCreateParent()}
              onCreate={() => void workflow.submitCreate()}
            />
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
