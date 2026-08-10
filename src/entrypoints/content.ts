import {
  COMPARE_CASH_KEY,
  REVENUE_AUTH_HASH,
  JalData,
  PriceMap,
  RevenueProbeResult,
  RevenueSearch,
  SearchContext,
  availabilityUrl,
  buildAwardBootstrap,
  buildAwardSearch,
  buildRevenueBootstrap,
  extractSearch,
  isRevenue,
  jalParams,
  pageError,
  parseJalData,
  parsePrices
} from "../lib/jal";
import "../styles/jal-helper.css";

const CACHE_TTL = 6 * 60 * 60 * 1000;
const REQUEST_GAP = 900;
const REVENUE_PROBE_TIMEOUT = 30_000;
const RECENT_SEARCHES_KEY = "jal-recent-searches";
const inFlight = new Map<string, Promise<PriceMap>>();
let queue: Promise<void> = Promise.resolve();
let lastRequest = 0;
let runId = 0;
let context: SearchContext | null = null;
let awards: Record<string, PriceMap> = {};
let cash: PriceMap | undefined;

let activeRevenueProbe: {
  id: string;
  finish: (result: RevenueProbeResult) => void;
} | null = null;

export default defineContentScript({
  matches: ["https://book-i.jal.co.jp/*", "https://www.jal.co.jp/*"],
  runAt: "document_idle",
  async main() {
    if (location.hostname === "www.jal.co.jp") {
      if (location.hash.startsWith(REVENUE_AUTH_HASH)) await startRevenueAuth();
      else mountPanel(null, await recentSearches());
      return;
    }
    if (location.hostname !== "book-i.jal.co.jp") return;

    const data = parseJalData();
    if (!data) return;
    if (isRevenue(data)) {
      const revenueSearch = extractSearch(data);
      mountPanel(revenueSearch, await recentSearches());
      setPanelStatus("Finishing cash access…", true);
      await reportRevenuePage(data);
      setPanelStatus("Cash access ready.", false);
      return;
    }

    context = extractSearch(data);
    if (!context) return;
    const error = pageError(data, "JAL award search returned an error.");
    if (error) {
      mountPanel(context, await recentSearches());
      setPanelStatus(error, false, true);
      return;
    }
    awards = { [context.cabinCode]: parsePrices(data) };
    mountPanel(context, await remember(context));
    registerRuntimeMessages();
    await compare(context);

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[COMPARE_CASH_KEY] && context) void compare(context);
    });
  }
});

function registerRuntimeMessages() {
  browser.runtime.onMessage.addListener(async (raw: unknown) => {
    const message = raw as {
      type?: string;
      id?: string;
      search?: RevenueSearch;
      prices?: PriceMap;
      message?: string;
    };
    if (message.type === "jal:revenue-probe") {
      if (!message.id || !message.search) {
        return { status: "error" as const, message: "The revenue probe request was incomplete." };
      }
      return probeRevenue(message.id, message.search);
    }
    if (message.type === "jal:revenue-probe-auth-required") {
      const probe = activeRevenueProbe;
      if (probe && probe.id === message.id) probe.finish({ status: "auth-required" });
      return;
    }
    if (message.type === "jal:cancel-revenue-probe") {
      const probe = activeRevenueProbe;
      if (probe && probe.id === message.id) {
        probe.finish({ status: "cancelled" });
        setPanelStatus("Cash comparison is off.", false);
      }
      return;
    }
    if (message.type === "jal:revenue-auth-failed") {
      setPanelStatus(message.message || "Cash-fare authentication failed.", false, true);
      return;
    }
    if (message.type !== "jal:revenue-ready" || !message.prices || !context) return;
    const enabled = (await browser.storage.local.get(COMPARE_CASH_KEY))[COMPARE_CASH_KEY] !== false;
    if (!enabled) return;
    cash = message.prices;
    setPanelStatus("Loading fare classes…", true);
    await loadAwards(context, ++runId, true);
  });
}

