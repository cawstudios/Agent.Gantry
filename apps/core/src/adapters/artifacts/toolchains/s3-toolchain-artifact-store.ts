import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import {
  ArtifactIntegrityError,
  type MaterializedToolchainArtifact,
  type StoredToolchainArtifact,
  type ToolchainArtifactFile,
  type ToolchainArtifactMaterializer,
  type ToolchainArtifactStore,
} from '../../../domain/ports/toolchain-artifact-store.js';
import {
  hashToolchainFiles,
  normalizeToolchainFiles,
  normalizeToolchainStorageRef,
  resolveToolchainAssetPath,
  toolchainStorageRefFor,
} from './toolchain-artifact-bundle.js';

/**
 * Current-state S3 toolchain artifact store for fleet mode. Objects live under
 * the content-addressed `toolchains/<manifestHash>/<relpath>` prefix and are
 * replaced in place on update (no versioning). Materialize lists the prefix,
 * verifies sha256 against the recorded hash, and atomically activates,
 * quarantining on mismatch. Bake role holds rw; workers hold ro (split IAM).
 */
export class S3ToolchainArtifactStore
  implements ToolchainArtifactStore, ToolchainArtifactMaterializer
{
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putToolchainArtifact(input: {
    appId: string;
    manifestHash: string;
    files: ToolchainArtifactFile[];
  }): Promise<StoredToolchainArtifact> {
    const files = normalizeToolchainFiles(input.files);
    const contentHash = hashToolchainFiles(files);
    const storageRef = toolchainStorageRefFor(input.manifestHash);
    await this.deletePrefix(storageRef);
    let sizeBytes = 0;
    for (const file of files) {
      const content = Buffer.from(file.content);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey(storageRef, file.path),
          Body: content,
        }),
      );
      sizeBytes += content.byteLength;
    }
    return {
      storageType: 'object-store',
      storageRef,
      contentHash,
      sizeBytes,
    };
  }

  async materializeToolchainArtifact(input: {
    storageRef: string;
    expectedContentHash: string;
    targetDir: string;
    quarantineDir: string;
  }): Promise<MaterializedToolchainArtifact> {
    const files = await this.fetchToolchainFiles(input.storageRef);
    const actualContentHash = hashToolchainFiles(files);
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gantry-toolchain-'),
    );
    try {
      let sizeBytes = 0;
      for (const file of files) {
        const filePath = resolveToolchainAssetPath(tempDir, file.path);
        await fs.mkdir(path.dirname(filePath), {
          recursive: true,
          mode: 0o700,
        });
        const content = Buffer.from(file.content);
        await fs.writeFile(filePath, content, { mode: 0o600 });
        sizeBytes += content.byteLength;
      }
      if (actualContentHash !== input.expectedContentHash) {
        const quarantinePath = await this.quarantine(
          tempDir,
          input.quarantineDir,
          input.storageRef,
        );
        throw new ArtifactIntegrityError({
          storageRef: input.storageRef,
          expectedContentHash: input.expectedContentHash,
          actualContentHash,
          quarantinePath,
        });
      }
      const targetDir = path.resolve(input.targetDir);
      await fs.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.rename(tempDir, targetDir);
      return {
        storageRef: input.storageRef,
        contentHash: actualContentHash,
        targetDir,
        sizeBytes,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async fetchToolchainFiles(
    storageRef: string,
  ): Promise<ToolchainArtifactFile[]> {
    const prefix = `${normalizeToolchainStorageRef(storageRef)}/`;
    const keys = await this.listPrefix(prefix);
    const files: ToolchainArtifactFile[] = [];
    for (const key of keys) {
      const relative = key.slice(prefix.length);
      if (!relative) continue;
      const content = await this.getObjectBytes(key);
      files.push({ path: relative, content: new Uint8Array(content) });
    }
    return files;
  }

  private async quarantine(
    sourceDir: string,
    quarantineRoot: string,
    storageRef: string,
  ): Promise<string> {
    const root = path.resolve(quarantineRoot);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stamp = `${storageRef.replace(/[^A-Za-z0-9._-]+/g, '-')}-${Date.now()}`;
    const quarantinePath = path.join(root, stamp);
    await fs.rm(quarantinePath, { recursive: true, force: true });
    await fs.rename(sourceDir, quarantinePath);
    return quarantinePath;
  }

  private async deletePrefix(storageRef: string): Promise<void> {
    const prefix = `${normalizeToolchainStorageRef(storageRef)}/`;
    const keys = await this.listPrefix(prefix);
    if (keys.length === 0) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    );
  }

  private async listPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const entry of response.Contents ?? []) {
        if (entry.Key) keys.push(entry.Key);
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  }

  private async getObjectBytes(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body;
    if (!body || typeof body.transformToByteArray !== 'function') {
      throw new Error(`S3 object ${key} returned no readable body`);
    }
    return Buffer.from(await body.transformToByteArray());
  }
}

function objectKey(storageRef: string, relative: string): string {
  return `${normalizeToolchainStorageRef(storageRef)}/${relative}`;
}
