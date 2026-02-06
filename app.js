// ─── State ────────────────────────────────────────────────────────────────────

let nameMapping = {};      // sanitizedName -> displayName
let renderCounter = 0;
let debounceTimer = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const editor = document.getElementById("editor");
const preview = document.getElementById("preview");
const processedWrapper = document.getElementById("processed-wrapper");
const processedCode = document.getElementById("processed-code");
const showProcessed = document.getElementById("show-processed");
const templateSelect = document.getElementById("templates");
const zoomLevel = document.getElementById("zoom-level");
let currentZoom = 100;
let currentTheme = "default";
let currentLayout = "dagre";
let elkLoaded = false;

// ─── Mermaid init ─────────────────────────────────────────────────────────────

function initMermaid(erDirection) {
    mermaid.initialize({
        startOnLoad: false,
        theme: currentTheme,
        layout: currentLayout,
        securityLevel: "loose",
        er: { useMaxWidth: false, layoutDirection: erDirection || "TB" },
        flowchart: { useMaxWidth: false, htmlLabels: true },
    });
}

async function loadElkLayout() {
    if (elkLoaded) return true;
    try {
        const module = await import("https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0/dist/mermaid-layout-elk.esm.min.mjs");
        mermaid.registerLayoutLoaders(module.default);
        elkLoaded = true;
        return true;
    } catch (e) {
        console.error("Failed to load ELK layout:", e);
        return false;
    }
}

initMermaid();

// ─── Templates ────────────────────────────────────────────────────────────────

const TEMPLATES = {
    "er-german": `erDiagram
    Gebäude ||--o{ Raum : enthält
    Gebäude ||--|{ Gebäude Adresse : hat
    Raum ||--o{ Sensor : besitzt
    Gebäude {
        Gebäude ID, int, PK
        Gebäude Name, string
        Baujahr, int, , "z.B. 1990, 2005"
        Gebäude Typ, string, , "Büro, Wohnung, Lager"
    }
    Gebäude Adresse {
        Adresse ID, int, PK
        Straße, string
        Hausnummer, string
        Postleitzahl, string
        Ort, string
    }
    Raum {
        Raum ID, int, PK
        Raum Name, string
        Fläche in m², float
        Stockwerk, int, , "EG, 1. OG, 2. OG"
    }
    Sensor {
        Sensor ID, int, PK
        Sensor Typ, string, , "Temperatur, CO₂, Feuchte"
        Messeinheit, string
        Letzter Messwert, date
    }`,

    "er-basic": `erDiagram
    Customer ||--o{ Order : places
    Order ||--|{ Order Item : contains
    Product ||--o{ Order Item : "is in"
    Customer {
        Customer ID, int, PK
        Full Name, string
        Email Address, string, UK
        Phone Number, string
    }
    Order {
        Order ID, int, PK
        Order Date, date
        Shipping Address, string
        Order Status, string, , "New, Shipped, Delivered"
    }
    Order Item {
        Item ID, int, PK
        Quantity Ordered, int
        Unit Price, float
    }
    Product {
        Product ID, int, PK
        Product Name, string
        Product Category, string, , "Electronics, Clothing, Food"
        List Price, float
    }`,

    "flow-german": `flowchart TD
    "Antrag einreichen" --> "Dokumente prüfen"
    "Dokumente prüfen" --> {"Unterlagen vollständig?"}
    "Unterlagen vollständig?" -->|"Ja"| "Fachliche Prüfung"
    "Unterlagen vollständig?" -->|"Nein"| "Nachforderung senden"
    "Nachforderung senden" --> "Antrag einreichen"
    "Fachliche Prüfung" --> {"Genehmigung erteilt?"}
    "Genehmigung erteilt?" -->|"Ja"| "Bescheid erstellen"
    "Genehmigung erteilt?" -->|"Nein"| "Ablehnung mitteilen"
    "Bescheid erstellen" --> "Antrag abgeschlossen"
    "Ablehnung mitteilen" --> "Antrag abgeschlossen"`,

    "flow-basic": `flowchart TD
    "Customer places order" --> "Validate payment"
    "Validate payment" --> {"Payment valid?"}
    "Payment valid?" -->|"Yes"| "Process order"
    "Payment valid?" -->|"No"| "Show error message"
    "Show error message" --> "Customer places order"
    "Process order" --> "Update inventory"
    "Update inventory" --> "Send confirmation email"
    "Send confirmation email" --> "Order complete"`,
};

