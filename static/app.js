"use strict";

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------
//
// Every browser gets its own session_id so two people hitting the same
// hosted instance can't see each other's pod edits, tracking events, or
// drift. Resolution order on page load:
//
//   1. ?session_id= in the URL        (someone shared a link — honour it)
//   2. vast_session_id in localStorage (returning visitor — keep stable)
//   3. freshly generated               (first visit ever)
//
// Whichever one wins is written back to localStorage and reflected in
// the URL bar via history.replaceState so the URL is always a bookmark
// of the current session. Every /api/* and /vast fetch threads this
// value through as a query param; tracking-pixel URLs baked into the
// VAST XML carry it too, so the CTV player's pings route back to the
// right session partition on arrival at /track.

var SESSION_STORAGE_KEY = "vast_session_id";
var SESSION_ID = null;

function initSession() {
  var urlParam = null;
  try {
    var params = new URLSearchParams(window.location.search);
    urlParam = params.get("session_id");
  } catch(e) { /* older browsers — fall through */ }

  var stored = null;
  try { stored = window.localStorage.getItem(SESSION_STORAGE_KEY); } catch(e) {}

  var chosen = (urlParam && urlParam.trim()) || (stored && stored.trim()) || generateSessionId();

  SESSION_ID = chosen;
  try { window.localStorage.setItem(SESSION_STORAGE_KEY, chosen); } catch(e) {}

  // Reflect the winner in the URL bar so sharing the link or bookmarking
  // it preserves this session. Don't add a history entry — replaceState.
  try {
    var params2 = new URLSearchParams(window.location.search);
    if (params2.get("session_id") !== chosen) {
      params2.set("session_id", chosen);
      var newUrl = window.location.pathname + "?" + params2.toString() + window.location.hash;
      window.history.replaceState(null, "", newUrl);
    }
  } catch(e) {}
}

function generateSessionId() {
  // 8 hex chars — plenty of space for a handful of testers, short
  // enough to eyeball in the chip and type into a URL if needed.
  try {
    var buf = new Uint8Array(4);
    window.crypto.getRandomValues(buf);
    var out = "";
    for (var i = 0; i < buf.length; i++) {
      var h = buf[i].toString(16);
      if (h.length < 2) { h = "0" + h; }
      out += h;
    }
    return out;
  } catch(e) {
    // Fallback — non-crypto, but still unique enough for test traffic
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  }
}

function newSession() {
  var fresh = generateSessionId();
  SESSION_ID = fresh;
  try { window.localStorage.setItem(SESSION_STORAGE_KEY, fresh); } catch(e) {}
  // Full reload so every piece of in-memory state (pod, history, drift
  // cache) rebuilds against the new session from the backend.
  var params = new URLSearchParams(window.location.search);
  params.set("session_id", fresh);
  window.location.search = params.toString();
}

// Append session_id to any URL we fetch. Preserves any existing query
// string; if session_id is already present it gets overwritten with
// the canonical one.
function apiUrl(path) {
  var sep = path.indexOf("?") === -1 ? "?" : "&";
  var sid = encodeURIComponent(SESSION_ID || "default");
  // If session_id already present, replace it. Otherwise append.
  if (path.indexOf("session_id=") !== -1) {
    return path.replace(/session_id=[^&]*/, "session_id=" + sid);
  }
  return path + sep + "session_id=" + sid;
}

var API = "";
var POLL_INTERVAL_MS = 2000;
var AUTOSAVE_DEBOUNCE_MS = 800;
// If the active break receives no events for this long, we assume the
// player/simulator has been killed and finalise the break to history
// with whatever events actually fired. Mirrors FINALISE_IDLE_SECONDS on
// the backend so drift and history stay in agreement.
var BREAK_IDLE_FINALISE_MS = 15000;

var allAssets = [];
var podAds = [];
var adCounter = 0;
var autosaveTimer = null;
var pollTimer = null;
var lastEventTs = new Date().toISOString();  // ignore tracking events older than page load
var breakHistory = [];
var currentBreakEvents = {};
var currentBreakId = null;
var driftByBreak = {};        // break_id -> latest drift record
var latestDriftSnapshot = null;
var pageLoadTs = new Date().toISOString();  // ignore drift records older than this

document.addEventListener("DOMContentLoaded", async function() {
  initSession();          // resolve / generate session_id BEFORE any fetch
  renderSessionChip();
  setupSessionControls();
  initTabs();
  await loadAssets();
  await loadCurrentConfig();
  setupApplyReset();
  setupLiveControls();
  setupVastUrlTab();
  setupDriftControls();
  setupRandomise();
  updateVastUrlDisplay();
  startPolling();
  fetchDrift();  // initial populate
});

function renderSessionChip() {
  var chip = document.getElementById("session-chip-id");
  if (chip) { chip.textContent = SESSION_ID; }
}

function setupSessionControls() {
  var copyBtn = document.getElementById("btn-copy-session");
  if (copyBtn) {
    copyBtn.addEventListener("click", function() {
      if (!SESSION_ID) { return; }
      navigator.clipboard.writeText(SESSION_ID).then(function() {
        var original = copyBtn.textContent;
        copyBtn.textContent = "Copied";
        setTimeout(function() { copyBtn.textContent = original; }, 1500);
      }).catch(function() { /* clipboard may be blocked — no-op */ });
    });
  }
  var newBtn = document.getElementById("btn-new-session");
  if (newBtn) {
    newBtn.addEventListener("click", function() {
      if (!confirm("Start a fresh session? Your current pod, break history and drift totals will be left behind.")) { return; }
      newSession();
    });
  }
}

function initTabs() {
  document.querySelectorAll(".nav__tab").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var target = btn.dataset.tab;
      document.querySelectorAll(".nav__tab").forEach(function(b) {
        b.classList.toggle("nav__tab--active", b === btn);
      });
      document.querySelectorAll(".tab").forEach(function(s) {
        s.classList.toggle("tab--active", s.id === "tab-" + target);
      });
      if (target === "vasturl") { updateVastUrlDisplay(); }
    });
  });
}

async function loadAssets() {
  var list = document.getElementById("asset-list");
  list.innerHTML = "Loading assets...";
  try {
    var res = await fetch("/api/assets");
    if (!res.ok) { throw new Error("HTTP " + res.status); }
    allAssets = await res.json();
    renderAssets(allAssets);
  } catch(e) {
    list.innerHTML = "Error: " + e.message + "";
  }
}

