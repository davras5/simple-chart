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

// ─── Mermaid init ─────────────────────────────────────────────────────────────

mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    securityLevel: "loose",
    er: { useMaxWidth: true },
    flowchart: { useMaxWidth: true, htmlLabels: true },
});

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

function getUniqueId(displayName) {
    const base = sanitizeName(displayName);
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

    // relationship line regex — captures entity names around the cardinality
    // pattern (e.g.  ||--o{ )
    const relOp = /([|}][o|])(--|\.\.)([o|][|{])/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // blank / comment / directive
        if (trimmed === "" || trimmed.startsWith("%%") || trimmed === "erDiagram") {
            result.push(line);
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

    return result.join("\n");
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

    const safeName = getUniqueId(displayName);

    // Rebuild as Mermaid attribute:  type safeName [PK|FK|UK] ["comment"]
    let out = `${indent}${type} ${safeName}`;
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

    const elements = container.querySelectorAll("text, tspan, span, p, foreignObject");
    elements.forEach((el) => {
        // For elements with child nodes, only process leaf text
        if (el.children && el.children.length > 0 && el.tagName !== "foreignObject") return;

        for (const [sanitized, display] of entries) {
            if (el.textContent && el.textContent.includes(sanitized)) {
                el.textContent = el.textContent.replaceAll(sanitized, display);
            }
        }
    });

    // Also handle foreignObject content which Mermaid uses for HTML labels
    container.querySelectorAll("foreignObject span, foreignObject p, foreignObject div").forEach((el) => {
        for (const [sanitized, display] of entries) {
            if (el.innerHTML && el.innerHTML.includes(sanitized)) {
                el.innerHTML = el.innerHTML.replaceAll(sanitized, display);
            }
        }
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
    const isER = /^\s*erDiagram/i.test(raw);
    if (isER) {
        processed = preprocessER(raw);
    } else {
        processed = preprocessFlowchart(raw);
    }

    processedCode.textContent = processed;

    try {
        const id = "mermaid-" + ++renderCounter;
        const { svg } = await mermaid.render(id, processed);
        preview.innerHTML = svg;
        postProcessSVG(preview.querySelector("svg"));
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

// ─── Export: SVG ──────────────────────────────────────────────────────────────

document.getElementById("export-svg").addEventListener("click", () => {
    const svg = preview.querySelector("svg");
    if (!svg) return alert("Nothing to export — render a diagram first.");
    const data = new XMLSerializer().serializeToString(svg);
    download("diagram.svg", "image/svg+xml", data);
});

// ─── Export: PNG ──────────────────────────────────────────────────────────────

document.getElementById("export-png").addEventListener("click", () => {
    const svg = preview.querySelector("svg");
    if (!svg) return alert("Nothing to export — render a diagram first.");

    const data = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([data], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
        const scale = 2; // retina
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext("2d");
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
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