// ─── Utility: sanitise a display name to a safe Mermaid identifier ────────────

function sanitizeName(name) {
    let s = name
        .replace(/[äÄ]/g, (c) => (c === "ä" ? "ae" : "Ae"))
        .replace(/[öÖ]/g, (c) => (c === "ö" ? "oe" : "Oe"))
        .replace(/[üÜ]/g, (c) => (c === "ü" ? "ue" : "Ue"))
        .replace(/ß/g, "ss")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    return s || "unnamed";
}

// Track used IDs to avoid collisions within one render pass
let usedIds;

function getUniqueId(displayName, minLength) {
    let base = sanitizeName(displayName);
    // Pad the ID so Mermaid allocates enough column width for the
    // display name that will replace it during post-processing.
    if (minLength && base.length < minLength) {
        base += "_".repeat(minLength - base.length);
    }
    let id = base;
    let n = 2;
    while (usedIds.has(id) && nameMapping[id] !== displayName) {
        id = base + n++;
    }
    usedIds.add(id);
    nameMapping[id] = displayName;
    return id;
}

// ─── CSV splitter that respects quoted strings ────────────────────────────────

function splitCSV(line) {
    const parts = [];
    let current = "";
    let inQuotes = false;
    for (const ch of line) {
        if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
        } else if (ch === "," && !inQuotes) {
            parts.push(current.trim());
            current = "";
        } else {
            current += ch;
        }
    }
    parts.push(current.trim());
    return parts;
}

// ─── ER-diagram preprocessing ─────────────────────────────────────────────────
//
//  Attribute syntax (name-first, comma-separated):
//      Field Name, type [, PK|FK|UK] [, "comment / value list"]
//
//  Examples:
//      Gebäude ID, int, PK
//      Gebäude Typ, string, , "Büro, Wohnung, Lager"
//      Fläche in m², float

function preprocessER(code) {
    nameMapping = {};
    usedIds = new Set();

    const lines = code.split("\n");
    const result = [];
    let inEntity = false;
    let erDirection = null;

    // relationship line regex — captures entity names around the cardinality
    // pattern (e.g.  ||--o{ )
    const relOp = /([|}][o|])(--|\.\.)([o|][|{])/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // blank / comment / directive
        if (trimmed === "" || trimmed.startsWith("%%")) {
            result.push(line);
            continue;
        }

        // erDiagram line (with optional shorthand direction, e.g. "erDiagram LR")
        const erDeclMatch = trimmed.match(/^erDiagram(\s+(TD|TB|BT|LR|RL))?$/i);
        if (erDeclMatch) {
            if (erDeclMatch[2]) erDirection = erDeclMatch[2].toUpperCase();
            result.push("erDiagram");
            continue;
        }

        // "direction XX" line — extract and skip
        const dirMatch = trimmed.match(/^direction\s+(TD|TB|BT|LR|RL)$/i);
        if (dirMatch) {
            erDirection = dirMatch[1].toUpperCase();
            continue;
        }

        // closing brace of entity block
        if (trimmed === "}") {
            inEntity = false;
            result.push(line);
            continue;
        }

        // inside entity block → attribute line
        if (inEntity) {
            result.push(preprocessERAttribute(line));
            continue;
        }

        // entity opening  (e.g.  "Gebäude Adresse {")
        const entityOpen = trimmed.match(/^(.+?)\s*\{$/);
        if (entityOpen) {
            const display = entityOpen[1].replace(/^"|"$/g, "").trim();
            const id = getUniqueId(display);
            const indent = line.match(/^(\s*)/)[1];
            result.push(`${indent}${id} {`);
            inEntity = true;
            continue;
        }

        // relationship line
        const relMatch = trimmed.match(relOp);
        if (relMatch) {
            result.push(preprocessERRelationship(line, relOp));
            continue;
        }

        // anything else → pass through
        result.push(line);
    }

    return { code: result.join("\n"), direction: erDirection };
}

