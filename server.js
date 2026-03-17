import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const widgetHtml = readFileSync("public/property-widget.html", "utf8");

const MCP_PATH = "/mcp";
const PORT = Number(process.env.PORT ?? 8787);

// SimplyRETS demo API
const RETS_BASE = "https://api.simplyrets.com";
const RETS_AUTH = "Basic " + Buffer.from("simplyrets:simplyrets").toString("base64");

// In-memory store for widget data (keyed by search ID)
const searchResults = new Map();

async function fetchProperties({ city, minPrice, maxPrice, minBeds, type, limit }) {
  const params = new URLSearchParams();
  if (city) params.set("q", city);
  if (minPrice) params.set("minprice", String(minPrice));
  if (maxPrice) params.set("maxprice", String(maxPrice));
  if (minBeds) params.set("minbeds", String(minBeds));
  if (type) params.set("type", type);
  params.set("limit", String(limit || 20));

  const url = `${RETS_BASE}/properties?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: RETS_AUTH, Accept: "application/json" },
  });

  if (!res.ok) throw new Error(`SimplyRETS API error: ${res.status}`);
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

function formatPrice(price) {
  if (price >= 1000000) return "$" + (price / 1000000).toFixed(1) + "M";
  if (price >= 1000) return "$" + (price / 1000).toFixed(0) + "K";
  return "$" + price;
}

// Session store for MCP
const sessions = new Map();

function createPropertyServer(baseUrl) {
  const server = new McpServer({ name: "property-explorer", version: "1.0.0" });

  // Register widget resource
  server.resource(
    "property-widget",
    "ui://widget/property.html",
    { mimeType: "text/html+skybridge" },
    async () => ({
      contents: [{
        uri: "ui://widget/property.html",
        mimeType: "text/html+skybridge",
        text: widgetHtml,
        _meta: { "openai/widgetPrefersBorder": true },
      }],
    })
  );

  // Search properties tool
  server.registerTool(
    "search_properties",
    {
      title: "Search Property Listings",
      description: "Search real estate property listings by location, price range, bedrooms, and property type. Use this when the user wants to explore, find, or browse property listings.",
      inputSchema: {
        city: z.string().optional().describe("City name to search in (e.g., Houston, Dallas)"),
        minPrice: z.number().optional().describe("Minimum listing price in USD"),
        maxPrice: z.number().optional().describe("Maximum listing price in USD"),
        minBeds: z.number().optional().describe("Minimum number of bedrooms"),
        type: z.enum(["residential", "condominium", "rental"]).optional().describe("Property type filter"),
        limit: z.number().optional().default(20).describe("Max results to return (default 20)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: "ui://widget/property.html" },
        "openai/outputTemplate": "ui://widget/property.html",
        "openai/toolInvocation/invoking": "Searching property listings...",
        "openai/toolInvocation/invoked": "Found property listings",
      },
    },
    async (args) => {
      try {
        const properties = await fetchProperties({
          city: args.city,
          minPrice: args.minPrice,
          maxPrice: args.maxPrice,
          minBeds: args.minBeds,
          type: args.type,
          limit: args.limit,
        });

        // Store results for the widget page
        const searchId = randomUUID();
        searchResults.set(searchId, properties);

        // Clean old results (keep last 100)
        if (searchResults.size > 100) {
          const firstKey = searchResults.keys().next().value;
          searchResults.delete(firstKey);
        }

        const widgetUrl = `${baseUrl}/widget/${searchId}`;
        const summary = `Found ${properties.length} properties${args.city ? ` in ${args.city}` : ""}. Prices range from ${formatPrice(Math.min(...properties.map((p) => p.price)))} to ${formatPrice(Math.max(...properties.map((p) => p.price)))}.`;

        return {
          content: [
            { type: "text", text: `${summary}\n\nView interactive explorer: ${widgetUrl}` },
          ],
          structuredContent: { properties, widgetUrl },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching listings: ${err.message}` }],
        };
      }
    }
  );

  return server;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, accept",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const baseUrl = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Property Explorer MCP Server is running");
    return;
  }

  // Widget page - serves the interactive widget with embedded data
  if (req.method === "GET" && url.pathname.startsWith("/widget/")) {
    const searchId = url.pathname.split("/widget/")[1];
    const properties = searchResults.get(searchId);

    if (!properties) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>Search expired. Please search again.</h1>");
      return;
    }

    // Inject data into widget HTML
    const dataScript = `<script>window.__PROPERTY_DATA__ = ${JSON.stringify({ properties })};</script>`;
    const fullHtml = widgetHtml.replace('<body>', `<body>\n${dataScript}`);

    res.writeHead(200, {
      "Content-Type": "text/html",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(fullHtml);
    return;
  }

  // API endpoint - returns search results as JSON
  if (req.method === "GET" && url.pathname === "/api/search") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    try {
      const properties = await fetchProperties({
        city: url.searchParams.get("city") || undefined,
        minPrice: url.searchParams.get("minPrice") ? Number(url.searchParams.get("minPrice")) : undefined,
        maxPrice: url.searchParams.get("maxPrice") ? Number(url.searchParams.get("maxPrice")) : undefined,
        minBeds: url.searchParams.get("minBeds") ? Number(url.searchParams.get("minBeds")) : undefined,
        type: url.searchParams.get("type") || undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 20,
      });
      res.writeHead(200);
      res.end(JSON.stringify({ properties }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // MCP endpoint
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end("Not Found");
    return;
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  const sessionId = req.headers["mcp-session-id"];

  if (req.method === "POST") {
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("Session error:", error);
        if (!res.headersSent) res.writeHead(500).end("Internal server error");
      }
      return;
    }

    const server = createPropertyServer(baseUrl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      server.close().catch(() => {});
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
      if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
      }
    } catch (error) {
      console.error("New session error:", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  if (req.method === "GET") {
    if (sessionId && sessions.has(sessionId)) {
      try {
        await sessions.get(sessionId).handleRequest(req, res);
      } catch (error) {
        if (!res.headersSent) res.writeHead(500).end("Error");
      }
    } else {
      res.writeHead(400).end("No valid session");
    }
    return;
  }

  if (req.method === "DELETE") {
    if (sessionId && sessions.has(sessionId)) {
      try {
        await sessions.get(sessionId).handleRequest(req, res);
      } catch (error) {}
      sessions.delete(sessionId);
    } else {
      res.writeHead(200).end();
    }
    return;
  }

  res.writeHead(405).end("Method not allowed");
});

httpServer.listen(PORT, () => {
  console.log(`Property Explorer MCP server running at http://localhost:${PORT}${MCP_PATH}`);
});
