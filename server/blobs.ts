import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import { config, fail } from "./config.js";
export class Blobs {
  private file(key: string) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(key) || key.includes(".."))
      return fail("invalid_path", "檔案路徑不合法。");
    return path.join(config.localPath, "blobs", key);
  }
  async put(key: string, data: Buffer, type = "application/octet-stream") {
    if (config.mode === "firebase") {
      await new Storage()
        .bucket(config.bucket)
        .file(key)
        .save(data, { contentType: type, resumable: false });
    } else {
      const f = this.file(key);
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, data);
    }
    return key;
  }
  async get(key: string) {
    if (config.mode === "firebase")
      return (
        await new Storage().bucket(config.bucket).file(key).download()
      )[0];
    return readFile(this.file(key));
  }
  async delete(key: string) {
    if (config.mode === "firebase")
      await new Storage()
        .bucket(config.bucket)
        .file(key)
        .delete({ ignoreNotFound: true });
    else await rm(this.file(key), { force: true });
  }
}
