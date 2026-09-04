#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const VERSION = "0.4.1";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 100_000;

function fail(message, exitCode = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--check" || key === "--help") {
      options[key.slice(2)] = true;
      continue;
    }
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function isExecutable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findAgy() {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat", "agy"] : ["agy"];
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry.replace(/^"|"$/g, ""), name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function run(executable, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const append = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      const remaining = MAX_OUTPUT_BYTES - current.length;
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
      });
    });
  });
}

function inferPinnedEffort(model) {
  const match = model?.match(/-(low|medium|high)$/i);
  return match?.[1]?.toLowerCase();
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write("Usage: agy-delegate.mjs --check | --cwd PATH --prompt-file PATH [--mode plan|default|accept-edits] [--output-format text|json] [--timeout-seconds N] [--agent NAME] [--model NAME] [--effort low|medium|high] [--conversation ID]\n");
  process.exit(0);
}

const executable = await findAgy();
if (!executable) fail("Antigravity CLI was not found. Install and authenticate the official `agy` CLI first.", 1);

if (options.check) {
  process.stdout.write(`${JSON.stringify({ available: true, executable, runnerVersion: VERSION })}\n`);
  process.exit(0);
}

if (!options.cwd) fail("--cwd is required");
const workspace = path.resolve(options.cwd);
try {
  const info = await stat(workspace);
  if (!info.isDirectory()) fail(`Workspace is not a directory: ${workspace}`);
} catch {
  fail(`Workspace is not accessible: ${workspace}`);
}

if (!options["prompt-file"]) fail("--prompt-file is required");
let prompt;
try {
  prompt = await readFile(path.resolve(options["prompt-file"]), "utf8");
} catch {
  fail(`Prompt file is not readable: ${path.resolve(options["prompt-file"])}`);
}
if (!prompt.trim()) fail("Prompt must not be empty");
if (prompt.length > MAX_PROMPT_CHARS) fail(`Prompt exceeds ${MAX_PROMPT_CHARS} characters`);

const mode = options.mode ?? "plan";
if (!["plan", "default", "accept-edits"].includes(mode)) fail(`Unsupported mode: ${mode}`);
const outputFormat = options["output-format"] ?? "text";
if (!["text", "json"].includes(outputFormat)) fail(`Unsupported output format: ${outputFormat}`);
const timeoutSeconds = Number(options["timeout-seconds"] ?? 900);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) {
  fail("--timeout-seconds must be an integer from 1 to 1800");
}
const effort = options.effort;
if (effort !== undefined && !["low", "medium", "high"].includes(effort)) {
  fail("--effort must be one of: low, medium, high");
}
const pinnedEffort = inferPinnedEffort(options.model);
if (pinnedEffort && effort && pinnedEffort !== effort) {
  fail(`--model ${options.model} pins effort ${pinnedEffort}; --effort ${effort} conflicts with that model slug`);
}

const agyArgs = ["--print", prompt, "--output-format", outputFormat, "--mode", mode];
if (options.agent) agyArgs.push("--agent", options.agent);
if (options.model) agyArgs.push("--model", options.model);
if (effort && !pinnedEffort) agyArgs.push("--effort", effort);
if (options.conversation) agyArgs.push("--conversation", options.conversation);

const result = await run(executable, agyArgs, workspace, timeoutSeconds * 1000);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.truncated) process.stderr.write("\nOutput was truncated at 2 MiB.\n");
if (result.timedOut) fail(`Antigravity timed out after ${timeoutSeconds} seconds`, 124);
process.exit(result.exitCode ?? 1);
