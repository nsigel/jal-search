import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";
import path from "node:path";

const extensionPath = path.resolve("dist/chrome-mv3");
const awardUrl =
  "https://book-i.jal.co.jp/JLInt/dyn/air/booking/availability;JAL_SESSION_ID=award-session";
const otpUrl =
  "https://jallogin.jal.co.jp/contents/login?AUTH_TYPE=AUTH_THREEKEY_LOW&SITE_ID=co";
const otpRevenueUrl =
  "https://book-i.jal.co.jp/JLInt/dyn/air/booking/availability;JAL_SESSION_ID=otp-revenue-session?DDS_PREVIOUS_REQUEST_ID=0";

test("preflights revenue auth, completes it in the background, then loads award and cash rows", async ({}, testInfo) => {
  const events: string[] = [];
  const { context, serviceWorker, extensionId } = await launchExtension(testInfo.outputPath("profile"));
  await addBookingToken(context);

  await context.route("https://www.jal.co.jp/**", async (route) => {
    if (new URL(route.request().url()).pathname.includes("getEnc1A.cgi")) {
      events.push("enc-token");
      await route.fulfill({
        status: 200,
        headers: { "Set-Cookie": "enc1A=e2e-token; Domain=.jal.co.jp; Path=/" },
        body: ""
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>JAL</body></html>" });
  });

  await context.route("https://book-i.jal.co.jp/**", async (route) => {
    const request = route.request();
    const body = request.postData() || "";
    if (!request.url().includes("JAL_SESSION_ID=")) {
      const params = new URLSearchParams(body);
      if (params.get("FLOW_MODE") === "REDEMPTION") {
        expect(params.get("ENC")).toBe("e2e-token");
        expect(params.get("ENCT")).toBe("2");
        expect(params.get("CFF_1")).toBe("9JE");
        expect(params.has("CFF_OUTBOUND")).toBe(false);
        events.push("fresh-award-search");
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: bookingPage("REDEMPTION", "homepage-award-session", "9JE", { miles: 60_000 }, true)
        });
        return;
      }
      events.push("revenue-bootstrap");
      expect(body).toContain("FLOW_MODE=REVENUE");
      expect(body).toContain("IS_FLEXIBLE=TRUE");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: bookingPage("REVENUE", "revenue-session", "1YE", { cash: 1234 })
      });
      return;
    }

    if (request.method() === "POST") {
      const cabin = new URLSearchParams(body).get("CFF_OUTBOUND") || "9YE";
      events.push(`award-${cabin}`);
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: bookingPage("REDEMPTION", "award-session", cabin, { miles: cabin === "9JE" ? 60_000 : 35_000 })
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: bookingPage("REDEMPTION", "award-session", "9YE", { miles: 35_000 }, true)
    });
  });

  await serviceWorker.evaluate(async () => {
    const recent = {
      origin: "SFO",
      destination: "HND",
      departureDate: "202610010000",
      cabinCode: "9JE",
      params: {
        PATTERN: "1B",
        NB_ADT: "1",
        NB_CHD: "0",
        NB_INF: "0",
        DIRECT_NON_STOP: "TRUE"
      }
    };
    await chrome.storage.local.set({
      "jal-recent-searches": [recent, recent]
    });
  });

  const awardPage = await context.newPage();
  await awardPage.goto(awardUrl);
  const panel = awardPage.locator(".jal-helper-panel");
  await expect(panel.locator("summary")).toHaveText("NYC-TYO · Sep 9, 2026");
  await expect(panel.locator(".jal-helper-status")).toHaveAttribute("data-loading", "true");
  await expect(panel.getByRole("link", { name: "International" })).toHaveAttribute(
    "href",
    "https://www.jal.co.jp/arl/en/jmb/award/"
  );
  await expect(panel.getByRole("link", { name: "Domestic" })).toHaveAttribute(
    "href",
    "https://www.jal.co.jp/jp/en/jmb/award-dom/booking/"
  );
  await expect(panel.getByRole("link", { name: "International" })).not.toHaveAttribute("target", "_blank");
  await expect(panel.getByRole("link", { name: "Domestic" })).not.toHaveAttribute("target", "_blank");
  await expect(panel.getByRole("link", { name: "International" })).toHaveCSS("text-decoration-line", "underline");
  await expect(panel.getByRole("link", { name: "Domestic" })).toHaveCSS("text-decoration-line", "underline");
  await expect(panel.getByRole("columnheader")).toHaveText(["Route", "Date", "Cabin", ""]);
  await expect(panel.locator("tbody tr")).toHaveCount(2);
  await expect(panel.locator("tbody tr").first()).toContainText("NYC-TYO");
  await expect(panel.locator("tbody tr").last()).toContainText("SFO-HND");
  await expect(panel.getByRole("button", { name: "Search" })).toHaveCount(2);
  await expect(awardPage.locator(".jal-helper-price-row")).toHaveCount(3);
  await expect(awardPage.locator(".jal-helper-price-row").last()).toContainText("$1,234");
  await expect(panel.locator(".jal-helper-status")).toHaveText("Fares ready.");
  await expect(panel.locator(".jal-helper-status")).toHaveAttribute("data-loading", "false");
  await expect(panel.locator(".jal-helper-status")).toHaveCSS("background-color", "rgb(238, 246, 241)");
  await awardPage.screenshot({
    path: testInfo.outputPath("award-calendar.png"),
    animations: "disabled"
  });

  expect(events.indexOf("revenue-bootstrap")).toBeGreaterThan(-1);
  expect(events.findIndex((event) => event.startsWith("award-"))).toBeGreaterThan(
    events.indexOf("revenue-bootstrap")
  );

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const checkbox = popup.getByRole("checkbox", { name: "Compare cash fares" });
  await expect(checkbox).toBeChecked();
  await expect(popup.getByRole("status")).toHaveCSS("background-color", "rgb(238, 246, 241)");
  await popup.screenshot({
    path: testInfo.outputPath("popup.png"),
    animations: "disabled"
  });
  await checkbox.setChecked(false);
  await expect
    .poll(() => serviceWorker.evaluate(async () => (await chrome.storage.local.get("jal-compare-cash"))["jal-compare-cash"]))
    .toBe(false);

  const jalPage = await context.newPage();
  await jalPage.goto("https://www.jal.co.jp/ar/en/");
  const homepagePanel = jalPage.locator(".jal-helper-panel");
  await expect(homepagePanel.locator("summary")).toHaveText("Award searches");
  await expect(homepagePanel.locator("tbody tr")).toHaveCount(2);

  const recentRequest = awardPage.waitForRequest(
    (request) => request.isNavigationRequest() && request.method() === "POST"
  );
  await panel.locator("tbody tr").filter({ hasText: "SFO-HND" }).getByRole("button", { name: "Search" }).press("Enter");
  const recentBody = new URLSearchParams((await recentRequest).postData() || "");
  expect(recentBody.get("FLOW_MODE")).toBe("REDEMPTION");
  expect(recentBody.get("DEPARTURE_LOCATION_1")).toBe("SFO");
  expect(recentBody.get("ARRIVAL_LOCATION_1")).toBe("HND");
  expect(recentBody.get("DEPARTURE_DATE_1")).toBe("202610010000");
  expect(recentBody.get("CFF_1")).toBe("9JE");
  expect(recentBody.get("ENC")).toBe("e2e-token");
  expect(recentBody.get("ENCT")).toBe("2");
  expect(recentBody.get("DIRECT_NON_STOP")).toBe("TRUE");
  await expect.poll(() => events).toContain("fresh-award-search");

  await context.close();
});

