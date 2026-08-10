use std::path::{Path, PathBuf};

use crate::{
    persistence::Repositories,
    worktree_catalog::{
        WorkspaceAdmissionLease, WorkspaceAvailabilityRegistry, WorkspaceUnavailable,
    },
};

#[derive(Clone)]
pub(crate) struct WorkspaceAdmissionController {
    registry: WorkspaceAvailabilityRegistry,
    repositories: Option<Repositories>,
}

pub(crate) enum WorkspaceAdmissionError {
    Unavailable(WorkspaceUnavailable),
    Resolution(String),
}

impl WorkspaceAdmissionController {
    pub(crate) fn new(registry: WorkspaceAvailabilityRegistry, repositories: Repositories) -> Self {
        Self {
            registry,
            repositories: Some(repositories),
        }
    }

    pub(crate) fn registry_only(registry: WorkspaceAvailabilityRegistry) -> Self {
        Self {
            registry,
            repositories: None,
        }
    }

    pub(crate) async fn acquire_thread<'a>(
        &self,
        thread_id: &str,
        requested_paths: impl IntoIterator<Item = &'a Path>,
    ) -> Result<WorkspaceAdmissionLease, WorkspaceAdmissionError> {
        let mut paths = requested_paths
            .into_iter()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        if let Some(repositories) = &self.repositories
            && let Some(path) = resolve_persisted_workspace(repositories, thread_id).await?
        {
            paths.push(path);
        }
        self.registry
            .acquire_admission(thread_id, paths.iter().map(PathBuf::as_path))
            .await
            .map_err(WorkspaceAdmissionError::Unavailable)
    }
}

async fn resolve_persisted_workspace(
    repositories: &Repositories,
    thread_id: &str,
) -> Result<Option<PathBuf>, WorkspaceAdmissionError> {
    let Some(thread) = repositories
        .get_thread(thread_id.to_owned())
        .await
        .map_err(|error| WorkspaceAdmissionError::Resolution(error.to_string()))?
    else {
        return Ok(None);
    };
    if let Some(path) = thread.worktree_path {
        return Ok(Some(PathBuf::from(path)));
    }
    repositories
        .get_project(thread.project_id)
        .await
        .map(|project| project.map(|project| PathBuf::from(project.workspace_root)))
        .map_err(|error| WorkspaceAdmissionError::Resolution(error.to_string()))
}
