#!/usr/bin/env node
// Validates an MCP server against the Athena agent + widget requirements.
//   node verify.mjs                      -> http://localhost:8787/mcp
//   node verify.mjs https://host/mcp     -> a deployed server
//   node verify.mjs <url> '{"city":"Houston","limit":5}'

const url = process.argv[2] || "http://localhost:8787/mcp";
const callArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};

let pass = 0, fail = 0;
const ok = (m, extra = "") => { pass++; console.log(`  PASS  ${m}${extra && "  " + extra}`); };
const no = (m, extra = "") => { fail++; console.log(`  FAIL  ${m}${extra && "  " + extra}`); };

async function rpc(method, params = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await res.text();
  // Streamable HTTP may answer as SSE; pull the data frame out if so
  const body = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : text;
  const json = JSON.parse(body);
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

console.log(`\nVerifying ${url}\n`);

// --- handshake -------------------------------------------------------------
console.log("Handshake");
let init;
try {
  init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "verify", version: "1.0" },
  });
  ok("initialize", `${init.serverInfo.name} v${init.serverInfo.version}`);
} catch (e) {
  no("initialize", e.message);
  console.log("\nServer unreachable - nothing else can run.\n");
  process.exit(1);
}

// --- CORS ------------------------------------------------------------------
console.log("\nCORS");
try {
  const pre = await fetch(url, { method: "OPTIONS" });
  const acao = pre.headers.get("access-control-allow-origin");
  acao === "*" ? ok("Access-Control-Allow-Origin: *") : no("Access-Control-Allow-Origin", `got ${acao}`);
} catch (e) {
  no("preflight", e.message);
}

// --- tools -----------------------------------------------------------------
console.log("\nTools");
const { tools } = await rpc("tools/list");
tools.length ? ok(`${tools.length} tool(s) registered`) : no("no tools registered");

const templates = new Set();
for (const t of tools) {
  console.log(`\n  [${t.name}]`);
  t.description?.length > 20 ? ok("has description") : no("description too short / missing");
  /^use this when/i.test(t.description || "")
    ? ok('description starts with "Use this when"')
    : no('description should start with "Use this when" (docs convention)');

  const a = t.annotations || {};
  ["readOnlyHint", "destructiveHint", "openWorldHint"].forEach((k) =>
    typeof a[k] === "boolean" ? ok(`annotations.${k}`, String(a[k])) : no(`annotations.${k} missing`)
  );

  const tpl = t._meta?.["openai/outputTemplate"];
  if (tpl) { ok("openai/outputTemplate", tpl); templates.add(tpl); }
  else no("openai/outputTemplate missing - no widget will render");

  t._meta?.["openai/toolInvocation/invoking"]
    ? ok("invoking/invoked labels")
    : no("invoking/invoked labels missing (cosmetic)");

  t.inputSchema?.properties?._athenaAttachments
    ? ok("_athenaAttachments declared")
    : no("_athenaAttachments not declared - PDF attachments will fail validation");
}

// --- widget resources ------------------------------------------------------
console.log("\nWidget resources");
const { resources } = await rpc("resources/list");
ok(`${resources.length} resource(s) listed`);

for (const uri of templates) {
  console.log(`\n  [${uri}]`);
  let contents;
  try {
    ({ contents } = await rpc("resources/read", { uri }));
  } catch (e) {
    no("resources/read failed", e.message);
    continue;
  }
  const c = contents[0];
  c.mimeType === "text/html+skybridge"
    ? ok("mimeType text/html+skybridge")
    : no("wrong mimeType", c.mimeType);

  const csp = c._meta?.["openai/widgetCSP"];
  const hosts = [...(c.text.matchAll(/https:\/\/[^"'\s)]+/g))]
    .map((m) => { try { return new URL(m[0]).origin; } catch { return null; } })
    .filter(Boolean);
  if (csp) {
    ok("openai/widgetCSP declared", JSON.stringify(csp.resource_domains || []));
  } else if (hosts.length) {
    no("no widgetCSP but widget references external hosts", [...new Set(hosts)].join(", "));
  } else {
    ok("no widgetCSP needed (no external hosts)");
  }

  const inline = (c.text.match(/\son(click|error|change|input|submit|load)=/g) || []).length;
  inline === 0
    ? ok("no inline event handlers")
    : no(`${inline} inline handler(s) - blocked by widget CSP`, "use addEventListener");

  c.text.includes("window.openai")
    ? ok("reads window.openai")
    : no("widget never reads window.openai - it will render empty");
}

// --- live call -------------------------------------------------------------
console.log("\nLive data");
const tool = tools[0];
try {
  const r = await rpc("tools/call", { name: tool.name, arguments: callArgs });
  const sc = r.structuredContent;
  if (!sc) {
    no("no structuredContent - widget receives nothing");
  } else {
    const arr = Object.values(sc).find(Array.isArray);
    arr?.length
      ? ok(`structuredContent has ${arr.length} record(s)`)
      : no("structuredContent contains no records - is the upstream API returning data?");
    const kb = JSON.stringify(sc).length / 1024;
    kb < 50 ? ok(`payload ${kb.toFixed(1)} KB`) : no(`payload ${kb.toFixed(1)} KB - trim before it eats model context`);
    if (arr?.length) console.log(`        sample: ${JSON.stringify(arr[0]).slice(0, 140)}...`);
  }
  r.isError ? no("tool returned isError") : ok("tool call succeeded");
} catch (e) {
  no("tools/call failed", e.message);
}

console.log(`\n${"-".repeat(58)}\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
