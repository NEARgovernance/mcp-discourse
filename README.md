# Remote MCP Server for Discourse Agents

### Usage

> https://disco.multidaomensional.workers.dev/sse

Add the server URL to your MCP client.

## Tools

- `get_latest_topics` - View recent forum topics
- `search_posts` - Browse all topics and posts
- `get_topic` - Get a specific discussion thread
- `get_recent_posts` - Get latest posts across topics
- _more coming soon_

## Stack

- [Cloudflare Workers + Durable Objects](https://developers.cloudflare.com/workers)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Discourse APIs](https://docs.discourse.org)

## Deploy

```bash
npm install
wrangler secret put DISCOURSE_API_URL
wrangler secret put DISCOURSE_API_KEY
wrangler secret put DISCOURSE_API_USERNAME
wrangler deploy
```

## License

MIT
