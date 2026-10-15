"use strict";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const labels = {
  kayak: "Single kayak",
  tandem: "Tandem kayak",
  paddleboard: "Paddleboard",
  pfd: "PFD",
  paddle: "Paddle",
  available: "Available",
  in_use: "On the water",
  inspection_due: "Inspection due",
  maintenance: "Maintenance",
  retired: "Retired",
  open: "Open",
  hold: "On hold",
  closed: "Closed",
};
const actions = {
  RegisterAsset: "Equipment registered",
  InspectAsset: "Equipment inspected",
  SetAssetStatus: "Equipment status changed",
  SetLaunchStatus: "Launch review recorded",
  CheckoutRental: "Rental checked out",
  ReturnRental: "Rental returned",
};
let token = sessionStorage.getItem("kayak-token") || "";
let state = null,
  currentView = "overview",
  fleetFilter = "vessels",
  toastTimer,
  refreshing = false;
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("token")) {
  token = fragment.get("token");
  history.replaceState(null, "", location.pathname + location.search);
}
const time = (value) =>
  new Date(value).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
const dateTime = (value) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const randomHex = (bytes) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
const isManager = () => state?.meta.role === "manager";
const canWrite = () => ["manager", "staff"].includes(state?.meta.role);
const vessel = (asset) =>
  ["kayak", "tandem", "paddleboard"].includes(asset.type);
const badge = (status) =>
  `<span class="badge ${escapeHTML(status)}">${escapeHTML(labels[status] || status)}</span>`;