function preprocessERAttribute(line) {
    const indent = line.match(/^(\s*)/)[1];
    const trimmed = line.trim();

    // Comma-separated format:  Name, type [, PK|FK|UK] [, "comment"]
    const parts = splitCSV(trimmed);

    if (parts.length < 2) {
        // Not comma-separated or just a single token — pass through
        return line;
    }

    const displayName = parts[0];
    const type = parts[1];

    // Column 3: key constraint (PK / FK / UK) or empty
    let key = null;
    if (parts.length >= 3 && /^(PK|FK|UK)$/i.test(parts[2])) {
        key = parts[2].toUpperCase();
    }

    // Column 4+: comment / value list (may itself contain commas since
    // splitCSV respects quotes).  If column 3 wasn't a key, treat it
    // as the start of the comment.
    let comment = null;
    if (parts.length >= 4) {
        comment = parts.slice(3).join(", ").trim();
    } else if (parts.length === 3 && !key) {
        comment = parts[2].trim();
    }

    const safeName = getUniqueId(displayName, displayName.length + 2);

    // Rebuild as Mermaid attribute:  safeName type [PK|FK|UK] ["comment"]
    // (swapped so the display name renders in the first column)
    let out = `${indent}${safeName} ${type}`;
    if (key) out += ` ${key}`;
    if (comment) {
        const c = comment.replace(/^"|"$/g, "").trim();
        if (c) out += ` "${c}"`;
    }
    return out;
}

function preprocessERRelationship(line, relOp) {
    const indent = line.match(/^(\s*)/)[1];
    const trimmed = line.trim();

    // Find the relationship operator position
    const opMatch = trimmed.match(relOp);
    if (!opMatch) return line;

    const opStart = opMatch.index;
    const opEnd = opMatch.index + opMatch[0].length;

    const leftRaw = trimmed.substring(0, opStart).trim();
    const operator = opMatch[0];
    const rightPart = trimmed.substring(opEnd).trim();

    // Right part is:  entityName : label
    const colonIdx = rightPart.indexOf(":");
    let rightEntity, label;
    if (colonIdx !== -1) {
        rightEntity = rightPart.substring(0, colonIdx).trim();
        label = rightPart.substring(colonIdx + 1).trim();
    } else {
        rightEntity = rightPart;
        label = "";
    }

    // Clean up quotes the user may have already added
    const leftDisplay = leftRaw.replace(/^"|"$/g, "").trim();
    const rightDisplay = rightEntity.replace(/^"|"$/g, "").trim();

    const leftId = getUniqueId(leftDisplay);
    const rightId = getUniqueId(rightDisplay);

    // Quote the label if it contains special chars and isn't already quoted
    let labelOut = label;
    if (label && !label.startsWith('"')) {
        if (/[^a-zA-Z0-9_ ]/.test(label)) {
            labelOut = `"${label}"`;
        }
    }

    let out = `${indent}${leftId} ${operator} ${rightId}`;
    if (labelOut) out += ` : ${labelOut}`;
    return out;
}

// ─── Flowchart preprocessing ──────────────────────────────────────────────────
//
//  The user can write quoted free-text node labels like:
//      "Gebäude prüfen" --> "Raum auswählen"
//  and also decision nodes in braces:
//      {"Genehmigung erteilt?"}
//  We auto-generate IDs and create proper Mermaid syntax.

function preprocessFlowchart(code) {
    nameMapping = {};
    usedIds = new Set();

    const nodeIdMap = {}; // displayLabel → generated id

    function getFlowNodeId(label) {
        if (nodeIdMap[label]) return nodeIdMap[label];
        const base = sanitizeName(label);
        let id = base;
        let n = 2;
        while (usedIds.has(id)) id = base + n++;
        usedIds.add(id);
        nodeIdMap[label] = id;
        nameMapping[id] = label;
        return id;
    }

    const lines = code.split("\n");
    const result = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Pass through directives, comments, blanks, subgraph, end
        if (
            trimmed === "" ||
            trimmed.startsWith("%%") ||
            /^(flowchart|graph)\s/i.test(trimmed) ||
            /^(subgraph|end)\b/i.test(trimmed) ||
            /^(classDef|class|style|click|linkStyle)\b/.test(trimmed)
        ) {
            result.push(line);
            continue;
        }

        result.push(preprocessFlowLine(line, getFlowNodeId));
    }

    return result.join("\n");
}

