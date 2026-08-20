import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CapturePlan,
  CONTRACT_LIMITS,
  capturePlanSchema,
} from "@airux/shared/v1";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Route,
} from "playwright";

import { runCapturePlan } from "./capture-plan-runner.js";

const TEMPORARY_DIRECTORY_PREFIX = "airux-browser-recording-";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const BROWSER_VIDEO_MEDIA_TYPE = "video/webm" as const;

interface RecordingFileStats {
  readonly size: number;
  isFile(): boolean;
}

export interface BrowserRecordingDependencies {
  readonly createTemporaryDirectory?: () => Promise<string>;
  readonly executePlan?: typeof runCapturePlan;
  readonly inspectFile?: (path: string) => Promise<RecordingFileStats>;
  readonly launchBrowser?: () => Promise<Browser>;
  readonly removeDirectory?: (path: string) => Promise<void>;
}

export class BrowserRecordingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserRecordingError";
  }
}

export class TemporaryBrowserRecording {
  readonly filePath: string;
  readonly height: number;
  readonly mediaType = BROWSER_VIDEO_MEDIA_TYPE;
  readonly sizeBytes: number;
  readonly width: number;

  readonly #directory: string;
  readonly #removeDirectory: (path: string) => Promise<void>;

  constructor(
    details: {
      readonly directory: string;
      readonly filePath: string;
      readonly height: number;
      readonly sizeBytes: number;
      readonly width: number;
    },
    removeDirectory: (path: string) => Promise<void>,
  ) {
    this.#directory = details.directory;
    this.#removeDirectory = removeDirectory;
    this.filePath = details.filePath;
    this.height = details.height;
    this.sizeBytes = details.sizeBytes;
    this.width = details.width;
  }

  delete() {
    return this.#removeDirectory(this.#directory);
  }
}

function isLoopbackHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOOPBACK_HOSTNAMES.has(url.hostname)
    );
  } catch {
    return false;
  }
}

async function applyHostBoundary(
  route: Route,
  onBlockedNavigation: () => void,
) {
  const request = route.request();
  if (!request.isNavigationRequest() || isLoopbackHttpUrl(request.url())) {
    await route.continue();
    return;
  }

  try {
    if (request.frame().parentFrame() !== null) {
      await route.continue();
      return;
    }
  } catch {
    // Popup navigations may not have a frame yet and fail closed.
  }

  await route.abort("blockedbyclient");
  onBlockedNavigation();
}

function createTemporaryDirectory() {
  return mkdtemp(join(tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
}

function removeDirectory(path: string) {
  return rm(path, { force: true, recursive: true });
}

async function closeCaptureResources(
  context: BrowserContext | undefined,
  browser: Browser | undefined,
) {
  if (context !== undefined) {
    try {
      await context.close();
    } catch {
      // Preserve the capture failure that triggered cleanup.
    }
  }
  if (browser !== undefined) {
    try {
      await browser.close();
    } catch {
      // Preserve the capture failure that triggered cleanup.
    }
  }
}

export async function recordBrowserVideo(
  input: unknown,
  dependencies: BrowserRecordingDependencies = {},
) {
  const plan: CapturePlan = capturePlanSchema.parse(input);
  const makeTemporaryDirectory =
    dependencies.createTemporaryDirectory ?? createTemporaryDirectory;
  const executePlan = dependencies.executePlan ?? runCapturePlan;
  const inspectFile = dependencies.inspectFile ?? stat;
  const launchBrowser =
    dependencies.launchBrowser ?? (() => chromium.launch({ headless: true }));
  const removeTemporaryDirectory =
    dependencies.removeDirectory ?? removeDirectory;

  const directory = await makeTemporaryDirectory();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await launchBrowser();
    context = await browser.newContext({
      acceptDownloads: false,
      recordVideo: {
        dir: directory,
        size: plan.viewport,
      },
      screen: plan.viewport,
      serviceWorkers: "block",
      viewport: plan.viewport,
    });
    let hostBoundaryError: BrowserRecordingError | undefined;
    let rejectHostBoundary: (error: BrowserRecordingError) => void = () => {};
    const hostBoundaryViolation = new Promise<never>((_resolve, reject) => {
      rejectHostBoundary = reject;
    });
    await context.route("**/*", (route) =>
      applyHostBoundary(route, () => {
        hostBoundaryError ??= new BrowserRecordingError(
          "Browser recording blocked a non-loopback top-level navigation",
        );
        rejectHostBoundary(hostBoundaryError);
      }),
    );

    const page = await context.newPage();
    const video = page.video();
    if (video === null) {
      throw new BrowserRecordingError("Browser video recording did not start");
    }

    await Promise.race([executePlan(page, plan), hostBoundaryViolation]);
    if (hostBoundaryError !== undefined) {
      throw hostBoundaryError;
    }
    await context.close();
    context = undefined;

    const filePath = await video.path();
    const file = await inspectFile(filePath);
    if (
      !file.isFile() ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > CONTRACT_LIMITS.mediaSizeBytes
    ) {
      throw new BrowserRecordingError(
        "Browser video recording is missing or outside the supported size limit",
      );
    }

    await browser.close();
    browser = undefined;

    return new TemporaryBrowserRecording(
      {
        directory,
        filePath,
        height: plan.viewport.height,
        sizeBytes: file.size,
        width: plan.viewport.width,
      },
      removeTemporaryDirectory,
    );
  } catch (error) {
    await closeCaptureResources(context, browser);
    try {
      await removeTemporaryDirectory(directory);
    } catch {
      // Preserve the capture failure when best-effort cleanup also fails.
    }
    throw error;
  }
}
