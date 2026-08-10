type Params = Record<string, string>;

export type PriceMap = Record<string, { miles?: number; cash?: number; currency?: string }>;

export type RevenueSearch = {
  origin: string;
  destination: string;
  departureDate: string;
  cabinCode: string;
  params: Params;
};

export type RevenueSession = {
  sessionId: string;
  params: Params;
};

export type SearchContext = RevenueSearch & {
  sessionId: string;
  cabins: Array<{ code: string; label: string }>;
};

export type JalData = {
  jsessionid?: string;
  PAGE?: {
    DATA?: {
      jlPageSettings?: { requestParams?: Record<string, unknown> };
      context?: {
        flow?: {
          mode?: string;
          departureDates?: number[];
          departureLocations?: string[];
          arrivalLocations?: string[];
          cffOutbound?: string;
        };
      };
      jlSearch?: { cabins?: Array<{ cabinName?: string; cabinCode?: string }> };
      errorMessages?: Array<{ text?: string }>;
      containingErrors?: boolean;
      jlowdFlexpricerAvailability?: {
        calendar?: {
          itineraryRecommendations?: Record<
            string,
            {
              recommendation?: {
                recommendationPrice?: {
                  price?: {
                    totalPrice?: {
                      cashAmount?: { amount?: number; currency?: string };
                      milesAmount?: { amount?: number };
                    };
                    totalPriceWithoutTax?: { milesAmount?: { amount?: number } };
                    currency?: string;
                  };
                };
              };
            }
          >;
        };
      };
    };
  };
};

export const COMPARE_CASH_KEY = "jal-compare-cash";
export const REVENUE_SESSION_KEY = "jal-revenue-session";
export const REVENUE_STATUS_KEY = "jal-revenue-status";
export const REVENUE_AUTH_KEY = "jal-revenue-auth-request";
export const REVENUE_AUTH_HASH = "#jal-helper-revenue=";

const DEFAULT_CABINS = [
  { code: "9YE", label: "Y" },
  { code: "9WE", label: "PY" },
  { code: "9JE", label: "J" },
  { code: "9FE", label: "F" }
];