function preprocessFlowLine(line, getFlowNodeId) {
    const indent = line.match(/^(\s*)/)[1];
    let rest = line.trim();

    // Tokenise the line into node references and arrows.
    // We handle: quoted strings "...", decision braces {"..."}, and plain IDs.
    // Arrows: -->, ---,  -.-> , ==>, and variants with |labels|
    const tokens = [];
    let pos = 0;

    while (pos < rest.length) {
        // skip whitespace
        if (/\s/.test(rest[pos])) { pos++; continue; }

        // arrow with optional label:  -->|"text"|  or  -->|text|
        const arrowMatch = rest.substring(pos).match(
            /^(--+>|--+|==+>|==+|-\.+-\>?|-\.+)((?:\|[^|]*\|)?)/
        );
        if (arrowMatch && arrowMatch[0].length > 0) {
            tokens.push({ type: "arrow", raw: arrowMatch[0] });
            pos += arrowMatch[0].length;
            continue;
        }

        // decision node: {"text"} or {text}
        if (rest[pos] === "{") {
            const end = rest.indexOf("}", pos + 1);
            if (end !== -1) {
                let inner = rest.substring(pos + 1, end).trim();
                inner = inner.replace(/^"|"$/g, "");
                tokens.push({ type: "node", label: inner, shape: "diamond" });
                pos = end + 1;
                continue;
            }
        }

        // quoted node: "text"
        if (rest[pos] === '"') {
            const end = rest.indexOf('"', pos + 1);
            if (end !== -1) {
                const label = rest.substring(pos + 1, end);
                tokens.push({ type: "node", label, shape: "rect" });
                pos = end + 1;
                continue;
            }
        }

        // round node: ("text")
        if (rest[pos] === "(" && rest[pos + 1] === '"') {
            const end = rest.indexOf('")', pos + 2);
            if (end !== -1) {
                const label = rest.substring(pos + 2, end);
                tokens.push({ type: "node", label, shape: "round" });
                pos = end + 2;
                continue;
            }
        }

        // existing ID-based node reference (e.g.  A or nodeId["label"])
        const idMatch = rest.substring(pos).match(
            /^([a-zA-Z_]\w*)(\["[^"]*"\]|\("[^"]*"\)|\{"[^"]*"\}|\(\["[^"]*"\]\)|\[\["[^"]*"\]\])?/
        );
        if (idMatch && idMatch[0].length > 0) {
            tokens.push({ type: "raw", raw: idMatch[0] });
            pos += idMatch[0].length;
            continue;
        }

        // fallback — consume one character
        pos++;
    }

    // Rebuild the line
    const parts = tokens.map((tok) => {
        if (tok.type === "arrow") return ` ${tok.raw} `;
        if (tok.type === "raw") return tok.raw;
        // node with label
        const id = getFlowNodeId(tok.label);
        if (tok.shape === "diamond") return `${id}{"${tok.label}"}`;
        if (tok.shape === "round")  return `${id}("${tok.label}")`;
        return `${id}["${tok.label}"]`;
    });

    return indent + parts.join("").replace(/  +/g, " ");
}

// ─── SVG post-processing — replace sanitised IDs with display names ───────────

function postProcessSVG(container) {
    if (!container) return;

    // Build replacements sorted longest-first to avoid partial matches
    const entries = Object.entries(nameMapping).sort(
        (a, b) => b[0].length - a[0].length
    );
    if (entries.length === 0) return;

    // Native SVG text elements — only process leaf nodes (no children)
    container.querySelectorAll("text, tspan").forEach((el) => {
        if (el.children && el.children.length > 0) return;
        for (const [sanitized, display] of entries) {
            if (el.textContent && el.textContent.includes(sanitized)) {
                el.textContent = el.textContent.replaceAll(sanitized, display);
            }
        }
    });

    // foreignObject HTML content — use innerHTML to preserve DOM structure
    container.querySelectorAll("foreignObject span, foreignObject p, foreignObject div").forEach((el) => {
        for (const [sanitized, display] of entries) {
            if (el.innerHTML && el.innerHTML.includes(sanitized)) {
                el.innerHTML = el.innerHTML.replaceAll(sanitized, display);
            }
        }
    });

    // Prevent text wrapping in foreignObject cells after name replacement
    container.querySelectorAll("foreignObject").forEach((fo) => {
        fo.style.overflow = "visible";
        fo.querySelectorAll("div, span, p").forEach((child) => {
            child.style.whiteSpace = "nowrap";
        });
    });
}

// ─── Render ───────────────────────────────────────────────────────────────────

async function render() {
    const raw = editor.value.trim();
    if (!raw) {
        preview.innerHTML = '<div class="placeholder">Choose an example or start typing to see a live preview.</div>';
        processedCode.textContent = "";
        return;
    }

    let processed;
    const isER = /\berDiagram\b/i.test(raw);
    if (isER) {
        const result = preprocessER(raw);
        processed = result.code;
        initMermaid(result.direction);
    } else {
        processed = preprocessFlowchart(raw);
        initMermaid();
    }

    processedCode.textContent = processed;

    try {
        const id = "mermaid-" + ++renderCounter;
        const { svg } = await mermaid.render(id, processed);
        preview.innerHTML = svg;
        postProcessSVG(preview.querySelector("svg"));
        fitToView();
    } catch (err) {
        const msg = (err.message || String(err))
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        preview.innerHTML = `<div class="error">Render error:\n${msg}</div>`;
    }
}

function scheduleRender() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 400);
}

