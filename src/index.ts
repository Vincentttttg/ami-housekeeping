import {
  DeleteSnapshotCommand,
  DeregisterImageCommand,
  EC2Client,
  paginateDescribeImages,
  paginateDescribeInstances,
  type Image,
} from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({});

const TAG_KEY = process.env.TAG_KEY ?? "App";
const TAG_VALUE = process.env.TAG_VALUE ?? "POC-Housekeeping";
const KEEP_LATEST = Number(process.env.KEEP_LATEST ?? "3");
// Safety default: report what would be deleted without touching anything.
// Set DRY_RUN=false in the Lambda environment to actually delete.
const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

const INSTANCE_FILTER_CHUNK_SIZE = 100;

export interface CleanupResult {
  scanned: number;
  obsolete: number;
  skippedInUse: string[];
  deregistered: string[];
  snapshotsDeleted: string[];
  errors: string[];
  dryRun: boolean;
}

async function findTaggedImages(): Promise<Image[]> {
  const images: Image[] = [];
  const paginator = paginateDescribeImages(
    { client: ec2 },
    {
      Owners: ["self"],
      Filters: [{ Name: `tag:${TAG_KEY}`, Values: [TAG_VALUE] }],
    },
  );
  for await (const page of paginator) {
    images.push(...(page.Images ?? []));
  }
  return images;
}

/**
 * Sorts images newest-first and returns everything beyond the newest
 * KEEP_LATEST. Images without a CreationDate sort as oldest but are
 * conservatively kept (never returned as obsolete).
 */
function selectObsoleteImages(images: Image[]): Image[] {
  const sorted = [...images].sort((a, b) => {
    const timeA = a.CreationDate ? Date.parse(a.CreationDate) : 0;
    const timeB = b.CreationDate ? Date.parse(b.CreationDate) : 0;
    return timeB - timeA;
  });
  return sorted
    .slice(KEEP_LATEST)
    .filter((image) => Boolean(image.ImageId) && Boolean(image.CreationDate));
}

/** Returns the subset of the given AMI IDs still referenced by non-terminated instances. */
async function findImagesInUse(imageIds: string[]): Promise<Set<string>> {
  const inUse = new Set<string>();
  for (let i = 0; i < imageIds.length; i += INSTANCE_FILTER_CHUNK_SIZE) {
    const chunk = imageIds.slice(i, i + INSTANCE_FILTER_CHUNK_SIZE);
    const paginator = paginateDescribeInstances(
      { client: ec2 },
      {
        Filters: [
          { Name: "image-id", Values: chunk },
          {
            Name: "instance-state-name",
            Values: ["pending", "running", "shutting-down", "stopping", "stopped"],
          },
        ],
      },
    );
    for await (const page of paginator) {
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (instance.ImageId) {
            inUse.add(instance.ImageId);
          }
        }
      }
    }
  }
  return inUse;
}

function snapshotIdsOf(image: Image): string[] {
  return (image.BlockDeviceMappings ?? [])
    .map((mapping) => mapping.Ebs?.SnapshotId)
    .filter((id): id is string => Boolean(id));
}

async function deleteImage(image: Image, result: CleanupResult): Promise<void> {
  const imageId = image.ImageId!;
  const snapshotIds = snapshotIdsOf(image);

  if (DRY_RUN) {
    console.log(
      `[DRY RUN] Would deregister ${imageId} (${image.Name ?? "unnamed"}, created ${image.CreationDate}) and delete snapshots: ${snapshotIds.join(", ") || "none"}`,
    );
    result.deregistered.push(imageId);
    result.snapshotsDeleted.push(...snapshotIds);
    return;
  }

  await ec2.send(new DeregisterImageCommand({ ImageId: imageId }));
  console.log(`Deregistered ${imageId} (${image.Name ?? "unnamed"}, created ${image.CreationDate})`);
  result.deregistered.push(imageId);

  for (const snapshotId of snapshotIds) {
    try {
      await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
      console.log(`Deleted snapshot ${snapshotId} (backing ${imageId})`);
      result.snapshotsDeleted.push(snapshotId);
    } catch (error) {
      const message = `Failed to delete snapshot ${snapshotId} of ${imageId}: ${String(error)}`;
      console.error(message);
      result.errors.push(message);
    }
  }
}

export const handler = async (): Promise<CleanupResult> => {
  console.log(
    `AMI housekeeping started. Tag ${TAG_KEY}=${TAG_VALUE}, keeping latest ${KEEP_LATEST} AMI(s), dryRun=${DRY_RUN}`,
  );

  const result: CleanupResult = {
    scanned: 0,
    obsolete: 0,
    skippedInUse: [],
    deregistered: [],
    snapshotsDeleted: [],
    errors: [],
    dryRun: DRY_RUN,
  };

  const images = await findTaggedImages();
  result.scanned = images.length;

  const obsoleteImages = selectObsoleteImages(images);
  result.obsolete = obsoleteImages.length;

  if (obsoleteImages.length === 0) {
    console.log(
      `Nothing to clean up: ${images.length} tagged AMI(s) found, keeping the latest ${KEEP_LATEST}.`,
    );
    return result;
  }

  const inUse = await findImagesInUse(obsoleteImages.map((image) => image.ImageId!));

  for (const image of obsoleteImages) {
    const imageId = image.ImageId!;
    if (inUse.has(imageId)) {
      console.log(`Skipping ${imageId}: still referenced by a non-terminated instance.`);
      result.skippedInUse.push(imageId);
      continue;
    }
    try {
      await deleteImage(image, result);
    } catch (error) {
      const message = `Failed to deregister ${imageId}: ${String(error)}`;
      console.error(message);
      result.errors.push(message);
    }
  }

  console.log(
    `AMI housekeeping finished. Scanned=${result.scanned}, obsolete=${result.obsolete}, deregistered=${result.deregistered.length}, snapshotsDeleted=${result.snapshotsDeleted.length}, skippedInUse=${result.skippedInUse.length}, errors=${result.errors.length}`,
  );

  if (result.errors.length > 0) {
    // Surface partial failure to CloudWatch/EventBridge metrics without losing the summary in the message.
    throw new Error(`AMI housekeeping completed with ${result.errors.length} error(s): ${result.errors.join(" | ")}`);
  }

  return result;
};
