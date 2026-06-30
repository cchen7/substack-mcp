import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type AppPaths = {
  appHome: string;
  browserProfileDir: string;
  cacheDbPath: string;
  configPath: string;
  logsDir: string;
};

export function getAppPaths(): AppPaths {
  const appHome =
    process.env.MCP_SUBSTACK_HOME ??
    join(homedir(), "Library", "Application Support", "mcp-substack");

  return {
    appHome,
    browserProfileDir: join(appHome, "browser-profile"),
    cacheDbPath: join(appHome, "substack.db"),
    configPath: join(appHome, "config.json"),
    logsDir: join(appHome, "logs"),
  };
}

export async function ensureAppDirs(paths = getAppPaths()): Promise<AppPaths> {
  await mkdir(paths.appHome, { recursive: true, mode: 0o700 });
  await mkdir(paths.browserProfileDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  return paths;
}