test("surfaces JAL's exact OTP page when revenue authentication needs interaction", async ({}, testInfo) => {
  let awardRequests = 0;
  const { context, serviceWorker } = await launchExtension(testInfo.outputPath("profile"));
  await addBookingToken(context);

  await context.route("https://www.jal.co.jp/**", async (route) => {
    if (new URL(route.request().url()).pathname.includes("getEnc1A.cgi")) {
      await route.fulfill({
        status: 200,
        headers: { "Set-Cookie": "enc1A=e2e-token; Domain=.jal.co.jp; Path=/" },
        body: ""
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>JAL</body></html>" });
  });
  await context.route("https://book-i.jal.co.jp/**", async (route) => {
    const request = route.request();
    if (!request.url().includes("JAL_SESSION_ID=")) {
      await route.fulfill({ status: 302, headers: { Location: otpUrl }, body: "" });
      return;
    }
    if (request.url().includes("otp-revenue-session")) {
      if (request.method() === "POST") {
        expect(new URLSearchParams(request.postData() || "").get("FLOW_MODE")).toBe("REVENUE");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: bookingPage("REVENUE", "otp-revenue-session", "1YE", { cash: 1234 })
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: bookingPage("REVENUE", "otp-revenue-session", "1YE", {}, false, false)
      });
      return;
    }
    if (request.method() === "POST") awardRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: bookingPage("REDEMPTION", "award-session", "9YE", { miles: 35_000 }, true)
    });
  });
  await context.route("https://jallogin.jal.co.jp/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><head><title>One-time password</title></head><body><label>OTP <input></label></body></html>"
    })
  );

  const awardPage = await context.newPage();
  await awardPage.goto(awardUrl);

  await expect
    .poll(async () => {
      const tabs = await serviceWorker.evaluate(
        () => new Promise<Array<{ active?: boolean; url?: string }>>((resolve) => chrome.tabs.query({}, resolve))
      );
      return tabs.find((tab) => tab.active)?.url;
    })
    .toBe(otpUrl);
  await expect(awardPage.locator(".jal-helper-status")).toHaveText(
    "Waiting for JAL verification…"
  );
  await expect(awardPage.locator(".jal-helper-status")).toHaveAttribute("data-loading", "true");

  const status = await serviceWorker.evaluate(
    async () => (await chrome.storage.local.get("jal-revenue-status"))["jal-revenue-status"]
  );
  expect(status).toMatchObject({ phase: "authenticating" });
  expect(awardRequests).toBe(0);

  const otpPage = context.pages().find((page) => page.url() === otpUrl)!;
  await otpPage.goto(otpRevenueUrl);
  await expect(otpPage.locator(".jal-helper-panel summary")).toHaveText(
    "NYC-TYO · Sep 9, 2026"
  );
  await expect(otpPage.locator(".jal-helper-status")).toHaveText("Finishing cash access…");
  await expect(otpPage.locator(".jal-helper-status")).toHaveAttribute("data-loading", "true");
  await expect(awardPage.locator(".jal-helper-price-row")).toHaveCount(3);

  await context.close();
});

