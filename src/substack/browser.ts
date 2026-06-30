import { chromium, type BrowserContext, type Page } from "playwright";

import { ensureAppDirs, getAppPaths } from "../paths.js";
import type { LoginStatus } from "../types.js";

const SUBSTACK_HOME = "https://substack.com/home";
const SUBSTACK_SIGN_IN = "https://substack.com/sign-in";

type BrowserOptions = {
  headless?: boolean;
};

export async function launchSubstackContext(
  options: BrowserOptions = {},
): Promise<BrowserContext> {
  const paths = await ensureAppDirs(getAppPaths());

  return chromium.launchPersistentContext(paths.browserProfileDir, {
    headless: options.headless ?? true,
    viewport: { width: 1400, height: 950 },
    locale: "en-US",
  });
}

export async function checkLoginStatus(page: Page): Promise<LoginStatus> {
  const evidence: string[] = [];

  await page.goto(SUBSTACK_HOME, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });

  const url = page.url();
  evidence.push(`navigated:${url}`);

  if (/sign-?in|login|account\/login/i.test(url)) {
    evidence.push("redirected-to-login");
    return { loggedIn: false, url, evidence };
  }

  const user = await fetchCurrentUser(page);
  if (user) {
    evidence.push("current-user-api-ok");
    return { loggedIn: true, url, user, evidence };
  }

  const hasAccountEvidence = await page
    .locator(
      [
        "[data-testid*='user']",
        "[data-testid*='account']",
        "[aria-label*='Account']",
        "[aria-label*='Profile']",
        "a[href^='/@']",
      ].join(", "),
    )
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  if (hasAccountEvidence) {
    evidence.push("account-ui-visible");
    return { loggedIn: true, url, evidence };
  }

  evidence.push("no-login-evidence");
  return { loggedIn: false, url, evidence };
}

export async function openLoginFlow(timeoutSeconds: number): Promise<LoginStatus> {
  const context = await launchSubstackContext({ headless: false });
  const page = await context.newPage();
  const deadline = Date.now() + timeoutSeconds * 1000;

  try {
    await page.goto(SUBSTACK_SIGN_IN, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    let lastStatus: LoginStatus = {
      loggedIn: false,
      url: page.url(),
      evidence: ["login-window-opened"],
    };

    while (Date.now() < deadline) {
      await page.waitForTimeout(3_000);
      lastStatus = await checkLoginStatus(page);
      if (lastStatus.loggedIn) {
        return lastStatus;
      }
      await page.goto(SUBSTACK_SIGN_IN, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }

    return {
      ...lastStatus,
      evidence: [...lastStatus.evidence, "login-timeout"],
    };
  } finally {
    await context.close();
  }
}

export async function withSubstackPage<T>(
  options: BrowserOptions,
  fn: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await launchSubstackContext(options);
  const page = await context.newPage();

  try {
    return await fn(page, context);
  } finally {
    await context.close();
  }
}

async function fetchCurrentUser(
  page: Page,
): Promise<LoginStatus["user"] | undefined> {
  const candidates = [
    "https://substack.com/api/v1/user/self",
    "https://substack.com/api/v1/user/profile",
    "https://substack.com/api/v1/profile",
  ];

  for (const url of candidates) {
    const result = await page
      .evaluate(async (endpoint) => {
        const response = await fetch(endpoint, {
          credentials: "include",
          headers: { accept: "application/json" },
        });

        if (!response.ok) {
          return undefined;
        }

        return response.json();
      }, url)
      .catch(() => undefined);

    const user = normalizeUser(result);
    if (user) {
      return user;
    }
  }

  return undefined;
}

function normalizeUser(value: unknown): LoginStatus["user"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidate =
    asRecord(record.user) ??
    asRecord(record.profile) ??
    asRecord(record.reader) ??
    record;

  const id = readStringOrNumber(candidate, ["id", "user_id"]);
  const name = readString(candidate, ["name", "display_name"]);
  const handle = readString(candidate, ["handle", "username"]);
  const email = readString(candidate, ["email"]);

  if (!id && !name && !handle && !email) {
    return undefined;
  }

  return { id, name, handle, email };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function readStringOrNumber(
  record: Record<string, unknown>,
  keys: string[],
): string | number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (
      (typeof value === "string" && value.length > 0) ||
      typeof value === "number"
    ) {
      return value;
    }
  }
  return undefined;
}