function renderAssets(assets) {
  var list = document.getElementById("asset-list");

  if (!assets || assets.length === 0) {
    list.innerHTML = "No assets match";
    return;
  }

  list.innerHTML = "";

  for (var i = 0; i < assets.length; i++) {
    var a = assets[i];

    var variantText = "";
    if (a.variants && a.variants.length > 0) {
      var dims = [];
      for (var v = 0; v < a.variants.length; v++) {
        dims.push(a.variants[v].width + "x" + a.variants[v].height);
      }
      variantText = a.variants.length + " variant" + (a.variants.length !== 1 ? "s" : "") + " - " + dims.join(", ");
    } else {
      variantText = "No variants";
    }

    var li = document.createElement("li");
    li.className = "asset-card";
    li.setAttribute("draggable", "true");
    li.dataset.assetId = a.asset_id;

    var badge = document.createElement("span");
    badge.className = "asset-card__badge asset-card__badge--" + a.duration + "s";
    badge.textContent = a.duration + "s";

    var info = document.createElement("div");
    info.className = "asset-card__info";

    var name = document.createElement("strong");
    name.className = "asset-card__name";
    name.textContent = a.name;

    var desc = document.createElement("span");
    desc.className = "asset-card__desc";
    desc.textContent = a.description;

    var variants = document.createElement("span");
    variants.className = "asset-card__variants";
    variants.textContent = variantText;

    info.appendChild(name);
    info.appendChild(desc);
    info.appendChild(variants);

    var addBtn = document.createElement("button");
    addBtn.className = "asset-card__add";
    addBtn.textContent = "+";

    li.appendChild(badge);
    li.appendChild(info);
    li.appendChild(addBtn);

    (function(assetId) {
      li.addEventListener("dragstart", function(e) {
        e.dataTransfer.setData("text/plain", assetId);
        e.dataTransfer.effectAllowed = "copy";
        li.classList.add("asset-card--dragging");
      });
      li.addEventListener("dragend", function() {
        li.classList.remove("asset-card--dragging");
      });
      addBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        addAssetToPod(assetId);
      });
    })(a.asset_id);

    list.appendChild(li);
  }

  setupFilterListeners();
}

function setupFilterListeners() {
  var durSelect = document.getElementById("filter-duration");
  var searchInput = document.getElementById("filter-search");
  var newDur = durSelect.cloneNode(true);
  var newSearch = searchInput.cloneNode(true);
  durSelect.parentNode.replaceChild(newDur, durSelect);
  searchInput.parentNode.replaceChild(newSearch, searchInput);
  newDur.addEventListener("change", applyFilters);
  newSearch.addEventListener("input", applyFilters);
}

function applyFilters() {
  var dur = document.getElementById("filter-duration").value;
  var search = document.getElementById("filter-search").value.toLowerCase();
  var filtered = allAssets.filter(function(a) {
    var matchDur = !dur || a.duration === parseInt(dur, 10);
    var matchSearch = !search
      || a.name.toLowerCase().indexOf(search) !== -1
      || a.description.toLowerCase().indexOf(search) !== -1;
    return matchDur && matchSearch;
  });
  renderAssets(filtered);
}

async function loadCurrentConfig() {
  try {
    var res = await fetch(apiUrl("/api/config"));
    if (!res.ok) { throw new Error("HTTP " + res.status); }
    var config = await res.json();
    podAds = [];
    for (var i = 0; i < config.ads.length; i++) {
      var ad = config.ads[i];
      var asset = findAsset(ad.asset_id) || {
        asset_id: ad.asset_id,
        name: ad.title,
        duration: ad.duration,
        description: "",
        variants: []
      };
      var combined = mergeObjects(asset, { ad_id: ad.ad_id, sequence: ad.sequence });
      podAds.push(combined);
    }
    renderPod();
    updatePodMeter();
  } catch(e) {
    console.warn("Could not load config: " + e.message);
  }
}

function findAsset(assetId) {
  for (var i = 0; i < allAssets.length; i++) {
    if (allAssets[i].asset_id === assetId) { return allAssets[i]; }
  }
  return null;
}

function mergeObjects(base, extra) {
  var result = {};
  for (var k in base)  { result[k] = base[k];  }
  for (var k in extra) { result[k] = extra[k]; }
  return result;
}

function addAssetToPod(assetId) {
  var asset = findAsset(assetId);
  if (!asset) { return; }
  adCounter++;
  var newAd = mergeObjects(asset, {
    ad_id: "ad_" + Date.now() + "_" + adCounter,
    sequence: podAds.length + 1
  });
  podAds.push(newAd);
  renderPod();
  updatePodMeter();
  scheduleAutosave();
}

function scheduleAutosave() {
  setAutosaveIndicator("saving");
  if (autosaveTimer) { clearTimeout(autosaveTimer); }
  autosaveTimer = setTimeout(function() {
    saveConfig(false);
  }, AUTOSAVE_DEBOUNCE_MS);
}