export function parseJalData(source: Document | string = document): JalData | null {
  const text =
    typeof source === "string"
      ? source.match(/<script\b[^>]*\bid=["']clientSideData["'][^>]*>([\s\S]*?)<\/script>/i)?.[1]
      : source.querySelector<HTMLScriptElement>("#clientSideData")?.textContent;
  if (!text?.trim()) return null;
  try {
    return JSON.parse(text) as JalData;
  } catch {
    return null;
  }
}

export function jalParams(data: JalData): Params {
  return Object.fromEntries(
    Object.entries(data.PAGE?.DATA?.jlPageSettings?.requestParams ?? {}).map(([key, value]) => [
      key,
      value == null ? "" : String(value)
    ])
  );
}

export function isRevenue(data: JalData): boolean {
  const page = data.PAGE?.DATA;
  return String(
    page?.context?.flow?.mode ?? page?.jlPageSettings?.requestParams?.FLOW_MODE ?? ""
  ).toUpperCase() === "REVENUE";
}

export function extractSearch(data: JalData): SearchContext | null {
  const page = data.PAGE?.DATA;
  const params = jalParams(data);
  const flow = page?.context?.flow;
  const sessionId = data.jsessionid ?? location.href.match(/JAL_SESSION_ID=([^?;&]+)/)?.[1];
  const origin = params.DEPARTURE_LOCATION_1 || flow?.departureLocations?.[0];
  const destination = params.ARRIVAL_LOCATION_1 || flow?.arrivalLocations?.[0];
  const departureDate = params.DEPARTURE_DATE_1 || formatDate(flow?.departureDates?.[0]);
  const cabinCode = params.CFF_OUTBOUND || params.CFF_1 || flow?.cffOutbound;
  if (!sessionId || !origin || !destination || !departureDate || !cabinCode) return null;

  const cabins = page?.jlSearch?.cabins
    ?.filter((cabin) => cabin.cabinCode)
    .map((cabin) => ({
      code: cabin.cabinCode!,
      label: cabinLabel(cabin.cabinName ?? "")
    }));

  return {
    sessionId,
    origin,
    destination,
    departureDate,
    cabinCode,
    params,
    cabins: cabins?.length ? cabins : DEFAULT_CABINS
  };
}

export function parsePrices(data: JalData): PriceMap {
  const recommendations =
    data.PAGE?.DATA?.jlowdFlexpricerAvailability?.calendar?.itineraryRecommendations ?? {};
  const prices: PriceMap = {};
  for (const [date, entry] of Object.entries(recommendations)) {
    const price = entry.recommendation?.recommendationPrice?.price;
    if (!price) continue;
    const total = price.totalPrice;
    prices[date] = {
      miles: price.totalPriceWithoutTax?.milesAmount?.amount ?? total?.milesAmount?.amount,
      cash: total?.cashAmount?.amount,
      currency: total?.cashAmount?.currency ?? price.currency
    };
  }
  return prices;
}

export function pageError(data: JalData, fallback: string): string | null {
  const page = data.PAGE?.DATA;
  if (!page?.containingErrors) return null;
  return page.errorMessages?.map(({ text }) => text).filter(Boolean).join(" ") || fallback;
}

export function buildRevenueBootstrap(search: RevenueSearch, encryptionKey: string): URLSearchParams {
  const source = search.params;
  const request = new URLSearchParams({
    SITE: source.SITE || "J019J019",
    LANGUAGE: source.LANGUAGE || "GB",
    COUNTRY_SITE: source.COUNTRY_SITE || "JAL_AR_US",
    ENC: encryptionKey,
    ENCT: "2",
    DEVICE_TYPE: "DESKTOP",
    FLOW_MODE: "REVENUE",
    PATTERN: source.PATTERN || "1B",
    DEPARTURE_LOCATION_1: search.origin.toUpperCase(),
    ARRIVAL_LOCATION_1: search.destination.toUpperCase(),
    DEPARTURE_DATE_1: search.departureDate,
    CFF_1: cashCabin(search.cabinCode),
    NB_ADT: source.NB_ADT || "1",
    NB_YADT: source.NB_YADT || "",
    NB_CHD: source.NB_CHD || "0",
    NB_INF: source.NB_INF || "0",
    IS_FLEXIBLE: "TRUE",
    DIRECT_NON_STOP: source.DIRECT_NON_STOP || "FALSE",
    SIMULTANEOUS_UPGRADE: "FALSE",
    SEARCH_CASSETTE_ID: source.SEARCH_CASSETTE_ID || "",
    WDS_PROMO_CODE: source.WDS_PROMO_CODE || ""
  });

  for (const name of [
    "DEPARTURE_LOCATION_2",
    "ARRIVAL_LOCATION_2",
    "DEPARTURE_DATE_2",
    "DEPARTURE_AREA_1",
    "DEPARTURE_AREA_2",
    "ARRIVAL_AREA_1",
    "ARRIVAL_AREA_2"
  ]) {
    if (source[name]) request.set(name, source[name]);
  }
  return request;
}

export function buildAwardBootstrap(search: RevenueSearch, encryptionKey: string): URLSearchParams {
  const request = buildRevenueBootstrap(search, encryptionKey);
  request.set("FLOW_MODE", "REDEMPTION");
  request.set("CFF_1", search.cabinCode);
  return request;
}

export function buildRevenueCalendar(
  session: RevenueSession,
  search: RevenueSearch,
  fromPage: string
): URLSearchParams {
  const request = new URLSearchParams(session.params);
  const source = search.params;
  request.set("SITE", source.SITE || request.get("SITE") || "J019J019");
  request.set("LANGUAGE", source.LANGUAGE || request.get("LANGUAGE") || "GB");
  request.set("COUNTRY_SITE", source.COUNTRY_SITE || request.get("COUNTRY_SITE") || "JAL_AR_US");
  request.set("DEVICE_TYPE", "desktop");
  request.set("FORCE_OVERRIDE", "TRUE");
  request.set("FLOW_MODE", "REVENUE");
  request.set("WDS_USER_TRAVELLING", "true");
  request.set("STREAM", "booking");
  request.set("PATTERN", source.PATTERN || request.get("PATTERN") || "1B");
  request.set("NB_ADT", source.NB_ADT || "1");
  request.set("NB_YADT", source.NB_YADT || "");
  request.set("NB_CHD", source.NB_CHD || "0");
  request.set("NB_INF", source.NB_INF || "0");
  request.set("IS_FLEXIBLE", "TRUE");
  request.set("DIRECT_NON_STOP", source.DIRECT_NON_STOP || "FALSE");
  request.set("DDS_FROM_PAGE", fromPage);
  request.set("DEPARTURE_LOCATION_1", search.origin.toUpperCase());
  request.set("ARRIVAL_LOCATION_1", search.destination.toUpperCase());
  request.set("DEPARTURE_DATE_1", search.departureDate);
  request.delete("CFF_1");
  request.set("CFF_OUTBOUND", cashCabin(search.cabinCode));
  request.delete("ENC");
  return request;
}

export function buildAwardSearch(search: RevenueSearch): URLSearchParams {
  const request = new URLSearchParams(search.params);
  request.set("COUNTRY_SITE", request.get("COUNTRY_SITE") || "JAL_AR_US");
  request.set("LANGUAGE", request.get("LANGUAGE") || "GB");
  request.set("SITE", request.get("SITE") || "J019J019");
  request.set("DEVICE_TYPE", "desktop");
  request.set("FORCE_OVERRIDE", "TRUE");
  request.set("FLOW_MODE", "REDEMPTION");
  request.set("WDS_USER_TRAVELLING", "true");
  request.set("STREAM", "booking");
  request.set("NB_YADT", request.get("NB_YADT") || "");
  request.set("NB_ADT", request.get("NB_ADT") || "1");
  request.set("NB_CHD", request.get("NB_CHD") || "0");
  request.set("NB_INF", request.get("NB_INF") || "0");
  request.set("PATTERN", request.get("PATTERN") || "1B");
  request.set("IS_FLEXIBLE", "TRUE");
  request.set("DIRECT_NON_STOP", request.get("DIRECT_NON_STOP") || "FALSE");
  request.set("DDS_FROM_PAGE", "ODCL");
  request.set("DEPARTURE_LOCATION_1", search.origin);
  request.set("ARRIVAL_LOCATION_1", search.destination);
  request.set("DEPARTURE_DATE_1", search.departureDate);
  request.delete("CFF_1");
  request.set("CFF_OUTBOUND", search.cabinCode);
  request.set("DEPARTURE_AREA_1", request.get("DEPARTURE_AREA_1") || "");
  request.set("ARRIVAL_AREA_1", request.get("ARRIVAL_AREA_1") || "");
  return request;
}

export function availabilityUrl(sessionId?: string): string {
  const base = "https://book-i.jal.co.jp/JLInt/dyn/air/booking/availability";
  return sessionId ? `${base};JAL_SESSION_ID=${encodeURIComponent(sessionId)}` : base;
}

function cashCabin(cabin: string): string {
  if (cabin === "9WE") return "1WE";
  if (cabin === "9JE" || cabin === "9FE") return "1JE";
  return "1YE";
}

function cabinLabel(name: string): string {
  if (/premium/i.test(name)) return "PY";
  if (/business/i.test(name)) return "J";
  if (/first/i.test(name)) return "F";
  return "Y";
}

function formatDate(epoch?: number): string | undefined {
  if (!epoch) return undefined;
  return new Date(epoch).toISOString().slice(0, 10).replaceAll("-", "") + "0000";
}
