//! SQLite-backed display snapshots for GitLab merge request reads.

#![allow(dead_code)]

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
};

use rusqlite::{Connection, OptionalExtension, Result, params};

/// Per lowercased host, the generation of its last logout or sign-in failure.
/// Every display write checks it on the database worker, so a read that
/// started before the rows were deleted cannot bring them back.
#[derive(Clone, Default)]
pub(crate) struct HostFences(Arc<Mutex<HashMap<String, i64>>>);

impl HostFences {
    /// Raises the fence for `host` to a new generation and returns it.
    pub(crate) fn raise(&self, host: &str) -> i64 {
        let generation = next_generation();
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(host.to_ascii_lowercase(), generation);
        generation
    }

    /// A write stamped at or below the host's fence started before it.
    pub(crate) fn blocks(&self, host: &str, generation: i64) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(host)
            .is_some_and(|fence| generation <= *fence)
    }
}

pub(crate) const BYTE_CAP: i64 = 33_554_432;
pub(crate) const FILES_PAYLOAD_CAP: usize = 1_048_576;
/// A pipeline detail near 1,000 jobs would push a dozen merge request rows
/// out of the shared `BYTE_CAP`; it paints from the live read only.
pub(crate) const PIPELINE_DETAIL_PAYLOAD_CAP: usize = 1_048_576;

static LAST_GENERATION: AtomicI64 = AtomicI64::new(0);

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write order for `put`, taken before the host read starts: epoch
/// milliseconds, bumped past the previous stamp in this process. Rows left by
/// an earlier poller or an earlier server process carry older stamps, so a
/// later read can always replace them; a wall clock moved backwards across a
/// restart holds writes off only until it passes the stored stamps again.
pub(crate) fn next_generation() -> i64 {
    let now = now_ms();
    let previous = LAST_GENERATION
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |last| {
            Some(now.max(last + 1))
        })
        .unwrap_or_else(|last| last);
    now.max(previous + 1)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub host: String,
    pub project: String,
    pub kind: String,
    pub key: String,
    pub fingerprint: String,
    pub payload: Vec<u8>,
    pub observed_at_ms: i64,
    pub generation: i64,
}

pub struct SnapshotStore<'a> {
    connection: &'a Connection,
}

impl<'a> SnapshotStore<'a> {
    #[must_use]
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    pub fn get(
        &self,
        host: &str,
        project: &str,
        kind: &str,
        key: &str,
    ) -> Result<Option<Snapshot>> {
        self.connection
            .query_row(
                "SELECT host, project, kind, key, fingerprint, payload, observed_at_ms, generation
                 FROM pull_request_snapshots
                 WHERE host = ?1 AND project = ?2 AND kind = ?3 AND key = ?4",
                params![host, project, kind, key],
                |row| {
                    Ok(Snapshot {
                        host: row.get(0)?,
                        project: row.get(1)?,
                        kind: row.get(2)?,
                        key: row.get(3)?,
                        fingerprint: row.get(4)?,
                        payload: row.get(5)?,
                        observed_at_ms: row.get(6)?,
                        generation: row.get(7)?,
                    })
                },
            )
            .optional()
    }

    /// `Ok(true)` when the row was written; `Ok(false)` when a row of the same
    /// or a newer generation is already stored (or a files payload is over its
    /// cap), so the caller can tell its write from one it lost.
    pub fn put(&self, snapshot: Snapshot) -> Result<bool> {
        if snapshot.kind == "files" && snapshot.payload.len() > FILES_PAYLOAD_CAP {
            return Ok(false);
        }
        if snapshot.kind == "pipelines_detail"
            && snapshot.payload.len() > PIPELINE_DETAIL_PAYLOAD_CAP
        {
            return Ok(false);
        }
        if self
            .connection
            .query_row(
                "SELECT generation
                 FROM pull_request_snapshots
                 WHERE host = ?1 AND project = ?2 AND kind = ?3 AND key = ?4",
                params![snapshot.host, snapshot.project, snapshot.kind, snapshot.key],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some_and(|existing| existing >= snapshot.generation)
        {
            return Ok(false);
        }

        self.connection.execute(
            "INSERT INTO pull_request_snapshots (
               host, project, kind, key, fingerprint, payload, observed_at_ms, generation
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(host, project, kind, key) DO UPDATE SET
               fingerprint = excluded.fingerprint,
               payload = excluded.payload,
               observed_at_ms = excluded.observed_at_ms,
               generation = excluded.generation",
            params![
                snapshot.host,
                snapshot.project,
                snapshot.kind,
                snapshot.key,
                snapshot.fingerprint,
                snapshot.payload,
                snapshot.observed_at_ms,
                snapshot.generation,
            ],
        )?;

        while self.byte_total()? > BYTE_CAP {
            let deleted = self.connection.execute(
                "DELETE FROM pull_request_snapshots
                 WHERE rowid = (
                   SELECT rowid
                   FROM pull_request_snapshots
                   ORDER BY observed_at_ms ASC
                   LIMIT 1
                 )",
                [],
            )?;
            if deleted == 0 {
                break;
            }
        }

        Ok(true)
    }

    pub fn delete_host(&self, host: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM pull_request_snapshots WHERE host = ?1",
            params![host],
        )?;
        Ok(())
    }