function icon(type) {
  const kayak =
    '<path d="M24 4C10 13 9 34 24 44c15-10 14-31 0-40Z"/><ellipse cx="24" cy="24" rx="5" ry="9"/><path d="m10 9 28 30M6 5l8 8M34 35l8 8"/>';
  const paddle =
    '<path d="m31 5-16 28M15 30c-9 3-11 13-4 13 5 0 11-5 11-9l-7-4Z"/>';
  const pfd =
    '<path d="m17 7-9 7-3 27h38l-3-27-9-7-7 7-7-7ZM24 15v26M10 25h28M9 33h30"/>';
  return `<span class="boat-icon ${escapeHTML(type)}" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${type === "pfd" ? pfd : type === "paddle" ? paddle : kayak}</svg></span>`;
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      sessionStorage.removeItem("kayak-token");
      if (!$("#access-dialog").open) $("#access-dialog").showModal();
    }
    const error = new Error(
      data.message || "Unable to complete this operation.",
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
function notify(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 6500);
}
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    state = await api("/snapshot");
    sessionStorage.setItem("kayak-token", token);
    $("#error-banner").hidden = true;
    $("#connection").textContent = "Ledger connected";
    $("#connection").classList.remove("offline");
    $("#mode-banner").textContent =
      state.meta.mode === "demo"
        ? "LOCAL DEMO · Sample fleet and synthetic waivers · Saved in SQLite · No blockchain consensus"
        : "HYPERLEDGER FABRIC · Permissioned rental ledger · Connected to your configured network";
    $("#mode-banner").classList.toggle("fabric", state.meta.mode === "fabric");
    $("#today").textContent =
      new Date(state.meta.serverTime)
        .toLocaleDateString("en-US", {
          timeZone: "America/New_York",
          weekday: "long",
          month: "long",
          day: "numeric",
        })
        .toUpperCase() + " / EASTLAKE, OHIO";
    $("#last-updated").textContent =
      `UPDATED ${time(state.meta.serverTime)} ET · ${state.meta.role.toUpperCase()}`;
    if ($("#access-dialog").open) $("#access-dialog").close();
    render();
    return true;
  } catch (error) {
    $("#connection").textContent = "Connection interrupted";
    $("#connection").classList.add("offline");
    $("#error-banner").textContent = error.message;
    $("#error-banner").hidden = false;
    if ($("#access-dialog").open)
      $("#access-error").textContent = error.message;
    return false;
  } finally {
    refreshing = false;
  }
}
function render() {
  const boats = state.assets.filter(vessel);
  const metricData = [
    [
      "Available vessels",
      boats.filter((a) => a.status === "available").length,
      `${boats.length} vessels in the fleet`,
      "◇",
      false,
    ],
    [
      "On the water",
      boats.filter((a) => a.status === "in_use").length,
      `${state.rentals.length} active rentals`,
      "↗",
      false,
    ],
    [
      "Inspections due",
      state.assets.filter((a) => a.status === "inspection_due").length,
      "All equipment · inspect before release",
      "✓",
      false,
    ],
    [
      "Held for repair",
      state.assets.filter((a) => a.status === "maintenance").length,
      "Manager release required",
      "⌁",
      true,
    ],
  ];
  $("#metrics").innerHTML = metricData
    .map(
      ([name, value, note, symbol, attention]) =>
        `<div class="metric"><div class="metric-label">${name}<span class="metric-symbol" aria-hidden="true">${symbol}</span></div><div class="metric-value">${value.toString().padStart(2, "0")}</div><div class="metric-note ${attention ? "attention" : ""}">${note}</div></div>`,
    )
    .join("");
  const dock = boats.filter((a) => a.status === "available").slice(0, 3);
  $("#dock-list").innerHTML = dock.length
    ? dock
        .map(
          (a) =>
            `<div class="dock-row">${icon(a.type)}<div class="dock-name"><strong>${escapeHTML(a.label)}</strong><small>${escapeHTML(a.id)} · ${labels[a.type]} · ${a.capacity} ${a.capacity === 1 ? "seat" : "seats"}</small></div>${badge(a.status)}${canWrite() ? `<button class="text-button" data-command="checkout" data-id="${escapeHTML(a.id)}">Check out ↗</button>` : ""}</div>`,
        )
        .join("")
    : '<div class="empty">No vessels are available. Check returns and inspection records.</div>';
  renderLaunch();
  renderFleet();
  const rentalTable = rentalsTable();
  $("#overview-rentals").innerHTML = rentalTable;
  $("#all-rentals").innerHTML = rentalTable;
  $("#active-count").textContent = state.rentals.length;
  $("#activity-list").innerHTML = state.events.length
    ? state.events
        .map(
          (event) =>
            `<div class="activity-row"><span class="activity-dot" aria-hidden="true">${event.action === "CheckoutRental" ? "↗" : event.action === "ReturnRental" ? "↙" : "✓"}</span><div class="activity-info"><strong>${escapeHTML(actions[event.action] || event.action)} · ${escapeHTML(event.subjectId)}</strong><small>${escapeHTML(event.role)} · ${escapeHTML(event.transactionId)}</small></div><time class="activity-time" datetime="${escapeHTML(event.timestamp)}">${dateTime(event.timestamp)} ET</time></div>`,
        )
        .join("")
    : '<div class="empty">The first recorded operation will appear here.</div>';
  $$(".manager-control").forEach((button) => {
    button.hidden = !isManager();
  });
  $$(".write-control").forEach((button) => {
    button.hidden = !canWrite();
  });
}
function renderLaunch() {
  const review = state.launch;
  const fresh = review && Date.parse(review.validUntil) > Date.now();
  const status = fresh ? review.status : "hold";
  $("#launch-panel").innerHTML =
    `<div class="launch-heading"><div class="eyebrow">THE LAUNCH CHECK</div><span class="launch-icon" aria-hidden="true">↗</span></div><h2>${!review ? "Review needed" : !fresh ? "Review expired" : status === "open" ? "Launch is open." : status === "closed" ? "Launch is closed." : "Launch on hold."}</h2><p>${status === "open" ? "A current staff review is on record.<br>Check local conditions before each departure." : "New checkouts are blocked.<br>Returns and inspections remain available."}</p><div class="launch-facts"><span>Review status</span>${badge(status)}</div><div class="launch-facts"><span>Valid until</span><strong>${review ? `${time(review.validUntil)} ET` : "Not reviewed"}</strong></div>${isManager() ? '<button class="button secondary" data-command="launch">Update launch review →</button>' : ""}<p class="launch-disclaimer">Manual review only. Weather, water and air quality feeds are not connected.${state.meta.mode === "demo" ? " This review is sample data." : ""}</p>`;
}
function rentalsTable() {
  if (!state.rentals.length)
    return '<div class="empty">All recorded rentals are back at the stand.</div>';
  const sorted = [...state.rentals].sort((a, b) =>
    a.dueAt.localeCompare(b.dueAt),
  );
  const mobile = `<div class="mobile-rentals">${sorted
    .map((rental) => {
      const late = Date.parse(rental.dueAt) < Date.now();
      const craft = rental.assetIds.filter((id) =>
        vessel(state.assets.find((a) => a.id === id) || {}),
      );
      return `<div class="mobile-rental-card"><div class="rental-card-heading"><strong>${escapeHTML(rental.id)}</strong>${late ? '<span class="badge overdue">Overdue</span>' : badge("in_use")}</div><p>${escapeHTML(craft.join(", "))} · ${rental.partySize} ${rental.partySize === 1 ? "paddler" : "paddlers"} · ${rental.assetIds.length} equipment items</p><div class="rental-card-bottom"><div><small>RETURN DUE</small><strong class="${late ? "overdue-time" : ""}">${time(rental.dueAt)} ET</strong></div>${canWrite() ? `<button class="return-button" data-command="return" data-id="${escapeHTML(rental.id)}">Check in ↙</button>` : '<span class="muted">Read only</span>'}</div></div>`;
    })
    .join("")}</div>`;
  return `${mobile}<div class="table-wrap rental-table"><table><thead><tr><th>RENTAL</th><th>EQUIPMENT</th><th>RETURN DUE</th><th>STATUS</th><th><span class="muted">ACTION</span></th></tr></thead><tbody>${sorted
    .map((rental) => {
      const late = Date.parse(rental.dueAt) < Date.now();
      const craft = rental.assetIds.filter((id) =>
        vessel(state.assets.find((a) => a.id === id) || {}),
      );
      return `<tr><td><strong>${escapeHTML(rental.id)}</strong><small>${rental.partySize} ${rental.partySize === 1 ? "paddler" : "paddlers"} · out ${time(rental.checkedOutAt)}</small></td><td><strong>${escapeHTML(craft.join(", "))}</strong><small>${rental.assetIds.length} equipment items</small></td><td><strong class="${late ? "overdue-time" : ""}">${time(rental.dueAt)} ET</strong><small>${late ? `${Math.floor((Date.now() - Date.parse(rental.dueAt)) / 60000)} min overdue` : "Return to stand"}</small></td><td>${late ? '<span class="badge overdue">Overdue</span>' : badge("in_use")}</td><td>${canWrite() ? `<button class="return-button" data-command="return" data-id="${escapeHTML(rental.id)}">Check in ↙</button>` : '<span class="muted">Read only</span>'}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}
