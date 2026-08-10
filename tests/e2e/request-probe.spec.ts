import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";
import path from "node:path";

const extensionPath = path.resolve("dist/chrome-mv3");
const availabilityUrl =
  "https://book-i.jal.co.jp/JLInt/dyn/air/booking/availability";

test("extension service worker can read a response but does not receive a Lax JAL cookie", async ({}, testInfo) => {
  const { context, serviceWorker } = await launchExtension(testInfo.outputPath("profile"));
  await context.addCookies([
    {
      name: "enc1A",
      value: "e2e-token",
      domain: ".jal.co.jp",
      path: "/",
      secure: true,
      sameSite: "Lax"
    }
  ]);
  let requestBody = "";
  const requestCookies: string[] = [];
  await context.route("https://book-i.jal.co.jp/**", async (route) => {
    requestBody = route.request().postData() || "";
    requestCookies.push((await route.request().allHeaders()).cookie || "");
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<html><script id="clientSideData" type="application/json">${JSON.stringify({
        jsessionid: "probe-session",
        PAGE: { DATA: { context: { flow: { mode: "REVENUE" } } } }
      })}</script></html>`
    });
  });

  const result = await serviceWorker.evaluate(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "FLOW_MODE=REVENUE&ENC=e2e-token"
    });
    return { status: response.status, url: response.url, body: await response.text() };
  }, availabilityUrl);

  expect(result.status).toBe(200);
  expect(result.url).toBe(availabilityUrl);
  expect(result.body).toContain('"jsessionid":"probe-session"');
  expect(requestBody).toBe("FLOW_MODE=REVENUE&ENC=e2e-token");
  expect(requestCookies[0]).toBe("");
  await context.close();
});

test("manual redirects hide the authentication Location from an extension fetch", async ({}, testInfo) => {
  const { context, serviceWorker } = await launchExtension(testInfo.outputPath("profile"));
  const loginUrl = `${availabilityUrl}/auth-required`;
  await context.route("https://book-i.jal.co.jp/**", async (route) => {
    await route.fulfill({ status: 302, headers: { Location: loginUrl }, body: "" });
  });

  const result = await serviceWorker.evaluate(async (url) => {
    const response = await fetch(url, { method: "POST", redirect: "manual" });
    return {
      status: response.status,
      type: response.type,
      url: response.url,
      location: response.headers.get("location")
    };
  }, availabilityUrl);

  expect(result).toMatchObject({ status: 0, type: "opaqueredirect", url: availabilityUrl });
  expect(result.location).toBeNull();
  await context.close();
});

test("a book-i page context can send the Lax JAL cookie with the bootstrap request", async ({}, testInfo) => {
  const { context } = await launchExtension(testInfo.outputPath("profile"));
  await context.addCookies([
    {
      name: "enc1A",
      value: "e2e-token",
      domain: ".jal.co.jp",
      path: "/",
      secure: true,
      sameSite: "Lax"
    }
  ]);
  let requestCookie = "";
  await context.route("https://book-i.jal.co.jp/**", async (route) => {
    requestCookie = (await route.request().allHeaders()).cookie || "";
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html>book-i</html>" });
  });

  const page = await context.newPage();
  await page.goto(availabilityUrl);
  await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "FLOW_MODE=REVENUE&ENC=e2e-token"
    });
    return response.status;
  }, availabilityUrl);

  expect(requestCookie).toContain("enc1A=e2e-token");
  await context.close();
});

test("a book-i page can obtain enc1A without a visible navigation", async ({}, testInfo) => {
  const { context } = await launchExtension(testInfo.outputPath("profile"));
  await context.route("https://book-i.jal.co.jp/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html>book-i</html>" });
  });
  await context.route("https://www.jal.co.jp/cgi-bin/jal/common_rn/getEnc1A.cgi**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Set-Cookie": "enc1A=e2e-token; Domain=.jal.co.jp; Path=/" },
      body: ""
    });
  });

  const page = await context.newPage();
  await page.goto(availabilityUrl);
  const token = await page.evaluate(async () => {
    const current = () => document.cookie.split(";").map((part) => part.trim())
      .find((part) => part.startsWith("enc1A="))?.slice(6);
    const before = current();
    if (!before) {
      await fetch(`https://www.jal.co.jp/cgi-bin/jal/common_rn/getEnc1A.cgi?_${Date.now()}`, {
        credentials: "include",
        cache: "no-store",
        mode: "no-cors"
      });
    }
    return { before, after: current() };
  });

  expect(token).toEqual({ before: undefined, after: "e2e-token" });
  await context.close();
});

