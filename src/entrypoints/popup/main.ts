import { COMPARE_CASH_KEY, REVENUE_STATUS_KEY } from "../../lib/jal";
import "./style.css";

const checkbox = document.querySelector<HTMLInputElement>("#compare-cash")!;
const status = document.querySelector<HTMLParagraphElement>("#cash-status")!;

void browser.storage.local.get([COMPARE_CASH_KEY, REVENUE_STATUS_KEY]).then((stored) => {
  checkbox.checked = stored[COMPARE_CASH_KEY] !== false;
  showStatus(stored[REVENUE_STATUS_KEY]);
});

checkbox.addEventListener("change", () => {
  void browser.storage.local.set({ [COMPARE_CASH_KEY]: checkbox.checked });
  status.hidden = !checkbox.checked;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[COMPARE_CASH_KEY]) {
    checkbox.checked = changes[COMPARE_CASH_KEY].newValue !== false;
    status.hidden = !checkbox.checked;
  }
  if (changes[REVENUE_STATUS_KEY]) showStatus(changes[REVENUE_STATUS_KEY].newValue);
});

function showStatus(value: unknown) {
  const next = value as { phase?: string; message?: string } | undefined;
  status.hidden = !checkbox.checked;
  status.dataset.phase = next?.phase || "idle";
  status.textContent = next?.message || "Cash access is checked before award requests.";
}
