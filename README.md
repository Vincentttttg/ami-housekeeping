# AMI Housekeeping Lambda

A TypeScript Lambda function that cleans up obsolete AMIs tagged `App=POC-Housekeeping`. It is **event-driven**: an EventBridge rule matches the native `EC2 AMI State Change` event, so the moment a new AMI becomes `available` the function runs and prunes older ones.

## How it works

When any AMI in the account reaches the `available` state, EventBridge invokes the function, which:

1. Lists all AMIs **owned by this account** with the tag `App=POC-Housekeeping`.
2. Checks the AMI that triggered the event — if it doesn't carry the tag, exits without touching anything (the event fires for every AMI in the account, not just ours).
3. Sorts the tagged AMIs by creation date and keeps the latest `KEEP_LATEST` (default **3**); everything older is obsolete.
4. Skips any obsolete AMI still referenced by a non-terminated EC2 instance.
5. Deregisters the remaining AMIs and deletes their backing EBS snapshots.

A manual invoke (empty payload, e.g. `npm run rehearse`) skips step 2 and runs a full sweep.

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
- [AWS CLI v2](https://awscli.amazonaws.com/AWSCLIV2.msi) and [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) (Windows: `winget install Amazon.AWSCLI Amazon.SAM-CLI`, or the MSI installers)
- AWS credentials configured — see below

## Configure AWS credentials (one-time)

Deploying needs credentials on your machine; without them `sam deploy` fails with
`Error: Unable to locate credentials`.

1. **Create an access key** in the AWS console:
   - Sign in → **IAM** → **Users** → select your user → **Security credentials** tab → **Create access key** → choose *Command Line Interface (CLI)*.
   - Copy both the **Access key ID** and the **Secret access key** — the secret is shown only once.
   - Do **not** create access keys for the root account. If you only have the root login, first create an IAM user (IAM → Users → Create user, attach the `AdministratorAccess` policy) and create the key on that user.

2. **Store them with the AWS CLI:**

   ```bash
   aws configure
   # AWS Access Key ID:     <paste>
   # AWS Secret Access Key: <paste>
   # Default region name:   ap-southeast-1   # must be the region where your AMIs live
   # Default output format: json
   ```

   This writes to `~/.aws/credentials` and `~/.aws/config` — outside the project, so nothing sensitive can end up in git. Never paste keys into project files.

3. **Verify:**

   ```bash
   aws sts get-caller-identity
   ```

   If it prints your account ID and user ARN, you're authenticated.

Note these credentials are only used at **deploy time**, from your machine. The deployed
Lambda authenticates with its own IAM execution role (created by the template) — your
access key never leaves your machine.

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
- An EventBridge rule on the default event bus matching `EC2 AMI State Change` events with `State: available`, plus the permission for EventBridge to invoke the function.
- A least-privilege execution role and a 30-day CloudWatch log group.

Override parameters at deploy time, e.g.:

```bash
sam deploy --parameter-overrides DryRun=false KeepLatest=5
```

## Test manually

```bash
aws lambda invoke --function-name ami-housekeeping --payload '{}' out.json
cat out.json
```

The response (and CloudWatch Logs) contains a summary: AMIs scanned, obsolete, deregistered, snapshots deleted, and anything skipped because it was in use.
