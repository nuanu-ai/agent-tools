import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEYCHAIN_PATH = "/usr/bin/security";
const KEYCHAIN_ACCOUNT = "default-worker";
const KEYCHAIN_SERVICE = "nuanu-flow-worker";

export const defaultCredentialPath = () => path.join(os.homedir(), ".config", "nuanu-flow", "worker.json");

function parseCredential(value) {
  let record = value;
  if (typeof value === "string") {
    try {
      record = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !record ||
    typeof record !== "object" ||
    typeof record.baseUrl !== "string" ||
    typeof record.agentKey !== "string" ||
    !record.agent ||
    typeof record.agent !== "object"
  ) {
    return null;
  }
  return record;
}

export function createFileCredentialStore({ filePath = defaultCredentialPath() } = {}) {
  const directory = path.dirname(filePath);

  return {
    async load() {
      try {
        return parseCredential(await readFile(filePath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    loadSync() {
      try {
        return parseCredential(readFileSync(filePath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    async save(record) {
      const serialized = JSON.stringify(record);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, filePath);
      await chmod(filePath, 0o600);
    },
  };
}

function runSecurity(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(KEYCHAIN_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => reject(new Error("macOS Keychain is unavailable")));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error("macOS Keychain operation failed"));
    });
    child.stdin.end(input);
  });
}

export function createKeychainCredentialStore() {
  return {
    async load() {
      try {
        const output = await runSecurity([
          "find-generic-password",
          "-a",
          KEYCHAIN_ACCOUNT,
          "-s",
          KEYCHAIN_SERVICE,
          "-w",
        ]);
        return parseCredential(output.trim());
      } catch {
        return null;
      }
    },

    loadSync() {
      const result = spawnSync(
        KEYCHAIN_PATH,
        ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8" }
      );
      if (result.status !== 0) return null;
      return parseCredential(result.stdout.trim());
    },

    async save(record) {
      await runSecurity(
        ["add-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-U", "-w"],
        JSON.stringify(record)
      );
    },
  };
}

export function createDefaultCredentialStore({
  platform = process.platform,
  fileStore = createFileCredentialStore(),
  keychainStore = platform === "darwin" ? createKeychainCredentialStore() : null,
} = {}) {
  if (!keychainStore) return fileStore;

  return {
    async load() {
      return (await keychainStore.load()) ?? fileStore.load();
    },

    loadSync() {
      return keychainStore.loadSync() ?? fileStore.loadSync();
    },

    async save(record) {
      try {
        await keychainStore.save(record);
      } catch {
        await fileStore.save(record);
      }
    },
  };
}