async function launchExtension(userDataDir: string): Promise<{
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
}> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker");
  return {
    context,
    serviceWorker,
    extensionId: new URL(serviceWorker.url()).host
  };
}

async function addBookingToken(context: BrowserContext) {
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
}

function bookingPage(
  mode: "REDEMPTION" | "REVENUE",
  sessionId: string,
  cabinCode: string,
  amount: { miles?: number; cash?: number },
  includeCalendar = false,
  includePrices = true
): string {
  const price = {
    totalPrice: {
      cashAmount: amount.cash == null ? undefined : { amount: amount.cash, currency: "USD" },
      milesAmount: amount.miles == null ? undefined : { amount: amount.miles }
    },
    totalPriceWithoutTax: {
      milesAmount: amount.miles == null ? undefined : { amount: amount.miles }
    },
    totalTaxes: { cashAmount: { amount: 50, currency: "USD" } },
    currency: "USD"
  };
  const data = {
    jsessionid: sessionId,
    PAGE: {
      DATA: {
        jlPageSettings: {
          requestParams: {
            SITE: "J019J019",
            LANGUAGE: "GB",
            COUNTRY_SITE: "JAL_AR_US",
            FLOW_MODE: mode,
            PATTERN: "1B",
            DDS_FROM_PAGE: "ODCL",
            IS_FLEXIBLE: "TRUE",
            DEPARTURE_LOCATION_1: "NYC",
            ARRIVAL_LOCATION_1: "TYO",
            DEPARTURE_DATE_1: "202609090000",
            CFF_OUTBOUND: cabinCode,
            NB_ADT: "1",
            NB_CHD: "0",
            NB_INF: "0",
            DIRECT_NON_STOP: "FALSE"
          }
        },
        context: {
          flow: {
            mode,
            departureLocations: ["NYC"],
            arrivalLocations: ["TYO"],
            departureDates: [Date.UTC(2026, 8, 9)],
            cffOutbound: cabinCode
          }
        },
        jlSearch: {
          cabins: [
            { cabinName: "Economy", cabinCode: "9YE" },
            { cabinName: "Business", cabinCode: "9JE" }
          ]
        },
        jlowdFlexpricerAvailability: {
          calendar: {
            itineraryRecommendations: includePrices
              ? { "20260909": { recommendation: { recommendationPrice: { price } } } }
              : {}
          }
        }
      }
    }
  };
  const calendar = includeCalendar
    ? `<style>
        body { margin: 0; padding: 48px; background: #f3f4f6; color: #1f2933; font: 14px Arial, sans-serif; }
        .demo-page { max-width: 1040px; margin: 0 auto; }
        .demo-label { margin: 0 0 8px; color: #6b7280; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
        h1 { margin: 0; font-size: 30px; }
        .demo-meta { margin: 8px 0 24px; color: #6b7280; }
        .demo-calendar { padding: 18px; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; box-shadow: 0 4px 18px rgba(17, 24, 39, .08); }
        .demo-calendar-heading { margin: 0 0 14px; font-size: 16px; }
        .cell { width: 220px; min-height: 180px; border: 1px solid #d1d5db; border-radius: 3px; }
        .cell-content { padding: 12px; }
        time { display: block; margin-bottom: 12px; font-weight: 700; }
      </style>
      <main class="demo-page">
        <p class="demo-label">JAL · Award calendar</p>
        <h1>New York → Tokyo</h1>
        <p class="demo-meta">September 2026 · 1 traveler · Flexible dates</p>
        <section class="demo-calendar">
          <h2 class="demo-calendar-heading">Wednesday, September 9</h2>
          <jal-calendar-bound-date-desktop>
            <div class="cell"><div class="cell-content"><time datetime="2026-09-09">Sep 9</time></div></div>
          </jal-calendar-bound-date-desktop>
        </section>
      </main>`
    : "";
  return `<html><head><meta charset="UTF-8"></head><body>${calendar}<script id="clientSideData" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}