function renderFleet() {
  const query = $("#fleet-search").value.toLowerCase();
  const assets = state.assets.filter(
    (a) =>
      (fleetFilter === "all" ||
        (fleetFilter === "vessels" ? vessel(a) : a.status === fleetFilter)) &&
      `${a.id} ${a.label}`.toLowerCase().includes(query),
  );
  $("#fleet-grid").innerHTML = assets.length
    ? assets
        .map(
          (a) =>
            `<article class="equipment-card"><div class="equipment-top">${icon(a.type)}${badge(a.status)}</div><h3>${escapeHTML(a.label)}</h3><div class="equipment-id">${escapeHTML(a.id)} · ${labels[a.type]}</div><div class="equipment-facts"><span>${vessel(a) ? `${a.capacity} ${a.capacity === 1 ? "seat" : "seats"}` : "Individual equipment"}</span><span>${a.lastInspection ? `Inspected ${dateTime(a.lastInspection.inspectedAt)}` : "Never inspected"}</span></div><div class="equipment-actions">${canWrite() && !["in_use", "retired"].includes(a.status) ? `<button class="button secondary" data-command="inspect" data-id="${escapeHTML(a.id)}">Inspect</button>` : ""}<button class="text-button" data-command="history" data-id="${escapeHTML(a.id)}">History ↗</button>${isManager() && !["in_use", "retired"].includes(a.status) ? `<button class="text-button" data-command="asset-status" data-id="${escapeHTML(a.id)}">Manage</button>` : ""}</div></article>`,
        )
        .join("")
    : '<div class="empty">No equipment matches this view.</div>';
}
function showView(view) {
  if (!["overview", "fleet", "rentals", "ledger"].includes(view)) return;
  currentView = view;
  $$(".view").forEach((section) => {
    section.hidden = section.id !== `${view}-view`;
  });
  $$(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
    if (button.dataset.view === view)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const text = {
    overview: [
      "A clear view of the dock.",
      "Get the next crew out. Bring every boat back.",
    ],
    fleet: [
      "Know your equipment.",
      "Inspections, condition and custody in one place.",
    ],
    rentals: [
      "Every crew accounted for.",
      "Track departure, return time and equipment handoff.",
    ],
    ledger: [
      "Every handoff has a history.",
      "Follow recorded operations from launch to return.",
    ],
  };
  $("#page-title").textContent = text[view][0];
  $("#page-description").textContent = text[view][1];
}
function openDialog(title, html) {
  $("#operation-title").textContent = title;
  $("#operation-body").innerHTML = html;
  if (!$("#operation-dialog").open) $("#operation-dialog").showModal();
}
function formDialog(
  title,
  fields,
  action,
  payloadFrom,
  submitLabel = "Record operation",
) {
  const requestId = crypto.randomUUID();
  let uncertainPayload = null;
  openDialog(
    title,
    `<form id="operation-form">${fields}<p class="form-error" role="alert"></p><div class="form-actions"><button type="button" class="button secondary" data-close>Cancel</button><button type="submit" class="button primary">${submitLabel}</button></div></form>`,
  );
  $("#operation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      submit = form.querySelector("[type=submit]");
    form.querySelector(".form-error").textContent = "";
    submit.disabled = true;
    submit.textContent = "Recording…";
    let payload;
    try {
      payload = uncertainPayload || (await payloadFrom(new FormData(form)));
      const receipt = await api("/transactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify({ action, payload }),
      });
      $("#operation-dialog").close();
      notify(
        `${actions[action]} · receipt ${receipt.transactionId.slice(0, 18)}…`,
      );
      await refresh();
    } catch (error) {
      if (payload && (!error.status || error.status >= 500))
        uncertainPayload = payload;
      form.querySelector(".form-error").textContent =
        error.message +
        (uncertainPayload
          ? " Retrying will resend the original request unchanged."
          : "");
    } finally {
      submit.disabled = false;
      submit.textContent = submitLabel;
    }
  });
}
const reasons = () =>
  [
    "ROUTINE",
    "BODY_DAMAGE",
    "FITTINGS",
    "CLEANING",
    "WEATHER",
    "WATER",
    "AIR_QUALITY",
    "STAFF_REVIEW",
    "OTHER",
  ]
    .map(
      (value) =>
        `<option value="${value}">${value.replaceAll("_", " ").toLowerCase()}</option>`,
    )
    .join("");
