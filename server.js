import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";

const propertyWidgetHtml = readFileSync("public/property-widget.html", "utf8");

// SimplyRETS demo API
const RETS_BASE = "https://api.simplyrets.com";
const RETS_AUTH = "Basic " + Buffer.from("simplyrets:simplyrets").toString("base64");

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

  return data.map((p) => ({
    mlsId: p.mlsId,
    price: p.listPrice || 0,
    address: p.address?.full || "Unknown",
    city: p.address?.city || "",
    state: p.address?.state || "",
    zip: p.address?.postalCode || "",
    bedrooms: p.property?.bedrooms || 0,
    bathrooms: p.property?.bathsFull || 0,
    sqft: p.property?.area || 0,
    type: p.property?.type || "",
    yearBuilt: p.property?.yearBuilt || null,
    lotSize: p.property?.lotSize || null,
    description: p.remarks || "",
    photo: p.photos?.[0] || null,
    listingType: p.leaseTerm ? "Lease" : "Sale",
  }));
}

let cachedProperties = [];

const replyWithProperties = (message) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { properties: cachedProperties },
});

function createPropertyServer() {
  const server = new McpServer({ name: "property-explorer", version: "0.1.0" });

  server.registerResource(
    "property-widget",
    "ui://widget/property.html",
    {},
    async () => ({
      contents: [{
        uri: "ui://widget/property.html",
        mimeType: "text/html+skybridge",
        text: propertyWidgetHtml,
        _meta: { "openai/widgetPrefersBorder": true },
      }],
    })
  );

  server.registerTool(
    "search_properties",
    {
      title: "Search Properties",
      description: "Search real estate property listings by location, price range, bedrooms, and type.",
      inputSchema: {
        city: z.string().optional().describe("City name (e.g., Houston)"),
        minPrice: z.number().optional().describe("Min price USD"),
        maxPrice: z.number().optional().describe("Max price USD"),
        minBeds: z.number().optional().describe("Min bedrooms"),
        type: z.enum(["residential", "condominium", "rental"]).optional().describe("Property type"),
        limit: z.number().optional().default(20).describe("Max results"),
      },
      _meta: {
        "openai/outputTemplate": "ui://widget/property.html",
        "openai/toolInvocation/invoking": "Searching properties",
        "openai/toolInvocation/invoked": "Found properties",
      },
    },
    async (args) => {
      try {
        cachedProperties = await fetchProperties(args);
        return replyWithProperties(`Found ${cachedProperties.length} properties.`);
      } catch (err) {
        return replyWithProperties(`Error: ${err.message}`);
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
    const server = createPropertyServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
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
