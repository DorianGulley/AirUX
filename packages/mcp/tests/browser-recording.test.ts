import { CONTRACT_LIMITS } from "@airux/shared/v1";
import type {
  Browser,
  BrowserContext,
  Frame,
  Page,
  Request,
  Route,
  Video,
} from "playwright";
import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_VIDEO_MEDIA_TYPE,
  BrowserRecordingError,
  recordBrowserVideo,
} from "../src/browser-recording.js";

const plan = {
  start_url: "http://127.0.0.1:3000/reviews",
  viewport: { width: 1_280, height: 720 },
  max_duration_ms: 30_000,
  steps: [{ action: "click", selector: "#open-review" }],
};

function createBrowserDouble() {
  const video = {
    path: vi.fn().mockResolvedValue("/tmp/airux-test/capture.webm"),
  } as unknown as Video;
  const page = { video: vi.fn(() => video) } as unknown as Page;
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  const context = {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    route: vi.fn(
      async (_pattern: string, handler: (route: Route) => Promise<void>) => {
        routeHandler = handler;
      },
    ),
  } as unknown as BrowserContext;
  const browser = {
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn().mockResolvedValue(context),
  } as unknown as Browser;

  return {
    browser,
    context,
    getRouteHandler: () => routeHandler,
    page,
    video,
  };
}

function createRouteDouble(options: {
  frame?: Frame;
  frameThrows?: boolean;
  navigation: boolean;
  url: string;
}) {
  const request = {
    frame: vi.fn(() => {
      if (options.frameThrows === true) {
        throw new Error("Frame is not available");
      }
      return options.frame;
    }),
    isNavigationRequest: vi.fn(() => options.navigation),
    url: vi.fn(() => options.url),
  } as unknown as Request;
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(() => request),
  } as unknown as Route;
}

function dependencies(browser: Browser) {
  return {
    createTemporaryDirectory: vi.fn().mockResolvedValue("/tmp/airux-test"),
    executePlan: vi.fn().mockResolvedValue(undefined),
    inspectFile: vi.fn().mockResolvedValue({
      isFile: () => true,
      size: 4_096,
    }),
    launchBrowser: vi.fn().mockResolvedValue(browser),
    removeDirectory: vi.fn().mockResolvedValue(undefined),
  };
}

