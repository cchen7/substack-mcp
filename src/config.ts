import { readFile, writeFile } from "node:fs/promises";

import { ensureAppDirs, getAppPaths } from "./paths.js";

export type AppConfig = {
  priorityPublicationUrls: string[];
  defaultSyncDays: number;
  defaultLimitPerPublication: number;
  defaultFetchContent: boolean;
};

export const DEFAULT_CONFIG: AppConfig = {
  priorityPublicationUrls: [],
  defaultSyncDays: 3,
  defaultLimitPerPublication: 5,
  defaultFetchContent: true,
};

export async function readConfig(): Promise<AppConfig> {
  const paths = await ensureAppDirs(getAppPaths());

  try {
    const raw = await readFile(paths.configPath, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await writeConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

export async function writeConfig(config: AppConfig): Promise<AppConfig> {
  const paths = await ensureAppDirs(getAppPaths());
  const normalized = normalizeConfig(config);
  await writeFile(paths.configPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: 0o600,
  });
  return normalized;
}

export async function setPriorityPublicationUrls(
  urls: string[],
): Promise<AppConfig> {
  const config = await readConfig();
  return writeConfig({
    ...config,
    priorityPublicationUrls: dedupe(urls.map(normalizePublicationUrl)),
  });
}

export function normalizePublicationUrl(value: string): string {
  const withProtocol = value.startsWith("http") ? value : `https://${value}`;
  const url = new URL(withProtocol);
  return `${url.protocol}//${url.hostname}`;
}

export function normalizeConfig(value: unknown): AppConfig {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  const priorityPublicationUrls = Array.isArray(record.priorityPublicationUrls)
    ? record.priorityPublicationUrls
        .filter((item): item is string => typeof item === "string")
        .map(normalizePublicationUrl)
    : DEFAULT_CONFIG.priorityPublicationUrls;

  return {
    priorityPublicationUrls: dedupe(priorityPublicationUrls),
    defaultSyncDays: readBoundedInteger(
      record.defaultSyncDays,
      DEFAULT_CONFIG.defaultSyncDays,
      1,
      30,
    ),
    defaultLimitPerPublication: readBoundedInteger(
      record.defaultLimitPerPublication,
      DEFAULT_CONFIG.defaultLimitPerPublication,
      1,
      20,
    ),
    defaultFetchContent:
      typeof record.defaultFetchContent === "boolean"
        ? record.defaultFetchContent
        : DEFAULT_CONFIG.defaultFetchContent,
  };
}

function readBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
