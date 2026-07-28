/**
 * OpenAPI 3.0 specification for the Stellar Royalty Splitter API (#587).
 *
 * Served at GET /api/docs (Swagger UI) and GET /api/docs/json (raw spec).
 */

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Stellar Royalty Splitter API",
    version: "1.0.0",
    description:
      "HTTP API for managing royalty distribution smart contracts on the Stellar/Soroban network.",
    contact: { url: "https://github.com/Just-Bamford/Stellar-Royalty-Splitter" },
  },
  servers: [
    { url: "/api/v1", description: "Current version (v1)" },
    { url: "/api", description: "Legacy (deprecated) — redirects to /api/v1 with HTTP 308" },
  ],
  tags: [
    { name: "Version", description: "API version discovery" },
    { name: "Health", description: "Operational health probes" },
    { name: "Contract", description: "Contract initialization and state" },
    { name: "Distribution", description: "Royalty distribution transactions" },
    { name: "Collaborators", description: "On-chain collaborator shares" },
    { name: "Analytics", description: "Earnings analytics and trends" },
    { name: "Ranking", description: "Contributor performance rankings (#586)" },
    { name: "History", description: "Transaction history and audit log" },
    { name: "Webhooks", description: "Distribution completion webhooks" },
    { name: "Admin", description: "Admin operations (requires auth)" },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "RBAC API key. Grants elevated rate limits and role-based access.",
      },
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Admin bearer token (ADMIN_ROTATE_TOKEN) for key-rotation and user management.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string", example: "not_found" },
          message: { type: "string", example: "Contract not found" },
        },
      },
      StellarAddress: {
        type: "string",
        pattern: "^G[A-Z2-7]{55}$",
        example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      },
      ContractId: {
        type: "string",
        pattern: "^C[A-Z2-7]{55}$",
        example: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      },
      TransactionResponse: {
        type: "object",
        properties: {
          xdr: { type: "string", description: "Base64-encoded unsigned transaction XDR" },
          transactionId: { type: "integer" },
        },
      },
      RankingEntry: {
        type: "object",
        properties: {
          rank: { type: "integer" },
          address: { $ref: "#/components/schemas/StellarAddress" },
          totalEarned: { type: "number" },
          payoutCount: { type: "integer" },
          avgPayout: { type: "number" },
        },
      },
    },
  },
  paths: {
    "/version": {
      get: {
        tags: ["Version"],
        summary: "API version discovery",
        description:
          "Returns the current API version, list of supported versions, deprecated versions, and a link to documentation. " +
          "Legacy routes under `/api/*` (without the version prefix) redirect permanently (HTTP 308) to `/api/v1/*` " +
          "and include `Deprecation: true` and `Link` headers pointing to the canonical versioned URL. " +
          "All `/api/v1/*` responses include an `X-API-Version: v1` header.",
        responses: {
          200: {
            description: "Version information",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    data: {
                      type: "object",
                      properties: {
                        current: { type: "string", example: "v1" },
                        supported: { type: "array", items: { type: "string" }, example: ["v1"] },
                        deprecated: { type: "array", items: { type: "string" }, example: [] },
                        sunset: { type: "string", nullable: true, example: null },
                        documentation: { type: "string", example: "/api/docs" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        description: "Returns backend and Stellar connectivity status. Cached for 30 s.",
        responses: {
          200: {
            description: "Service healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    dbVersion: { type: "integer" },
                    network: { type: "string", example: "Testnet" },
                    horizon: {
                      type: "object",
                      properties: {
                        connected: { type: "boolean" },
                        url: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/initialize": {
      post: {
        tags: ["Contract"],
        summary: "Build initialize transaction XDR",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "walletAddress", "collaborators", "shares"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  collaborators: {
                    type: "array",
                    items: { $ref: "#/components/schemas/StellarAddress" },
                    minItems: 1,
                    maxItems: 20,
                  },
                  shares: {
                    type: "array",
                    items: { type: "integer", minimum: 0, maximum: 10000 },
                    description: "Basis points per collaborator (must sum to 10000)",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "XDR built", content: { "application/json": { schema: { $ref: "#/components/schemas/TransactionResponse" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          413: { description: "Payload too large" },
        },
      },
    },
    "/distribute": {
      post: {
        tags: ["Distribution"],
        summary: "Build distribute transaction XDR",
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            schema: { type: "string", maxLength: 255 },
            description: "Prevent duplicate submissions within 24 h",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "walletAddress", "tokenId"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  walletAddress: { $ref: "#/components/schemas/StellarAddress" },
                  tokenId: { $ref: "#/components/schemas/ContractId" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "XDR built", content: { "application/json": { schema: { $ref: "#/components/schemas/TransactionResponse" } } } },
          400: { description: "Validation error" },
          409: { description: "Idempotency key conflict" },
        },
      },
    },
    "/collaborators/{contractId}": {
      get: {
        tags: ["Collaborators"],
        summary: "Get on-chain collaborator shares",
        parameters: [{ in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } }],
        responses: {
          200: {
            description: "Collaborator list",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      address: { $ref: "#/components/schemas/StellarAddress" },
                      basisPoints: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/analytics/{contractId}": {
      get: {
        tags: ["Analytics"],
        summary: "Get earnings analytics for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "start", schema: { type: "string", format: "date" }, description: "Start date (YYYY-MM-DD, default: 90 days ago)" },
          { in: "query", name: "end", schema: { type: "string", format: "date" }, description: "End date (YYYY-MM-DD, default: today)" },
        ],
        responses: {
          200: {
            description: "Analytics data",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    summary: {
                      type: "object",
                      properties: {
                        totalTransactions: { type: "integer" },
                        totalDistributed: { type: "number" },
                        averagePayout: { type: "number" },
                      },
                    },
                    trends: { type: "array", items: { type: "object" } },
                    topEarners: { type: "array", items: { $ref: "#/components/schemas/RankingEntry" } },
                    collaboratorStats: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/ranking": {
      get: {
        tags: ["Ranking"],
        summary: "Global contributor performance ranking",
        description: "Ranks contributors by earnings across all contracts.",
        parameters: [
          { in: "query", name: "metric", schema: { type: "string", enum: ["totalEarned", "payoutCount", "avgPayout"] }, description: "Ranking metric (default: totalEarned)" },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 }, description: "Number of results (default: 10)" },
          { in: "query", name: "start", schema: { type: "string", format: "date" } },
          { in: "query", name: "end", schema: { type: "string", format: "date" } },
        ],
        responses: {
          200: {
            description: "Global rankings",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    scope: { type: "string", example: "global" },
                    metric: { type: "string" },
                    period: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } },
                    rankings: { type: "array", items: { $ref: "#/components/schemas/RankingEntry" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/ranking/{contractId}": {
      get: {
        tags: ["Ranking"],
        summary: "Contract-scoped contributor performance ranking",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "metric", schema: { type: "string", enum: ["totalEarned", "payoutCount", "avgPayout"] } },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { in: "query", name: "start", schema: { type: "string", format: "date" } },
          { in: "query", name: "end", schema: { type: "string", format: "date" } },
        ],
        responses: {
          200: {
            description: "Contract rankings",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    contractId: { $ref: "#/components/schemas/ContractId" },
                    metric: { type: "string" },
                    period: { type: "object" },
                    rankings: { type: "array", items: { $ref: "#/components/schemas/RankingEntry" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/history/{contractId}": {
      get: {
        tags: ["History"],
        summary: "Transaction history for a contract",
        parameters: [
          { in: "path", name: "contractId", required: true, schema: { $ref: "#/components/schemas/ContractId" } },
          { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
        ],
        responses: { 200: { description: "Transaction list" } },
      },
    },
    "/webhooks": {
      post: {
        tags: ["Webhooks"],
        summary: "Register a webhook",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["contractId", "url"],
                properties: {
                  contractId: { $ref: "#/components/schemas/ContractId" },
                  url: { type: "string", format: "uri" },
                },
              },
            },
          },
        },
        responses: { 201: { description: "Webhook registered" } },
      },
    },
  },
};
