## Large-store compaction, backup and restore, 2026-11-02

The capture the [large-store compaction design](../../plans/2026-11-02-large-store-compaction-design.md)
asks for before merge (issue #262): `bibcode storage compact` and
`bibcode storage restore` on a store of more than 4 GiB, compared with the
pre-compact backup and restore budget, `StoreIoBudget::LARGE_STORE` (30 s plus
240 s per GiB). Raw data: [large-store-compaction-20261102.json](large-store-compaction-20261102.json).

The code is `c3dec1cbc`, built with
`cargo build --release -p bibcode-server --bin bibcode` and
`CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`. The
store is real: one `bibcode serve` start on a scratch data root created and
marked it. Then 48,319 rows of 100 KB incompressible text went into
`projection_projects` and 40 % of them were deleted, which left a 4.86 GB
(4.53 GiB) `state.sqlite` with 1.92 GB of free pages. The commands ran in
order: `inspect`, `compact`, `inspect` with the pre-compact backup present, and
`restore --backup-id` of that backup. Phase times come from the
`storage.compact` profiler event; command times are wall-clock times including
process start. One run per platform, with a warm page cache, because the store
had just been written.

| Platform                                                          | Backup (s) | `VACUUM` (s) | Compact total (s) | Restore (s) | Inspect (s) |
| ----------------------------------------------------------------- | ---------: | -----------: | ----------------: | ----------: | ----------: |
| Windows 11 x64, Ryzen 5 7600, 32 GB, NVMe (NTFS)                  |       18.1 |         21.2 |              41.3 |        13.0 | 1.97 / 1.92 |
| Linux 6.18 (WSL2) in Docker, 12 CPUs, 16 GB VM, ext4 on that NVMe |       21.9 |         21.3 |              44.2 |        17.5 | 0.95 / 0.93 |

The store went from 4.86 GB to 2.92 GB on both. The second inspection lists the
4.86 GB pre-compact backup in the same time as the first, because listing no
longer reads backup contents.

### Against the budget

| Platform | Backup s/GiB | Backup GiB/min | Restore s/GiB | Restore GiB/min | Budget for this store | Backup's share of it |
| -------- | -----------: | -------------: | ------------: | --------------: | --------------------: | -------------------: |
| Windows  |         3.99 |           15.0 |          2.87 |            20.9 |      1,116 s (19 min) |                1.6 % |
| Linux    |         4.84 |           12.4 |          3.86 |            15.5 |      1,116 s (19 min) |                2.0 % |

The budget allows 240 s per GiB; the slowest measured operation used 4.84 s
per GiB, about 50 times less. The design's rule (raise the constant if three
times the slowest measured time per GiB exceeds it) needs 14.5 s per GiB, so
the budget is not too tight and stays at 240 s per GiB. The margin is meant for
what this capture does not cover: a cold page cache, a spinning or network
disk, antivirus scanning on Windows, and a loaded machine. A disk 50 times
slower than this NVMe would still fit.

Not measured: a store created before `auto_vacuum = INCREMENTAL` (this one
started incremental; `VACUUM` does the same rewrite either way), a cold cache,
macOS, and the desktop's WSL restore through `wsl.exe`.