// ─── Template selector ───────────────────────────────────────────────────────

templateSelect.addEventListener("change", () => {
    const key = templateSelect.value;
    if (key && TEMPLATES[key]) {
        editor.value = TEMPLATES[key];
        render();
    }
});

// ─── Dropdown menus ─────────────────────────────────────────────────────────

// Toggle dropdown open/close on trigger click
document.querySelectorAll(".tb-dropdown-trigger").forEach((btn) => {
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = btn.nextElementSibling;
        const wasOpen = menu.classList.contains("open");
        // Close all dropdowns first
        document.querySelectorAll(".tb-dropdown-menu").forEach((m) => m.classList.remove("open"));
        if (!wasOpen) menu.classList.add("open");
    });
});

// Close dropdowns when clicking outside
document.addEventListener("click", () => {
    document.querySelectorAll(".tb-dropdown-menu").forEach((m) => m.classList.remove("open"));
});

// Direction menu — modifies editor text directly
document.querySelectorAll("#direction-menu button[data-value]").forEach((btn) => {
    btn.addEventListener("click", () => {
        const dir = btn.dataset.value;
        document.querySelectorAll("#direction-menu button[data-value]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyDirectionToEditor(dir);
        render();
    });
});

function applyDirectionToEditor(dir) {
    const code = editor.value;

    if (/\berDiagram\b/i.test(code)) {
        // ER diagram: use inline shorthand "erDiagram LR"
        // Also clean any stale "direction XX" lines the user may have typed
        let updated = code.replace(
            /^\s*direction\s+(TD|TB|BT|LR|RL)\s*\n?/im,
            ``
        );

        if (dir) {
            updated = updated.replace(
                /^(\s*erDiagram)\b(\s+(TD|TB|BT|LR|RL))?/im,
                `$1 ${dir}`
            );
        } else {
            // "Auto" — remove direction from erDiagram line
            updated = updated.replace(
                /^(\s*erDiagram)\s+(TD|TB|BT|LR|RL)/im,
                `$1`
            );
        }

        editor.value = updated;
        return;
    }

    // Flowchart: replace direction on the flowchart/graph line
    if (dir) {
        editor.value = code.replace(
            /^(\s*(?:flowchart|graph))\s+(TD|TB|BT|LR|RL)/im,
            `$1 ${dir}`
        );
    }
}

// Layout menu
document.querySelectorAll("#layout-menu button[data-value]").forEach((btn) => {
    btn.addEventListener("click", async () => {
        const layout = btn.dataset.value;
        document.querySelectorAll("#layout-menu button[data-value]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        if (layout === "elk") await loadElkLayout();
        currentLayout = layout;
        render();
    });
});

// Theme menu
document.querySelectorAll("#theme-menu button[data-value]").forEach((btn) => {
    btn.addEventListener("click", () => {
        currentTheme = btn.dataset.value;
        document.querySelectorAll("#theme-menu button[data-value]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        render();
    });
});

// ─── Infinite canvas: zoom + pan ─────────────────────────────────────────────

let panX = 0;
let panY = 0;

function applyTransform() {
    const svg = preview.querySelector("svg");
    if (!svg) return;
    const s = currentZoom / 100;
    svg.style.transform = `translate(${panX}px, ${panY}px) scale(${s})`;
    svg.style.transformOrigin = "0 0";
    zoomLevel.textContent = Math.round(currentZoom) + "%";
}

function fitToView() {
    const svg = preview.querySelector("svg");
    if (!svg) return;
    const vw = preview.clientWidth;
    const vh = preview.clientHeight;
    const sw = svg.width.baseVal.value || svg.getBBox().width;
    const sh = svg.height.baseVal.value || svg.getBBox().height;
    if (!sw || !sh) return;
    const padding = 0.9;
    const scale = Math.min((vw / sw) * padding, (vh / sh) * padding, 3);
    currentZoom = scale * 100;
    panX = (vw - sw * scale) / 2;
    panY = (vh - sh * scale) / 2;
    applyTransform();
}

function zoomBy(delta, cx, cy) {
    const oldZoom = currentZoom;
    currentZoom = Math.min(500, Math.max(10, currentZoom + delta));
    const factor = currentZoom / oldZoom;
    panX = cx - (cx - panX) * factor;
    panY = cy - (cy - panY) * factor;
    applyTransform();
}

document.getElementById("zoom-in").addEventListener("click", () => {
    const rect = preview.getBoundingClientRect();
    zoomBy(25, rect.width / 2, rect.height / 2);
});

document.getElementById("zoom-out").addEventListener("click", () => {
    const rect = preview.getBoundingClientRect();
    zoomBy(-25, rect.width / 2, rect.height / 2);
});

document.getElementById("zoom-reset").addEventListener("click", () => {
    fitToView();
});

// Scroll to zoom toward cursor
preview.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = preview.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? 10 : -10;
    zoomBy(delta, cx, cy);
}, { passive: false });

// ─── Pan (always active) ────────────────────────────────────────────────────

preview.addEventListener("mousedown", (e) => {
    e.preventDefault();
    preview.classList.add("panning");
    const startX = e.clientX;
    const startY = e.clientY;
    const startPanX = panX;
    const startPanY = panY;

    const onMove = (ev) => {
        panX = startPanX + (ev.clientX - startX);
        panY = startPanY + (ev.clientY - startY);
        applyTransform();
    };
    const onUp = () => {
        preview.classList.remove("panning");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
});

// ─── Show processed toggle ───────────────────────────────────────────────────

showProcessed.addEventListener("change", () => {
    processedWrapper.classList.toggle("hidden", !showProcessed.checked);
});

// ─── Live editing ─────────────────────────────────────────────────────────────

editor.addEventListener("input", scheduleRender);

// Support Tab key for indentation in the editor
editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + "    " + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 4;
        scheduleRender();
    }
});

