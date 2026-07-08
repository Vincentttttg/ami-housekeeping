# AMI Housekeeping Lambda

A TypeScript Lambda function, triggered on a schedule by **EventBridge Scheduler**, that cleans up obsolete AMIs tagged `App=POC-Housekeeping`.

## How it works

On each scheduled run the function:

1. Lists all AMIs **owned by this account** with the tag `App=POC-Housekeeping`.
2. Sorts them by creation date and keeps the latest `KEEP_LATEST` (default **3**); everything older is obsolete.
3. Skips any obsolete AMI still referenced by a non-terminated EC2 instance.
4. Deregisters the remaining AMIs and deletes their backing EBS snapshots.

> **Note:** the AMIs themselves must carry the `App=POC-Housekeeping` tag. If you create images from a tagged instance via `CreateImage`, pass `TagSpecifications` (or use the console's "copy tags" option) so the tag lands on the AMI.

## Safety

- **`DRY_RUN` defaults to `true`** — the function only logs what it *would* delete. Set the `DryRun` stack parameter (or the Lambda's `DRY_RUN` env var) to `false` once you've reviewed a dry run in CloudWatch Logs.
- The IAM policy only allows `DeregisterImage` on AMIs tagged `App=POC-Housekeeping`, so a code bug cannot delete unrelated images.
- In-use AMIs are never touched.

## Configuration (Lambda environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `TAG_KEY` | `App` | Tag key to match |
| `TAG_VALUE` | `POC-Housekeeping` | Tag value to match |
| `KEEP_LATEST` | `3` | Number of most recent AMIs to keep |
| `DRY_RUN` | `true` | `false` enables real deletion |

## Prerequisites

- Node.js 22+
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS credentials configured (`aws configure` or SSO)

## Develop

```bash
npm install
npm run typecheck   # type-check without emitting
npm run build       # bundle to dist/index.js with esbuild
```

## Deploy

The full lifecycle is wrapped in npm scripts:

```bash
npm run deploy:first   # first time only: sam build + interactive guided deploy (dry-run mode)
npm run rehearse       # invoke the function once and print the result — review the delete list
npm run arm            # happy with the rehearsal? redeploy with DryRun=false (real deletions)
npm run disarm         # switch back to dry-run mode at any time
```

`arm` and `disarm` are the **only** two deploy commands after the first — each one rebuilds, redeploys, and sets the DryRun flag explicitly, so the command you run is always the mode you get. For routine code changes, rerun whichever mode you're in (normally `npm run arm`).

Or run the underlying commands directly:

```bash
sam build
sam deploy --guided   # first time; afterwards just `sam deploy`
```

This creates:

- The `ami-housekeeping` Lambda (Node.js 22, arm64), bundled by SAM via esbuild.
- An EventBridge Scheduler schedule (`ami-housekeeping-nightly`, daily at 01:00 UTC by default) with its own invoke role.
- A least-privilege execution role and a 30-day CloudWatch log group.

Override parameters at deploy time, e.g.:

```bash
sam deploy --parameter-overrides DryRun=false KeepLatest=5 "ScheduleExpression=rate(12 hours)"
```

## Test manually

```bash
aws lambda invoke --function-name ami-housekeeping --payload '{}' out.json
cat out.json
```

The response (and CloudWatch Logs) contains a summary: AMIs scanned, obsolete, deregistered, snapshots deleted, and anything skipped because it was in use.