async function saveConfig(showStatus) {
  var ads = [];
  var totalDuration = 0;
  for (var i = 0; i < podAds.length; i++) {
    ads.push({
      ad_id:    podAds[i].ad_id,
      title:    podAds[i].name,
      asset_id: podAds[i].asset_id,
      duration: podAds[i].duration,
      sequence: podAds[i].sequence
    });
    totalDuration += podAds[i].duration;
  }

  var payload = { ads: ads };

  try {
    var res = await fetch(apiUrl("/api/config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    var data = await res.json();

    if (data.ok) {
      setAutosaveIndicator("saved");
      if (showStatus) {
        var statusEl = document.getElementById("apply-status");
        statusEl.className = "status-bar status-bar--ok";
        statusEl.textContent = "Saved - " + ads.length + " ad(s), " + totalDuration + "s total";
      }
    } else {
      setAutosaveIndicator("error");
      if (showStatus) {
        var statusEl = document.getElementById("apply-status");
        statusEl.className = "status-bar status-bar--error";
        statusEl.textContent = "Error: " + (data.errors || []).join("; ");
      }
    }
  } catch(e) {
    setAutosaveIndicator("error");
  }
}

function setAutosaveIndicator(state) {
  var el = document.getElementById("autosave-indicator");
  if (state === "saving") {
    el.textContent = "Saving...";
    el.className = "autosave-indicator autosave-indicator--saving";
  } else if (state === "saved") {
    el.textContent = "\u2713 Saved";
    el.className = "autosave-indicator autosave-indicator--saved";
  } else if (state === "error") {
    el.textContent = "\u26a0 Save failed";
    el.className = "autosave-indicator autosave-indicator--error";
  }
}

function renderPod() {
  var zone = document.getElementById("drop-zone");

  zone.ondragover = function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    zone.classList.add("drop-zone--over");
  };
  zone.ondragleave = function(e) {
    if (!zone.contains(e.relatedTarget)) {
      zone.classList.remove("drop-zone--over");
    }
  };
  zone.ondrop = function(e) {
    e.preventDefault();
    zone.classList.remove("drop-zone--over");
    var assetId = e.dataTransfer.getData("text/plain");
    if (assetId) { addAssetToPod(assetId); }
  };

  var countBadge = document.getElementById("pod-ad-count");
  countBadge.textContent = podAds.length + " ad" + (podAds.length !== 1 ? "s" : "");

  if (podAds.length === 0) {
    zone.innerHTML = "Drag assets from the library into the pod or use the + button";
    updatePodMeter();
    renderEpgBlocks();
    return;
  }

  zone.innerHTML = "";

  for (var i = 0; i < podAds.length; i++) {
    (function(ad, idx) {
      var div = document.createElement("div");
      div.className = "pod-ad";
      div.id = "pod-ad-" + ad.ad_id;

      var seq = document.createElement("span");
      seq.className = "pod-ad__seq";
      seq.textContent = idx + 1;

      var info = document.createElement("div");
      info.className = "pod-ad__info";

      var strong = document.createElement("strong");
      strong.textContent = ad.name;

      var dur = document.createElement("span");
      dur.className = "pod-ad__dur";
      dur.textContent = ad.duration + "s";

      info.appendChild(strong);
      info.appendChild(dur);

      var reorder = document.createElement("div");
      reorder.className = "pod-ad__reorder";

      var upBtn = document.createElement("button");
      upBtn.className = "pod-ad__btn";
      upBtn.textContent = "up";
      upBtn.addEventListener("click", function() {
        if (idx > 0) {
          swap(idx, idx - 1);
          resequence();
          renderPod();
          updatePodMeter();
          scheduleAutosave();
        }
      });

      var dnBtn = document.createElement("button");
      dnBtn.className = "pod-ad__btn";
      dnBtn.textContent = "dn";
      dnBtn.addEventListener("click", function() {
        if (idx < podAds.length - 1) {
          swap(idx, idx + 1);
          resequence();
          renderPod();
          updatePodMeter();
          scheduleAutosave();
        }
      });

      reorder.appendChild(upBtn);
      reorder.appendChild(dnBtn);

      var removeBtn = document.createElement("button");
      removeBtn.className = "pod-ad__remove";
      removeBtn.textContent = "x";
      removeBtn.addEventListener("click", function() {
        podAds.splice(idx, 1);
        resequence();
        renderPod();
        updatePodMeter();
        scheduleAutosave();
      });

      div.appendChild(seq);
      div.appendChild(info);
      div.appendChild(reorder);
      div.appendChild(removeBtn);
      zone.appendChild(div);
    })(podAds[i], i);
  }

  updatePodMeter();
  renderEpgBlocks();
}

function swap(i, j) {
  var tmp = podAds[i];
  podAds[i] = podAds[j];
  podAds[j] = tmp;
}

function resequence() {
  for (var i = 0; i < podAds.length; i++) {
    podAds[i].sequence = i + 1;
  }
}

function updatePodMeter() {
  var used = 0;
  for (var i = 0; i < podAds.length; i++) { used += podAds[i].duration; }

  // "Last requested" is only meaningful as a live reference if we've
  // seen a request in this page session. Older records are still shown
  // as a hint but don't drive bar state / warnings.
  var snap = latestDriftSnapshot;
  var last = snap && snap.last_record;
  var lastReq = (snap && snap.last_requested) || null;
  var isFresh = !!(last && last.ts && last.ts >= pageLoadTs && last.requested != null);

  // Ads total
  setText("pod-ads-total", used + "s");

  // Player last requested (+ timestamp sub)
  var reqEl    = document.getElementById("pod-last-requested");
  var reqWhen  = document.getElementById("pod-last-requested-when");
  if (reqEl) {
    if (lastReq != null) {
      reqEl.textContent = lastReq + "s";
    } else {
      reqEl.textContent = "\u2014";
    }
  }
  if (reqWhen) {
    reqWhen.textContent = (last && last.ts) ? ("at " + formatTs(last.ts)) : "";
  }

  // Fill-vs-request status and meter bar colouring
  var statusEl = document.getElementById("pod-fill-status");
  var barFill  = document.getElementById("pod-fill");
  var items    = document.querySelectorAll(".pod-reference__item");
  // Clear state classes on the fill-status item
  var statusItem = statusEl ? statusEl.parentNode : null;
  if (statusItem) {
    statusItem.classList.remove(
      "pod-reference__item--under",
      "pod-reference__item--exact",
      "pod-reference__item--over",
      "pod-reference__item--none"
    );
  }

  if (lastReq == null) {
    if (statusEl) { statusEl.textContent = "No request yet"; }
    if (statusItem) { statusItem.classList.add("pod-reference__item--none"); }
    if (barFill) {
      barFill.style.width = used ? "100%" : "0%";
      barFill.className = "pod-meter__fill pod-meter__fill--neutral";
    }
  } else {
    var diff = used - lastReq;
    var pct  = lastReq ? Math.min((used / lastReq) * 100, 100) : 0;
    var over = used > lastReq;

    if (barFill) {
      barFill.style.width = pct + "%";
      barFill.className = "pod-meter__fill" + (over ? " pod-meter__fill--over" : "");
    }

    if (statusEl) {
      if (diff === 0) {
        statusEl.textContent = "Exact";
        if (statusItem) { statusItem.classList.add("pod-reference__item--exact"); }
      } else if (diff < 0) {
        statusEl.textContent = "\u2212" + Math.abs(diff) + "s under";
        if (statusItem) { statusItem.classList.add("pod-reference__item--under"); }
      } else {
        statusEl.textContent = "+" + diff + "s over";
        if (statusItem) { statusItem.classList.add("pod-reference__item--over"); }
      }
    }
  }

  // Refresh the over-fill warning against the most recent VAST request
  if (latestDriftSnapshot) {
    updateOverfillWarning(latestDriftSnapshot);
  }

  // Enable/disable the Randomise button based on whether we have a cap to respect
  refreshRandomiseButton();

  // Side-effect: swallow the unused `items` variable
  void items;
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) { el.textContent = text; }
}

function setupApplyReset() {
  document.getElementById("btn-apply").addEventListener("click", function() {
    saveConfig(true);
  });
  document.getElementById("btn-reset").addEventListener("click", async function() {
    if (!confirm("Reset to the default configuration?")) { return; }
    await fetch(apiUrl("/api/config/reset"), { method: "POST" });
    await loadCurrentConfig();
    var statusEl = document.getElementById("apply-status");
    statusEl.className = "status-bar status-bar--ok";
    statusEl.textContent = "Reset to default configuration";
  });
}

// ---------------------------------------------------------------------------
// Randomise — build a random pod capped at the last requested duration
// ---------------------------------------------------------------------------

function setupRandomise() {
  var btn = document.getElementById("btn-randomise");
  if (!btn) { return; }
  btn.addEventListener("click", function() {
    randomisePod();
  });
}

function getFreshLastRequested() {
  // Same freshness rule as the warning: ignore records that predate this
  // page load so the cap matches what the user just saw happen.
  var snap = latestDriftSnapshot;
  var last = snap && snap.last_record;
  if (!last || !last.ts || last.ts < pageLoadTs) { return null; }
  if (last.requested == null) { return null; }
  return last.requested;
}

function refreshRandomiseButton() {
  var btn = document.getElementById("btn-randomise");
  if (!btn) { return; }
  var cap = getFreshLastRequested();
  if (cap == null) {
    btn.disabled = true;
    btn.title = "Waiting for a VAST request so we know the duration cap";
  } else {
    btn.disabled = false;
    btn.title = "Replace the pod with a random set of ads fitting under " + cap + "s";
  }
}

