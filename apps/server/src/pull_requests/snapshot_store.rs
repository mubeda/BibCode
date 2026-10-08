//! SQLite-backed display snapshots for GitLab merge request reads.

#![allow(dead_code)]

use rusqlite::{Connection, OptionalExtension, Result, params};

pub(crate) const BYTE_CAP: i64 = 33_554_432;
pub(crate) const FILES_PAYLOAD_CAP: usize = 1_048_576;

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

    pub fn put(&self, snapshot: Snapshot) -> Result<()> {
        if snapshot.kind == "files" && snapshot.payload.len() > FILES_PAYLOAD_CAP {
            return Ok(());
        }
        if self
            .connection
            .query_row(
                "SELECT generation
                 FROM pull_request_snapshots
                 WHERE host = ?1 AND project = ?2 AND kind = ?3 AND key = ?4",
                params![
                    snapshot.host,
                    snapshot.project,
                    snapshot.kind,
                    snapshot.key
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some_and(|existing| existing >= snapshot.generation)
        {
            return Ok(());
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

        Ok(())
    }

    pub fn delete_host(&self, host: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM pull_request_snapshots WHERE host = ?1",
            params![host],
        )?;
        Ok(())
    }

    pub fn delete_number(&self, host: &str, project: &str, number: u64) -> Result<()> {
        self.connection.execute(
            "DELETE FROM pull_request_snapshots
             WHERE host = ?1 AND project = ?2 AND key = ?3",
            params![host, project, number.to_string()],
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
