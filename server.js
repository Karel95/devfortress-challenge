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

// Session store
const sessions = new Map();

function createPropertyServer() {
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
        _meta: {
          "openai/widgetPrefersBorder": true,
        },
      }],
    })
  );

  // Search properties tool - use registerTool to ensure _meta is passed
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

        const summary = `Found ${properties.length} properties${args.city ? ` in ${args.city}` : ""}. Prices range from ${formatPrice(Math.min(...properties.map((p) => p.price)))} to ${formatPrice(Math.max(...properties.map((p) => p.price)))}.`;

        return {
          content: [],
          structuredContent: { properties },
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

  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end("Not Found");
    return;
  }

  // Set CORS on all MCP responses
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  const sessionId = req.headers["mcp-session-id"];

  if (req.method === "POST") {
    // Check for existing session
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("Session request error:", error);
        if (!res.headersSent) res.writeHead(500).end("Internal server error");
      }
      return;
    }

    // New session - create server + transport
    const server = createPropertyServer();
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
      // Store session after successful initialization
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
    // SSE stream for notifications
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("SSE error:", error);
        if (!res.headersSent) res.writeHead(500).end("Internal server error");
      }
    } else {
      res.writeHead(400).end("No valid session");
    }
    return;
  }

  if (req.method === "DELETE") {
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("Delete error:", error);
      }
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