// ─── Export helpers ───────────────────────────────────────────────────────────

function getCleanSvg() {
    const svg = preview.querySelector("svg");
    if (!svg) return null;
    const clone = svg.cloneNode(true);
    // Strip pan/zoom transforms so the export is clean
    clone.style.transform = "";
    clone.style.transformOrigin = "";
    clone.style.position = "";
    return clone;
}

// ─── Export: SVG ──────────────────────────────────────────────────────────────

document.getElementById("export-svg").addEventListener("click", () => {
    const svg = getCleanSvg();
    if (!svg) return alert("Nothing to export — render a diagram first.");
    const data = new XMLSerializer().serializeToString(svg);
    download("diagram.svg", "image/svg+xml", data);
});

// ─── Export: PNG ──────────────────────────────────────────────────────────────

document.getElementById("export-png").addEventListener("click", () => {
    const svg = getCleanSvg();
    if (!svg) return alert("Nothing to export — render a diagram first.");

    const data = new XMLSerializer().serializeToString(svg);
    // Use a base64 data URL instead of blob URL to avoid tainted-canvas errors
    const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(data)));
    const img = new Image();
    img.onload = () => {
        const scale = 2; // retina
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((pngBlob) => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(pngBlob);
            a.download = "diagram.png";
            a.click();
            URL.revokeObjectURL(a.href);
        });
    };
    img.src = url;
});

function download(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ─── Draggable divider ───────────────────────────────────────────────────────

const divider = document.querySelector(".divider");
const editorPane = document.querySelector(".editor-pane");

divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    divider.classList.add("dragging");
    const onMove = (ev) => {
        const pct = (ev.clientX / window.innerWidth) * 100;
        const clamped = Math.max(20, Math.min(70, pct));
        editorPane.style.width = clamped + "%";
    };
    const onUp = () => {
        divider.classList.remove("dragging");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
});

// ─── Initial load ─────────────────────────────────────────────────────────────

editor.value = TEMPLATES["er-german"];
templateSelect.value = "er-german";
render();
