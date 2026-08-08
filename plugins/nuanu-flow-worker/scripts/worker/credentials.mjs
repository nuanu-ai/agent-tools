import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEYCHAIN_PATH = "/usr/bin/security";
const KEYCHAIN_SERVICE = "nuanu-flow-worker";
const DEFAULT_CREDENTIAL_PROFILE = "default-worker";
const CREDENTIAL_PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeCredentialProfile(value = DEFAULT_CREDENTIAL_PROFILE) {
  const profile = value || DEFAULT_CREDENTIAL_PROFILE;
  if (!CREDENTIAL_PROFILE_PATTERN.test(profile)) {
    throw new Error("Worker profile must use 1-64 lowercase letters, numbers, dots, underscores, or dashes");
  }
  return profile;
}

export const defaultCredentialPath = (profile = DEFAULT_CREDENTIAL_PROFILE) => {
  const normalized = normalizeCredentialProfile(profile);
  return normalized === DEFAULT_CREDENTIAL_PROFILE
    ? path.join(os.homedir(), ".config", "nuanu-flow", "worker.json")
    : path.join(os.homedir(), ".config", "nuanu-flow", "workers", `${normalized}.json`);
};

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

function securityInteractiveQuote(value) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
    throw new Error("Keychain value contains unsupported control characters");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildKeychainSaveInput(record, { profile = DEFAULT_CREDENTIAL_PROFILE } = {}) {
  const account = normalizeCredentialProfile(profile);
  const serialized = JSON.stringify(record);
  if (typeof serialized !== "string") {
    throw new Error("Worker credential cannot be serialized");
  }
  return (
    [
      "add-generic-password",
      "-a",
      securityInteractiveQuote(account),
      "-s",
      securityInteractiveQuote(KEYCHAIN_SERVICE),
      "-U",
      "-w",
      securityInteractiveQuote(serialized),
    ].join(" ") + "\n"
  );
}

export function createKeychainCredentialStore({
  runSecurityImpl = runSecurity,
  profile = DEFAULT_CREDENTIAL_PROFILE,
} = {}) {
  const account = normalizeCredentialProfile(profile);
  return {
    async load() {
      try {
        const output = await runSecurityImpl(["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"]);
        return parseCredential(output.trim());
      } catch {
        return null;
      }
    },

    loadSync() {
      const result = spawnSync(KEYCHAIN_PATH, ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"], {
        encoding: "utf8",
      });
      if (result.status !== 0) return null;
      return parseCredential(result.stdout.trim());
    },

    async save(record) {
      // `security add-generic-password ... -w` with no argument silently stores
      // an empty password. Passing the record as an argv value would expose a
      // durable agent key through the process list. Interactive mode accepts
      // the complete command over stdin, keeping the key out of argv/env/files.
      await runSecurityImpl(["-i"], buildKeychainSaveInput(record, { profile: account }));
    },
  };
}

export function createDefaultCredentialStore({
  platform = process.platform,
  profile = process.env.NUANU_WORKER_PROFILE || DEFAULT_CREDENTIAL_PROFILE,
  fileStore = createFileCredentialStore({ filePath: defaultCredentialPath(profile) }),
  keychainStore = platform === "darwin" ? createKeychainCredentialStore({ profile }) : null,
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