const options = (assets) =>
  assets
    .map(
      (a) =>
        `<option value="${escapeHTML(a.id)}">${escapeHTML(a.id)} · ${escapeHTML(a.label)}</option>`,
    )
    .join("");
async function checkout(assetId) {
  const ready = state.assets.filter((a) => a.status === "available");
  const boats = ready.filter(vessel);
  if (!boats.length)
    return notify("No available vessels. Inspect equipment before checkout.");
  const rentalId = `RNT-${randomHex(5).toUpperCase()}`;
  const renterRef = `R-${randomHex(12).toUpperCase()}`;
  const demo = state.meta.mode === "demo";
  const demoHash = demo
    ? [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`SYNTHETIC DEMO WAIVER:${rentalId}`),
          ),
        ),
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
    : "";
  formDialog(
    "Ready for the river?",
    `<p>Assign the vessel, fitted PFDs and paddles. Rental and renter references are generated without personal details.</p><div class="form-grid"><label>Rental reference<input name="id" value="${rentalId}" readonly></label><label>Return in<select name="minutes"><option value="60">1 hour</option><option value="120">2 hours</option><option value="180">3 hours</option><option value="240">4 hours</option></select></label></div><div class="form-grid"><label>Vessel<select name="vesselId" id="rental-vessel">${options(boats)}</select></label><label>Paddlers<select name="partySize" id="party-size"><option value="1">1 paddler</option><option value="2">2 paddlers (tandem)</option></select></label></div><div class="form-grid"><label>Fitted PFDs<select name="pfdIds" multiple required>${options(ready.filter((a) => a.type === "pfd"))}</select></label><label>Paddles<select name="paddleIds" multiple required>${options(ready.filter((a) => a.type === "paddle"))}</select></label></div><p class="hint">Hold Ctrl / ⌘ to select multiple items on desktop. Confirm the selected PFDs fit the paddlers.</p><div class="form-section">WAIVER EVIDENCE</div>${demo ? '<p class="hint">Synthetic waiver digest supplied for this demo rental.</p>' : '<label>Hash a signed waiver file locally<input type="file" id="waiver-file" accept="application/pdf,image/*"></label><p class="hint">The file stays in your browser. Keep the original in your approved private records.</p>'}<label>SHA-256 digest<input name="waiverHash" id="waiver-hash" value="${demoHash}" pattern="[a-f0-9]{64}" required placeholder="64-character SHA-256 digest" ${demo ? "readonly" : ""}></label><label class="checkbox"><input type="checkbox" name="briefing" required>Safety briefing completed with this crew</label><label class="checkbox"><input type="checkbox" name="pfdFit" required>Fitted PFDs confirmed for every paddler</label>`,
    "CheckoutRental",
    (form) => ({
      id: rentalId,
      assetIds: [
        form.get("vesselId"),
        ...form.getAll("pfdIds"),
        ...form.getAll("paddleIds"),
      ],
      partySize: Number(form.get("partySize")),
      renterRef,
      waiverHash: form.get("waiverHash").trim(),
      dueAt: new Date(
        Date.now() + Number(form.get("minutes")) * 60000,
      ).toISOString(),
      briefingConfirmed: form.has("briefing"),
      pfdFitConfirmed: form.has("pfdFit"),
    }),
    "Confirm checkout ↗",
  );
  if (assetId) $("#rental-vessel").value = assetId;
  const fitEquipment = () => {
    const count = Number($("#party-size").value);
    ["pfdIds", "paddleIds"].forEach((name) =>
      [...$(`[name=${name}]`).options].forEach((option, index) => {
        option.selected = index < count;
      }),
    );
  };
  $("#party-size").addEventListener("change", fitEquipment);
  fitEquipment();
  if (!demo)
    $("#waiver-file").addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) {
        $("#operation-form .form-error").textContent =
          "Choose a waiver under 20 MiB.";
        return;
      }
      $("#waiver-hash").value = [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        ),
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    });
}
function inspect(assetId) {
  const a = state.assets.find((asset) => asset.id === assetId);
  formDialog(
    `Inspect ${a.id}`,
    `<p>${escapeHTML(a.label)} · ${labels[a.type]}. A passing inspection makes the equipment available. Maintenance releases require a manager.</p><label class="checkbox"><input type="checkbox" name="body">Body / hull / flotation material checked</label><label class="checkbox"><input type="checkbox" name="fittings">Fittings, straps and attachments checked</label><label class="checkbox"><input type="checkbox" name="clean">Clean and ready for use</label><div class="form-grid"><label>Inspection result<select name="result"><option value="pass">Pass and release</option><option value="fail">Fail and hold for maintenance</option></select></label><label>Reason<select name="reasonCode">${reasons()}</select></label></div>`,
    "InspectAsset",
    (form) => ({
      assetId,
      result: form.get("result"),
      checks: {
        body: form.has("body"),
        fittings: form.has("fittings"),
        clean: form.has("clean"),
      },
      reasonCode: form.get("reasonCode"),
    }),
    "Record inspection",
  );
}
function checkin(rentalId) {
  const rental = state.rentals.find((r) => r.id === rentalId);
  formDialog(
    "Welcome back to the dock.",
    `<p>Check in <strong>${escapeHTML(rentalId)}</strong>. Every returned item will need an inspection. Select any damaged items to place them into maintenance.</p><div class="form-section">DAMAGE OBSERVED</div>${rental.assetIds.map((id) => `<label class="checkbox"><input type="checkbox" name="damagedAssetIds" value="${escapeHTML(id)}">${escapeHTML(id)} · ${escapeHTML(state.assets.find((a) => a.id === id)?.label)}</label>`).join("")}`,
    "ReturnRental",
    (form) => ({ rentalId, damagedAssetIds: form.getAll("damagedAssetIds") }),
    "Confirm return ↙",
  );
}
function launch() {
  formDialog(
    "Review the launch.",
    '<p>Record your operational decision after reviewing current conditions. This application does not measure weather, water or air quality.</p><div class="form-grid"><label>Launch decision<select name="status"><option value="open">Open</option><option value="hold">Hold new launches</option><option value="closed">Closed</option></select></label><label>Review valid for<select name="hours"><option value="1">1 hour</option><option value="2">2 hours</option><option value="4">4 hours</option><option value="8">8 hours</option></select></label></div><label>Reason<select name="reasonCode">' +
      reasons() +
      "</select></label>",
    "SetLaunchStatus",
    (form) => ({
      status: form.get("status"),
      reasonCode: form.get("reasonCode"),
      validUntil: new Date(
        Date.now() + Number(form.get("hours")) * 3600000,
      ).toISOString(),
    }),
    "Record launch review",
  );
  $("[name=reasonCode]").value = "STAFF_REVIEW";
}
function register() {
  formDialog(
    "Add equipment to the fleet.",
    `<p>Use an equipment label, without personal details. The new item starts in inspection due.</p><label>Equipment ID<input name="id" placeholder="K-09" pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,63}" required maxlength="64"></label><label>Equipment label<input name="label" placeholder="River Willow" pattern="[A-Za-z0-9][A-Za-z0-9 .()_-]{1,63}" required maxlength="64"></label><label>Type<select name="type">${["kayak", "tandem", "paddleboard", "pfd", "paddle"].map((type) => `<option value="${type}">${labels[type]}</option>`).join("")}</select></label>`,
    "RegisterAsset",
    (form) => Object.fromEntries(form),
    "Add equipment",
  );
}
function manageAsset(assetId) {
  formDialog(
    `Manage ${assetId}`,
    `<p>Place equipment on hold or retire it from the fleet. Retirement is permanent in this version. Clear a maintenance hold with a passing manager inspection.</p><label>New status<select name="status"><option value="maintenance">Maintenance hold</option><option value="retired">Retired</option></select></label><label>Reason<select name="reasonCode">${reasons()}</select></label>`,
    "SetAssetStatus",
    (form) => ({
      assetId,
      status: form.get("status"),
      reasonCode: form.get("reasonCode"),
    }),
    "Update equipment",
  );
}
async function assetHistory(assetId) {
  openDialog(`History · ${assetId}`, "<p>Loading equipment history…</p>");
  let cursor = "",
    records = [];
  const load = async () => {
    try {
      const page = await api(
        `/assets/${encodeURIComponent(assetId)}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      records = [...records, ...page.items];
      cursor = page.nextCursor;
      $("#operation-body").innerHTML =
        `<p>${state.meta.mode === "demo" ? "Local demonstration records. These are not Fabric transactions." : "Recorded equipment state changes from the Fabric ledger."}</p>${records.map((item) => `<div class="history-item"><strong>${escapeHTML(actions[item.action])} ${badge(item.asset.status)}</strong><small>${dateTime(item.timestamp)} ET<br>${escapeHTML(item.transactionId)}</small></div>`).join("")}${cursor ? '<button class="button secondary history-load" id="load-history">Load earlier records</button>' : ""}`;
      if (cursor) $("#load-history").addEventListener("click", load);
    } catch (error) {
      $("#operation-body").textContent = error.message;
    }
  };
  await load();
}
document.addEventListener("click", async (event) => {
  const view = event.target.closest("[data-view]");
  if (view) showView(view.dataset.view);
  if (event.target.closest("[data-close]")) $("#operation-dialog").close();
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    fleetFilter = filter.dataset.filter;
    $$("[data-filter]").forEach((button) => {
      const active = button === filter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active);
    });
    if (state) renderFleet();
  }
  const command = event.target.closest("[data-command]");
  if (!command || !state) return;
  try {
    const handlers = {
      checkout,
      inspect,
      return: checkin,
      launch,
      register,
      history: assetHistory,
      "asset-status": manageAsset,
    };
    await handlers[command.dataset.command]?.(command.dataset.id);
  } catch (error) {
    notify(error.message);
  }
});
$("#new-rental").addEventListener("click", () =>
  checkout().catch((error) => notify(error.message)),
);
$("#refresh").addEventListener("click", refresh);
$("#fleet-search").addEventListener("input", () => {
  if (state) renderFleet();
});
$("#lock").addEventListener("click", () => {
  token = "";
  state = null;
  sessionStorage.removeItem("kayak-token");
  $("#access-key").value = "";
  $("#access-error").textContent = "";
  if ($("#operation-dialog").open) $("#operation-dialog").close();
  $("#access-dialog").showModal();
  $("#connection").textContent = "Session locked";
  $("#connection").classList.add("offline");
});
$("#access-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
});
$("#access-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = $("#access-key").value.trim();
  $("#access-error").textContent = "";
  const success = await refresh();
  if (success) $("#access-key").value = "";
});
$("#lookup-rental").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = new FormData(event.currentTarget).get("rentalId");
  try {
    const rental = await api(`/rentals/${encodeURIComponent(id)}`);
    openDialog(
      `Rental · ${rental.id}`,
      `<dl class="detail-grid"><dt>Status</dt><dd>${escapeHTML(rental.status)}</dd><dt>Equipment</dt><dd>${escapeHTML(rental.assetIds.join(", "))}</dd><dt>Checked out</dt><dd>${dateTime(rental.checkedOutAt)} ET</dd><dt>Due</dt><dd>${dateTime(rental.dueAt)} ET</dd>${rental.returnedAt ? `<dt>Returned</dt><dd>${dateTime(rental.returnedAt)} ET</dd>` : ""}<dt>Waiver digest</dt><dd>${escapeHTML(rental.waiverHash)}</dd></dl>`,
    );
  } catch (error) {
    notify(error.message);
  }
});
$("#export").addEventListener("click", async () => {
  const success = await refresh();
  if (!success) return;
  const blob = new Blob(
    [
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          scope:
            "Current fleet, active rentals, and latest 50 operations. Per-equipment histories are queried separately.",
          ...state,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = `chagrin-river-${state.meta.mode}-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && token) refresh();
});
setInterval(() => {
  if (token && !document.hidden && !$("#operation-dialog").open) refresh();
}, 30000);
if (token) refresh();
else $("#access-dialog").showModal();
