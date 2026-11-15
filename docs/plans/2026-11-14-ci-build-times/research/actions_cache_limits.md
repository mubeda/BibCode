# GitHub Actions cache storage limits, eviction and alternatives (as of November 2026)

Research date 2026-11-14. About 14 tool calls; several vendor claims come from search snippets and are flagged as such.

## 1. Per-repository limit, raising it, price

### Takeaway

Default is still 10 GB per repository, but since the 2025-11-20 changelog the limit can be raised, pay-as-you-go. The docs give $0.07 per GiB-month for usage above 10 GB. Whether a public repository can raise the limit and be billed is not stated on any page I could read.

### Cited Findings

- Default is 10 GB per repository. Enterprise owners, organization owners and repository admins can raise it in Actions settings. User-owned repositories can go up to 10 TB, organization-owned ones are capped by the org setting, and enterprise orgs by the enterprise setting. — [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- Changelog 2025-11-20: every repository keeps 10 GB free with a 7-day default retention. Going beyond is pay-as-you-go, and the changelog says exceeding 10 GB requires a Pro, Team or Enterprise account. Two policies exist, a size limit (GB) and a retention limit (days). Enterprise policies cascade down to orgs and repos. — [GitHub changelog](https://github.blog/changelog/2025-11-20-github-actions-cache-size-can-now-exceed-10-gb-per-repository/)
- Price: $0.07 per GB per month (binary GiB, billed in GB-hours). Only usage above 10 GB per repository is billed, measured by peak usage per hour. The owner is charged only if the limit is configured above the included amount. Cache is a separate allowance from artifacts and Packages. — [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- Docs examples (illustrative, fully utilized): 50 GB about $2.80, 200 GB about $13.30, 1000 GB about $69.30 per month. — [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- Budgets: billing owners can set a budget on the new SKU. At the cap the cache becomes read-only for every repository using higher limits until the next cycle. Without a payment method on file, usage is blocked once the included quota is used. — [changelog](https://github.blog/changelog/2025-11-20-github-actions-cache-size-can-now-exceed-10-gb-per-repository/), [billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- How to set it by API: `PUT /repos/{owner}/{repo}/actions/cache/storage-limit` with `max_cache_size_gb`, and `.../cache/retention-limit` with `max_cache_retention_days`. Org uses `/organizations/{org}/actions/cache/...`, enterprise `/enterprises/{e}/actions/cache/...`. Org and enterprise endpoints need `admin:organization` or `admin:enterprise` classic scopes. The API page gives no numeric maximums. — [REST: Actions cache](https://docs.github.com/en/rest/actions/cache)
- Usage endpoint `GET /repos/{owner}/{repo}/actions/cache/usage` refreshes about every 5 minutes. Org-level usage page is `https://github.com/organizations/ORG/settings/actions/caches`. — [REST](https://docs.github.com/en/rest/actions/cache), [changelog 2025-09-29](https://github.blog/changelog/2025-09-29-new-date-for-enforcement-of-cache-eviction-policy/)
- A September 2025 community post says the limit cannot be raised; it predates the 2025-11 change. Some third-party guides still say cache is capped, not billed. — [Discussion 173258](https://github.com/orgs/community/discussions/173258), [latchkey guide](https://latchkey.dev/learn/optimize-ci/github-actions-caching-explained)

### Inferences

- The repo's 17 GB demand would cost about 7 GB x $0.07 = about $0.50 per month at the docs rate, if a public repo is allowed to raise the limit. This is arithmetic, not a quoted figure.
- The docs say user-owned repos can reach 10 TB. If the repo is user-owned the setting is probably reachable by the owner, but a Pro or Team requirement per the changelog may apply.

### Gaps

- Whether public repositories on a Free plan can raise the limit, and whether they are billed, is not stated on any page I read. The billing page covers free runner minutes for public repos but is silent on cache storage. Verify in the repo's Settings > Actions > Caches, or by calling the storage-limit PUT and reading the error.
- Exact maximum values for the limit via the API.

## 2. Eviction rules and "Unable to reserve cache"

### Takeaway

Eviction is LRU by last access, plus removal of entries unused for 7 days. A save that goes over the limit succeeds first, then eviction trims back, and eviction now runs hourly, so oversubscription causes churn (thrash).

### Cited Findings

- Entries not accessed in over 7 days are removed. At the limit, entries are deleted from oldest last-access to most recent. When the limit is exceeded, GitHub saves the new cache and then evicts until under the limit. The docs name the resulting churn "cache thrashing". — [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- Eviction interval: previously every 24 hours, changed to every hour. Enforcement was delayed to November 2025 (exact date not on the page). GitHub warned hourly checks may cause more thrashing. — [changelog 2025-09-29](https://github.blog/changelog/2025-09-29-new-date-for-enforcement-of-cache-eviction-policy/)
- Rate limits per repository: 200 uploads per minute and 1,500 downloads per minute, with `Retry-After` on rejection. — [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- Usage figure refreshes about every 5 minutes, so the 9.98 GiB reading can lag. — [REST](https://docs.github.com/en/rest/actions/cache)
- "Unable to reserve cache with key ..., another job may be creating this cache" is not defined on the official docs page. Community threads attribute it to a key already reserved or existing (a concurrent job, or a prior save that failed between reserve and upload). Fix reported: change the key. These are issue-thread claims, not official. — [setup-node issue summary](https://lightrun.com/answers/actions-setup-node-unable-to-reserve-cache-with-key-node-cache-linux-yarn-another-job-may-be-creating-this-cache), [setup-python issue 826](https://redirect.github.com/actions/setup-python/issues/826)
- Cache entries are keyed immutably: a key that already exists on a scope cannot be overwritten (the "Cache already exists" log line seen with the error above). Not stated on the pages I fetched; from the thread summaries only.

### Inferences

- With 17 GB demanded against 10 GB, each save evicts the oldest-accessed entries, those entries then miss, rebuild, and evict others. "No cache found" on main fits this loop.
- Rust entries that are restored on every run keep fresh access times, so the LRU victims are likely the entries least recently used, for example the per-PR pnpm entries and less frequent jobs.

### Gaps

- No official text on the exact "Unable to reserve" cause; no figure on how long between over-limit save and eviction beyond the hourly interval.

## 3. Scoping by ref, and stopping PRs from saving

### Takeaway

PR runs can restore from the PR merge ref, the base branch and the default branch, but save only to `refs/pull/N/merge`, which only that PR's re-runs can read. Those entries count in the same repo total, so PR-saved pnpm entries are pure waste and should be disabled.

### Cited Findings

- A run restores from its current branch or the default branch. A PR run can also restore from its base branch. Sibling and child branches are not reachable. Tags do not share across names. — [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- Caches created by a PR run are scoped to the merge ref and only re-runs of that PR can restore them. — same page
- Low-trust triggers (`pull_request_target`, `issue_comment`, `workflow_run`) get read-only access to default-branch caches; `pull_request` is unaffected. Only `push`, `workflow_dispatch`, `repository_dispatch`, `delete`, `registry_package`, `page_build` and `schedule` can write the default-branch scope. A failed save in a read-only run is a warning only. — same page
- The docs describe a `cache-mode` key (`read`, `write`, `write-only`, `none`) at workflow or job level. I did not verify its syntax or availability elsewhere. — same page
- `actions/cache/restore` is restore-only (no post step); `actions/cache/save` is save-only; both have `lookup-only`, and `fail-on-cache-miss` on restore. — [actions/cache restore README](https://github.com/actions/cache/blob/main/restore/README.md)
- `Swatinem/rust-cache`: `save-if` (default true) restores only when false, for example `${{ github.ref == 'refs/heads/main' }}`; `lookup-only`; `cache-targets`, `cache-on-failure`, `shared-key`. It removes incremental artifacts and files older than a week before save, and notes the 10 GB limit and base-branch availability. — [rust-cache](https://github.com/Swatinem/rust-cache)
- `actions/setup-node`: `cache: pnpm` enables caching; its README has no save-disable or restore-only input. `package-manager-cache: false` disables auto caching for npm. — [setup-node](https://github.com/actions/setup-node)

### Inferences

- For `actions/setup-node` with `cache: pnpm`, the only lever is to drop `cache:` on PR runs (conditional input expression, or two steps) and use `actions/cache/restore` with the pnpm store path. This follows from the absent input, not from a statement.
- Simplest set: save on `push` to main only (`if: github.event_name == 'push'` on `actions/cache` / `cache/save`, or `save-if` for rust-cache), restore everywhere.

### Gaps

- Did not verify `cache-mode` syntax in the workflow YAML reference.

## 4. Alternative backends

### Takeaway

Real alternatives are sccache with S3/R2/GCS (needs secrets, which fork PRs do not get), sccache on the GHA cache (same pool, no relief), or third-party runner/cache vendors whose cache requires their runners. I found no confirmed free, public-repo-friendly drop-in for GitHub-hosted runners.

### Cited Findings

- sccache GHA backend: `SCCACHE_GHA_ENABLED=on`, needs `ACTIONS_RESULTS_URL` and `ACTIONS_RUNTIME_TOKEN` exported; `SCCACHE_GHA_RW_MODE=READ_ONLY` for read-only; changing `SCCACHE_GHA_VERSION` purges; on rate limit the build completes but may not save. The page does not mention size limits or cache v2. — [sccache GHA.md](https://raw.githubusercontent.com/mozilla/sccache/main/docs/GHA.md)
- sccache with R2: bucket name in `SCCACHE_BUCKET`, endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `SCCACHE_REGION=auto`, keys via the AWS variables. — [sccache docs via search](https://docs.rs/crate/sccache/0.17.0/source/README.md); [Namespace sccache page](https://namespace.so/docs/integrations/sccache)
- Depot and Namespace publish sccache guides. — [Depot](https://depot.dev/blog/sccache-in-github-actions), [Namespace](https://namespace.so/docs/integrations/sccache)
- Blacksmith: co-located actions cache, "no additional cost", 25 GB free per repo per week; sticky disks $0.50/GB/month. Docs conflict on whether `useblacksmith/cache` forks are archived (use upstream actions) versus a one-line swap. Requires Blacksmith runners. — [Blacksmith cache docs](https://docs.blacksmith.sh/github-actions-runners/blacksmith-cache) (search snippet only; not fetched)
- RunsOn: S3 cache in your own AWS account, "Magic Cache" redirects `actions/cache` with no workflow change; opt-in via `extras=s3-cache`. Requires RunsOn runners. — [runs-on caching](https://runs-on.com/reference/caching/), [runs-on/cache](https://github.com/runs-on/cache)
- WarpBuild: `WarpBuilds/cache@v1`, on by default on WarpBuild runners. — [WarpBuild docs](https://docs.warpbuild.com/cache/quickstart)
- Fork PRs do not receive repository secrets by default. This is general GitHub behavior I did not source in this session; search did not return it. Confirm in GitHub docs before relying on it.

### Inferences

- sccache on the GHA backend draws on the same 10 GB pool, so it only helps if it shrinks total size. It stores compiled objects, which can be smaller than whole `target` dirs but spread across many entries.
- An S3/R2/GCS sccache backend fits GitHub-hosted runners and main-branch writes, with PRs read-only or off. Cost not researched.

### Gaps

- Not researched: pricing and caveats for BuildJet, Namespace and Depot caches, artifacts as caches (retention and size limits), GHCR/OCI as a cache store, and R2 or S3 pricing. No claim is made here.
- Vendor pricing for public repos not found.

## 5. 2025-2026 changes to the cache service

### Takeaway

The backend was rewritten (cache service v2, `actions/cache` v4.2.0 and later), the legacy service was sunset in 2025, eviction went hourly, and paid limits arrived in November 2025.

### Cited Findings

- `actions/cache` v4.2.0 and v3.4.0 moved to the rewritten v2 cache service; the legacy service was to be sunset 2025-02-01. Self-hosted runners needed 2.231.0 or newer. This comes from mirrored release notes; I did not see the official discussion. — [RELEASES.md mirror](https://gitea.psi.ch/actions/cache/src/tag/v4/RELEASES.md)
- Current README lists v5 on Node 24, minimum runner 2.327.1. A v6.0.0 changelog mirror exists but is poorly corroborated. — [actions/cache README](https://cdn.jsdelivr.net/gh/actions/cache@main/README.md), [v6 mirror](https://gitea.wp-staging.com/actions/cache/raw/tag/v6.0.0/RELEASES.md)
- 2025-09-29: eviction interval 24 h to hourly, enforcement moved to November 2025. — [changelog](https://github.blog/changelog/2025-09-29-new-date-for-enforcement-of-cache-eviction-policy/)
- 2025-11-20: configurable size and retention limits, paid storage. — [changelog](https://github.blog/changelog/2025-11-20-github-actions-cache-size-can-now-exceed-10-gb-per-repository/)
- The docs now document upload and download rate limits and per-trigger read-only scoping (see sections 2 and 3). — [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

### Gaps

- No official 2026 changelog entries were found; nothing on immutability changes beyond what is above. The search was not exhaustive for 2026.