function randomisePod() {
  var cap = getFreshLastRequested();
  if (cap == null) { return; }              // button should be disabled anyway
  if (!allAssets || allAssets.length === 0) { return; }

  // Work out a sensible max ad count for this cap so "random count" spans a
  // realistic range. Floor by smallest-asset-duration; cap at 10 so we don't
  // produce absurd pods on big caps.
  var minDur = allAssets[0].duration;
  for (var i = 1; i < allAssets.length; i++) {
    if (allAssets[i].duration < minDur) { minDur = allAssets[i].duration; }
  }
  var hardMax = minDur > 0 ? Math.floor(cap / minDur) : 0;
  if (hardMax > 10) { hardMax = 10; }
  if (hardMax < 0)  { hardMax = 0; }

  // Target count can be 0 (zero fill is a valid outcome) up to hardMax inclusive
  var target = Math.floor(Math.random() * (hardMax + 1));

  var budget = cap;
  var newPod = [];
  adCounter = 0;

  for (var n = 0; n < target; n++) {
    var candidates = [];
    for (var j = 0; j < allAssets.length; j++) {
      if (allAssets[j].duration <= budget) {
        candidates.push(allAssets[j]);
      }
    }
    if (candidates.length === 0) { break; }
    var picked = candidates[Math.floor(Math.random() * candidates.length)];
    adCounter++;
    var combined = mergeObjects(picked, {
      ad_id:    "ad_rand_" + Date.now() + "_" + adCounter,
      sequence: newPod.length + 1
    });
    newPod.push(combined);
    budget -= picked.duration;
  }

  podAds = newPod;
  renderPod();
  updatePodMeter();
  scheduleAutosave();

  // Surface a short status so the user can see what just happened
  var statusEl = document.getElementById("apply-status");
  if (statusEl) {
    var total = cap - budget;
    statusEl.className = "status-bar status-bar--ok";
    statusEl.textContent = newPod.length === 0
      ? "Randomised: zero fill (cap " + cap + "s)"
      : "Randomised: " + newPod.length + " ad(s), " + total + "s / " + cap + "s";
  }
}

var EVENT_LABELS = {
  vast_request:  "VAST Request",
  impression:    "Impression",
  start:         "Start",
  firstQuartile: "25%",
  midpoint:      "50%",
  thirdQuartile: "75%",
  complete:      "Complete"
};

var EVENT_COLOURS = {
  vast_request:  "#6366f1",
  impression:    "#0ea5e9",
  start:         "#22c55e",
  firstQuartile: "#84cc16",
  midpoint:      "#eab308",
  thirdQuartile: "#f97316",
  complete:      "#ef4444"
};

var EVENT_ORDER = [
  "impression",
  "start",
  "firstQuartile",
  "midpoint",
  "thirdQuartile",
  "complete"
];

function startPolling() {
  if (pollTimer) { clearInterval(pollTimer); }
  pollTimer = setInterval(function() {
    pollTrackingEvents();
  }, POLL_INTERVAL_MS);
}

async function pollTrackingEvents() {
  try {
    var url = apiUrl("/api/events?limit=50");
    var res = await fetch(url);
    var data = await res.json();
    processNewEvents(data.events);
  } catch(e) {
    console.warn("Poll failed: " + e.message);
  }
  // If nothing has hit the active break for a while, push it to history
  // before any future events can pile on top of the same break_id.
  checkBreakIdleTimeout();
  // Also refresh drift on the same cadence
  fetchDrift();
}

function checkBreakIdleTimeout() {
  if (!currentBreakId) { return; }
  var breakData = currentBreakEvents[currentBreakId];
  if (!breakData || !breakData.lastLocalMs) { return; }
  if ((Date.now() - breakData.lastLocalMs) >= BREAK_IDLE_FINALISE_MS) {
    finaliseBreak(currentBreakId);
  }
}

function processNewEvents(events) {
  if (!events || events.length === 0) { return; }

  var newEvents = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.event === "vast_request") { continue; }
    if (!lastEventTs || e.ts > lastEventTs) {
      newEvents.push(e);
    }
  }

  if (newEvents.length === 0) { return; }

  newEvents.sort(function(a, b) { return a.ts > b.ts ? 1 : -1; });
  lastEventTs = newEvents[newEvents.length - 1].ts;

  for (var i = 0; i < newEvents.length; i++) {
    handleTrackingEvent(newEvents[i]);
  }

  updateLiveView();
}

function handleTrackingEvent(e) {
  var breakId = e.break_id || "unknown";
  var adId    = e.ad_id    || "unknown";
  var event   = e.event;

  if (currentBreakId && currentBreakId !== breakId) {
    finaliseBreak(currentBreakId);
  }
  currentBreakId = breakId;

  if (!currentBreakEvents[breakId]) {
    currentBreakEvents[breakId] = {
      break_id:     breakId,
      started:      e.ts,
      updated:      e.ts,
      lastLocalMs:  Date.now(),
      ads:          {}
    };
  }

  var breakData = currentBreakEvents[breakId];
  breakData.updated      = e.ts;          // server ISO ts, still used for display
  breakData.lastLocalMs  = Date.now();    // client monotonic-ish stamp for watchdog
                                          // (server emits tz-naive UTC, so we can't
                                          //  safely Date.parse it for elapsed-time)

  if (!breakData.ads[adId]) {
    breakData.ads[adId] = {
      ad_id:    adId,
      name:     getAdName(adId),
      sequence: parseInt(e.sequence, 10) || 0,
      events:   {}
    };
  }

  breakData.ads[adId].events[event] = e.ts;

  if (event === "complete") {
    var allComplete = true;
    var adIds = Object.keys(breakData.ads);
    for (var i = 0; i < adIds.length; i++) {
      if (!breakData.ads[adIds[i]].events["complete"]) {
        allComplete = false;
        break;
      }
    }
    if (allComplete && adIds.length >= podAds.length && podAds.length > 0) {
      setTimeout(function() {
        finaliseBreak(breakId);
      }, 3000);
    }
  }
}

function getAdName(adId) {
  for (var i = 0; i < podAds.length; i++) {
    if (podAds[i].ad_id === adId) { return podAds[i].name; }
  }
  return adId;
}

function finaliseBreak(breakId) {
  var breakData = currentBreakEvents[breakId];
  // Re-entry guard: once finalised we delete the live record, so any
  // subsequent call (e.g. the 3s all-complete timer racing with the
  // idle watchdog) no-ops here. Note we deliberately do NOT dedupe by
  // break_id against breakHistory — the simulator reuses the same id
  // across runs, and each run is a legitimately new break.
  if (!breakData) { return; }

  breakHistory.unshift(breakData);
  renderBreakHistory();

  delete currentBreakEvents[breakId];
  currentBreakId = null;
  if (epgPlayState.breakId === breakId) { finishEpgBreak(); }
  updateLiveView();
}

// ---------------------------------------------------------------------------
// Live Pod View — EPG-style right-to-left strip
// ---------------------------------------------------------------------------

