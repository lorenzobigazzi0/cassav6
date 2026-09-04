import { constants as fsConstants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 262_144;

export class PeerTrustPublishedDirectoryStoreV1 {
  readonly #filePath: string;

  constructor(filePath: string) {
    if (!path.isAbsolute(filePath)) {
      throw new TypeError("published peer trust path must be absolute");
    }
    this.#filePath = path.resolve(filePath);
  }

  async read(): Promise<Buffer | null> {
    let handle;
    try {
      handle = await open(
        this.#filePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      assertPrivateFile(stat, this.#filePath);
      if (stat.size < 1 || stat.size > MAX_BYTES) {
        throw new Error("published peer trust directory size is invalid");
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async writeAtomically(value: Uint8Array): Promise<void> {
    const bytes = Buffer.from(value);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) {
      bytes.fill(0);
      throw new Error("published peer trust directory size is invalid");
    }
    const parent = path.dirname(this.#filePath);
    const parentStat = await lstat(parent);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      parentStat.isSymbolicLink() ||
      !parentStat.isDirectory() ||
      (parentStat.mode & 0o077) !== 0 ||
      (uid !== undefined && parentStat.uid !== uid)
    ) {
      bytes.fill(0);
      throw new Error("published peer trust parent must be an owned private directory");
    }
    const existing = await this.#statExisting();
    if (existing !== null) assertPrivateFile(existing, this.#filePath);
    const temporary = path.join(
      parent,
      `.${path.basename(this.#filePath)}.${randomUUID()}.tmp`
    );
    let temporaryCreated = false;
    let handle;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      temporaryCreated = true;
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#filePath);
      temporaryCreated = false;
      const directory = await open(parent, fsConstants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const committed = await this.read();
      if (committed === null || !committed.equals(bytes)) {
        committed?.fill(0);
        throw new Error("published peer trust commit verification failed");
      }
      committed.fill(0);
    } finally {
      bytes.fill(0);
      await handle?.close().catch(() => undefined);
      if (temporaryCreated) await unlink(temporary).catch(() => undefined);
    }
  }

  async #statExisting() {
    try {
      return await lstat(this.#filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

function assertPrivateFile(stat: Stats, filePath: string) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new Error(`${filePath} must be an owned single-link 0600 file`);
  }
}
