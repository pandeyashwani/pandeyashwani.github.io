let sources = [];
let currentSourceIndex = -1;
let cards = [];          // one entry per spectrum shown for the current source
let renderToken = 0;     // guards against stale fetches when switching sources quickly

const emissionLines = [
  { name: "Lyα", wavelength: 1215.67 },
  { name: "C IV", wavelength: 1549.48 },
  { name: "C III]", wavelength: 1908.73 },
  { name: "Mg II", wavelength: 2798.75 },
  { name: "[O II]", wavelength: 3727.09 },
  { name: "Hγ", wavelength: 4340.47 },
  { name: "Hβ", wavelength: 4861.33 },
  { name: "[O III]", wavelength: 5006.84 },
  { name: "Hα", wavelength: 6562.80 }
];

const $ = id => document.getElementById(id);

function fmt(value, digits = 5) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showPageError(message) {
  const box = $("errorBox");
  box.textContent = message;
  box.style.display = "block";
}

function hidePageError() {
  $("errorBox").style.display = "none";
}

/* ---------------- Source list ---------------- */

async function loadSources() {
  try {
    const response = await fetch("sources.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    sources = await response.json();

    $("sourceCount").textContent = sources.length;
    renderSourceList();

    if (sources.length) selectSource(0);
    else showPageError("sources.json contains no sources.");
  } catch (error) {
    console.error(error);
    showPageError(`Could not load sources.json: ${error.message}`);
  }
}

function renderSourceList() {
  const query = $("sourceSearch").value.trim().toLowerCase();
  const list = $("sourceList");
  list.innerHTML = "";

  let visible = 0;

  sources.forEach((source, index) => {
    if (query && !source.name.toLowerCase().includes(query)) return;
    visible++;

    const div = document.createElement("div");
    div.className = "source-item" + (index === currentSourceIndex ? " active" : "");
    div.innerHTML = `
      <div class="source-name">${escapeHtml(source.name)}</div>
      <div class="source-meta">
        z = ${source.redshift ?? "—"} · ${source.n_spectra ?? (source.spectra || []).length} spectra
      </div>
    `;
    div.addEventListener("click", () => selectSource(index));
    list.appendChild(div);
  });

  $("sourceCount").textContent = query ? `${visible} / ${sources.length}` : sources.length;
}

function observationLabel(s) {
  if (s.plate != null && s.mjd != null && s.fiber != null) {
    return `${s.plate} / ${s.mjd} / ${s.fiber}`;
  }
  return s.label || "Spectrum";
}

function selectSource(index) {
  if (index < 0 || index >= sources.length) return;

  currentSourceIndex = index;
  const source = sources[index];
  const n = source.n_spectra ?? (source.spectra || []).length;

  $("objectName").textContent = source.name;
  $("objectSubtitle").textContent = `SDSS spectral observations · ${n} spectra, scroll to view all`;
  $("ra").textContent = source.ra != null ? fmt(source.ra, 6) : "—";
  $("dec").textContent = source.dec != null ? fmt(source.dec, 6) : "—";
  $("redshift").textContent = source.redshift != null ? fmt(source.redshift, 5) : "—";
  $("spectrumCount").textContent = n;

  renderSourceList();
  buildCards(source);
  $("spectraScroll").scrollTop = 0;
}

/* ---------------- Stacked spectrum cards ---------------- */

function buildCards(source) {
  hidePageError();

  // Free old plots before clearing the DOM
  cards.forEach(c => { try { Plotly.purge(c.plotEl); } catch (_) {} });
  $("spectraContainer").innerHTML = "";
  cards = [];

  const token = ++renderToken;
  const spectra = source.spectra || [];

  if (!spectra.length) {
    showPageError("This source has no spectrum entries.");
    return;
  }

  spectra.forEach((spectrum, i) => {
    const card = createCard(spectrum, i);
    $("spectraContainer").appendChild(card.root);
    cards.push(card);
  });

  cards.forEach(card => loadCardSpectrum(card, token));
}

function createCard(spectrum, i) {
  const root = document.createElement("article");
  root.className = "spec-card";

  const meta =
    `Plate ${spectrum.plate ?? "—"} · MJD ${spectrum.mjd ?? "—"} · Fiber ${spectrum.fiber ?? "—"}` +
    (spectrum.label ? ` · ${spectrum.label}` : "");

  root.innerHTML = `
    <div class="spec-head">
      <span class="spec-index">${i + 1}</span>
      <span class="spec-meta">${escapeHtml(meta)}</span>
    </div>
    <div class="spec-plot-wrap">
      <div class="spec-plot"></div>
      <div class="spec-loading"><div class="spinner"></div><span>Loading spectrum…</span></div>
      <div class="spec-error"></div>
    </div>
    <div class="range-row">
      <label>x min <input type="number" step="any" data-k="xmin"></label>
      <label>x max <input type="number" step="any" data-k="xmax"></label>
      <label>y min <input type="number" step="any" data-k="ymin"></label>
      <label>y max <input type="number" step="any" data-k="ymax"></label>
      <button data-act="apply">Apply</button>
      <button data-act="auto">Auto scale</button>
      <button data-act="reset">Reset</button>
    </div>
  `;

  const q = sel => root.querySelector(sel);
  const card = {
    root,
    meta: spectrum,
    plotEl: q(".spec-plot"),
    loading: q(".spec-loading"),
    errorEl: q(".spec-error"),
    clean: null,
    data: null,
    bound: false
  };

  q('[data-act="apply"]').addEventListener("click", () => applyRange(card));
  q('[data-act="auto"]').addEventListener("click", () => autoScaleY(card));
  q('[data-act="reset"]').addEventListener("click", () => resetView(card));
  root.querySelectorAll(".range-row input").forEach(inp =>
    inp.addEventListener("keydown", e => { if (e.key === "Enter") applyRange(card); })
  );

  return card;
}

async function loadCardSpectrum(card, token) {
  card.loading.style.display = "flex";
  card.errorEl.style.display = "none";

  try {
    const response = await fetch(card.meta.file, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${card.meta.file}`);
    const json = await response.json();

    if (token !== renderToken) return;     // user moved to another source
    card.clean = cleanSpectrum(json);
    plotCard(card);
  } catch (error) {
    if (token !== renderToken) return;
    console.error(error);
    card.errorEl.textContent = `Could not load spectrum: ${error.message}`;
    card.errorEl.style.display = "block";
  } finally {
    if (token === renderToken) card.loading.style.display = "none";
  }
}

/* ---------------- Data handling ---------------- */

function cleanSpectrum(data) {
  const wave = data.wavelength || [];
  const flux = data.flux || [];
  const error = data.error || null;

  const outWave = [];
  const outFlux = [];
  const outError = [];

  for (let i = 0; i < Math.min(wave.length, flux.length); i++) {
    const w = Number(wave[i]);
    const f = Number(flux[i]);

    if (!Number.isFinite(w) || !Number.isFinite(f)) continue;

    outWave.push(w);
    outFlux.push(f);

    if (error) {
      const e = Number(error[i]);
      outError.push(Number.isFinite(e) && e >= 0 ? e : null);
    }
  }

  return { wave: outWave, flux: outFlux, error: error ? outError : null };
}

function transformSpectrum(clean) {
  const source = sources[currentSourceIndex];
  const z = Number(source.redshift);

  let wave = clean.wave.slice();
  let flux = clean.flux.slice();
  let error = clean.error ? clean.error.slice() : null;

  if ($("wavelengthMode").value === "rest" && Number.isFinite(z)) {
    wave = wave.map(w => w / (1 + z));
  }

  if ($("fluxMode").value === "log") {
    const logFlux = [];
    const logError = error ? [] : null;

    for (let i = 0; i < flux.length; i++) {
      if (flux[i] > 0) {
        logFlux.push(Math.log10(flux[i]));
        if (error) {
          const e = error[i];
          logError.push(e != null && e > 0 ? e / (flux[i] * Math.LN10) : null);
        }
      } else {
        logFlux.push(null);
        if (error) logError.push(null);
      }
    }
    flux = logFlux;
    error = logError;
  }

  return { wave, flux, error };
}

function lineShapes() {
  if (!$("showLines").checked) return [];

  const source = sources[currentSourceIndex];
  const z = Number(source.redshift);
  const rest = $("wavelengthMode").value === "rest";
  const shapes = [];

  for (const line of emissionLines) {
    let x = line.wavelength;
    if (!rest && Number.isFinite(z)) x *= (1 + z);

    shapes.push({
      type: "line",
      x0: x,
      x1: x,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { width: 1, dash: "dot", color: "#c0392b" }
    });
  }

  return shapes;
}

/* ---------------- Plotting ---------------- */

/* Default y range: tight around the flux itself (ignores the error band) */
function defaultYRange(data) {
  let mn = Infinity, mx = -Infinity;
  for (const f of data.flux) {
    if (f == null || !Number.isFinite(f)) continue;
    if (f < mn) mn = f;
    if (f > mx) mx = f;
  }
  if (!Number.isFinite(mn)) return null;
  const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
  return [mn - pad, mx + pad];
}

function plotCard(card) {
  if (!card.clean) return;

  const data = transformSpectrum(card.clean);
  card.data = data;
  const withErr = $("showError").checked && data.error;

  const traces = [{
    x: data.wave,
    y: data.flux,
    type: "scattergl",
    mode: "lines",
    name: "Flux",
    line: { width: 1, color: "#1f4fd8" },
    hovertemplate: "λ = %{x:.2f} Å<br>Flux = %{y:.5g}<extra></extra>"
  }];

  if (withErr) {
    const upper = data.flux.map((f, i) => f == null || data.error[i] == null ? null : f + data.error[i]);
    const lower = data.flux.map((f, i) => f == null || data.error[i] == null ? null : f - data.error[i]);

    traces.push({
      x: data.wave,
      y: upper,
      type: "scattergl",
      mode: "lines",
      line: { width: 0 },
      hoverinfo: "skip",
      showlegend: false
    });

    traces.push({
      x: data.wave,
      y: lower,
      type: "scattergl",
      mode: "lines",
      fill: "tonexty",
      fillcolor: "rgba(125,156,255,0.3)",
      line: { width: 0 },
      hoverinfo: "skip",
      showlegend: false
    });
  }

  const yRange = defaultYRange(data);

  const layout = {
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    font: { color: "#1a1f26" },
    margin: { l: 72, r: 20, t: 14, b: 56 },
    hovermode: "x unified",
    shapes: lineShapes(),
    xaxis: {
      title: $("wavelengthMode").value === "rest"
        ? "Rest-frame wavelength (Å)"
        : "Observed wavelength (Å)",
      gridcolor: "#e3e7ec",
      zerolinecolor: "#c5cbd3",
      exponentformat: "power"
    },
    yaxis: {
      ...(yRange ? { range: yRange, autorange: false } : {}),
      title: $("fluxMode").value === "log" ? "log₁₀ Flux" : "Flux",
      gridcolor: "#e3e7ec",
      zerolinecolor: "#c5cbd3",
      exponentformat: "power"
    },
    showlegend: false
  };

  Plotly.react(card.plotEl, traces, layout, {
    responsive: true,
    displaylogo: false,
    scrollZoom: false,   // keep the mouse wheel for scrolling the page
    modeBarButtonsToRemove: ["lasso2d", "select2d"]
  });

  if (!card.bound) {
    // Keep the range inputs in sync with box-zoom, pan, double-click, etc.
    card.plotEl.on("plotly_relayout", () => syncRangeInputs(card));
    card.bound = true;
  }
  syncRangeInputs(card);
}

/* ---------------- Per-plot axis range controls ---------------- */

function setInput(card, key, value) {
  const el = card.root.querySelector(`[data-k="${key}"]`);
  if (el && Number.isFinite(value)) el.value = String(Number(value.toPrecision(6)));
}

function syncRangeInputs(card) {
  const layout = card.plotEl._fullLayout;
  if (!layout) return;
  const [x0, x1] = layout.xaxis.range;
  const [y0, y1] = layout.yaxis.range;
  setInput(card, "xmin", x0);
  setInput(card, "xmax", x1);
  setInput(card, "ymin", y0);
  setInput(card, "ymax", y1);
}

function readInput(card, key) {
  const s = card.root.querySelector(`[data-k="${key}"]`).value.trim();
  return s === "" ? null : Number(s);
}

function applyRange(card) {
  if (!card.data) return;
  const x0 = readInput(card, "xmin"), x1 = readInput(card, "xmax");
  const y0 = readInput(card, "ymin"), y1 = readInput(card, "ymax");
  const update = {};

  if (Number.isFinite(x0) && Number.isFinite(x1) && x0 < x1) update["xaxis.range"] = [x0, x1];
  if (Number.isFinite(y0) && Number.isFinite(y1) && y0 < y1) update["yaxis.range"] = [y0, y1];

  if (Object.keys(update).length) Plotly.relayout(card.plotEl, update);
}

// Rescale y to the flux values inside the currently visible x range
function autoScaleY(card) {
  if (!card.data) return;
  const [a, b] = card.plotEl._fullLayout.xaxis.range;
  const lo = Math.min(a, b), hi = Math.max(a, b);

  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < card.data.wave.length; i++) {
    const w = card.data.wave[i], f = card.data.flux[i];
    if (f == null || !Number.isFinite(f) || w < lo || w > hi) continue;
    if (f < mn) mn = f;
    if (f > mx) mx = f;
  }
  if (!Number.isFinite(mn)) return;

  const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
  Plotly.relayout(card.plotEl, { "yaxis.range": [mn - pad, mx + pad] });
}

function resetView(card) {
  if (!card.data) return;
  const yr = defaultYRange(card.data);
  const update = { "xaxis.autorange": true };
  if (yr) update["yaxis.range"] = yr;
  else update["yaxis.autorange"] = true;
  Plotly.relayout(card.plotEl, update);
}

/* ---------------- Events ---------------- */

const replotAll = () => cards.forEach(plotCard);

$("sourceSearch").addEventListener("input", renderSourceList);
$("wavelengthMode").addEventListener("change", replotAll);
$("fluxMode").addEventListener("change", replotAll);
$("showError").addEventListener("change", replotAll);
$("showLines").addEventListener("change", replotAll);

$("resetZoom").addEventListener("click", () => cards.forEach(resetView));

$("previousButton").addEventListener("click", () => {
  if (currentSourceIndex > 0) selectSource(currentSourceIndex - 1);
});

$("nextButton").addEventListener("click", () => {
  if (currentSourceIndex < sources.length - 1) selectSource(currentSourceIndex + 1);
});

document.addEventListener("keydown", e => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  if (e.key === "ArrowLeft" && currentSourceIndex > 0) {
    selectSource(currentSourceIndex - 1);
  } else if (e.key === "ArrowRight" && currentSourceIndex < sources.length - 1) {
    selectSource(currentSourceIndex + 1);
  }
});

window.addEventListener("resize", () => {
  cards.forEach(c => { if (c.plotEl.data) Plotly.Plots.resize(c.plotEl); });
});

loadSources();