var EPG_PX_PER_SEC = 6;            // visual scale of the EPG strip
var epgAnimHandle = null;
var epgPlayState = {
  breakId:           null,
  currentSeq:        null,
  currentStartLocal: 0,   // Date.now() when the current ad was activated
  completedBefore:   0,   // sum of durations of all pod ads with seq < currentSeq
  finished:          false
};

function findPodAdBySeq(seq) {
  for (var i = 0; i < podAds.length; i++) {
    if ((podAds[i].sequence || (i + 1)) === seq) { return podAds[i]; }
  }
  return null;
}

function renderEpgBlocks() {
  var track = document.getElementById("epg-track");
  if (!track) { return; }
  track.innerHTML = "";

  var offset = 0;
  for (var i = 0; i < podAds.length; i++) {
    var ad = podAds[i];
    var seq = ad.sequence || (i + 1);
    var dur = ad.duration || 0;

    var block = document.createElement("div");
    block.className = "epg-block";
    block.dataset.seq = String(seq);
    block.style.width = (dur * EPG_PX_PER_SEC) + "px";

    var title = document.createElement("span");
    title.className = "epg-block__title";
    title.textContent = ad.name || ad.title || ad.ad_id || ("Ad " + seq);
    block.appendChild(title);

    var durLbl = document.createElement("span");
    durLbl.className = "epg-block__dur";
    durLbl.textContent = dur + "s";
    block.appendChild(durLbl);

    track.appendChild(block);
    offset += dur;
  }

  // Reset transform to park the first block at the live edge
  track.style.transform = "translateX(0px)";
  applyEpgBlockStates();
}

function applyEpgBlockStates() {
  var track = document.getElementById("epg-track");
  if (!track) { return; }
  var activeSeq = epgPlayState.currentSeq;
  for (var i = 0; i < track.children.length; i++) {
    var blk = track.children[i];
    var seq = parseInt(blk.dataset.seq, 10);
    var isActive = (seq === activeSeq) && !epgPlayState.finished;
    var isDone   = activeSeq != null && seq < activeSeq;
    blk.classList.toggle("epg-block--active", isActive);
    blk.classList.toggle("epg-block--done",   isDone);
  }
}

function updateEpgTransform() {
  var track = document.getElementById("epg-track");
  if (!track) { return false; }

  var podElapsed = 0;
  var keepAnimating = false;
  var curDur  = 0;
  var elapsed = 0;

  if (epgPlayState.currentSeq != null) {
    var current = findPodAdBySeq(epgPlayState.currentSeq);
    curDur  = current ? (current.duration || 0) : 0;
    elapsed = (Date.now() - epgPlayState.currentStartLocal) / 1000;
    if (elapsed < 0) { elapsed = 0; }
    if (elapsed > curDur) { elapsed = curDur; }
    podElapsed = epgPlayState.completedBefore + elapsed;
    // Keep animating while still inside the active ad window
    keepAnimating = !epgPlayState.finished && elapsed < curDur;
  }

  track.style.transform = "translateX(" + (-podElapsed * EPG_PX_PER_SEC) + "px)";
  updateTvPreviewTick(elapsed, curDur);
  return keepAnimating;
}

function startEpgTick() {
  if (epgAnimHandle !== null) { return; }
  var loop = function() {
    var keep = updateEpgTransform();
    if (keep) {
      epgAnimHandle = requestAnimationFrame(loop);
    } else {
      epgAnimHandle = null;
    }
  };
  epgAnimHandle = requestAnimationFrame(loop);
}

function stopEpgTick() {
  if (epgAnimHandle !== null) {
    cancelAnimationFrame(epgAnimHandle);
    epgAnimHandle = null;
  }
}

function resetEpgForNewBreak(breakId) {
  epgPlayState.breakId           = breakId;
  epgPlayState.currentSeq        = null;
  epgPlayState.currentStartLocal = 0;
  epgPlayState.completedBefore   = 0;
  epgPlayState.finished          = false;
  var track = document.getElementById("epg-track");
  if (track) { track.style.transform = "translateX(0px)"; }
  applyEpgBlockStates();
  resetTvPreview();
}

function activateEpgAd(breakId, seq, eventKey) {
  if (!seq) { return; }

  if (epgPlayState.breakId !== breakId) {
    resetEpgForNewBreak(breakId);
  }

  // Only move the playhead forward — ignore out-of-order / repeat events
  if (epgPlayState.currentSeq != null && seq < epgPlayState.currentSeq) { return; }
  if (epgPlayState.currentSeq === seq) { return; }

  // Sum durations of ads earlier than this sequence in the current pod
  var sumBefore = 0;
  for (var i = 0; i < podAds.length; i++) {
    var s = podAds[i].sequence || (i + 1);
    if (s < seq) { sumBefore += (podAds[i].duration || 0); }
  }
  epgPlayState.completedBefore   = sumBefore;
  epgPlayState.currentSeq        = seq;
  epgPlayState.currentStartLocal = Date.now();
  epgPlayState.finished          = false;

  applyEpgBlockStates();
  updateEpgNowLabel();
  updateTvPreviewForActiveAd(seq);
  startEpgTick();
}

function finishEpgBreak() {
  epgPlayState.finished          = true;
  epgPlayState.currentSeq        = null;
  epgPlayState.currentStartLocal = 0;
  epgPlayState.completedBefore   = 0;
  stopEpgTick();

  // Hide the track immediately — once the pod's playing window has ended
  // we don't want any leftover blocks lingering in the viewport. The CSS
  // transition on .epg-strip__track handles the fade-out.
  var strip = document.getElementById("epg-strip");
  if (strip) { strip.classList.remove("epg-strip--playing"); }

  var track = document.getElementById("epg-track");
  if (track) { track.style.transform = "translateX(0px)"; }

  var label = document.getElementById("epg-now-label");
  if (label) { label.innerHTML = ""; }

  applyEpgBlockStates();
  resetTvPreview();
}

// ---------------------------------------------------------------------------
// TV preview — synthesised "what's on screen" analogue
// ---------------------------------------------------------------------------

// Deterministic hash of an ad_id (or any string) into a hue 0..359. Same
// ad always gets the same colour, different ads land far enough apart
// that the screen visibly changes when the pod advances. Split into two
// hues (primary + shifted partner) so the gradient still has depth.
function tvHueForAd(adId) {
  var s = String(adId || "");
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h % 360;
}

function formatTvTime(seconds) {
  var s = Math.max(0, Math.floor(seconds || 0));
  var m = Math.floor(s / 60);
  var ss = s % 60;
  return m + ":" + (ss < 10 ? "0" : "") + ss;
}

