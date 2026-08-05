import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";

const propertyWidgetHtml = readFileSync("public/property-widget.html", "utf8");

// SimplyRETS demo API
const RETS_BASE = "https://api.simplyrets.com";
const RETS_AUTH = "Basic " + Buffer.from("simplyrets:simplyrets").toString("base64");

// Host serving listing photos - must stay in sync with widgetCSP resource_domains
const PHOTO_HOST = "https://d2bd5h5te3s67r.cloudfront.net";

// The feed returns type codes; the widget filters on readable labels
const TYPE_LABELS = { RES: "Residential", CND: "Condominium", RNT: "Rental" };

// Single source of truth - referenced by the resource, the tool descriptor and
// the tool result, which must agree for the host to render the widget
const WIDGET_URI = "ui://widget/property.html";

async function fetchProperties(args) {
  const params = new URLSearchParams();
  if (args.city) params.set("q", args.city);
  if (args.minPrice) params.set("minprice", String(args.minPrice));
  if (args.maxPrice) params.set("maxprice", String(args.maxPrice));
  if (args.minBeds) params.set("minbeds", String(args.minBeds));
  if (args.type) params.set("type", args.type);
  params.set("limit", String(args.limit || 20));

  const res = await fetch(`${RETS_BASE}/properties?${params}`, {
    headers: { Authorization: RETS_AUTH, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();

  return data.map((p) => {
    const code = p.property?.type || "";
    return {
      mlsId: p.mlsId,
      price: p.listPrice || 0,
      address: p.address?.full || "Unknown",
      city: p.address?.city || "",
      state: p.address?.state || "",
      zip: p.address?.postalCode || "",
      bedrooms: p.property?.bedrooms || 0,
      bathrooms: p.property?.bathsFull || 0,
      sqft: p.property?.area || 0,
      type: TYPE_LABELS[code] || code,
      yearBuilt: p.property?.yearBuilt || null,
      lotSize: p.property?.lotSize || null,
      // Trimmed to what the detail view actually shows - the full remarks are
      // boilerplate and this payload is sent to the model on every call
      description: (p.remarks || "").slice(0, 300),
      photo: p.photos?.[0] || null,
      listingType: code === "RNT" || p.leaseTerm ? "Rent" : "Sale",
    };
  });
}

// Ring buffer of recent MCP calls, surfaced at GET /log
const callLog = [];
function recordCall(httpMethod, body) {
  callLog.push({
    at: new Date().toISOString(),
    http: httpMethod,
    method: body?.method ?? null,
    uri: body?.params?.uri ?? body?.params?.name ?? null,
  });
  if (callLog.length > 100) callLog.shift();
}

function createPropertyServer() {
  const server = new McpServer({ name: "property-explorer", version: "0.1.0" });

  server.registerResource(
    "property-widget",
    WIDGET_URI,
    { mimeType: "text/html+skybridge" },
    async () => ({
      contents: [{
        uri: WIDGET_URI,
        mimeType: "text/html+skybridge",
        text: propertyWidgetHtml,
        _meta: {
          "openai/widgetPrefersBorder": true,
          // Newer Apps SDK contract - hosts that have migrated read this instead
          ui: { prefersBorder: true },
          "openai/widgetDescription":
            "Browse property listings as cards with sorting, filtering and a detail view.",
          // Listing photos are blocked by the widget sandbox unless declared here
          "openai/widgetCSP": {
            connect_domains: [],
            resource_domains: [PHOTO_HOST],
          },
        },
      }],
    })
  );

  server.registerTool(
    "search_properties",
    {
      title: "Search Properties",
      description:
        "Use this when the user asks about real estate listings, homes, condos or rentals - " +
        "searches property listings by location, price range, bedrooms, and type.",
      inputSchema: {
        city: z.string().optional().describe("City name (e.g., Houston)"),
        minPrice: z.number().optional().describe("Min price USD"),
        maxPrice: z.number().optional().describe("Max price USD"),
        minBeds: z.number().optional().describe("Min bedrooms"),
        type: z.enum(["residential", "condominium", "rental"]).optional().describe("Property type"),
        limit: z.number().optional().default(20).describe("Max results"),
        // Athena injects this when PDFs are attached; unused here, but it must be
        // declared or the tool call fails schema validation
        _athenaAttachments: z.array(z.any()).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        // Newer Apps SDK names this ui.resourceUri and treats outputTemplate as
        // a compatibility alias; advertise both so either host contract matches
        ui: { resourceUri: WIDGET_URI },
        "openai/toolInvocation/invoking": "Searching properties",
        "openai/toolInvocation/invoked": "Found properties",
      },
    },
    async (args) => {
      try {
        const properties = await fetchProperties(args);
        return {
          content: [{ type: "text", text: `Found ${properties.length} properties.` }],
          structuredContent: { properties },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          structuredContent: { properties: [] },
          isError: true,
        };
      }
    }
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) { res.writeHead(400).end("Missing URL"); return; }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("Property Explorer MCP server");
    return;
  }

  // Diagnostic: shows which MCP methods the host actually called, newest first.
  // Answers "did Athena ever ask for the widget resource?"
  if (req.method === "GET" && url.pathname === "/log") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ calls: callLog.slice().reverse() }, null, 2));
    return;
  }

  // Standalone widget page - fetches live data and renders interactive widget
  if (req.method === "GET" && url.pathname === "/widget") {
    try {
      const properties = await fetchProperties({
        city: url.searchParams.get("city") || undefined,
        minPrice: url.searchParams.get("minPrice") ? Number(url.searchParams.get("minPrice")) : undefined,
        maxPrice: url.searchParams.get("maxPrice") ? Number(url.searchParams.get("maxPrice")) : undefined,
        minBeds: url.searchParams.get("minBeds") ? Number(url.searchParams.get("minBeds")) : undefined,
        type: url.searchParams.get("type") || undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 20,
      });
      const dataScript = `<script>window.openai = { toolOutput: { properties: ${JSON.stringify(properties)} } };</script>`;
      const fullHtml = propertyWidgetHtml.replace('<head>', `<head>\n${dataScript}`);
      res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
      res.end(fullHtml);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(`<h1>Error: ${err.message}</h1>`);
    }
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    // Read the body ourselves so we can record which JSON-RPC method the host
    // asked for, then hand the parsed body to the transport
    let parsedBody;
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      try { parsedBody = JSON.parse(raw); } catch { /* leave undefined */ }
    }
    recordCall(req.method, parsedBody);

    const server = createPropertyServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }
  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Property Explorer MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
