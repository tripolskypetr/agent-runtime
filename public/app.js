/* agent-runtime admin: plain JS, no dependencies. */
(() => {
  const API = "/api/v1";
  const PAGE = 50;

  const state = {
    items: [],
    total: 0,
    offset: 0,
    status: "",
    mode: "",
    selectedId: null,
    record: null,
    tab: "transcript",
    auto: true,
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  };

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
  const fmtDuration = (ms) => {
    if (ms === null || ms === undefined) return "—";
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  };
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const short = (id) => id.slice(0, 8);
  const attachmentUrl = (inferenceId, attachmentId, download) =>
    `${API}/inferences/${inferenceId}/attachments/${attachmentId}${download ? "?download=true" : ""}`;
  const json = (value) => el("pre", { class: "json" }, JSON.stringify(value, null, 2));

  /* ---------- data ---------- */

  const fetchJson = async (url, options) => {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  };

  const loadHealth = async () => {
    try {
      const health = await fetchJson(`${API}/health`);
      const node = $("#health");
      node.textContent = `${health.model} · ${health.running ? "running" : "idle"}${health.queued ? ` · ${health.queued} queued` : ""}`;
      node.classList.toggle("busy", health.running);
    } catch {
      $("#health").textContent = "offline";
    }
  };

  const loadList = async (reset = true) => {
    if (reset) state.offset = 0;
    const params = new URLSearchParams({ limit: String(reset ? Math.max(PAGE, state.items.length || PAGE) : PAGE), offset: String(reset ? 0 : state.offset) });
    if (state.status) params.set("status", state.status);
    if (state.mode) params.set("mode", state.mode);
    const data = await fetchJson(`${API}/inferences?${params}`);
    state.total = data.total;
    state.items = reset ? data.items : state.items.concat(data.items);
    state.offset = state.items.length;
    renderList();
  };

  const loadRecord = async (id) => {
    const record = await fetchJson(`${API}/inferences/${id}`);
    if (state.selectedId !== id) return;
    state.record = record;
    renderDetail();
  };

  const select = async (id) => {
    state.selectedId = id;
    state.record = null;
    renderList();
    $("#detail").replaceChildren(el("div", { class: "empty" }, "Loading…"));
    try {
      await loadRecord(id);
    } catch (error) {
      $("#detail").replaceChildren(el("div", { class: "empty" }, `Failed to load: ${error.message}`));
    }
  };

  const remove = async (id) => {
    if (!confirm(`Delete inference ${short(id)}?`)) return;
    await fetch(`${API}/inferences/${id}`, { method: "DELETE" });
    state.selectedId = null;
    state.record = null;
    $("#detail").replaceChildren(el("div", { class: "empty" }, "Select an inference on the left."));
    await loadList();
  };

  /* ---------- list ---------- */

  const renderList = () => {
    const list = $("#list");
    list.replaceChildren(
      ...state.items.map((item) =>
        el(
          "li",
          { class: item.id === state.selectedId ? "active" : "", onclick: () => select(item.id) },
          [
            el("span", { class: `dot ${item.status}` }),
            el("span", { class: "title" }, short(item.id)),
            el("span", { class: "time" }, fmtTime(item.createdAt)),
            el("span", { class: "sub" }, [
              el("span", { class: "kind" }, item.mode || "object"),
              el("span", {}, item.model),
              el("span", {}, fmtDuration(item.durationMs)),
              el("span", {}, `${item.attempts} att · ${item.turns} turns`),
              item.fileCount ? el("span", {}, `${item.fileCount} files`) : null,
              item.errorCode ? el("span", { class: "errcode" }, item.errorCode) : null,
            ]),
          ],
        ),
      ),
    );
    $("#listTotal").textContent = `${state.items.length} / ${state.total}`;
    $("#more").style.display = state.items.length < state.total ? "" : "none";
  };

  /* ---------- detail ---------- */

  const renderDetail = () => {
    const record = state.record;
    if (!record) return;
    const detail = $("#detail");
    const tabs = ["transcript", "request", "result", "files"];
    detail.replaceChildren(
      el("div", { class: "detail-head" }, [
        el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, [
          el("span", { class: `badge ${record.status}` }, record.status),
          el("span", { class: "kind" }, record.mode || "object"),
          el("h2", {}, record.id),
        ]),
        el("div", { style: "display:flex;gap:8px" }, [
          el("a", { href: `${API}/inferences/${record.id}`, target: "_blank", rel: "noopener" }, el("button", {}, "JSON")),
          el("button", { class: "danger", onclick: () => remove(record.id) }, "delete"),
        ]),
      ]),
      el("div", { class: "cards" }, [
        card("model", record.model),
        card("created", fmtTime(record.createdAt)),
        card("finished", fmtTime(record.finishedAt)),
        card("duration", fmtDuration(record.durationMs)),
        card("attempts", String(record.attempts)),
        card("turns", String(record.turns)),
        card("messages", String(record.messages.length)),
        record.error ? card("error", record.error.code) : null,
      ]),
      el(
        "div",
        { class: "tabs" },
        tabs.map((tab) =>
          el("button", { class: tab === state.tab ? "active" : "", onclick: () => { state.tab = tab; renderDetail(); } }, tab),
        ),
      ),
      renderTab(record),
    );
  };

  const card = (k, v) => el("div", { class: "card" }, [el("div", { class: "k" }, k), el("div", { class: "v" }, v)]);

  const renderTab = (record) => {
    switch (state.tab) {
      case "request": return renderRequest(record);
      case "result": return renderResult(record);
      case "files": return renderFiles(record);
      default: return renderTranscript(record);
    }
  };

  const renderResult = (record) => {
    const wrap = el("div");
    if (record.error) {
      wrap.append(
        el("div", { class: "error-box" }, [
          el("div", {}, [el("strong", {}, record.error.code), " — ", record.error.message]),
          record.error.details?.length ? el("ol", {}, record.error.details.map((d) => el("li", {}, d))) : null,
        ]),
      );
    }
    if (record.result !== null && record.result !== undefined) {
      if (record.mode === "text") {
        wrap.append(el("h3", {}, "text answer"), el("div", { class: "msg" }, el("div", { class: "msg-body" }, el("div", { class: "text" }, String(record.result)))));
      } else {
        wrap.append(el("h3", {}, "provide_answer"), json(record.result));
      }
    } else if (!record.error) {
      wrap.append(el("div", { class: "empty" }, record.status === "running" ? "Still running…" : "No result."));
    }
    return wrap;
  };

  const renderRequest = (record) => {
    const request = record.request || {};
    const wrap = el("div");
    (request.messages || []).forEach((message, index) => {
      wrap.append(
        el("div", { class: `msg ${message.role}` }, [
          el("div", { class: "msg-head" }, [el("span", { class: "role" }, message.role), el("span", {}, `#${index}`)]),
          el("div", { class: "msg-body" }, [
            message.content ? el("div", { class: "text" }, message.content) : el("div", { class: "muted" }, "(empty)"),
            thumbs(record.id, message.images || []),
          ]),
        ]),
      );
    });
    if (request.instructions) wrap.append(el("h3", {}, "instructions"), el("pre", { class: "json" }, request.instructions));
    if (request.format) wrap.append(el("h3", {}, "format"), json(request.format));
    return wrap;
  };

  const renderFiles = (record) => {
    const rows = record.attachments || [];
    if (!rows.length) return el("div", { class: "empty" }, "No attachments.");
    return el("table", {}, [
      el("thead", {}, el("tr", {}, ["kind", "name", "mime", "size", ""].map((h) => el("th", {}, h)))),
      el(
        "tbody",
        {},
        rows.map((a) =>
          el("tr", {}, [
            el("td", {}, el("span", { class: "kind" }, a.kind)),
            el("td", {}, [
              el("a", { href: attachmentUrl(record.id, a.id), target: "_blank", rel: "noopener" }, a.name),
              a.mime.startsWith("image/") ? el("div", { class: "thumbs", style: "margin-top:6px" }, thumb(record.id, a.id)) : null,
            ]),
            el("td", {}, a.mime),
            el("td", {}, fmtBytes(a.size)),
            el("td", {}, el("a", { href: attachmentUrl(record.id, a.id, true) }, "download")),
          ]),
        ),
      ),
    ]);
  };

  const thumb = (inferenceId, attachmentId) =>
    el("a", { href: attachmentUrl(inferenceId, attachmentId), target: "_blank", rel: "noopener" }, el("img", { src: attachmentUrl(inferenceId, attachmentId), loading: "lazy" }));
  const thumbs = (inferenceId, ids) => (ids.length ? el("div", { class: "thumbs" }, ids.map((id) => thumb(inferenceId, id))) : null);

  const renderTranscript = (record) => {
    const wrap = el("div");
    if (!record.messages.length) {
      wrap.append(el("div", { class: "empty" }, record.status === "running" ? "Waiting for the first turn…" : "Empty transcript."));
      return wrap;
    }
    record.messages.forEach((message, index) => wrap.append(renderMessage(record, message, index)));
    return wrap;
  };

  const renderMessage = (record, message, index) => {
    const body = [];
    const headExtra = [];
    const role = message.role;

    if (role === "system") {
      body.push(el("details", {}, [el("summary", {}, "system prompt"), el("div", { class: "text" }, message.content || "")]));
      if (message.toolsAdded?.length) {
        body.push(el("details", {}, [el("summary", {}, `tools: ${message.toolsAdded.map((t) => t.name).join(", ")}`), json(message.toolsAdded)]));
      }
    } else if (role === "user") {
      const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || [];
      const images = parts.filter((p) => p.type === "image").map((p) => p.attachmentId).filter(Boolean);
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      if (text) body.push(el("div", { class: "text" }, text));
      if (images.length) body.push(thumbs(record.id, images));
    } else if (role === "assistant") {
      headExtra.push(el("span", {}, message.stopReason || ""));
      if (message.usage?.totalTokens) headExtra.push(el("span", { class: "stat" }, `${message.usage.input}→${message.usage.output} tok`));
      if (message.durationMs) headExtra.push(el("span", { class: "stat" }, fmtDuration(message.durationMs)));
      for (const part of message.content || []) {
        if (part.type === "thinking") body.push(el("details", {}, [el("summary", {}, "thinking"), el("div", { class: "text" }, part.thinking)]));
        else if (part.type === "text") body.push(el("div", { class: "text" }, part.text));
        else if (part.type === "toolCall") body.push(el("div", { class: "toolcall" }, [el("div", { class: "name" }, `${part.name}()`), json(part.arguments)]));
      }
      if (message.errorMessage) body.push(el("div", { class: "error-box" }, message.errorMessage));
    } else if (role === "toolResult") {
      headExtra.push(el("span", { class: "name" }, message.toolName));
      if (message.isError) headExtra.push(el("span", {}, "error"));
      if (message.durationMs) headExtra.push(el("span", { class: "stat" }, fmtDuration(message.durationMs)));
      const parts = message.content || [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const images = parts.filter((p) => p.type === "image").map((p) => p.attachmentId).filter(Boolean);
      if (text) body.push(el("pre", { class: "json" }, text));
      if (images.length) body.push(thumbs(record.id, images));
    } else {
      body.push(json(message));
    }

    return el("div", { class: `msg ${role}${message.isError ? " isError" : ""}` }, [
      el("div", { class: "msg-head" }, [el("span", { class: "role" }, role), el("span", {}, `#${index}`), ...headExtra]),
      el("div", { class: "msg-body" }, body),
    ]);
  };

  /* ---------- wiring ---------- */

  $("#statusFilter").addEventListener("change", (event) => {
    state.status = event.target.value;
    loadList().catch(console.error);
  });
  $("#modeFilter").addEventListener("change", (event) => {
    state.mode = event.target.value;
    loadList().catch(console.error);
  });
  $("#reload").addEventListener("click", () => loadList().catch(console.error));
  $("#more").addEventListener("click", () => loadList(false).catch(console.error));
  $("#autoRefresh").addEventListener("change", (event) => {
    state.auto = event.target.checked;
  });

  const tick = async () => {
    if (!state.auto) return;
    await loadHealth();
    await loadList().catch(console.error);
    if (state.selectedId && (state.record?.status === "running" || !state.record)) {
      await loadRecord(state.selectedId).catch(console.error);
    }
  };

  loadHealth().then(() => loadList()).catch(console.error);
  setInterval(tick, 4000);

  const initial = new URLSearchParams(location.search).get("id");
  if (initial) select(initial);
})();