function updateTvPreviewForActiveAd(seq) {
  var root = document.getElementById("tv-preview");
  var title = document.getElementById("tv-preview-title");
  var seqEl = document.getElementById("tv-preview-seq");
  var timer = document.getElementById("tv-preview-timer");
  var fill  = document.getElementById("tv-preview-progress-fill");
  if (!root || !title || !seqEl || !timer || !fill) { return; }

  var ad = findPodAdBySeq(seq);
  var name = ad ? (ad.name || ad.title || ad.ad_id || ("Ad " + seq)) : ("Ad " + seq);
  var dur  = ad ? (ad.duration || 0) : 0;
  var adId = ad ? ad.ad_id : ("seq_" + seq);

  var hueA = tvHueForAd(adId);
  var hueB = (hueA + 35) % 360;
  root.style.setProperty("--tv-hue-a", String(hueA));
  root.style.setProperty("--tv-hue-b", String(hueB));

  title.textContent = name;
  seqEl.textContent = seq + " of " + (podAds.length || seq);
  timer.textContent = "0:00 / " + formatTvTime(dur);
  fill.style.width = "0%";
  root.classList.add("tv-preview--playing");
}

function updateTvPreviewTick(elapsed, curDur) {
  var root  = document.getElementById("tv-preview");
  if (!root || !root.classList.contains("tv-preview--playing")) { return; }
  var timer = document.getElementById("tv-preview-timer");
  var fill  = document.getElementById("tv-preview-progress-fill");
  if (!timer || !fill) { return; }

  var safeDur = (curDur && curDur > 0) ? curDur : 0;
  var pct = safeDur > 0 ? Math.min(100, (elapsed / safeDur) * 100) : 0;
  timer.textContent = formatTvTime(elapsed) + " / " + formatTvTime(safeDur);
  fill.style.width = pct.toFixed(1) + "%";
}

function resetTvPreview() {
  var root = document.getElementById("tv-preview");
  var fill = document.getElementById("tv-preview-progress-fill");
  var title = document.getElementById("tv-preview-title");
  var seqEl = document.getElementById("tv-preview-seq");
  var timer = document.getElementById("tv-preview-timer");
  if (root) {
    root.classList.remove("tv-preview--playing");
    root.style.removeProperty("--tv-hue-a");
    root.style.removeProperty("--tv-hue-b");
  }
  if (fill)  { fill.style.width = "0%"; }
  if (title) { title.textContent = "\u2014"; }
  if (seqEl) { seqEl.textContent = "\u2014"; }
  if (timer) { timer.textContent = "0:00 / 0:00"; }
}

function updateEpgNowLabel() {
  var label = document.getElementById("epg-now-label");
  var strip = document.getElementById("epg-strip");
  if (!label || !strip) { return; }

  if (epgPlayState.currentSeq == null || epgPlayState.finished) {
    label.innerHTML = "";
    strip.classList.remove("epg-strip--playing");
    return;
  }
  var ad = findPodAdBySeq(epgPlayState.currentSeq);
  var name = ad ? (ad.name || ad.title || ad.ad_id) : ("Ad " + epgPlayState.currentSeq);
  label.innerHTML = "<strong>\u25B6</strong> " + name;
  strip.classList.add("epg-strip--playing");
}

function updateLiveView() {
  var indicator = document.getElementById("live-indicator");
  var strip     = document.getElementById("epg-strip");

  if (!currentBreakId || !currentBreakEvents[currentBreakId]) {
    if (indicator) { indicator.className = "live-dot live-dot--idle"; }
    if (strip)     { strip.classList.remove("epg-strip--playing"); }
    var label = document.getElementById("epg-now-label");
    if (label) { label.innerHTML = ""; }
    return;
  }

  var breakData = currentBreakEvents[currentBreakId];
  var adIds = Object.keys(breakData.ads).sort(function(a, b) {
    return breakData.ads[a].sequence - breakData.ads[b].sequence;
  });

  // Determine the "active" ad from events — the highest-sequence ad with a
  // start or impression but no complete yet. This is what drives the EPG.
  var activeSeq = null;
  for (var i = adIds.length - 1; i >= 0; i--) {
    var ad = breakData.ads[adIds[i]];
    var hasKick = ad.events["start"] || ad.events["impression"];
    if (hasKick && !ad.events["complete"]) {
      activeSeq = parseInt(ad.sequence, 10) || null;
      break;
    }
  }

  // Fallback: the latest sequence that has ANY event (covers "complete" fired
  // on the last ad in the pod — we still want to show it as the current one)
  if (activeSeq == null && adIds.length) {
    var last = breakData.ads[adIds[adIds.length - 1]];
    activeSeq = parseInt(last.sequence, 10) || null;
  }

  if (activeSeq != null) {
    if (indicator) { indicator.className = "live-dot live-dot--active"; }
    activateEpgAd(currentBreakId, activeSeq);
  } else {
    if (indicator) { indicator.className = "live-dot live-dot--idle"; }
  }

  // If every ad we know about has completed, park the strip at the end
  var allCompleted = adIds.length > 0;
  for (var k = 0; k < adIds.length; k++) {
    if (!breakData.ads[adIds[k]].events["complete"]) { allCompleted = false; break; }
  }
  if (allCompleted) { finishEpgBreak(); }
}

function getCurrentMilestone(events) {
  var order = ["complete", "thirdQuartile", "midpoint", "firstQuartile", "start", "impression"];
  for (var i = 0; i < order.length; i++) {
    if (events[order[i]]) { return order[i]; }
  }
  return "impression";
}

function renderBreakHistory() {
  var container = document.getElementById("break-history");
  var countLabel = document.getElementById("break-count-label");
  countLabel.textContent = breakHistory.length + " break" + (breakHistory.length !== 1 ? "s" : "") + " recorded";

  if (breakHistory.length === 0) {
    container.innerHTML = "No breaks recorded yet.";
    return;
  }

  container.innerHTML = "";

  for (var i = 0; i < breakHistory.length; i++) {
    var b = breakHistory[i];
    var adIds = Object.keys(b.ads).sort(function(a, x) {
      return b.ads[a].sequence - b.ads[x].sequence;
    });

    var totalDur = 0;
    for (var j = 0; j < adIds.length; j++) {
      var foundAd = findAsset(b.ads[adIds[j]].ad_id);
      if (foundAd) { totalDur += foundAd.duration; }
    }

    var card = document.createElement("div");
    card.className = "break-card";

    var cardHeader = document.createElement("div");
    cardHeader.className = "break-card__header";

    var breakMeta = document.createElement("div");
    breakMeta.className = "break-card__meta";
    breakMeta.innerHTML =
      "Break: " + b.break_id + "" +
      "" + formatTs(b.started) + "" +
      "" + adIds.length + " ad" + (adIds.length !== 1 ? "s" : "") + "";

    cardHeader.appendChild(breakMeta);
    card.appendChild(cardHeader);

    // EPG drift info for this break (if we have a matching drift record)
    card.appendChild(driftChipForBreak(b.break_id));

    var adRows = document.createElement("div");
    adRows.className = "break-card__ads-list";

    for (var j = 0; j < adIds.length; j++) {
      var ad = b.ads[adIds[j]];
      var adRow = document.createElement("div");
      adRow.className = "break-card__ad-row";

      var adInfo = document.createElement("div");
      adInfo.className = "break-card__ad-info";
      adInfo.innerHTML =
        "" + (ad.sequence || j + 1) + "" +
        "" + ad.name + "";

      var adMilestones = document.createElement("div");
      adMilestones.className = "break-card__milestones";

      for (var k = 0; k < EVENT_ORDER.length; k++) {
        var evKey = EVENT_ORDER[k];
        var pill = document.createElement("span");
        pill.className = "history-milestone" + (ad.events[evKey] ? " history-milestone--hit" : " history-milestone--miss");
        pill.style.setProperty("--colour", EVENT_COLOURS[evKey] || "#888");
        pill.textContent = EVENT_LABELS[evKey] || evKey;
        adMilestones.appendChild(pill);
      }

      adRow.appendChild(adInfo);
      adRow.appendChild(adMilestones);
      adRows.appendChild(adRow);
    }

    card.appendChild(adRows);
    container.appendChild(card);
  }
}

