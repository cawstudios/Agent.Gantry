# Deployment Profiles

Operator-facing reference for the three ways Gantry's single binary is deployed:
**workstation**, **fleet**, and the **locked support stack** (a fleet variant).
This doc is the operator view; the decisions behind it are the ADRs:

- [Deployment Modes](../decisions/2026-06-11-deployment-modes.md) — the
  `runtime.deployment_mode` key; topology vs security-posture axes; v1 live
  topology; Phase-4 cutover criteria.
- [Capability Artifacts](../decisions/2026-06-11-capability-artifacts.md) — skills
  and toolchains as current-state S3 artifacts + sandboxed bake jobs.
- [Settings Authority](../decisions/2026-06-11-settings-authority.md) — one
  desired-state service, two surfaces (YAML watcher vs control API).
- [Locked Preset](../decisions/2026-06-11-locked-preset.md) — `access.preset:
  locked`, parent-side enforcement, isolation tiers.
- [Delivery Vehicle](../decisions/2026-06-11-delivery-vehicle.md) — Terraform/
  AWS-first.

Note: "profile" in this doc's title is operator vocabulary for the deployment
shape. The runtime **setting** is `runtime.deployment_mode` (`workstation|fleet`)
— it is **not** named "profile", which is reserved for agent persona tooling. See
[Deployment Modes](../decisions/2026-06-11-deployment-modes.md).

## Architecture Sketch (Fleet)

```
                  ┌─────────────────────────────┐
  Slack/Teams/TG  │   ALB (webhooks, SSE, API)  │
  webhooks ──────►│     control ingress (all)   │
                  └──────────────┬──────────────┘
        ┌────────────────────────┼─────────────────────────┐
        ▼                        ▼                         ▼
  ┌───────────┐          ┌─────────────┐           ┌─────────────┐
  │ live host │          │ job worker 1│    ...    │ job worker N│  ASG, immutable image
  │ (1; lease │          │ + bake jobs │           │             │
  │  failover)│          └──────┬──────┘           └──────┬──────┘
  └────┬──────┘                 │                         │
       │ leases/slots/turns/commands/manifest/settings_revisions
       └──────────────────┬───────────────┬───────────────┘
                          ▼               ▼
               ┌─────────────────┐   ┌──────────────────────┐
               │ RDS Postgres    │   │ S3 artifact store    │
               │ (pgvector)+Proxy│   │ skills/ toolchains/  │
               └─────────────────┘   │ (bake:rw, worker:ro) │
                                     └──────────────────────┘
```

## Mode Matrix

| Concern | Workstation | Fleet | Locked Support Stack |
|---|---|---|---|
| Topology | Single machine, vertical scale | N immutable workers behind ALB; 1 live host + N job workers | Fleet variant; locked agents only |
| Scaling | None (one host) | ASG; horizontal job workers; singleton live host (v1) | Same as fleet, sized per support deployment |
| Capability installs | Live on host (package manager runs) | Artifacts in S3, replace-on-update; sandboxed bake job; **no package manager on workers** | Pre-provisioned only; no live install, no escalation |
| Settings surface | `settings.yaml` watcher → auto-import | Control-API desired-state CRUD; `settings_revisions` + pg_notify; YAML is bootstrap/backup only | Same as fleet |
| Live-turn topology | In-process | 1 lease-elected live host + N standbys: the singleton lease `runtime:live-turn-host:default` gates the live-host services (message polling, new-turn admission, recovery sweep); standbys serve jobs and retry acquisition with backoff; failover RTO = lease TTL (~30s) | Same as fleet |
| Security posture | Relaxed local (may opt into production) | **Production required** | **Production required** |
| Agent access preset | `full` (default) | `full` or `locked` per agent | `locked` |
| Delivery | Local run | Terraform/AWS (`envs/fleet`) | Terraform/AWS (`terraform apply -var-file=support.tfvars`) |
| Isolation | n/a | Per-tenant stack | Isolated stack (default) or co-tenant (cheaper, weaker blast radius) |

## State-Ownership Table

Where each piece of state lives, per mode. "—" means not applicable in that mode.

