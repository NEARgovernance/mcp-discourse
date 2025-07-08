import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Environment interface
interface Env {
  DISCOURSE_API_URL: string;
  DISCOURSE_API_KEY: string;
  DISCOURSE_API_USERNAME: string;
}

// State interface for persistent data
interface State {
  requestCount: number;
  lastRequestTime?: number;
  cachedTopics?: any[];
  cacheExpiry?: number;
}

export class MyMCP extends McpAgent<Env, State> {
  server = new McpServer({
    name: "discourse-mcp",
    version: "1.0.0",
  });

  // Initial state
  initialState: State = {
    requestCount: 0,
  };

  async init() {
    if (
      !this.env.DISCOURSE_API_URL ||
      !this.env.DISCOURSE_API_KEY ||
      !this.env.DISCOURSE_API_USERNAME
    ) {
      throw new Error("Missing required environment variable");
    }

    // Helper function for API requests
    const makeDiscourseRequest = async (
      endpoint: string,
      options: RequestInit = {}
    ): Promise<any> => {
      const url = `${this.env.DISCOURSE_API_URL}${endpoint}`;
      const headers = {
        "Api-Key": this.env.DISCOURSE_API_KEY,
        "Api-Username": this.env.DISCOURSE_API_USERNAME,
        "Content-Type": "application/json",
        ...options.headers,
      };

      // Update request count
      this.setState({
        ...this.state,
        requestCount: this.state.requestCount + 1,
        lastRequestTime: Date.now(),
      });

      const response = await fetch(url, { ...options, headers });

      if (!response.ok) {
        throw new Error(
          `Discourse API error: ${response.status} ${response.statusText}`
        );
      }

      return response.json();
    };

    // Resource: statistics
    this.server.resource("request-stats", "mcp://discourse/stats", (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(
            {
              requestCount: this.state.requestCount,
              lastRequestTime: this.state.lastRequestTime,
              cacheStatus: this.state.cacheExpiry
                ? Date.now() < this.state.cacheExpiry
                  ? "valid"
                  : "expired"
                : "empty",
            },
            null,
            2
          ),
        },
      ],
    }));

    // Tool: Get latest topics
    this.server.tool(
      "get_latest_topics",
      "Get the latest topics from the NEAR Vote community forum",
      {
        per_page: z.coerce
          .number()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Number of topics to return (1-50)"),
        use_cache: z.coerce
          .boolean()
          .optional()
          .default(true)
          .describe("Use cached results if available (5 min cache)"),
        order: z
          .enum([
            "default",
            "created",
            "activity",
            "views",
            "posts",
            "category",
            "likes",
          ])
          .optional()
          .describe("Sort order"),
      },
      async ({ per_page, use_cache, order }) => {
        try {
          // Check cache
          const cacheValid =
            this.state.cacheExpiry && Date.now() < this.state.cacheExpiry;
          if (use_cache && cacheValid && this.state.cachedTopics) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      cached: true,
                      topics: this.state.cachedTopics,
                      total_topics: this.state.cachedTopics.length,
                      request_count: this.state.requestCount,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          // Build query parameters
          const params = new URLSearchParams();
          if (per_page) params.append("per_page", per_page.toString());
          if (order) params.append("order", order);

          const endpoint = `/latest.json${
            params.toString() ? `?${params.toString()}` : ""
          }`;
          const result = await makeDiscourseRequest(endpoint);

          // Cache the results for 5 minutes
          const topics = result.topic_list?.topics || [];
          this.setState({
            ...this.state,
            cachedTopics: topics,
            cacheExpiry: Date.now() + 5 * 60 * 1000,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    cached: false,
                    topics: topics.map((topic: any) => ({
                      id: topic.id,
                      title: topic.title,
                      posts_count: topic.posts_count,
                      views: topic.views,
                      like_count: topic.like_count,
                      created_at: topic.created_at,
                      last_posted_at: topic.last_posted_at,
                      category_id: topic.category_id,
                      slug: topic.slug,
                      excerpt: topic.excerpt,
                    })),
                    total_topics: topics.length,
                    request_count: this.state.requestCount,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching latest topics: ${
                  (error as Error).message
                }`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    // Tool: Search posts
    this.server.tool(
      "search_posts",
      "Search for posts and topics of the NEAR governance forum. Leave query empty to browse recent posts.",
      {
        query: z
          .string()
          .optional()
          .default("")
          .describe("Search query (leave empty to browse all recent posts)"),
        max_results: z.coerce
          .number()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe("Maximum number of results (1-100)"),
      },
      async ({ query, max_results }) => {
        try {
          let result;

          if (!query || query.trim() === "") {
            result = await makeDiscourseRequest("/posts.json");

            const posts = (result.latest_posts || [])
              .slice(0, max_results)
              .map((post: any) => ({
                id: post.id,
                post_number: post.post_number,
                excerpt:
                  post.cooked?.replace(/<[^>]*>/g, "").substring(0, 200) ||
                  "No content",
                username: post.username,
                topic_title: post.topic_title,
                topic_id: post.topic_id,
                topic_slug: post.topic_slug,
                created_at: post.created_at,
                post_url: `${this.env.DISCOURSE_API_URL}/t/${post.topic_slug}/${post.topic_id}/${post.post_number}`,
              }));

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      query: "recent posts (no search query)",
                      posts,
                      total_results: posts.length,
                      showing: posts.length,
                      request_count: this.state.requestCount,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          const params = new URLSearchParams();
          params.append("q", query);

          result = await makeDiscourseRequest(
            `/search.json?${params.toString()}`
          );

          if (!result?.posts || result.posts.length < 1) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      query,
                      posts: [],
                      total_results: 0,
                      request_count: this.state.requestCount,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          const posts = result.posts.slice(0, max_results).map((post: any) => ({
            id: post.id,
            post_number: post.post_number,
            excerpt: post.blurb,
            username: post.username,
            topic_title: post.topic_title,
            topic_id: post.topic_id,
            topic_slug: post.topic_slug,
            created_at: post.created_at,
            post_url: `${this.env.DISCOURSE_API_URL}/t/${post.topic_slug}/${post.topic_id}/${post.post_number}`,
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    query,
                    posts,
                    total_results: result.posts.length,
                    showing: posts.length,
                    request_count: this.state.requestCount,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error searching posts: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    // Tool: Get specific topic
    this.server.tool(
      "get_topic",
      "Get a specific topic with its posts from the NEAR Vote forum",
      {
        id: z.coerce.string().describe("Topic ID"),
        include_posts: z.coerce
          .boolean()
          .optional()
          .default(true)
          .describe("Include first few posts"),
      },
      async ({ id, include_posts }) => {
        try {
          const result = await makeDiscourseRequest(`/t/${id}.json`);

          const topicData = {
            id: result.id,
            title: result.title,
            posts_count: result.posts_count,
            views: result.views,
            like_count: result.like_count,
            created_at: result.created_at,
            category_id: result.category_id,
            slug: result.slug,
            url: `${this.env.DISCOURSE_API_URL}/t/${result.slug}/${result.id}`,
            request_count: this.state.requestCount,
          };

          if (include_posts && result.post_stream?.posts) {
            const posts = result.post_stream.posts
              .slice(0, 5)
              .map((post: any) => ({
                id: post.id,
                post_number: post.post_number,
                username: post.username,
                created_at: post.created_at,
                excerpt:
                  post.cooked?.replace(/<[^>]*>/g, "").substring(0, 200) +
                  "...",
                like_count:
                  post.actions_summary?.find((a: any) => a.id === 2)?.count ||
                  0,
              }));

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ topic: topicData, posts }, null, 2),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ topic: topicData }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching topic ${id}: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    // Tool: Get recent posts
    this.server.tool(
      "get_recent_posts",
      "Get recent posts across all topics in the NEAR Vote forum",
      {
        before: z
          .string()
          .optional()
          .describe("Load posts with ID lower than this (pagination)"),
        limit: z.coerce
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Number of posts to return"),
      },
      async ({ before, limit }) => {
        try {
          let endpoint = "/posts.json";
          if (before) {
            endpoint += `?before=${before}`;
          }

          const result = await makeDiscourseRequest(endpoint);
          const posts = (result.latest_posts || [])
            .slice(0, limit)
            .map((post: any) => ({
              id: post.id,
              post_number: post.post_number,
              username: post.username,
              topic_title: post.topic_title,
              topic_slug: post.topic_slug,
              topic_id: post.topic_id,
              created_at: post.created_at,
              excerpt:
                post.cooked?.replace(/<[^>]*>/g, "").substring(0, 150) + "...",
              post_url: `${this.env.DISCOURSE_API_URL}${post.post_url}`,
            }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    posts,
                    count: posts.length,
                    request_count: this.state.requestCount,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching recent posts: ${
                  (error as Error).message
                }`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  // State update handler
  onStateUpdate(state: State) {
    console.log("Discourse MCP State Update:", {
      requestCount: state.requestCount,
      lastRequestTime: state.lastRequestTime,
      hasCachedTopics: !!state.cachedTopics,
      cacheValid: state.cacheExpiry ? Date.now() < state.cacheExpiry : false,
    });
  }
}

// Export worker
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const { pathname } = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, mcp-protocol-version", // ← Added MCP header
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Add CORS headers to any response
    const addCORSHeaders = (response: Response): Response => {
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      newHeaders.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, mcp-protocol-version"
      ); // ← Added MCP header

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    };

    // Support SSE transport with CORS
    if (pathname.startsWith("/sse")) {
      const response = await MyMCP.serveSSE("/sse").fetch(request, env, ctx);
      return addCORSHeaders(response);
    }

    // Support HTTP transport with CORS
    if (pathname.startsWith("/mcp")) {
      const response = await MyMCP.serve("/mcp").fetch(request, env, ctx);
      return addCORSHeaders(response);
    }

    // Health check endpoint
    if (pathname === "/health") {
      return new Response(
        JSON.stringify({
          name: "discourse-mcp-server",
          status: "healthy",
          version: "1.0.0",
          description: "MCP server for NEAR Vote community forum",
          tools: [
            "get_latest_topics",
            "search_posts",
            "get_topic",
            "get_recent_posts",
          ],
          resources: ["request-stats"],
          endpoints: {
            sse: "/sse (Server-Sent Events)",
            mcp: "/mcp (Streamable HTTP)",
            health: "/health",
          },
          env_check: {
            discourse_url: !!env.DISCOURSE_API_URL,
            api_key: !!env.DISCOURSE_API_KEY,
            username: !!env.DISCOURSE_API_USERNAME,
          },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, mcp-protocol-version",
          },
        }
      );
    }

    // Root path goes to MCP
    if (pathname === "/") {
      const response = await MyMCP.serve("/").fetch(request, env, ctx);
      return addCORSHeaders(response);
    }

    return new Response("Not found", {
      status: 404,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, mcp-protocol-version",
      },
    });
  },
};
