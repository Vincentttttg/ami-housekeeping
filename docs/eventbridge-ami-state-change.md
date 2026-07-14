# Reference: `EC2 AMI State Change` EventBridge event

Verified against the official AWS docs on 2026-07-14:
[Monitor AMI events using Amazon EventBridge — Amazon EC2 User Guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitor-ami-events.html)

This is the event that triggers the `ami-housekeeping` Lambda (see the
`AmiBecameAvailable` event in `template.yaml`). EC2 emits it to the **default
EventBridge event bus** whenever an AMI changes state.

## Exact payload (`State: available`), verbatim from AWS docs

```json
{
    "version": "0",
    "id": "example-9f07-51db-246b-d8b8441bcdf0",
    "detail-type": "EC2 AMI State Change",
    "source": "aws.ec2",
    "account": "012345678901",
    "time": "yyyy-mm-ddThh:mm:ssZ",
    "region": "us-east-1",
    "resources": ["arn:aws:ec2:us-east-1::image/ami-0abcdef1234567890"],
    "detail": {
        "RequestId": "example-9dcc-40a6-aa77-7ce457d5442b",
        "ImageId": "ami-0abcdef1234567890",
        "State": "available",
        "ErrorMessage": ""
    }
}
```

Key facts about `detail`:

- Contains **only** `RequestId`, `ImageId`, `State`, `ErrorMessage`.
- **No source instance ID and no tags** — this is why the handler must call
  `DescribeImages` (it checks the trigger `ImageId` against the tagged-AMI list)
  and why per-source-instance retention grouping isn't possible from this event
  alone. (The CloudTrail `CreateImage` event does carry `instanceId`, but
  requires an active CloudTrail trail and fires while the AMI is still
  `pending`.)

## States and the operations that produce them

| Operation | available | failed | deregistered | disabled |
| --- | --- | --- | --- | --- |
| CopyImage | Yes | Yes | | |
| CreateImage | Yes | Yes | | |
| CreateRestoreImageTask | Yes | Yes | | |
| DeregisterImage | | | Yes | |
| DisableImage | | | | Yes |
| EnableImage | Yes | | | |

Implications for this project:

- `available` fires for **five operations**, not just `CreateImage` — copying
  an AMI into the region or re-enabling a disabled one also triggers a
  housekeeping run. Harmless: the tag gate + fresh-state sweep make every run
  safe.
- Our own `DeregisterImage` calls emit `deregistered` events, which our rule
  does **not** match — no self-triggering loop.

## Event pattern used in `template.yaml`

```json
{
  "source": ["aws.ec2"],
  "detail-type": ["EC2 AMI State Change"],
  "detail": { "State": ["available"] }
}
```

## Caveat: best-effort delivery

AWS states events are "generated on a best effort basis" — delivery is not
guaranteed. If an event is dropped, cleanup for that round is skipped until the
next AMI creation triggers a sweep. A periodic cron backstop (SAM `ScheduleV2`
event alongside the `EventBridgeRule` event) was considered and deliberately
deferred; add it if missed cleanups ever matter.