test("a page-context bootstrap cannot read a cross-origin login redirect", async ({}, testInfo) => {
  const { context } = await launchExtension(testInfo.outputPath("profile"));
  const loginUrl =
    "https://jallogin.jal.co.jp/contents/login?AUTH_TYPE=AUTH_RISK&SITE_ID=co";
  const page = await context.newPage();
  await page.route("https://book-i.jal.co.jp/**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 302, headers: { Location: loginUrl }, body: "" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html>book-i</html>" });
  });
  await page.route("https://jallogin.jal.co.jp/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html>OTP</html>" });
  });
  await page.goto(availabilityUrl);

  const result = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "FLOW_MODE=REVENUE&ENC=e2e-token"
      });
      return { ok: true, status: response.status, url: response.url, body: await response.text() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, availabilityUrl);

  expect(result.ok).toBe(false);
  await context.close();
});

test("an invisible same-origin frame can inspect a successful revenue bootstrap", async ({}, testInfo) => {
  const { context } = await launchExtension(testInfo.outputPath("profile"));
  const page = await context.newPage();
  await page.route("https://book-i.jal.co.jp/**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>REVENUE_PROBE_OK</body></html>"
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html>award</html>" });
  });
  await page.goto(availabilityUrl);

  const result = await page.evaluate((url) => new Promise<{ sameOrigin: boolean; text: string }>((resolve) => {
    const frame = document.createElement("iframe");
    frame.name = "revenue-probe";
    document.body.append(frame);
    frame.addEventListener("load", () => {
      try {
        resolve({ sameOrigin: true, text: frame.contentDocument?.body?.textContent || "" });
      } catch {
        resolve({ sameOrigin: false, text: "" });
      }
    }, { once: true });
    const form = document.createElement("form");
    form.method = "POST";
    form.action = url;
    form.target = frame.name;
    form.innerHTML = '<input type="hidden" name="FLOW_MODE" value="REVENUE">';
    document.body.append(form);
    form.submit();
  }), availabilityUrl);

  expect(result).toEqual({ sameOrigin: true, text: "REVENUE_PROBE_OK" });
  await context.close();
});

test("webNavigation identifies the OTP redirect from the invisible probe", async ({}, testInfo) => {
  const { context, serviceWorker } = await launchExtension(testInfo.outputPath("profile"));
  const loginUrl =
    "https://jallogin.jal.co.jp/contents/login?AUTH_TYPE=AUTH_RISK&SITE_ID=co";
  const page = await context.newPage();
  await page.route("https://book-i.jal.co.jp/**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 302, headers: { Location: loginUrl }, body: "" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html>award</html>" });
  });
  await page.route("https://jallogin.jal.co.jp/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" },
      contentType: "text/html",
      body: "<html><body>OTP</body></html>"
    });
  });
  await serviceWorker.evaluate(() => {
    (globalThis as typeof globalThis & { __jalNavigations?: unknown[] }).__jalNavigations = [];
    const navigationState = globalThis as typeof globalThis & { __jalNavigations?: unknown[] };
    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      navigationState.__jalNavigations?.push({ event: "before", url: details.url, frameId: details.frameId });
    });
    chrome.webNavigation.onCommitted.addListener((details) => {
      navigationState.__jalNavigations?.push({ event: "committed", url: details.url, frameId: details.frameId });
    });
    chrome.webNavigation.onErrorOccurred.addListener((details) => {
      navigationState.__jalNavigations?.push({ event: "error", url: details.url, frameId: details.frameId });
    });
  });
  await page.goto(availabilityUrl);

  const result = await page.evaluate((url) => new Promise<{ sameOrigin: boolean; text: string }>((resolve) => {
    const frame = document.createElement("iframe");
    frame.name = "revenue-probe";
    document.body.append(frame);
    frame.addEventListener("load", () => {
      try {
        resolve({ sameOrigin: true, text: frame.contentDocument?.body?.textContent || "" });
      } catch {
        resolve({ sameOrigin: false, text: "" });
      }
    }, { once: true });
    const form = document.createElement("form");
    form.method = "POST";
    form.action = url;
    form.target = frame.name;
    form.innerHTML = '<input type="hidden" name="FLOW_MODE" value="REVENUE">';
    document.body.append(form);
    form.submit();
  }), availabilityUrl);

  await page.waitForTimeout(500);
  const navigations = await serviceWorker.evaluate(
    () => (globalThis as typeof globalThis & { __jalNavigations?: unknown[] }).__jalNavigations || []
  );
  expect(result.text).toBe("");
  expect(navigations).toContainEqual(
    expect.objectContaining({ event: "error", frameId: expect.any(Number), url: loginUrl })
  );
  await context.close();
});

async function launchExtension(userDataDir: string): Promise<{
  context: BrowserContext;
  serviceWorker: Worker;
}> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker");
  return { context, serviceWorker };
}