| State | Workstation | Fleet / Locked |
|---|---|---|
| Desired settings (canonical) | `settings.yaml` (watched, auto-imported) | Postgres `settings_revisions` via control API; `settings.yaml` = bootstrap/backup |
| Secrets / channel credentials | `.env` (local secret source) | Secret manager refs; no secret values in Terraform state |
| Skill source bytes | Local `skills/<name>/` on host disk | **S3** `skills/` (current-state artifact, sha256-verified) |
| Dependency toolchains | Installed live on host | **S3** `toolchains/` (bake-job output, current-state artifact) |
| Runtime/runs/leases/slots/turns/commands | Postgres | Postgres (RDS + Proxy) |
| Worker capability advertisement | n/a (single host) | Postgres `worker_instances.capabilities_json` |
| Activated artifact on a worker | Host disk | **Worker disk** (ephemeral cache; re-fetched/verified from S3, atomic temp-write + rename) |
| Browser profiles | Host disk | Single live host's disk (see Browser Note) |
| Audit / provenance | Postgres audit events | Postgres audit events |

## Upgrade / Skew Matrix

Rolling deploys mix old and new workers, old and new settings revisions, and old
and new artifacts. Each row is a skew scenario with the expected behavior and the
operator-visible signal.

| # | Scenario | Expected behavior | Operator signal |
|---|---|---|---|
| 1 | **Old worker + new settings revision** | Old worker whose code < revision `min_reader_version` **holds last-applied revision**, does not mis-apply | Skew-age alert + `/metrics` skew gauge; resolves as old workers cycle out |
| 2 | **New worker + old revision** | New worker reads the current (older) revision normally; `min_reader_version` only blocks the reverse direction | No alert; normal convergence |
| 3 | **Mixed-version workers mid-deploy** | Both serve; lease fencing + image digest keep terminal writes correct; no split-brain on a run | Worker inventory shows mixed image digests; normal during deploy |
| 4 | **Migration vs old worker** | Additive-only migrations; one pg advisory lock (inside `migrate()`) serializes every migrator — entrypoint passes and runtime boot-time migrations alike, including boots with `GANTRY_SKIP_MIGRATIONS=1`; old worker runs against newer additive schema | Migration runs once (lock holder); losers wait; failure exits non-zero |
| 5 | **Bake artifact vs old worker** | New artifact is replace-on-update; a worker still holding the prior artifact keeps serving until it reconciles (fetch → sha256 verify → atomic activate) | Capability advertised only after activate; hash mismatch → quarantine + `gantry artifacts quarantine rebake` |
| 6 | **Live-host failover during deploy** | Draining live host stops polling/admission, releases the live-turn lease early; a standby acquires via retry-with-backoff (no crash loop), starts the live-host services in-process, and recovers the turn at a higher fencing version | Live-turn `recovered` state; failover RTO ≈ lease TTL (~30s) |

## Security Posture vs Topology

These are **two axes** ([Deployment Modes](../decisions/2026-06-11-deployment-modes.md)):

- **Topology** = `runtime.deployment_mode` (`workstation|fleet`), a settings key.
- **Security posture** = the existing env var (values `production|remote`),
  renamed to `GANTRY_SECURITY_POSTURE` in Phase 3.

Composition: **fleet requires production posture**; workstation defaults to
relaxed local posture and may opt into production. Fleet `/readyz` fails if the
posture is not production.

## Browser Note

Browser state (profiles, sessions) is **stable in v1** because there is **exactly
one live host** — all browser-bearing live turns run on the single live-host
worker, so browser profiles have one home. This **degrades at Phase 4**
(multi-live), when browser-bearing turns can land on different live hosts and a
profile snapshot/restore mechanism becomes necessary. Browser profile
snapshot/restore is deferred — see [TODOS.md](../../TODOS.md). A per-agent browser
kill-switch is the documented v1 mitigation for any agent that must not depend on
single-host browser state.

## Runbook Index

| Runbook | Location | Status |
|---|---|---|
| AWS Terraform deployment (prerequisites → secrets → terraform → seeding → first locked agent → health → rollback → teardown) | `docs/deployment/aws-terraform.md` | Created in Phase 2 |
| Locked support stack | `terraform apply -var-file=support.tfvars` (covered in the AWS Terraform runbook) | Created in Phase 2 |

Measured gates (from the implementation plan): local compose → first agent turn
≤ 15 min; clean AWS account → first locked support-agent turn ≤ 60 min, both via
copy-paste runbook.

## See Also

- [personal-and-enterprise-modes.md](./personal-and-enterprise-modes.md) —
  workstation ↔ personal, fleet ↔ enterprise mapping.
- [multi-worker-execution.md](./multi-worker-execution.md) — job-worker leases,
  fencing, recovery.
- [live-horizontal-execution.md](./live-horizontal-execution.md) — durable
  multi-worker live turns; the singleton live-host lease.
- [TODOS.md](../../TODOS.md) — deferred items (multi-live cutover, browser
  snapshots, GCP/Azure, etc.).