describe("recordBrowserVideo", () => {
  it("validates the capture plan before allocating resources", async () => {
    const { browser } = createBrowserDouble();
    const recordingDependencies = dependencies(browser);

    await expect(
      recordBrowserVideo(
        { ...plan, start_url: "https://example.com" },
        recordingDependencies,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(
      recordingDependencies.createTemporaryDirectory,
    ).not.toHaveBeenCalled();
    expect(recordingDependencies.launchBrowser).not.toHaveBeenCalled();
  });

  it("records an isolated viewport and returns a deletable artifact", async () => {
    const { browser, context, page, video } = createBrowserDouble();
    const recordingDependencies = dependencies(browser);

    const recording = await recordBrowserVideo(plan, recordingDependencies);

    expect(browser.newContext).toHaveBeenCalledWith({
      acceptDownloads: false,
      recordVideo: {
        dir: "/tmp/airux-test",
        size: plan.viewport,
      },
      screen: plan.viewport,
      serviceWorkers: "block",
      viewport: plan.viewport,
    });
    expect(context.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(recordingDependencies.executePlan).toHaveBeenCalledWith(page, plan);
    expect(context.close).toHaveBeenCalledOnce();
    expect(video.path).toHaveBeenCalledOnce();
    expect(recordingDependencies.inspectFile).toHaveBeenCalledWith(
      "/tmp/airux-test/capture.webm",
    );
    expect(browser.close).toHaveBeenCalledOnce();
    expect(recording).toMatchObject({
      filePath: "/tmp/airux-test/capture.webm",
      height: 720,
      mediaType: BROWSER_VIDEO_MEDIA_TYPE,
      sizeBytes: 4_096,
      width: 1_280,
    });

    await recording.delete();
    await recording.delete();
    expect(recordingDependencies.removeDirectory).toHaveBeenCalledTimes(2);
    expect(recordingDependencies.removeDirectory).toHaveBeenCalledWith(
      "/tmp/airux-test",
    );
  });

  it("allows remote subresources and embedded-frame navigations", async () => {
    const { browser, getRouteHandler } = createBrowserDouble();
    await recordBrowserVideo(plan, dependencies(browser));
    const handler = getRouteHandler();
    expect(handler).toBeDefined();

    const subresource = createRouteDouble({
      navigation: false,
      url: "https://cdn.example.com/app.js",
    });
    await handler?.(subresource);
    expect(subresource.continue).toHaveBeenCalledOnce();
    expect(subresource.abort).not.toHaveBeenCalled();

    const childFrame = {
      parentFrame: vi.fn(() => ({}) as Frame),
    } as unknown as Frame;
    const embeddedFrame = createRouteDouble({
      frame: childFrame,
      navigation: true,
      url: "https://widgets.example.com/embed",
    });
    await handler?.(embeddedFrame);
    expect(embeddedFrame.continue).toHaveBeenCalledOnce();
    expect(embeddedFrame.abort).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost:3000/next",
    "https://127.0.0.1:8443/next",
    "http://[::1]:3000/next",
  ])("allows a loopback top-level navigation to %s", async (url) => {
    const { browser, getRouteHandler } = createBrowserDouble();
    await recordBrowserVideo(plan, dependencies(browser));
    const route = createRouteDouble({ navigation: true, url });

    await getRouteHandler()?.(route);

    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it("blocks a remote top-level navigation", async () => {
    const { browser, getRouteHandler } = createBrowserDouble();
    await recordBrowserVideo(plan, dependencies(browser));
    const mainFrame = {
      parentFrame: vi.fn(() => null),
    } as unknown as Frame;
    const route = createRouteDouble({
      frame: mainFrame,
      navigation: true,
      url: "https://example.com/escape",
    });

    await getRouteHandler()?.(route);

    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("fails the recording when the capture attempts a remote top-level navigation", async () => {
    const { browser, getRouteHandler } = createBrowserDouble();
    const recordingDependencies = dependencies(browser);
    const mainFrame = {
      parentFrame: vi.fn(() => null),
    } as unknown as Frame;
    const route = createRouteDouble({
      frame: mainFrame,
      navigation: true,
      url: "https://example.com/escape",
    });
    recordingDependencies.executePlan.mockImplementationOnce(async () => {
      await getRouteHandler()?.(route);
    });

    await expect(
      recordBrowserVideo(plan, recordingDependencies),
    ).rejects.toBeInstanceOf(BrowserRecordingError);
    expect(recordingDependencies.removeDirectory).toHaveBeenCalledWith(
      "/tmp/airux-test",
    );
  });

  it("fails closed for a remote popup without an available frame", async () => {
    const { browser, getRouteHandler } = createBrowserDouble();
    await recordBrowserVideo(plan, dependencies(browser));
    const route = createRouteDouble({
      frameThrows: true,
      navigation: true,
      url: "https://example.com/popup",
    });

    await getRouteHandler()?.(route);

    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("removes partial artifacts and closes resources after capture failure", async () => {
    const { browser, context } = createBrowserDouble();
    const recordingDependencies = dependencies(browser);
    const captureFailure = new Error("capture failed");
    recordingDependencies.executePlan.mockRejectedValueOnce(captureFailure);

    await expect(recordBrowserVideo(plan, recordingDependencies)).rejects.toBe(
      captureFailure,
    );
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(recordingDependencies.removeDirectory).toHaveBeenCalledWith(
      "/tmp/airux-test",
    );
  });

  it.each([0, CONTRACT_LIMITS.mediaSizeBytes + 1])(
    "rejects a recording with an invalid size of %i bytes",
    async (size) => {
      const { browser } = createBrowserDouble();
      const recordingDependencies = dependencies(browser);
      recordingDependencies.inspectFile.mockResolvedValueOnce({
        isFile: () => true,
        size,
      });

      await expect(
        recordBrowserVideo(plan, recordingDependencies),
      ).rejects.toBeInstanceOf(BrowserRecordingError);
      expect(recordingDependencies.removeDirectory).toHaveBeenCalledWith(
        "/tmp/airux-test",
      );
    },
  );
});