    /// Every row of one kind, for example each stored `context`.
    pub fn list_kind(&self, kind: &str) -> Result<Vec<Snapshot>> {
        let mut statement = self.connection.prepare(
            "SELECT host, project, kind, key, fingerprint, payload, observed_at_ms, generation
             FROM pull_request_snapshots
             WHERE kind = ?1",
        )?;
        statement
            .query_map(params![kind], |row| {
                Ok(Snapshot {
                    host: row.get(0)?,
                    project: row.get(1)?,
                    kind: row.get(2)?,
                    key: row.get(3)?,
                    fingerprint: row.get(4)?,
                    payload: row.get(5)?,
                    observed_at_ms: row.get(6)?,
                    generation: row.get(7)?,
                })
            })?
            .collect()
    }

    /// Every merge request row of one number. Pipelines rows are keyed by
    /// pipeline and job ids, which a merge request number can equal: they stay.
    pub fn delete_number(&self, host: &str, project: &str, number: u64) -> Result<()> {
        self.connection.execute(
            "DELETE FROM pull_request_snapshots
             WHERE host = ?1 AND project = ?2 AND key = ?3 AND kind NOT LIKE 'pipelines!_%' ESCAPE '!'",
            params![host, project, number.to_string()],
        )?;
        Ok(())
    }

    /// One row, and with `attempts` its `<key>:<attempt>` siblings too.
    pub fn delete_keyed(
        &self,
        host: &str,
        project: &str,
        kind: &str,
        key: &str,
        attempts: bool,
    ) -> Result<()> {
        self.connection.execute(
            "DELETE FROM pull_request_snapshots
             WHERE host = ?1 AND project = ?2 AND kind = ?3
               AND (key = ?4 OR (?5 AND substr(key, 1, length(?4) + 1) = ?4 || ':'))",
            params![host, project, kind, key, attempts],
        )?;
        Ok(())
    }

    pub fn byte_total(&self) -> Result<i64> {
        self.connection.query_row(
            "SELECT COALESCE(SUM(length(payload)), 0) FROM pull_request_snapshots",
            [],
            |row| row.get(0),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_request_snapshots_put_reports_written_and_older() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::persistence::run_migrations(&mut connection, None).unwrap();
        let store = SnapshotStore::new(&connection);
        let row = |generation: i64| Snapshot {
            host: "gitlab.com".into(),
            project: "team/repo".into(),
            kind: "pipeline".into(),
            key: "7".into(),
            fingerprint: format!("fp-{generation}"),
            payload: b"{}".to_vec(),
            observed_at_ms: 1,
            generation,
        };
        assert!(store.put(row(2)).unwrap(), "a first write lands");
        assert!(
            !store.put(row(1)).unwrap(),
            "an older generation is refused"
        );
        assert!(
            !store.put(row(2)).unwrap(),
            "the same generation is refused"
        );
        assert!(store.put(row(3)).unwrap(), "a newer generation replaces it");
        assert_eq!(
            store
                .get("gitlab.com", "team/repo", "pipeline", "7")
                .unwrap()
                .unwrap()
                .fingerprint,
            "fp-3"
        );
    }

    /// A successful action forgets every row of its number, the poller's
    /// `pipeline` row included, and leaves other numbers alone.
    #[test]
    fn pull_request_snapshots_delete_number_removes_the_pipeline_row() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::persistence::run_migrations(&mut connection, None).unwrap();
        let store = SnapshotStore::new(&connection);
        let row = |kind: &str, key: &str| Snapshot {
            host: "gitlab.com".into(),
            project: "team/repo".into(),
            kind: kind.into(),
            key: key.into(),
            fingerprint: "fp".into(),
            payload: b"{}".to_vec(),
            observed_at_ms: 1,
            generation: next_generation(),
        };
        for kind in ["pipeline", "probe", "detail"] {
            assert!(store.put(row(kind, "7")).unwrap());
        }
        assert!(store.put(row("pipeline", "8")).unwrap());
        store.delete_number("gitlab.com", "team/repo", 7).unwrap();
        for kind in ["pipeline", "probe", "detail"] {
            assert_eq!(
                store.get("gitlab.com", "team/repo", kind, "7").unwrap(),
                None,
                "{kind}"
            );
        }
        assert!(
            store
                .get("gitlab.com", "team/repo", "pipeline", "8")
                .unwrap()
                .is_some()
        );
    }