function setupLiveControls() {
  document.getElementById("btn-clear-live").addEventListener("click", function() {
    currentBreakEvents = {};
    currentBreakId = null;
    lastEventTs = new Date().toISOString();  // drop anything older than this clear
    // reset EPG strip back to its idle position
    epgPlayState.breakId           = null;
    epgPlayState.currentSeq        = null;
    epgPlayState.currentStartLocal = 0;
    epgPlayState.completedBefore   = 0;
    epgPlayState.finished          = false;
    stopEpgTick();
    var track = document.getElementById("epg-track");
    if (track) { track.style.transform = "translateX(0px)"; }
    applyEpgBlockStates();
    updateEpgNowLabel();
    resetTvPreview();
    updateLiveView();
  });

  document.getElementById("btn-clear-history").addEventListener("click", function() {
    if (!confirm("Clear all break history?")) { return; }
    breakHistory = [];
    renderBreakHistory();
  });
}

function formatTs(iso) {
  try {
    return new Date(iso).toISOString().replace("T", " ").substring(0, 19);
  } catch(e) { return iso; }
}

function setupVastUrlTab() {
  document.getElementById("btn-copy-url").addEventListener("click", function() {
    var url = document.getElementById("vast-url-display").textContent;
    navigator.clipboard.writeText(url).then(function() {
      document.getElementById("btn-copy-url").textContent = "Copied!";
      setTimeout(function() {
        document.getElementById("btn-copy-url").textContent = "Copy";
      }, 2000);
    });
  });
  document.getElementById("btn-fetch-vast").addEventListener("click", fetchVastPreview);
}

function updateVastUrlDisplay() {
  var sid = encodeURIComponent(SESSION_ID || "default");
  var url = window.location.origin
    + "/vast?session_id=" + sid
    + "&break_id=test&cb=CACHE_BUSTER&duration=60";
  document.getElementById("vast-url-display").textContent = url;
}

async function fetchVastPreview() {
  var pre = document.getElementById("vast-preview");
  pre.textContent = "Fetching...";
  try {
    // Don't pass ?duration= on the preview so it doesn't accumulate drift.
    var sid = encodeURIComponent(SESSION_ID || "default");
    var url = window.location.origin
      + "/vast?session_id=" + sid
      + "&break_id=preview&cb=" + Date.now();
    var res = await fetch(url);
    var xml = await res.text();
    pre.textContent = xml;
  } catch(e) {
    pre.textContent = "Error: " + e.message;
  }
}

// ---------------------------------------------------------------------------
// EPG Drift
// ---------------------------------------------------------------------------

function setupDriftControls() {
  var btn = document.getElementById("btn-reset-drift");
  if (!btn) { return; }
  btn.addEventListener("click", async function() {
    if (!confirm("Reset cumulative EPG drift to zero?")) { return; }
    try {
      await fetch(apiUrl("/api/drift/reset"), { method: "POST" });
      await fetchDrift();
      renderBreakHistory();  // refresh per-break drift columns too
    } catch(e) {
      console.warn("Drift reset failed: " + e.message);
    }
  });
}

async function fetchDrift() {
  try {
    var res = await fetch(apiUrl("/api/drift?limit=500"));
    if (!res.ok) { return; }
    var snap = await res.json();
    latestDriftSnapshot = snap;
    indexDriftByBreak(snap.records || []);
    renderDriftPanel(snap);
    renderRenderRatePanel(snap);
    updateOverfillWarning(snap);
    // Re-render history so per-break drift chips reflect any new records
    renderBreakHistory();
  } catch(e) {
    console.warn("Drift fetch failed: " + e.message);
  }
}

function indexDriftByBreak(records) {
  driftByBreak = {};
  // records are newest first; keep the most recent per break_id
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    if (!r) { continue; }
    var bid = r.break_id || "unknown";
    if (!(bid in driftByBreak)) {
      driftByBreak[bid] = r;
    }
  }
}

// Drift value at which the live edge reaches the right end of Program B.
// Picked so the edge moves visibly with second-scale drift but still has
// headroom for very long runs (30 min of cumulative drift = end of Program B).
var DRIFT_SCALE_MAX_SEC = 1800;

function renderDriftPanel(snap) {
  var valueEl = document.getElementById("drift-value");
  var edgeEl  = document.getElementById("drift-live-edge");
  var miniEl  = document.getElementById("drift-mini");

  if (!valueEl || !edgeEl || !miniEl) { return; }

  var total = snap.total_drift || 0;
  var count = snap.request_count || 0;

  valueEl.textContent = formatSeconds(total);

  // Position the live-edge line.
  // drift = 0  -> 50% (boundary between Program A and Program B)
  // drift up  -> pushes right into Program B, capped at the right edge
  var ratio = DRIFT_SCALE_MAX_SEC > 0 ? Math.min(total / DRIFT_SCALE_MAX_SEC, 1) : 0;
  var pct = 50 + ratio * 50;
  edgeEl.style.left = pct + "%";

  miniEl.classList.remove("drift-mini--zero", "drift-mini--drift");
  if (count === 0) {
    // neutral until the player has actually requested at least one pod
  } else if (total > 0) {
    miniEl.classList.add("drift-mini--drift");
  } else {
    miniEl.classList.add("drift-mini--zero");
  }
}

