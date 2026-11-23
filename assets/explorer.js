/* Data explorer: all benchmark rows, per-subject paired differences, controls.
   Loads docs/data/benchmark.json (aggregates) and docs/data/raw/*.csv
   (per-subject rows). No dependencies and no chart library. */

(() => {
  "use strict";

  const DATA_URL = "../data/benchmark.json";
  const RAW_BASE = "../data/raw/";
  const THEME_KEY = "eegbench-paper-theme";
  const PAPER_ORDER = [
    "mi_leftright_22ch",
    "mi_4class_22ch",
    "p300_8ch",
    "ssvep_8ch",
    "motor_execution_ear_vs_scalp",
    "sleep_staging_local",
    "stew_workload_14ch",
    "auditory_attention_earsaad",
    "faced_emotion_123",
  ];

  const state = {
    bundle: null,
    taskId: null,
    protocol: null,
    pipeline: null,
    metric: "score",
    sort: "score",
    selected: null,
    rawCache: new Map(),
    query: "",
  };

  let pairedToken = 0;

  const $ = (sel) => document.querySelector(sel);

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function isPct(metric) {
    return metric === "accuracy" || metric === "balanced_accuracy";
  }

  function fmtValue(value, metric, digits = 3) {
    const n = num(value);
    if (n === null) return "—";
    if (isPct(metric)) return `${(n * 100).toFixed(1)}%`;
    return n.toFixed(digits);
  }

  function fmtDelta(value, metric, digits = 3) {
    const n = num(value);
    if (n === null) return "—";
    if (isPct(metric)) {
      const p = n * 100;
      return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)} pp`;
    }
    return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;
  }

  function fmtItr(value) {
    const n = num(value);
    return n === null ? "—" : n.toFixed(1);
  }

  function strategyClass(strategy) {
    return ["full", "distributed", "region", "wearable", "random"].includes(strategy)
      ? strategy
      : "random";
  }

  function labelFor(row) {
    if (!row) return "";
    if (row.isRandom) {
      const m = String(row.subset).match(/random-s(\d+)/);
      return `Random${m ? ` s${m[1]}` : ""}`;
    }
    return row.subsetLabel || row.subset;
  }

  function shortTask(task) {
    return task ? task.short : "";
  }

  function tCritical(df) {
    // Two-sided 95% critical values. Above 30, the normal value is close
    // enough for a dot plot; the paper's own CIs are computed in Python.
    const t = [
      12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
      2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
      2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
    ];
    return df >= 1 && df <= t.length ? t[df - 1] : 1.960;
  }

  function meanSd(values) {
    const n = values.length;
    if (!n) return { n: 0, mean: null, sd: null };
    const mean = values.reduce((a, b) => a + b, 0) / n;
    if (n < 2) return { n, mean, sd: null };
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    return { n, mean, sd: Math.sqrt(variance) };
  }

  // ------------------------------------------------------------------ data

  function task() {
    return state.bundle.tasks.find((t) => t.id === state.taskId);
  }

  function taskById(id) {
    return state.bundle.tasks.find((t) => t.id === id);
  }

  function taskDelta(row) {
    const t = taskById(row.track);
    const target = num(t?.stats?.reference);
    const score = num(row.score);
    return target === null || score === null ? null : score - target;
  }

  function rowsFor(taskId = state.taskId, protocol = state.protocol, pipeline = state.pipeline) {
    return state.bundle.rows.filter(
      (r) => r.track === taskId && r.protocol === protocol && r.pipeline === pipeline,
    );
  }

  function referenceRow(rows, t) {
    // `task.stats.reference` is the task's chosen reference: the full cap for
    // most tasks, but the matched scalp set for sleep and attention. The row
    // scores carry that value; use it rather than assuming the full cap.
    const target = num(t?.stats?.reference);
    if (target !== null) {
      const match = rows.find((r) => Math.abs(num(r.score) - target) < 1e-6);
      if (match) return match;
    }
    return rows.find((r) => r.isFull) || rows[0];
  }

  function metricOf(row) {
    return row ? row.metric : "roc_auc";
  }

  function valueOf(row) {
    return state.metric === "itr" ? num(row.itr) : num(row.score);
  }

  function deltaOf(row, ref) {
    if (!row || !ref) return null;
    if (state.metric === "itr") {
      const a = num(row.itr);
      const b = num(ref.itr);
      return a === null || b === null ? null : a - b;
    }
    const a = num(row.score);
    const b = num(ref.score);
    return a === null || b === null ? null : a - b;
  }

  function sortRows(rows) {
    const copy = [...rows];
    if (state.sort === "k") {
      copy.sort((a, b) => (a.k - b.k) || (valueOf(b) ?? 0) - (valueOf(a) ?? 0));
    } else if (state.sort === "placement") {
      const order = { full: 0, region: 1, distributed: 2, wearable: 3, random: 4 };
      copy.sort(
        (a, b) =>
          (order[a.strategy] ?? 9) - (order[b.strategy] ?? 9) ||
          (valueOf(b) ?? 0) - (valueOf(a) ?? 0),
      );
    } else {
      copy.sort((a, b) => (valueOf(b) ?? -Infinity) - (valueOf(a) ?? -Infinity));
    }
    return copy;
  }

  function bestRow(rows, ref) {
    const candidates = rows.filter((r) => !r.isFull && !r.isRandom);
    const pool = candidates.length ? candidates : rows;
    return sortRows(pool)[0] || ref;
  }

  function headlineRow(rows, ref, t) {
    const stats = t?.stats;
    if (stats && stats.bestLabel && stats.bestK != null) {
      const match = rows.find(
        (r) =>
          r.subsetLabel === stats.bestLabel &&
          Number(r.k) === Number(stats.bestK),
      );
      if (match) return match;
    }
    return bestRow(rows, ref);
  }

  // --------------------------------------------------------------- controls

  function initTheme() {
    const button = $("#theme-toggle");
    if (!button) return;
    button.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (e) {
        /* private mode */
      }
    });
  }

  function populateTaskSelect() {
    const select = $("#task");
    const rank = (t) => {
      const i = PAPER_ORDER.indexOf(t.id);
      return i === -1 ? 100 + t.order : i;
    };
    select.innerHTML = state.bundle.tasks
      .slice()
      .sort((a, b) => rank(a) - rank(b))
      .map((t) => `<option value="${esc(t.id)}">${esc(t.short)} — ${esc(t.datasetName)}</option>`)
      .join("");
  }

  function protocolLabel(taskId, protocol) {
    const row = state.bundle.rows.find((r) => r.track === taskId && r.protocol === protocol);
    return row?.protocolLabel || protocol.replaceAll("_", " ");
  }

  function pipelineLabel(taskId, pipeline) {
    const row = state.bundle.rows.find((r) => r.track === taskId && r.pipeline === pipeline);
    return row?.pipelineLabel || pipeline;
  }

  function selectTask(taskId, opts = {}) {
    const t = state.bundle.tasks.find((x) => x.id === taskId) || state.bundle.tasks[0];
    state.taskId = t.id;
    state.protocol = t.protocols.includes(opts.protocol) ? opts.protocol : t.defaultProtocol;
    state.pipeline = t.pipelines.includes(opts.pipeline) ? opts.pipeline : t.defaultPipeline;
    state.selected = opts.subset || null;

    const protocolSelect = $("#protocol");
    protocolSelect.innerHTML = t.protocols
      .map((p) => `<option value="${esc(p)}">${esc(protocolLabel(t.id, p))}</option>`)
      .join("");
    protocolSelect.value = state.protocol;

    const decoderSelect = $("#decoder");
    decoderSelect.innerHTML = t.pipelines
      .map((p) => `<option value="${esc(p)}">${esc(pipelineLabel(t.id, p))}</option>`)
      .join("");
    decoderSelect.value = state.pipeline;

    const hasItr = rowsFor(t.id, state.protocol, state.pipeline).some(
      (r) => num(r.itr) !== null,
    );
    $("#metric-control").hidden = !hasItr;
    if (!hasItr) state.metric = "score";
    $("#metric").value = state.metric;

    $("#task").value = t.id;
    render();
  }

  // ---------------------------------------------------------------- render

  function render() {
    const t = task();
    if (!t) return;
    const rows = rowsFor();
    if (!rows.length) {
      $("#chart").innerHTML = `<div class="empty">No rows for this protocol/decoder.</div>`;
      return;
    }
    const ref = referenceRow(rows, t);
    if (!state.selected || !rows.some((r) => r.subset === state.selected)) {
      state.selected = headlineRow(rows, ref, t).subset;
    }
    renderMeta(t, rows, ref);
    renderChart(t, rows, ref);
    renderDetail(rows.find((r) => r.subset === state.selected) || ref, ref);
    renderMontageTable(rows, ref);
    updateUrl();
  }

  function renderMeta(t, rows, ref) {
    const first = rows[0];
    const parts = [
      ["Dataset", t.datasetName],
      ["Cohort", t.nLabel],
      ["Channels", t.channels],
      ["Sampling", t.sfreq],
      ["Metric", t.metricLabel],
      ["Chance", fmtValue(first.chance, first.metric)],
      ["Decoder", pipelineLabel(t.id, state.pipeline)],
      ["Trials / windows", Number(t.examples).toLocaleString()],
    ];
    $("#task-meta").innerHTML = parts
      .map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`)
      .join("");
    $("#chart-title").textContent = `${t.short} — ${rows.length} montages`;
    $("#chart-note").textContent = `reference: ${ref.subsetLabel || ref.subset}`;
  }

  function renderChart(t, rows, ref) {
    const metric = metricOf(rows[0]);
    const base = state.metric === "itr" ? 0 : rows[0].chance;
    const sorted = sortRows(rows);
    const values = sorted.map(valueOf).filter((v) => v !== null);
    const refValue = valueOf(ref);
    const maxValue = Math.max(...values, refValue ?? 0);
    const maxRel = Math.max(maxValue - base, 0.01);

    const axis = (pct) => fmtValue(base + maxRel * pct, state.metric === "itr" ? "bitrate" : metric, 3);
    $("#axis").innerHTML = `
      <span>${state.metric === "itr" ? "0" : `chance ${fmtValue(base, metric)}`}</span>
      <span>${axis(0.5)}</span>
      <span>${axis(1)}</span>`;

    const refPct = Math.max(0, Math.min(100, ((refValue ?? base) - base) / maxRel * 100));
    const html = sorted.map((row) => {
      const value = valueOf(row);
      if (value === null) return "";
      const rel = Math.max(0, value - base);
      const pct = Math.max(0, Math.min(100, rel / maxRel * 100));
      const sem = num(row.sem);
      let err = "";
      if (state.metric !== "itr" && sem !== null) {
        const half = 1.96 * sem;
        const left = Math.max(0, Math.min(100, (value - half - base) / maxRel * 100));
        const right = Math.max(0, Math.min(100, (value + half - base) / maxRel * 100));
        err = `<span class="bar-err" style="left:${left}%;width:${Math.max(right - left, 0.2)}%"></span>`;
      }
      const selected = row.subset === state.selected ? " is-selected" : "";
      return `<div class="bar-row${selected}" role="button" tabindex="0" data-subset="${esc(row.subset)}">
        <div class="bar-label"><span class="swatch" style="background:var(--c-${strategyClass(row.strategy)})"></span><span class="name">${esc(labelFor(row))}</span><span class="k">${row.k} ch</span></div>
        <div class="bar-track"><div class="bar" data-strategy="${strategyClass(row.strategy)}" style="width:${pct}%"></div>${err}<span class="bar-ref" style="left:${refPct}%"></span></div>
        <div class="bar-value">${state.metric === "itr" ? fmtItr(value) : fmtValue(value, metric)}</div>
      </div>`;
    });
    $("#chart").innerHTML = html.join("");
    $("#chart").querySelectorAll(".bar-row").forEach((el) => {
      const choose = () => {
        state.selected = el.dataset.subset;
        render();
      };
      el.addEventListener("click", choose);
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose();
        }
      });
    });

    const seen = new Map();
    sorted.forEach((r) => {
      if (!seen.has(r.strategy)) seen.set(r.strategy, r.strategyLabel || r.strategy);
    });
    const legend = [...seen.entries()]
      .map(
        ([strategy, label]) =>
          `<span class="item"><span class="swatch" style="background:var(--c-${strategyClass(strategy)})"></span>${esc(label)}</span>`,
      )
      .join("");
    $("#legend").innerHTML = `${legend}<span class="item"><span class="ref-key"></span>reference</span>`;
  }

  async function loadRaw(taskId, protocol) {
    const key = `${taskId}__${protocol}`;
    if (state.rawCache.has(key)) return state.rawCache.get(key);
    const response = await fetch(`${RAW_BASE}${key}.csv`, { cache: "no-store" });
    if (!response.ok) {
      state.rawCache.set(key, null);
      return null;
    }
    const parsed = parseCsv(await response.text());
    state.rawCache.set(key, parsed);
    return parsed;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c !== "\r") {
        field += c;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    if (!rows.length) return [];
    const header = rows.shift().map((h) => h.trim());
    return rows
      .filter((values) => values.length === header.length)
      .map((values) => Object.fromEntries(header.map((h, i) => [h, values[i]])));
  }

  async function renderPaired(row, ref) {
    const host = $("#paired");
    if (!host) return;
    const token = ++pairedToken;
    if (!ref || row.subset === ref.subset) {
      host.innerHTML = `<p class="small">Reference montage. The paired difference is zero by definition.</p>`;
      return;
    }
    host.innerHTML = `<p class="small">Loading per-subject rows…</p>`;
    let raw;
    try {
      raw = await loadRaw(state.taskId, state.protocol);
    } catch (error) {
      if (token === pairedToken) host.innerHTML = `<p class="small">Could not load per-subject rows.</p>`;
      return;
    }
    if (token !== pairedToken) return;
    if (!raw) {
      host.innerHTML = `<p class="small">Per-subject rows are not published for this track.</p>`;
      return;
    }
    const pipe = state.pipeline;
    const subset = row.subset;
    const reference = ref.subset;
    const headlineWindow = num(taskById(state.taskId)?.headlineWindow);
    const needed = new Set([subset, reference]);
    const maps = new Map([...needed].map((s) => [s, new Map()]));
    raw.forEach((r) => {
      if (r.pipeline !== pipe || !needed.has(r.subset)) return;
      if (headlineWindow !== null) {
        const windowS = num(r.trial_seconds);
        if (windowS !== null && Math.abs(windowS - headlineWindow) > 1e-6) return;
      }
      const score = num(r.score);
      if (score === null) return;
      const unit = `${r.subject}|${r.session}`;
      maps.get(r.subset).set(unit, score);
    });
    const deltas = [];
    for (const [unit, value] of maps.get(subset)) {
      const base = maps.get(reference).get(unit);
      if (base !== undefined) deltas.push(value - base);
    }
    if (!deltas.length) {
      host.innerHTML = `<p class="small">No matched subject rows for this comparison.</p>`;
      return;
    }
    const { n, mean, sd } = meanSd(deltas);
    const half = sd === null ? null : tCritical(n - 1) * sd / Math.sqrt(n);
    const lo = half === null ? null : mean - half;
    const hi = half === null ? null : mean + half;
    const negative = deltas.filter((d) => d < 0).length;
    const loD = Math.min(0, ...deltas);
    const hiD = Math.max(0, ...deltas);
    const pad = (hiD - loD || 0.02) * 0.08;
    const min = loD - pad;
    const max = hiD + pad;
    const x = (d) => ((d - min) / (max - min)) * 100;
    const dots = deltas
      .map((d, i) => {
        const y = 44 + ((i % 5) - 2) * 7;
        return `<span class="dot" style="left:${x(d)}%;top:${y}px" title="${esc(fmtDelta(d, metricOf(row)))}"></span>`;
      })
      .join("");
    const meanPct = x(mean);
    host.innerHTML = `
      <p class="small"><strong>${n}</strong> paired units · mean ${fmtDelta(mean, metricOf(row))}
      ${half === null ? "" : `[${fmtDelta(lo, metricOf(row))}, ${fmtDelta(hi, metricOf(row))}]`}
      · negative in ${negative}/${n}</p>
      <div class="strip" aria-hidden="true">
        <span class="zero" style="left:${x(0)}%"></span>
        ${dots}
        <span class="mean" style="left:${meanPct}%"></span>
        <span class="mean-label" style="left:${meanPct}%">${fmtDelta(mean, metricOf(row))}</span>
      </div>
      <div class="strip-axis"><span>${fmtDelta(min, metricOf(row))}</span><span>0</span><span>${fmtDelta(max, metricOf(row))}</span></div>`;
  }

  function renderDetail(row, ref) {
    const metric = metricOf(row);
    const isItr = state.metric === "itr";
    const score = valueOf(row);
    const delta = deltaOf(row, ref);
    const scoreText = isItr ? fmtItr(score) : fmtValue(score, metric);
    const deltaText = isItr
      ? delta === null ? "—" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} bpm`
      : fmtDelta(delta, metric);
    const refText = isItr ? `${fmtItr(ref.itr)} bits/min` : fmtValue(valueOf(ref), metric);
    const controls = state.bundle.controls.filter((c) => c.track === state.taskId);
    const control = controls.find((c) => c.subset === row.subset) || controls[0];
    const fidelity = row.fidelity && row.fidelity !== "measured"
      ? `<span class="badge proxy">${esc(row.fidelity)}</span>`
      : `<span class="badge">measured</span>`;
    const chans = Array.isArray(row.channels) ? row.channels : [];
    const channelText = chans.length ? chans.join(", ") : "—";

    $("#detail").innerHTML = `
      <h2>${esc(labelFor(row))}</h2>
      <p class="sub">${esc(row.strategyLabel || row.strategy)} · ${row.k} electrodes · n=${row.n}</p>
      <div class="score">${scoreText}<small>${isItr ? "bits/min" : esc(metric === "roc_auc" ? "ROC-AUC" : row.metricLabel)}</small></div>
      <div class="delta">Δ vs ${esc(ref.subsetLabel || ref.subset)}: ${deltaText}</div>
      <dl>
        <dt>Reference</dt><dd>${esc(ref.subsetLabel || ref.subset)} · ${refText}</dd>
        <dt>Chance</dt><dd>${isItr ? "—" : fmtValue(row.chance, metric)}</dd>
        <dt>s.e.m.</dt><dd>${isItr || num(row.sem) === null ? "—" : num(row.sem).toFixed(3)}</dd>
        <dt>Fidelity</dt><dd>${fidelity}</dd>
        ${control ? `<dt>Shuffled null${isItr ? " (accuracy)" : ""}</dt><dd><code>${esc(control.subset)}</code> · ${fmtValue(control.perm, control.metric)} ± ${num(control.perm_sd)?.toFixed(3) ?? "—"} (real ${fmtValue(control.real, control.metric)})</dd>` : ""}
      </dl>
      <div class="strip-block">
        <h3>Per-subject paired difference${isItr ? " (accuracy)" : ""}</h3>
        <div id="paired"></div>
      </div>
      <div class="strip-block">
        <h3>Electrodes</h3>
        <div class="channels">${esc(channelText)}</div>
      </div>`;

    if (control) {
      // The control is a cohort-level null, so show its units as a small note.
      const units = control.n_subjects > 1 ? `${control.n_subjects} subjects` : "cohort control";
      $("#detail").querySelector("dl").insertAdjacentHTML(
        "beforeend",
        `<dt>Control units</dt><dd>${esc(units)} · ${control.n_permutations} shuffles</dd>`,
      );
    }
    renderPaired(row, ref);
  }

  function renderMontageTable(rows, ref) {
    const metric = metricOf(rows[0]);
    const sorted = sortRows(rows);
    const header = `<thead><tr><th>Montage</th><th class="num">k</th><th class="num">Score</th><th class="num">Δ vs ref</th><th class="num">s.e.m.${state.metric === "itr" ? " (score)" : ""}</th><th class="num">n</th><th>Fidelity</th></tr></thead>`;
    const body = sorted
      .map((row) => {
        const value = valueOf(row);
        const delta = deltaOf(row, ref);
        const selected = row.subset === state.selected ? ' class="is-selected"' : "";
        const fidelity = row.fidelity && row.fidelity !== "measured"
          ? `<span class="badge proxy">${esc(row.fidelity)}</span>`
          : `<span class="badge">measured</span>`;
        return `<tr${selected} data-subset="${esc(row.subset)}" tabindex="0">
          <td>${esc(labelFor(row))}</td>
          <td class="num">${row.k}</td>
          <td class="num">${state.metric === "itr" ? fmtItr(value) : fmtValue(value, metric)}</td>
          <td class="num">${state.metric === "itr" ? (delta === null ? "—" : delta.toFixed(1)) : fmtDelta(delta, metric)}</td>
          <td class="num">${num(row.sem) === null ? "—" : num(row.sem).toFixed(3)}</td>
          <td class="num">${row.n}</td>
          <td>${fidelity}</td>
        </tr>`;
      })
      .join("");
    $("#montage-table").innerHTML = `${header}<tbody>${body}</tbody>`;
    $("#montage-table").querySelectorAll("tbody tr").forEach((el) => {
      const choose = () => {
        state.selected = el.dataset.subset;
        render();
      };
      el.addEventListener("click", choose);
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose();
        }
      });
    });
  }

  function renderAllRows() {
    const query = state.query.trim().toLowerCase();
    const rows = state.bundle.rows.filter((r) => {
      if (!query) return true;
      return [
        r.track,
        r.protocolLabel,
        r.pipelineLabel,
        r.subsetLabel,
        r.subset,
        r.strategyLabel,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    const taskName = new Map(state.bundle.tasks.map((t) => [t.id, t.short]));
    const header = `<thead><tr><th>Task</th><th>Protocol</th><th>Decoder</th><th>Montage</th><th class="num">k</th><th class="num">Score</th><th class="num">Δ</th><th class="num">n</th><th>Fidelity</th></tr></thead>`;
    const body = rows
      .map(
        (row) => `<tr data-track="${esc(row.track)}" data-protocol="${esc(row.protocol)}" data-pipeline="${esc(row.pipeline)}" data-subset="${esc(row.subset)}">
          <td>${esc(taskName.get(row.track) || row.track)}</td>
          <td>${esc(row.protocolLabel || row.protocol)}</td>
          <td>${esc(row.pipelineLabel || row.pipeline)}</td>
          <td>${esc(labelFor(row))}</td>
          <td class="num">${row.k}</td>
          <td class="num">${fmtValue(row.score, row.metric)}</td>
          <td class="num">${fmtDelta(taskDelta(row), row.metric)}</td>
          <td class="num">${row.n}</td>
          <td>${esc(row.fidelity || "measured")}</td>
        </tr>`,
      )
      .join("");
    $("#all-table").innerHTML = `${header}<tbody>${body}</tbody>`;
    $("#all-count").textContent = `${rows.length} of ${state.bundle.rows.length} rows`;
    $("#all-table").querySelectorAll("tbody tr").forEach((el) => {
      el.addEventListener("click", () => {
        selectTask(el.dataset.track, {
          protocol: el.dataset.protocol,
          pipeline: el.dataset.pipeline,
          subset: el.dataset.subset,
        });
        $("#chart").scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }

  function renderRawLinks() {
    const links = [];
    state.bundle.tasks.forEach((t) => {
      (t.protocols || []).forEach((p) => {
        const name = `${t.id}__${p}.csv`;
        links.push(
          `<a href="${RAW_BASE}${name}" download>${esc(t.short)} · ${esc(protocolLabel(t.id, p))}</a>`,
        );
      });
    });
    $("#raw-links").innerHTML = links.join("");
  }

  function renderControls() {    const taskName = new Map(state.bundle.tasks.map((t) => [t.id, t.short]));
    const header = `<thead><tr><th>Task</th><th>Subset</th><th class="num">Real</th><th class="num">Shuffled null</th><th class="num">Chance</th><th class="num">Gap</th><th class="num">Units</th><th class="num">Shuffles</th></tr></thead>`;
    const body = state.bundle.controls
      .map(
        (c) => `<tr>
          <td>${esc(taskName.get(c.track) || c.track)}</td>
          <td><code>${esc(c.subset)}</code></td>
          <td class="num">${fmtValue(c.real, c.metric)}</td>
          <td class="num">${fmtValue(c.perm, c.metric)} ± ${num(c.perm_sd)?.toFixed(3) ?? "—"}</td>
          <td class="num">${fmtValue(c.chance, c.metric)}</td>
          <td class="num">${fmtDelta(c.gap, c.metric)}</td>
          <td class="num">${c.n_subjects > 1 ? `${c.n_subjects} subj` : `${c.n_controls} row`}</td>
          <td class="num">${c.n_permutations}</td>
        </tr>`,
      )
      .join("");
    $("#controls-table").innerHTML = `${header}<tbody>${body}</tbody>`;
  }

  function renderQuality() {    const taskName = new Map(state.bundle.tasks.map((t) => [t.id, t.short]));
    const rows = state.bundle.quality || [];
    if (!rows.length) {
      $("#tab-quality").innerHTML = `<div class="empty">No signal-quality rows.</div>`;
      return;
    }
    const header = `<thead><tr><th>Task</th><th>Subset</th><th class="num">k</th><th class="num">Reject rate</th><th class="num">Line-noise ratio</th><th class="num">Effective rank</th><th class="num">Mean |r|</th></tr></thead>`;
    const body = rows
      .map(
        (q) => `<tr>
          <td>${esc(taskName.get(q.track) || q.track)}</td>
          <td><code>${esc(q.subset)}</code></td>
          <td class="num">${q.k}</td>
          <td class="num">${(q.reject_rate * 100).toFixed(2)}%</td>
          <td class="num">${num(q.line_noise_ratio)?.toFixed(2) ?? "—"}</td>
          <td class="num">${num(q.effective_rank)?.toFixed(2) ?? "—"}</td>
          <td class="num">${num(q.mean_abs_corr)?.toFixed(3) ?? "—"}</td>
        </tr>`,
      )
      .join("");
    $("#quality-table").innerHTML = `${header}<tbody>${body}</tbody>`;
  }

  function updateUrl() {
    const params = new URLSearchParams();
    params.set("task", state.taskId);
    if (state.protocol !== task().defaultProtocol) params.set("protocol", state.protocol);
    if (state.pipeline !== task().defaultPipeline) params.set("decoder", state.pipeline);
    if (state.selected) params.set("subset", state.selected);
    const next = `${location.pathname}?${params.toString()}`;
    history.replaceState(null, "", next);
  }

  function downloadCsv() {
    const columns = [
      "track", "protocol", "pipeline", "subset", "subsetLabel", "strategy",
      "k", "score", "sem", "n", "metric", "chance", "delta",
      "referenceScore", "fidelity", "itr", "channels",
    ];
    const lines = [columns.join(",")];
    state.bundle.rows.forEach((row) => {
      lines.push(
        columns
          .map((key) => {
            let value = row[key];
            if (key === "channels" && Array.isArray(value)) value = value.join(" ");
            if (typeof value === "string") value = `"${value.replaceAll('"', '""')}"`;
            return value ?? "";
          })
          .join(","),
      );
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "electrode-budget-rows.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // ------------------------------------------------------------------ wire

  function wire() {
    $("#task").addEventListener("change", (event) => selectTask(event.target.value));
    $("#protocol").addEventListener("change", (event) => {
      state.protocol = event.target.value;
      state.selected = null;
      selectTask(state.taskId, { protocol: state.protocol, pipeline: state.pipeline });
    });
    $("#decoder").addEventListener("change", (event) => {
      state.pipeline = event.target.value;
      state.selected = null;
      selectTask(state.taskId, { protocol: state.protocol, pipeline: state.pipeline });
    });
    $("#metric").addEventListener("change", (event) => {
      state.metric = event.target.value;
      render();
    });
    $("#sort").addEventListener("change", (event) => {
      state.sort = event.target.value;
      render();
    });
    $("#reset").addEventListener("click", () => {
      state.query = "";
      $("#search").value = "";
      $("#metric").value = "score";
      state.metric = "score";
      state.sort = "score";
      $("#sort").value = "score";
      selectTask(state.bundle.tasks[0].id);
      renderAllRows();
    });
    $("#download-all").addEventListener("click", downloadCsv);
    $("#search").addEventListener("input", (event) => {
      state.query = event.target.value;
      renderAllRows();
    });
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", String(active));
        });
        document.querySelectorAll(".tab-panel").forEach((panel) => {
          panel.classList.toggle("is-active", panel.id === `tab-${tab.dataset.tab}`);
        });
      });
    });
  }

  async function init() {
    initTheme();
    let bundle;
    try {
      const response = await fetch(DATA_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bundle = await response.json();
    } catch (error) {
      const box = $("#error");
      box.hidden = false;
      box.innerHTML = `Could not load <code>${esc(DATA_URL)}</code>. Serve the site over HTTP, e.g. <code>python -m http.server 8000 --directory docs</code>, then open <code>http://localhost:8000/explore/</code>.`;
      return;
    }
    state.bundle = bundle;
    populateTaskSelect();
    wire();
    const params = new URLSearchParams(location.search);
    const requested = bundle.tasks.find((t) => t.id === params.get("task")) || bundle.tasks[0];
    selectTask(requested.id, {
      protocol: params.get("protocol") || undefined,
      pipeline: params.get("decoder") || undefined,
      subset: params.get("subset") || undefined,
    });
    renderAllRows();
    renderControls();
    renderQuality();
    renderRawLinks();
  }

  init();
})();
