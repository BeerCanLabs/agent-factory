# AWS Data Exports for the factory Accountant

Issue #457. The Accountant reads a Cost and Usage Report (CUR 2.0) Data Export from one S3 prefix and maps every dollar to cost center `beercanlabs`. Cost Explorer stays the source until an object for that month has landed, and again if the object cannot be read.

This is a deploy point. Reverting the control-plane pin returns the spend report to Cost Explorer. Leave the bucket in place unless the operator wants the export removed.

## Cost center

All AI, cloud, and tech spend maps to cost center `beercanlabs`.

- Tag keys are `cost-center`, `project`, `env`, and `owner`.
- Tag values are lowercase kebab-case (`agent-factory`, `prod`).
- The `cost-center` value for this spend is `beercanlabs`.
- The `project` tag is the sub-center under BeerCanLabs.
- A line with no `cost-center` tag, a value other than `beercanlabs`, or a value that is not kebab-case is sub-center `untagged`. Those dollars still sit in `beercanlabs`.
- `GET /api/v1/spend/report` returns `allocation.backfill` with `applied: false` and `queuedFor: dale`. The factory does not call a tagging API. Applying tags is a separate yes from the operator.

GCP billing export is already read by the GCP accountant through BigQuery. This checklist does not change that path.

## What the landing zone grants

The `factory-<env>-accountant` role, which the control plane assumes:

- `ce:GetCostAndUsage`, `ce:GetCostForecast`, `ce:GetDimensionValues` (Cost Explorer has no resource ARN).
- ECS `List`/`Describe` of services and tasks, only on the factory cluster.
- `s3:ListBucket` on the data-export bucket, prefix `exports/` only, and `s3:GetObject` on `exports/*`.

The same role denies billing writes, payment and invoice APIs, `bcm-data-exports:*`, object writes and deletes, and compute lifecycle actions (`ecs:RunTask`, `ecs:StopTask`, `ec2:TerminateInstances`, and the matching create/update/delete actions). The control plane's own role is unchanged: it may assume the accountant role and holds no billing or export-bucket permission.

The bucket policy allows `bcm-data-exports.amazonaws.com` to `s3:PutObject` only, and only when the request's source account is this account and the source ARN is an export in `us-east-1`. That is the statement AWS documents for creating a Data Export. The bucket uses SSE-S3. The accountant has no `kms:Decrypt`.

No account id, access key, or export body is committed. The report and the ledger row for a read (`SPEND_REPORT_READ`) carry no credentials.

## Operator checklist

1. Apply the landing zone. Read the `data_export_uri` output (`s3://<bucket>/exports`).
2. In Billing, activate the user-defined cost allocation tags `cost-center`, `project`, `env`, and `owner`.
3. In Billing → Data Exports, create a standard data export (CUR 2.0), not a legacy CUR:
   - Include resource IDs.
   - Include the four cost allocation tags.
   - File format: text/CSV. Compression: gzip. Parquet is ignored.
   - S3 destination: the bucket from `data_export_uri`, prefix `exports/` (for example `exports/cur`).
   - Keep the bucket policy Terraform wrote. Do not accept a console overwrite that drops the source-account condition or adds read or delete.
   - Leave the bucket on SSE-S3. A customer-managed KMS key would make the objects unreadable (the accountant has no `kms:Decrypt`).
4. Wait for the first delivery. AWS can take up to a day, and it does not backfill earlier months. Until `BILLING_PERIOD=<YYYY-MM>` contains a `.csv` or `.csv.gz` object, the spend report for that month stays on Cost Explorer and `allocation.source` is `cost-explorer-fallback`.
5. Read `GET /api/v1/spend/report` (viewer `spend.read`, or a run whose policy grants `factory-spend`). `allocation` has `byService`, `byProject`, `byTag`, `bySubCenter`, tagged and untagged totals, and `centerCoverage: 1`.
6. Review `allocation.backfill`. It is a proposal. Nothing in this ingest applies a tag or changes a resource.

The ingest reads at most 40 CSV objects and 32 MiB each (64 MiB together). A larger prefix is logged and the report falls back to Cost Explorer, so a monthly close is not blocked on this export.

## Rollback

Unset `FACTORY_AWS_DATA_EXPORT_URI` or revert the control-plane image. The accountant returns to Cost Explorer. The bucket can stay.