function renderRenderRatePanel(snap) {
  var valueEl  = document.getElementById("render-rate-value");
  var barEl    = document.getElementById("render-rate-bar");
  var totalsEl = document.getElementById("render-rate-totals");
  var breaksEl = document.getElementById("render-rate-breaks");
  if (!valueEl || !barEl || !totalsEl || !breaksEl) { return; }

  var returned = snap.total_returned || 0;
  var played   = snap.total_played   || 0;
  var breaks   = snap.finalised_breaks || 0;

  // Totals line: what's been shipped vs rendered, aggregate across the session.
  totalsEl.textContent =
    formatSeconds(played) + " played / " + formatSeconds(returned) + " shipped";
  breaksEl.textContent =
    breaks + " break" + (breaks === 1 ? "" : "s");

  // Headline value + tone classes
  valueEl.classList.remove(
    "render-mini__value--ok",
    "render-mini__value--warn",
    "render-mini__value--danger",
    "render-mini__value--none"
  );
  barEl.classList.remove(
    "render-mini__fill--warn",
    "render-mini__fill--danger"
  );

  if (returned <= 0 || snap.render_rate == null) {
    valueEl.textContent = "\u2014";
    valueEl.classList.add("render-mini__value--none");
    barEl.style.width = "0%";
    return;
  }

  var ratio = snap.render_rate;  // 0..1
  valueEl.textContent = formatRenderRate(returned, played);

  if (ratio >= 0.995) {
    valueEl.classList.add("render-mini__value--ok");
  } else if (ratio >= 0.90) {
    valueEl.classList.add("render-mini__value--warn");
    barEl.classList.add("render-mini__fill--warn");
  } else {
    valueEl.classList.add("render-mini__value--danger");
    barEl.classList.add("render-mini__fill--danger");
  }

  barEl.style.width = Math.max(0, Math.min(ratio * 100, 100)).toFixed(2) + "%";
}

function updateOverfillWarning(snap) {
  var el = document.getElementById("overfill-warning");
  var txt = document.getElementById("overfill-warning-text");
  if (!el || !txt) { return; }

  var adSum  = 0;
  for (var i = 0; i < podAds.length; i++) { adSum += podAds[i].duration; }

  // Only warn based on VAST requests made since the page was opened.
  // The server keeps records from the whole Flask session, so without
  // this filter a fresh page load could fire the warning off stale data.
  var last = snap && snap.last_record;
  var hasFreshRequest =
       last
    && last.ts
    && last.ts >= pageLoadTs
    && last.requested != null;

  if (!hasFreshRequest) {
    el.hidden = true;
    return;
  }

  var lastReq = last.requested;
  if (adSum <= lastReq) {
    el.hidden = true;
    return;
  }

  var whenStr = formatTs(last.ts);
  txt.textContent =
      "Last VAST request (" + whenStr + ") asked for " + lastReq + "s, "
    + "but current ads total " + adSum + "s — the player won't have room for all of them.";
  el.hidden = false;
}

function formatSeconds(n) {
  if (n == null) { return "\u2014"; }
  var v = Number(n);
  if (!isFinite(v)) { return "\u2014"; }
  // Drop trailing ".0" for whole seconds
  if (v === Math.floor(v)) { return v + "s"; }
  return v.toFixed(1) + "s";
}

// Render rate helpers — used by per-break chip and aggregate panel.
// Thresholds: >=99.5% green (ok), >=90% amber (warn), otherwise red
// (danger). "Perfect" rounds to 100% so the common-case shows cleanly.
function formatRenderRate(returned, played) {
  var r = Number(returned);
  var p = Number(played);
  if (!isFinite(r) || r <= 0) { return "\u2014"; }
  if (!isFinite(p)) { p = 0; }
  var pct = (p / r) * 100;
  if (pct >= 99.95) { return "100%"; }
  if (pct >= 10)    { return pct.toFixed(1) + "%"; }
  return pct.toFixed(2) + "%";
}

function renderRateToneClass(returned, played) {
  var r = Number(returned);
  var p = Number(played);
  if (!isFinite(r) || r <= 0) { return "break-card__render-rate--none"; }
  if (!isFinite(p)) { p = 0; }
  var ratio = p / r;
  if (ratio >= 0.995) { return "break-card__render-rate--ok"; }
  if (ratio >= 0.90)  { return "break-card__render-rate--warn"; }
  return "break-card__render-rate--danger";
}

function formatSignedSeconds(n) {
  if (n == null) { return "\u2014"; }
  var v = Number(n);
  if (!isFinite(v)) { return "\u2014"; }
  if (v === 0) { return "0s (exact)"; }
  if (v > 0)  { return "+" + formatSeconds(v) + " under"; }
  return "\u2212" + formatSeconds(-v) + " over";
}

function driftChipForBreak(breakId) {
  var rec = driftByBreak[breakId];
  var wrap = document.createElement("div");
  wrap.className = "break-card__drift";

  if (!rec) {
    var none = document.createElement("span");
    none.className = "break-card__drift-chip break-card__drift-chip--none";
    none.textContent = "No drift record";
    wrap.appendChild(none);
    return wrap;
  }

  var reqItem = document.createElement("span");
  reqItem.className = "break-card__drift-item";
  reqItem.innerHTML = "Requested <strong>"
    + (rec.requested != null ? formatSeconds(rec.requested) : "\u2014")
    + "</strong>";

  var retItem = document.createElement("span");
  retItem.className = "break-card__drift-item";
  retItem.innerHTML = "Returned <strong>" + formatSeconds(rec.returned) + "</strong>";

  // Played = fractional sum of rendered seconds (highest quartile per
  // ad × its duration). While the break is still pending on the backend
  // this number is provisional; we mark that explicitly.
  var played = (rec.played != null) ? rec.played : 0;
  var playedItem = document.createElement("span");
  playedItem.className = "break-card__drift-item";
  playedItem.innerHTML = "Played <strong>" + formatSeconds(played) + "</strong>"
    + (rec.pending ? " <em class=\"break-card__drift-pending\">(in progress)</em>" : "");

  // Render rate = played / returned for this break, colour-coded by
  // threshold so at-a-glance you can spot pods where creatives failed
  // to render or were dropped by SSAI.
  var renderItem = document.createElement("span");
  renderItem.className = "break-card__drift-item break-card__render-rate "
    + renderRateToneClass(rec.returned, played);
  renderItem.innerHTML = "Render rate <strong>"
    + formatRenderRate(rec.returned, played) + "</strong>";

  wrap.appendChild(reqItem);
  wrap.appendChild(retItem);
  wrap.appendChild(playedItem);
  wrap.appendChild(renderItem);

  var chip = document.createElement("span");
  if (rec.requested == null) {
    chip.className = "break-card__drift-chip break-card__drift-chip--none";
    chip.textContent = "no duration param";
  } else if (rec.pending) {
    // Diff isn't authoritative until the break finalises — show the
    // current shortfall as provisional rather than a final number.
    var provDiff = rec.requested - played;
    chip.className = "break-card__drift-chip break-card__drift-chip--none";
    chip.textContent = "Pending — " + formatSeconds(Math.max(provDiff, 0)) + " short so far";
  } else if (rec.warning) {
    chip.className = "break-card__drift-chip break-card__drift-chip--over";
    chip.textContent = "Over-fill: " + formatSeconds(-rec.diff);
  } else if (rec.diff > 0) {
    chip.className = "break-card__drift-chip break-card__drift-chip--under";
    chip.textContent = "Under-fill: " + formatSeconds(rec.diff)
      + "  (played " + formatSeconds(played) + " of " + formatSeconds(rec.returned) + ")";
  } else {
    chip.className = "break-card__drift-chip break-card__drift-chip--exact";
    chip.textContent = "Exact fill";
  }

  wrap.appendChild(chip);
  return wrap;
}