async function probeRevenue(id: string, search: RevenueSearch): Promise<RevenueProbeResult> {
  if (activeRevenueProbe) {
    return { status: "error", message: "Another JAL revenue request is already running." };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: HTMLIFrameElement | undefined;
  let form: HTMLFormElement | undefined;
  let resolveProbe: ((result: RevenueProbeResult) => void) | undefined;

  const result = new Promise<RevenueProbeResult>((resolve) => {
    resolveProbe = resolve;
  });
  const finish = (response: RevenueProbeResult) => {
    if (activeRevenueProbe?.id !== id) return;
    if (timer) clearTimeout(timer);
    form?.remove();
    frame?.remove();
    activeRevenueProbe = null;
    resolveProbe?.(response);
  };
  activeRevenueProbe = { id, finish };

  const inspect = () => {
    const data = frame?.contentDocument ? parseJalData(frame.contentDocument) : null;
    if (!data) return;
    if (!isRevenue(data)) {
      finish({
        status: "error",
        message: pageError(data, "JAL returned a non-revenue response.") ||
          "JAL returned a non-revenue response."
      });
      return;
    }
    if (!data.jsessionid) {
      finish({ status: "error", message: "JAL returned a revenue page without a session." });
      return;
    }
    const error = pageError(data, "JAL revenue bootstrap returned an error.");
    if (error) {
      finish({ status: "error", message: error });
      return;
    }
    finish({
      status: "ready",
      session: { sessionId: data.jsessionid, params: jalParams(data) },
      prices: parsePrices(data)
    });
  };

  try {
    const token = await bookingToken();
    if (activeRevenueProbe?.id !== id) return result;

    // Same-origin with the award page: JAL's Lax cookies are sent and a
    // successful revenue document is readable. An OTP redirect is not.
    frame = document.createElement("iframe");
    frame.name = `jal-helper-revenue-probe-${id}`;
    frame.style.cssText =
      "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
    frame.addEventListener("load", inspect);
    document.body.append(frame);

    form = document.createElement("form");
    form.method = "POST";
    form.action = availabilityUrl();
    form.target = frame.name;
    form.hidden = true;
    for (const [name, value] of buildRevenueBootstrap(search, token)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
    timer = setTimeout(() => {
      finish({ status: "error", message: "JAL revenue bootstrap did not complete." });
    }, REVENUE_PROBE_TIMEOUT);
  } catch (error) {
    finish({
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }

  return result;
}

async function startRevenueAuth() {
  const id = decodeURIComponent(location.hash.slice(REVENUE_AUTH_HASH.length));
  const auth = (await browser.runtime.sendMessage({
    type: "jal:get-revenue-auth-request",
    id
  })) as { search?: RevenueSearch };

  try {
    if (!auth.search) throw new Error("The revenue authentication request expired.");
    const form = document.createElement("form");
    form.method = "POST";
    form.action = availabilityUrl();
    form.hidden = true;
    for (const [name, value] of buildRevenueBootstrap(auth.search, await bookingToken())) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  } catch (error) {
    await browser.runtime.sendMessage({
      type: "jal:revenue-auth-failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function reportRevenuePage(data: JalData) {
  if (!data.jsessionid) return;
  await browser.runtime.sendMessage({
    type: "jal:revenue-page-ready",
    session: { sessionId: data.jsessionid, params: jalParams(data) },
    prices: parsePrices(data)
  });
}

async function compare(search: SearchContext) {
  const currentRun = ++runId;
  const compareCash =
    (await browser.storage.local.get(COMPARE_CASH_KEY))[COMPARE_CASH_KEY] !== false;
  cash = undefined;
  setPanelStatus(compareCash ? "Checking cash access…" : "Loading fare classes…", true);

  if (compareCash) {
    const response = (await browser.runtime.sendMessage({
      type: "jal:prepare-revenue",
      search
    })) as { status?: string; prices?: PriceMap; message?: string };
    if (currentRun !== runId) return;
    if (response.status === "error") {
      setPanelStatus(response.message || "Cash-fare access failed.", false, true);
      return;
    }
    if (response.status === "cancelled") {
      setPanelStatus("Cash comparison is off.", false);
      return;
    }
    if (response.status !== "ready" || !response.prices) {
      setPanelStatus("Waiting for JAL verification…", true);
      return;
    }
    cash = response.prices;
    setPanelStatus("Loading fare classes…", true);
  }

  await loadAwards(search, currentRun, compareCash);
}

async function loadAwards(search: SearchContext, currentRun: number, compareCash: boolean) {
  const unavailable: string[] = [];
  for (const cabin of search.cabins) {
    if (currentRun !== runId) return;
    if (awards[cabin.code]) continue;
    try {
      awards[cabin.code] = await fetchAwardCalendar(search, cabin.code);
    } catch {
      awards[cabin.code] = {};
      unavailable.push(cabin.label);
    }
  }
  if (currentRun === runId) {
    render(search, compareCash);
    const message = unavailable.length
      ? `Some fares are unavailable (${unavailable.join(", ")}).`
      : "Fares ready.";
    setPanelStatus(message, false, unavailable.length > 0);
  }
}

async function fetchAwardCalendar(search: SearchContext, cabinCode: string): Promise<PriceMap> {
  const key = [
    "jal-award",
    search.sessionId,
    cabinCode,
    search.origin,
    search.destination,
    search.departureDate,
    search.params.NB_ADT || "1",
    search.params.NB_CHD || "0",
    search.params.NB_INF || "0",
    search.params.DIRECT_NON_STOP || "FALSE"
  ].join(":");
  const cached = (await browser.storage.local.get(key))[key] as
    | { expires: number; prices: PriceMap }
    | undefined;
  if (cached?.expires && cached.expires > Date.now()) return cached.prices;
  if (inFlight.has(key)) return inFlight.get(key)!;

  const task = enqueue(async () => {
    const response = await fetch(availabilityUrl(search.sessionId), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: buildAwardSearch({ ...search, cabinCode }).toString()
    });
    if (!response.ok) throw new Error(`JAL award availability failed: ${response.status}`);
    const data = parseJalData(await response.text());
    if (!data) throw new Error("JAL award availability returned no booking data");
    const error = pageError(data, "JAL award availability returned an error");
    if (error) throw new Error(error);
    const prices = parsePrices(data);
    if (!Object.keys(prices).length) throw new Error("JAL award calendar returned no prices");
    await browser.storage.local.set({ [key]: { expires: Date.now() + CACHE_TTL, prices } });
    return prices;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function remember(search: SearchContext): Promise<RevenueSearch[]> {
  const stored = await recentSearches();
  const current: RevenueSearch = {
    origin: search.origin,
    destination: search.destination,
    departureDate: search.departureDate,
    cabinCode: search.cabinCode,
    params: Object.fromEntries(
      Object.entries(search.params).filter(([name]) =>
        [
          "PATTERN",
          "NB_ADT",
          "NB_YADT",
          "NB_CHD",
          "NB_INF",
          "DIRECT_NON_STOP",
          "DEPARTURE_LOCATION_2",
          "ARRIVAL_LOCATION_2",
          "DEPARTURE_DATE_2",
          "DEPARTURE_AREA_1",
          "DEPARTURE_AREA_2",
          "ARRIVAL_AREA_1",
          "ARRIVAL_AREA_2"
        ].includes(name)
      )
    )
  };
  const seen = new Set<string>();
  const recent = [current, ...stored]
    .filter((item) => {
      const id = searchId(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, 5);
  await browser.storage.local.set({ [RECENT_SEARCHES_KEY]: recent });
  return recent;
}

async function recentSearches(): Promise<RevenueSearch[]> {
  return ((await browser.storage.local.get(RECENT_SEARCHES_KEY))[
    RECENT_SEARCHES_KEY
  ] as RevenueSearch[] | undefined) ?? [];
}

function mountPanel(search: SearchContext | null, recent: RevenueSearch[]) {
  document.querySelector(".jal-helper-panel")?.remove();
  const panel = document.createElement("details");
  panel.className = "jal-helper-panel";
  panel.open = true;

  const summary = document.createElement("summary");
  summary.textContent = search
    ? `${search.origin}-${search.destination} · ${displayDate(search.departureDate, true)}`
    : "Award searches";

  const body = document.createElement("div");
  body.className = "jal-helper-panel-body";
  if (search) {
    const status = document.createElement("p");
    status.className = "jal-helper-status";
    status.dataset.loading = "true";
    status.setAttribute("aria-live", "polite");
    status.textContent = "Checking cash access…";
    body.append(status);
  }

  const links = document.createElement("nav");
  links.className = "jal-helper-links";
  links.setAttribute("aria-label", "JAL award booking");
  for (const [label, href] of [
    ["International", "https://www.jal.co.jp/arl/en/jmb/award/"],
    ["Domestic", "https://www.jal.co.jp/jp/en/jmb/award-dom/booking/"]
  ] as const) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    links.append(link);
  }

  body.append(links);
  if (recent.length) {
    const heading = document.createElement("h2");
    heading.textContent = "Recent searches";
    const table = document.createElement("table");
    table.className = "jal-helper-recents";
    const header = table.createTHead().insertRow();
    for (const label of ["Route", "Date", "Cabin", ""]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      header.append(cell);
    }
    const rows = table.createTBody();
    for (const item of recent) {
      const row = rows.insertRow();
      row.insertCell().textContent = `${item.origin}-${item.destination}`;
      row.insertCell().textContent = displayDate(item.departureDate);
      row.insertCell().textContent = cabinName(search, item.cabinCode);
      const form = document.createElement("form");
      form.method = "POST";
      form.action = availabilityUrl();
      form.addEventListener("submit", (event) => void submitRecent(event, item));
      const button = document.createElement("button");
      button.type = "submit";
      button.className = "jal-helper-search-action";
      button.textContent = "Search";
      form.append(button);
      row.insertCell().append(form);
    }
    body.append(heading, table);
  }

  panel.append(summary, body);
  document.body.append(panel);
}

async function submitRecent(event: SubmitEvent, search: RevenueSearch) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  setPanelStatus("Starting award search…", true);
  try {
    for (const [name, value] of buildAwardBootstrap(search, await bookingToken())) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }
    form.submit();
  } catch (error) {
    setPanelStatus(error instanceof Error ? error.message : String(error), false, true);
  }
}

async function bookingToken(): Promise<string> {
  const read = () => document.cookie.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("enc1A="))
    ?.slice(6);
  let token = read();
  if (!token) {
    await fetch(`https://www.jal.co.jp/cgi-bin/jal/common_rn/getEnc1A.cgi?_${Date.now()}`, {
      credentials: "include",
      cache: "no-store",
      mode: "no-cors"
    });
    token = read();
  }
  if (!token) throw new Error("JAL did not issue its booking token.");
  return decodeURIComponent(token);
}

function setPanelStatus(message: string, loading: boolean, error = false) {
  let status = document.querySelector<HTMLElement>(".jal-helper-status");
  if (!status) {
    const body = document.querySelector<HTMLElement>(".jal-helper-panel-body");
    if (!body) return;
    status = document.createElement("p");
    status.className = "jal-helper-status";
    status.setAttribute("aria-live", "polite");
    body.prepend(status);
  }
  status.textContent = message;
  status.dataset.loading = String(loading);
  status.dataset.error = String(error);
}

function searchId(search: RevenueSearch): string {
  return [
    search.origin,
    search.destination,
    search.departureDate,
    search.cabinCode,
    search.params.NB_ADT,
    search.params.NB_CHD,
    search.params.NB_INF,
    search.params.DIRECT_NON_STOP,
    search.params.DEPARTURE_LOCATION_2,
    search.params.ARRIVAL_LOCATION_2,
    search.params.DEPARTURE_DATE_2
  ].join(":");
}

function displayDate(value: string, year = false): string {
  const date = new Date(
    Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)))
  );
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {})
  }).format(date);
}

function cabinName(search: SearchContext | null, code: string): string {
  return (
    search?.cabins.find((cabin) => cabin.code === code)?.label ??
    ({ "9YE": "Y", "9WE": "PY", "9JE": "J", "9FE": "F" }[code] || code)
  );
}

function render(search: SearchContext, compareCash: boolean) {
  for (const cell of document.querySelectorAll<HTMLElement>("jal-calendar-bound-date-desktop .cell")) {
    const date = cell.querySelector<HTMLTimeElement>("time[datetime]")?.dateTime.replaceAll("-", "").slice(0, 8);
    if (!date) continue;
    const rows = document.createElement("div");
    rows.className = "jal-helper-cell-prices";
    for (const cabin of search.cabins) {
      rows.append(priceRow(cabin.label, formatMiles(awards[cabin.code]?.[date]?.miles)));
    }
    if (compareCash) {
      const price = cash?.[date];
      rows.append(priceRow("Cash", formatMoney(price?.cash, price?.currency)));
    }
    cell.querySelector(".jal-helper-cell-prices")?.remove();
    (cell.querySelector<HTMLElement>(".cell-content") ?? cell).append(rows);
  }
}

function priceRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "jal-helper-price-row";
  const name = document.createElement("span");
  name.className = "jal-helper-price-label";
  name.textContent = label;
  const amount = document.createElement("span");
  amount.className = "jal-helper-price-value";
  amount.dataset.missing = String(value === "-");
  amount.textContent = value;
  row.append(name, amount);
  return row;
}

function formatMoney(amount?: number, currency = "USD"): string {
  if (amount == null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 1 ? 2 : 0
  }).format(amount);
}

function formatMiles(amount?: number): string {
  if (amount == null) return "-";
  return amount >= 1000 ? `${Math.round(amount / 1000)}k` : amount.toLocaleString("en-US");
}

function enqueue<T>(request: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => undefined).then(async () => {
    const wait = REQUEST_GAP - (Date.now() - lastRequest);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await request();
    } finally {
      lastRequest = Date.now();
    }
  });
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
