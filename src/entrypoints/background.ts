import {
  COMPARE_CASH_KEY,
  REVENUE_AUTH_HASH,
  REVENUE_AUTH_KEY,
  REVENUE_SESSION_KEY,
  REVENUE_STATUS_KEY,
  PriceMap,
  RevenueSearch,
  RevenueSession,
  availabilityUrl,
  buildRevenueCalendar,
  isRevenue,
  jalParams,
  pageError,
  parseJalData,
  parsePrices
} from "../lib/jal";

type PendingAuth = {
  id: string;
  search: RevenueSearch;
  awardTabId: number;
  authTabId: number;
};

type RevenuePage = {
  session: RevenueSession;
  prices: PriceMap;
};

let closingTab: number | undefined;
let queue: Promise<void> = Promise.resolve();

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((raw: unknown, sender: { tab?: { id?: number } }) => {
    const message = raw as Record<string, unknown> & { type?: string };
    const tabId = sender.tab?.id;

    if (message.type === "jal:prepare-revenue") {
      return tabId
        ? prepareRevenue(message.search as RevenueSearch, tabId)
        : { status: "error" };
    }
    if (message.type === "jal:get-revenue-auth-request") {
      return authForTab(String(message.id ?? ""), tabId);
    }
    if (message.type === "jal:revenue-page-ready") {
      return completeAuth(message as RevenuePage, tabId);
    }
    if (message.type === "jal:revenue-auth-failed") {
      return failAuth(String(message.message || "Revenue authentication failed."));
    }
  });

  browser.tabs.onUpdated.addListener((tabId, { url }) => {
    if (url?.startsWith("https://jallogin.jal.co.jp/")) void revealLogin(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    if (tabId === closingTab) {
      closingTab = undefined;
      return;
    }
    void authClosed(tabId);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[COMPARE_CASH_KEY]?.newValue === false) void cancelAuth();
  });
});

async function prepareRevenue(search: RevenueSearch, awardTabId: number) {
  await setStatus("checking", "Checking cash-fare access…");
  if (await getAuth()) return { status: "authenticating" as const };

  const session = (await browser.storage.local.get(REVENUE_SESSION_KEY))[
    REVENUE_SESSION_KEY
  ] as RevenueSession | undefined;
  if (session) {
    try {
      const result = await enqueue(() => fetchRevenueCalendar(session, search));
      await browser.storage.local.set({ [REVENUE_SESSION_KEY]: result.session });
      await setStatus("ready", "Cash-fare access is ready.");
      return { status: "ready" as const, prices: result.prices };
    } catch {
      await browser.storage.local.remove(REVENUE_SESSION_KEY);
    }
  }

  await beginAuth(search, awardTabId);
  return { status: "authenticating" as const };
}

async function beginAuth(search: RevenueSearch, awardTabId: number) {
  await setStatus("authenticating", "Establishing cash-fare access with JAL…");
  const tab = await browser.tabs.create({ active: false, url: "about:blank" });
  if (tab.id == null) throw new Error("JAL authentication tab could not be created.");

  const auth: PendingAuth = {
    id: crypto.randomUUID(),
    search,
    awardTabId,
    authTabId: tab.id
  };
  await browser.storage.session.set({ [REVENUE_AUTH_KEY]: auth });
  await browser.tabs.update(tab.id, {
    url: `https://www.jal.co.jp/ar/en/${REVENUE_AUTH_HASH}${encodeURIComponent(auth.id)}`
  });
}

async function authForTab(id: string, tabId?: number) {
  const auth = await getAuth();
  return auth?.id === id && auth.authTabId === tabId ? { search: auth.search } : {};
}

async function completeAuth(message: RevenuePage, tabId?: number) {
  const auth = await getAuth();
  if (!auth || auth.authTabId !== tabId || !message.session?.sessionId) return;

  try {
    const result = Object.keys(message.prices).length
      ? message
      : await enqueue(() => fetchRevenueCalendar(message.session, auth.search));
    await browser.storage.local.set({ [REVENUE_SESSION_KEY]: result.session });
    await browser.storage.session.remove(REVENUE_AUTH_KEY);
    await setStatus("ready", "Cash-fare access is ready.");
    await browser.tabs.sendMessage(auth.awardTabId, {
      type: "jal:revenue-ready",
      prices: result.prices
    }).catch(() => undefined);
    closingTab = auth.authTabId;
    await browser.tabs.remove(auth.authTabId);
    await browser.tabs.update(auth.awardTabId, { active: true }).catch(() => undefined);
  } catch (error) {
    await failAuth(error instanceof Error ? error.message : String(error));
  }
}

async function fetchRevenueCalendar(session: RevenueSession, search: RevenueSearch) {
  let lastError = "JAL cash availability failed.";
  for (const fromPage of ["ODCL", "ODUP"]) {
    try {
      const response = await fetch(availabilityUrl(session.sessionId), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: buildRevenueCalendar(session, search, fromPage).toString()
      });
      if (!response.ok) throw new Error(`JAL cash availability failed: ${response.status}`);
      const data = parseJalData(await response.text());
      if (!data || !isRevenue(data)) throw new Error("The JAL revenue session has expired.");
      const error = pageError(data, "JAL cash availability returned an error.");
      if (error) throw new Error(error);
      const prices = parsePrices(data);
      if (!Object.keys(prices).length) throw new Error("JAL cash availability returned no prices.");
      return {
        prices,
        session: { sessionId: data.jsessionid || session.sessionId, params: jalParams(data) }
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}

async function revealLogin(tabId: number) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const auth = await getAuth();
  if (auth?.authTabId !== tabId) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url?.startsWith("https://jallogin.jal.co.jp/")) return;
  await browser.tabs.update(tabId, { active: true });
  await setStatus("authenticating", "Complete JAL verification in the authentication tab.");
}

async function authClosed(tabId: number) {
  const auth = await getAuth();
  if (auth?.authTabId === tabId) {
    await failAuth("JAL cash-fare authentication was closed before it finished.");
  }
}

async function failAuth(message: string) {
  const auth = await getAuth();
  await browser.storage.session.remove(REVENUE_AUTH_KEY);
  await setStatus("error", message);
  if (auth) {
    await browser.tabs.sendMessage(auth.awardTabId, {
      type: "jal:revenue-auth-failed",
      message
    }).catch(() => undefined);
  }
}

async function cancelAuth() {
  const auth = await getAuth();
  await browser.storage.session.remove(REVENUE_AUTH_KEY);
  await setStatus("idle", "Cash comparison is off.");
  if (auth) {
    closingTab = auth.authTabId;
    await browser.tabs.remove(auth.authTabId).catch(() => undefined);
  }
}

async function getAuth(): Promise<PendingAuth | undefined> {
  return (await browser.storage.session.get(REVENUE_AUTH_KEY))[
    REVENUE_AUTH_KEY
  ] as PendingAuth | undefined;
}

async function setStatus(phase: string, message: string) {
  await browser.storage.local.set({ [REVENUE_STATUS_KEY]: { phase, message } });
}

function enqueue<T>(request: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => undefined).then(request);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
