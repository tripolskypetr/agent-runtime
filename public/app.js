/* agent-runtime admin: plain JS, no dependencies. */
(() => {
  const API = "/api/v1";

  const state = {
    items: [],
    total: 0,
    page: 0,
    pageSize: 50,
    q: "",
    status: "",
    mode: "",
    selectedId: null,
    record: null,
    tab: "transcript",
    auto: true,
    view: "detail", // "detail" | "compose"
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

  let listSeq = 0;
  const pageCount = () => Math.max(1, Math.ceil(state.total / state.pageSize));
  /** Loads the current page with the current filters and search; a newer call wins over an older one still in flight. */
  const loadList = async () => {
    const seq = ++listSeq;
    const params = new URLSearchParams({ limit: String(state.pageSize), offset: String(state.page * state.pageSize) });
    if (state.status) params.set("status", state.status);
    if (state.mode) params.set("mode", state.mode);
    if (state.q) params.set("q", state.q);
    const data = await fetchJson(`${API}/inferences?${params}`);
    if (seq !== listSeq) return;
    state.total = data.total;
    if (state.page >= pageCount()) {
      // the page vanished (deletion, filter or search change): fall back to the last existing one
      state.page = pageCount() - 1;
      return loadList();
    }
    state.items = data.items;
    renderList();
  };

  const loadRecord = async (id) => {
    const record = await fetchJson(`${API}/inferences/${id}`);
    if (state.selectedId !== id) return;
    state.record = record;
    if (state.view === "detail") renderDetail();
  };

  const select = async (id) => {
    state.view = "detail";
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
    if (!state.items.length) list.append(el("li", { class: "none" }, state.q ? "nothing matches the search" : "no inferences"));
    const from = state.total ? state.page * state.pageSize + 1 : 0;
    const to = Math.min(state.total, (state.page + 1) * state.pageSize);
    $("#listTotal").textContent = state.q ? `${state.total} found` : `${state.total} total`;
    $("#pageInfo").textContent = `${from}–${to} of ${state.total} · page ${state.page + 1}/${pageCount()}`;
    $("#prev").disabled = state.page === 0;
    $("#next").disabled = state.page >= pageCount() - 1;
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


  /* ---------- compose: send a message to the agent ---------- */

  const DRAFT_KEY = "agent-runtime.compose";
  const DEFAULT_FORMAT = {
    type: "object",
    required: ["summary", "sentiment"],
    properties: {
      summary: { type: "string", description: "Краткое содержание, 2-3 предложения" },
      sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"], description: "Общее настроение" },
      assets: { type: "array", items: { type: "string" }, description: "Упомянутые тикеры" },
    },
  };
  const newMessage = (role = "user") => ({ role, content: "", images: [] });
  const compose = {
    mode: "object",
    model: "",
    instructions: "",
    format: JSON.stringify(DEFAULT_FORMAT, null, 2),
    messages: [newMessage()],
    files: [],
    busy: false,
    status: "",
    result: null,
  };
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (draft && typeof draft === "object") {
      compose.mode = draft.mode === "text" ? "text" : "object";
      compose.model = draft.model || "";
      compose.instructions = draft.instructions || "";
      compose.format = typeof draft.format === "string" ? draft.format : compose.format;
      if (Array.isArray(draft.messages) && draft.messages.length) {
        compose.messages = draft.messages.map((m) => ({ role: m.role || "user", content: m.content || "", images: [] }));
      }
    }
  } catch { /* ignore broken drafts */ }
  const saveDraft = () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        mode: compose.mode,
        model: compose.model,
        instructions: compose.instructions,
        format: compose.format,
        messages: compose.messages.map(({ role, content }) => ({ role, content })),
      }));
    } catch { /* storage unavailable */ }
  };

  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const openCompose = () => {
    state.view = "compose";
    state.selectedId = null;
    state.record = null;
    renderList();
    renderCompose();
  };

  const renderCompose = () => {
    if (state.view !== "compose") return;
    const detail = $("#detail");
    const form = el("div", { class: "compose" });

    form.append(
      el("div", { class: "detail-head" }, [
        el("h2", {}, "New inference"),
        el("div", { class: "segmented" }, ["object", "text"].map((mode) =>
          el("button", { class: compose.mode === mode ? "active" : "", onclick: () => { compose.mode = mode; saveDraft(); renderCompose(); } },
            mode === "object" ? "object (provide_answer)" : "text"),
        )),
      ]),
    );

    // messages
    const messages = el("div", { class: "field" }, el("label", {}, "messages"));
    compose.messages.forEach((message, index) => {
      const card = el("div", { class: "message-card" });
      const roleSelect = el("select", { onchange: (e) => { message.role = e.target.value; saveDraft(); } },
        ["user", "assistant", "system"].map((role) => el("option", { value: role, ...(message.role === role ? { selected: "selected" } : {}) }, role)));
      const imageInput = el("input", { type: "file", accept: "image/*", multiple: "multiple", style: "display:none", onchange: async (e) => {
        for (const file of Array.from(e.target.files)) {
          message.images.push({ name: file.name, dataUrl: await readAsDataUrl(file) });
        }
        renderCompose();
      } });
      card.append(...[
        el("div", { class: "head" }, [
          roleSelect,
          el("span", { class: "muted" }, `#${index}`),
          el("span", { class: "spacer" }),
          el("button", { class: "ghost", onclick: () => imageInput.click() }, "+ image"),
          compose.messages.length > 1 ? el("button", { class: "ghost", onclick: () => { compose.messages.splice(index, 1); saveDraft(); renderCompose(); } }, "remove") : null,
          imageInput,
        ]),
        el("textarea", { placeholder: "message text", oninput: (e) => { message.content = e.target.value; saveDraft(); } }, message.content),
        message.images.length
          ? el("div", { class: "attach-list" }, message.images.map((img, i) =>
              el("span", { class: "chip" }, [
                el("img", { src: img.dataUrl, alt: img.name }),
                el("span", {}, img.name),
                el("button", { title: "remove", onclick: () => { message.images.splice(i, 1); renderCompose(); } }, "×"),
              ])))
          : null,
      ].filter(Boolean));
      messages.append(card);
    });
    messages.append(el("div", {}, el("button", { class: "ghost", onclick: () => { compose.messages.push(newMessage()); saveDraft(); renderCompose(); } }, "+ message")));
    form.append(messages);

    // files
    const fileInput = el("input", { type: "file", multiple: "multiple", style: "display:none", onchange: async (e) => {
      for (const file of Array.from(e.target.files)) {
        compose.files.push({ name: file.name, size: file.size, dataUrl: await readAsDataUrl(file) });
      }
      renderCompose();
    } });
    form.append(
      el("div", { class: "field" }, [
        el("label", {}, "files (written into the agent workspace)"),
        el("div", { class: "attach-list" }, [
          ...compose.files.map((file, i) => el("span", { class: "chip" }, [
            el("span", {}, `${file.name} · ${fmtBytes(file.size)}`),
            el("button", { title: "remove", onclick: () => { compose.files.splice(i, 1); renderCompose(); } }, "×"),
          ])),
          el("button", { class: "ghost", onclick: () => fileInput.click() }, "+ file"),
          fileInput,
        ]),
      ]),
    );

    // format (object mode only)
    if (compose.mode === "object") {
      form.append(
        el("div", { class: "field" }, [
          el("label", {}, "format (JSON schema, json-inference FormatModel)"),
          el("textarea", { class: "code", spellcheck: "false", oninput: (e) => { compose.format = e.target.value; saveDraft(); } }, compose.format),
          el("div", { class: "hint" }, "Becomes the parameters of the provide_answer tool. The answer is validated against it."),
        ]),
      );
    }

    // model + instructions
    form.append(
      el("div", { class: "row" }, [
        el("div", { class: "field" }, [
          el("label", {}, "model (optional)"),
          el("input", { type: "text", placeholder: "default from OLLAMA_MODEL", value: compose.model, oninput: (e) => { compose.model = e.target.value; saveDraft(); } }),
        ]),
        el("div", { class: "field" }, [
          el("label", {}, "instructions (optional, appended to the system prompt)"),
          el("textarea", { style: "min-height:42px", oninput: (e) => { compose.instructions = e.target.value; saveDraft(); } }, compose.instructions),
        ]),
      ]),
    );

    // actions
    form.append(
      el("div", { class: "compose-actions" }, [
        el("button", { class: "primary", ...(compose.busy ? { disabled: "disabled" } : {}), onclick: submitCompose }, compose.busy ? "running…" : `send to /api/v1/${compose.mode === "object" ? "inference" : "text"}`),
        el("button", { class: "ghost", ...(compose.busy ? { disabled: "disabled" } : {}), onclick: () => { compose.messages = [newMessage()]; compose.files = []; compose.result = null; compose.status = ""; saveDraft(); renderCompose(); } }, "clear"),
        el("span", { class: "compose-status" }, compose.status),
      ]),
    );

    // result
    if (compose.result) {
      const r = compose.result;
      const box = el("div", { class: `compose-result${r.status === "error" ? " error" : ""}` });
      box.append(el("div", {}, [
        el("span", { class: `badge ${r.status === "success" ? "success" : "error"}` }, r.status),
        " ",
        el("span", { class: "muted" }, `${r.model ?? ""} · ${r.attempts ?? "?"} attempts · ${r.turns ?? "?"} turns · ${fmtDuration(r.durationMs)}`),
        " ",
        r.id ? el("a", { href: `?id=${r.id}`, onclick: (e) => { e.preventDefault(); select(r.id); } }, "open transcript") : null,
      ]));
      if (r.status === "success" && "text" in r) box.append(el("div", { class: "text" }, r.text));
      else if (r.status === "success") box.append(json(r.data));
      else if (r.error) box.append(el("div", { class: "error-box" }, [
        el("div", {}, [el("strong", {}, r.error.code || "error"), " — ", r.error.message || ""]),
        r.error.details?.length ? el("ol", {}, r.error.details.map((d) => el("li", {}, d))) : null,
      ]));
      else box.append(json(r));
      form.append(box);
    }

    detail.replaceChildren(form);
  };

  const submitCompose = async () => {
    if (compose.busy) return;
    const messages = compose.messages
      .map(({ role, content, images }) => ({ role, content, ...(images.length ? { images: images.map((img) => img.dataUrl) } : {}) }))
      .filter((m) => m.content.trim() || m.images?.length);
    if (!messages.length) {
      compose.status = "add at least one message";
      renderCompose();
      return;
    }
    const body = { messages };
    if (compose.files.length) body.files = compose.files.map(({ name, dataUrl }) => ({ name, content: dataUrl }));
    if (compose.model.trim()) body.model = compose.model.trim();
    if (compose.instructions.trim()) body.instructions = compose.instructions.trim();
    if (compose.mode === "object") {
      try {
        body.format = JSON.parse(compose.format);
      } catch (error) {
        compose.status = `format is not valid JSON: ${error.message}`;
        renderCompose();
        return;
      }
    }
    compose.busy = true;
    compose.result = null;
    compose.status = "sending… the record appears in the list on the left as soon as the server accepts it";
    renderCompose();
    const started = Date.now();
    try {
      const response = await fetch(`${API}/${compose.mode === "object" ? "inference" : "text"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      compose.result = payload;
      compose.status = `HTTP ${response.status} in ${fmtDuration(Date.now() - started)}`;
    } catch (error) {
      compose.result = { status: "error", error: { code: "network", message: error.message, details: [] } };
      compose.status = "request failed";
    } finally {
      compose.busy = false;
      renderCompose();
      loadList().catch(console.error);
    }
  };

  /* ---------- wiring ---------- */

  $("#statusFilter").addEventListener("change", (event) => {
    state.status = event.target.value;
    state.page = 0;
    loadList().catch(console.error);
  });
  $("#modeFilter").addEventListener("change", (event) => {
    state.mode = event.target.value;
    state.page = 0;
    loadList().catch(console.error);
  });
  $("#reload").addEventListener("click", () => loadList().catch(console.error));
  $("#newInference").addEventListener("click", openCompose);
  $("#prev").addEventListener("click", () => {
    if (state.page === 0) return;
    state.page -= 1;
    loadList().catch(console.error);
  });
  $("#next").addEventListener("click", () => {
    if (state.page >= pageCount() - 1) return;
    state.page += 1;
    loadList().catch(console.error);
  });
  $("#pageSize").addEventListener("change", (event) => {
    state.pageSize = Number(event.target.value);
    state.page = 0;
    loadList().catch(console.error);
  });
  let searchTimer = null;
  const applySearch = (value) => {
    const q = value.trim();
    if (q === state.q) return;
    state.q = q;
    state.page = 0;
    loadList().catch(console.error);
  };
  $("#search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applySearch(event.target.value), 300);
  });
  $("#search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      clearTimeout(searchTimer);
      applySearch(event.target.value);
    } else if (event.key === "Escape") {
      event.target.value = "";
      clearTimeout(searchTimer);
      applySearch("");
    }
  });
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
  else if (new URLSearchParams(location.search).has("new")) openCompose();
})();