    /// A merge request action on number 7 leaves pipeline 7 and job 7.
    #[test]
    fn pull_request_snapshots_delete_number_keeps_pipelines_rows_and_delete_keyed_takes_attempts() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::persistence::run_migrations(&mut connection, None).unwrap();
        let store = SnapshotStore::new(&connection);
        let row = |kind: &str, key: &str| Snapshot {
            host: "gitlab.com".into(),
            project: "team/repo".into(),
            kind: kind.into(),
            key: key.into(),
            fingerprint: "fp".into(),
            payload: b"{}".to_vec(),
            observed_at_ms: 1,
            generation: next_generation(),
        };
        for (kind, key) in [
            ("detail", "7"),
            ("pipelines_detail", "7"),
            ("pipelines_job", "7"),
            ("pipelines_detail", "7:2"),
            ("pipelines_detail", "77"),
        ] {
            assert!(store.put(row(kind, key)).unwrap());
        }
        store.delete_number("gitlab.com", "team/repo", 7).unwrap();
        let get = |kind: &str, key: &str| store.get("gitlab.com", "team/repo", kind, key).unwrap();
        assert!(get("detail", "7").is_none());
        assert!(get("pipelines_detail", "7").is_some());
        assert!(get("pipelines_job", "7").is_some());
        store
            .delete_keyed("gitlab.com", "team/repo", "pipelines_detail", "7", true)
            .unwrap();
        assert!(get("pipelines_detail", "7").is_none());
        assert!(get("pipelines_detail", "7:2").is_none());
        assert!(
            get("pipelines_detail", "77").is_some(),
            "only its own attempts"
        );
        assert!(get("pipelines_job", "7").is_some(), "another kind stays");
    }

    #[test]
    fn pull_request_snapshots_a_pipeline_detail_over_1_mib_is_not_stored() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::persistence::run_migrations(&mut connection, None).unwrap();
        let store = SnapshotStore::new(&connection);
        let row = |size: usize| Snapshot {
            host: "gitlab.com".into(),
            project: "team/repo".into(),
            kind: "pipelines_detail".into(),
            key: "4821".into(),
            fingerprint: "fp".into(),
            payload: vec![b'x'; size],
            observed_at_ms: 1,
            generation: next_generation(),
        };
        assert!(!store.put(row(PIPELINE_DETAIL_PAYLOAD_CAP + 1)).unwrap());
        assert!(store.put(row(PIPELINE_DETAIL_PAYLOAD_CAP)).unwrap());
    }

    #[test]
    fn pull_request_snapshots_host_fence_blocks_writes_that_started_before_it() {
        let fences = HostFences::default();
        let before = next_generation();
        assert!(!fences.blocks("gitlab.com", before));
        fences.raise("GitLab.com");
        assert!(fences.blocks("gitlab.com", before));
        assert!(!fences.blocks("gitlab.com", next_generation()));
        assert!(!fences.blocks("other.example", before));
    }

    #[test]
    fn pull_request_snapshots_generation_is_wall_clock_based_and_strictly_increasing() {
        let before = now_ms();
        let first = next_generation();
        let second = next_generation();
        assert!(
            first >= before,
            "a stamp is never older than the clock it read"
        );
        assert!(
            second > first,
            "two stamps in the same millisecond still order"
        );
    }
}
