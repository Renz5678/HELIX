import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

export default function setupNativeHelix(): () => void {
  const prebuilt =
    process.platform === "win32"
      ? [
          resolve(REPO_ROOT, "build/native/libhelix.dll"),
          resolve(REPO_ROOT, "build/native/libhelix.so"),
        ]
      : [resolve(REPO_ROOT, "build/native/libhelix.so")];

  for (const candidate of prebuilt) {
    if (existsSync(candidate)) {
      process.env.HELIX_NATIVE_LIB = candidate;
      return () => {};
    }
  }

  const tempDir = mkdtempSync(join(tmpdir(), "helix-native-test-"));
  const outLib = join(
    tempDir,
    process.platform === "win32" ? "libhelix.dll" : "libhelix.so",
  );
  const srcDir = resolve(REPO_ROOT, "src");
  const cFiles = readdirSync(srcDir)
    .filter((f) => f.endsWith(".c") && f !== "main.c")
    .map((f) => join(srcDir, f));

  try {
    execFileSync(
      "gcc",
      [
        `-I${resolve(REPO_ROOT, "include")}`,
        "-std=c11",
        "-O0",
        "-shared",
        ...(process.platform === "win32" ? [] : ["-fPIC"]),
        "-o",
        outLib,
        ...cFiles,
        "-lm",
      ],
      { stdio: "pipe" },
    );
    process.env.HELIX_NATIVE_LIB = outLib;
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    if (process.env.CI) {
      throw err;
    }
    return () => {};
  }

  return () => {
    rmSync(tempDir, { recursive: true, force: true });
  };
}
