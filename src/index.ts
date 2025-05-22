// src/index.ts
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Environment interface matching our wrangler.json setup
interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  AI: any;
}

// User authentication context passed to MCP agent
export type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
  githubId: string;
};

// Book preferences state stored per user
interface BookPreferences {
  userName: string;
  favoriteGenres: string[];
  booksRead: Array<{
    title: string;
    author: string;
    rating: number;
    dateAdded: string;
  }>;
  sessionStarted: string;
  interactionCount: number;
}

export class MyMCP extends McpAgent<Env, BookPreferences, Props> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    console.log(`📚 MyMCP DEBUG:
      - Props login: ${this.props?.login}
      - Props githubId: ${this.props?.githubId} 
      - Durable Object ID: ${state.id.toString()}
      - DO ID name: ${state.id.name || 'no name'}`);
  }

  // MCP server instance for this agent
  server = new McpServer({
    name: "Personal Book Recommendations",
    version: "1.0.0",
  });

  // Initial state when user first connects
  initialState: BookPreferences = {
    userName: "",
    favoriteGenres: [],
    booksRead: [],
    sessionStarted: new Date().toISOString(),
    interactionCount: 0,
  };

  async init() {
    // Initialize user name from authentication context
    const userName = this.props?.name || this.props?.login || "Book Lover";
    
    // Ensure state is properly initialized with defaults
    this.setState({
      userName,
      favoriteGenres: this.state?.favoriteGenres || [],
      booksRead: this.state?.booksRead || [],
      sessionStarted: this.state?.sessionStarted || new Date().toISOString(),
      interactionCount: (this.state?.interactionCount || 0),
    });

    console.log(`Book Preferences agent initialized for ${userName}`);

    // ================== MCP TOOLS ==================

    this.server.tool("getProfile", "View your current reading preferences and statistics", {}, async () => {
      // Ensure state arrays exist before accessing them
      const genres = this.state?.favoriteGenres || [];
      const books = this.state?.booksRead || [];
      const startTime = this.state?.sessionStarted || new Date().toISOString();
      const interactions = (this.state?.interactionCount || 0) + 1;
      
      this.setState({
        ...this.state,
        favoriteGenres: genres,
        booksRead: books,
        sessionStarted: startTime,
        interactionCount: interactions,
      });

      const sessionMinutes = Math.round((Date.now() - new Date(startTime).getTime()) / 1000 / 60);
      
      return {
        content: [
          {
            type: "text",
            text: `📚 **${this.state.userName}'s Reading Profile**

**Favorite Genres:** ${genres.join(", ") || "None yet - add some with addGenre!"}

**Books You've Rated:** ${books.length}
${books.slice(-3).map(book => 
  `• "${book.title}" by ${book.author} - ${"⭐".repeat(book.rating)} (${book.rating}/5)`
).join('\n')}

**Session Info:**
• Active for: ${sessionMinutes} minutes
• Interactions: ${interactions}
• GitHub User: ${this.props?.login || 'Anonymous'}

💡 *Use addGenre and rateBook tools to improve recommendations!*`,
          },
        ],
      };
    });

    this.server.tool(
      "addGenre",
      "Add a book genre you enjoy reading",
      {
        genre: z.string().describe("A book genre you like (e.g., 'science fiction', 'mystery', 'romance')"),
      },
      async ({ genre }) => {
        // Ensure state is properly initialized before accessing arrays
        const currentGenres = this.state?.favoriteGenres || [];
        
        this.setState({
          ...this.state,
          favoriteGenres: currentGenres,
          interactionCount: (this.state?.interactionCount || 0) + 1,
        });

        const normalizedGenre = genre.toLowerCase().trim();
        
        if (currentGenres.includes(normalizedGenre)) {
          return {
            content: [
              {
                type: "text",
                text: `"${genre}" is already in your favorites! 📚

Current genres: ${currentGenres.join(", ")}`,
              },
            ],
          };
        }
        
        const updatedGenres = [...currentGenres, normalizedGenre];
        
        this.setState({
          ...this.state,
          favoriteGenres: updatedGenres,
          interactionCount: (this.state?.interactionCount || 0) + 1,
        });
        
        const encouragement = updatedGenres.length === 1 
          ? "Great start! Add more genres to improve recommendations."
          : `Perfect! With ${updatedGenres.length} genres, I'm learning your taste.`;
        
        return {
          content: [
            {
              type: "text",
              text: `✅ Added "${genre}" to your favorites!

**Your favorite genres:** ${updatedGenres.join(", ")}

${encouragement}`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "rateBook",
      "Rate a book you've read to improve future recommendations",
      {
        title: z.string().describe("The book title"),
        author: z.string().describe("The book author"), 
        rating: z.number().min(1).max(5).describe("Your rating from 1 (didn't like) to 5 (loved it)"),
      },
      async ({ title, author, rating }) => {
        this.setState({
          ...this.state,
          interactionCount: this.state.interactionCount + 1,
        });

        const bookEntry = {
          title,
          author,
          rating,
          dateAdded: new Date().toISOString(),
        };
        
        this.setState({
          ...this.state,
          booksRead: [...this.state.booksRead, bookEntry],
        });
        
        const stars = "⭐".repeat(rating);
        const reaction = rating >= 4 ? "Great choice!" : rating >= 3 ? "Nice read!" : "Thanks for the honest rating!";
        
        return {
          content: [
            {
              type: "text",
              text: `📖 Rated "${title}" by ${author}

${stars} **${rating}/5** - ${reaction}

**Your reading history:** ${this.state.booksRead.length} books rated
${this.state.booksRead.slice(-3).map(book => 
  `• "${book.title}" - ${"⭐".repeat(book.rating)}`
).join('\n')}

💡 *The more books you rate, the better recommendations I can give!*`,
            },
          ],
        };
      }
    );

    this.server.tool(
      "getRecommendations", 
      "Get personalized book recommendations based on your preferences",
      {
        count: z.number().min(1).max(5).default(3).describe("Number of books to recommend (1-5)"),
      },
      async ({ count }) => {
        this.setState({
          ...this.state,
          interactionCount: this.state.interactionCount + 1,
        });

        // Build contextual prompt for AI recommendations
        let prompt = `Recommend ${count} books for ${this.state.userName}. `;
        
        if (this.state.favoriteGenres.length > 0) {
          prompt += `They enjoy these genres: ${this.state.favoriteGenres.join(", ")}. `;
        }
        
        if (this.state.booksRead.length > 0) {
          const recentBooks = this.state.booksRead.slice(-3).map(b => 
            `"${b.title}" by ${b.author} (rated ${b.rating}/5)`
          );
          prompt += `Recent reads: ${recentBooks.join(", ")}. `;
          
          const avgRating = this.state.booksRead.reduce((sum, b) => sum + b.rating, 0) / this.state.booksRead.length;
          prompt += `Average rating: ${avgRating.toFixed(1)}/5. `;
        }
        
        prompt += `Provide specific book recommendations with title, author, and brief explanation of why they'd enjoy it based on their preferences.`;
        
        try {
          // Use Cloudflare Workers AI for recommendations
          const response = await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
            prompt,
            max_tokens: 600,
          });
          
          // Show what context was used for transparency
          const contextUsed = [];
          if (this.state.favoriteGenres.length > 0) contextUsed.push(`${this.state.favoriteGenres.length} favorite genres`);
          if (this.state.booksRead.length > 0) contextUsed.push(`${this.state.booksRead.length} rated books`);
          
          const contextText = contextUsed.length > 0 
            ? `\n\n🎯 *Personalized based on: ${contextUsed.join(", ")}*`
            : "\n\n💡 *Add genres and rate books for more personalized recommendations!*";
          
          return {
            content: [
              {
                type: "text",
                text: `📚 **Personalized Recommendations for ${this.state.userName}:**

${response.response}${contextText}`,
              },
            ],
          };
        } catch (error) {
          console.error("AI recommendation error:", error);
          return {
            content: [
              {
                type: "text",
                text: `Sorry, I had trouble generating recommendations right now. Please try again in a moment.`,
              },
            ],
          };
        }
      }
    );

    console.log(`✅ Book Preferences MCP server ready with all tools initialized`);
  }

  // Called when user state changes - useful for logging and analytics
  onStateUpdate(state: BookPreferences) {
    console.log(`📊 ${state.userName}: ${state.favoriteGenres.length} genres, ${state.booksRead.length} books, ${state.interactionCount} interactions`);
  }
}

export default new OAuthProvider({
  // Protect the MCP SSE endpoint with OAuth
  apiRoute: '/sse',
  
  // Create API handler using MyMCP's mount method
  apiHandler: MyMCP.mount('/sse', {
    binding: 'MCP_OBJECT',
    corsOptions: {
      origin: "*",
      methods: "GET, POST, OPTIONS",
      headers: "Content-Type, Authorization",
      maxAge: 86400
    }
  }),
  
  // GitHub OAuth authentication handler
  defaultHandler: {
    fetch: async (request: Request, env: Env, ctx: any) => {
      const url = new URL(request.url);
      
      // Add a token info endpoint for sharing tokens across clients
      if (url.pathname === '/token-info' && request.method === 'GET') {
        // This endpoint is protected by OAuth and returns current user's token info
        try {
          const authHeader = request.headers.get('Authorization');
          if (!authHeader?.startsWith('Bearer ')) {
            return new Response('Unauthorized', { status: 401 });
          }
          
          const token = authHeader.slice(7);
          
          // Validate token with OAuth provider
          const tokenInfo = await env.OAUTH_PROVIDER.validateAccessToken?.(token);
          if (!tokenInfo) {
            return new Response('Invalid token', { status: 401 });
          }
          
          return new Response(JSON.stringify({
            token: token,
            user: tokenInfo.props,
            instructions: {
              mcp_url: `${url.origin}/sse`,
              usage: "Use this token in your MCP client's Authorization header as 'Bearer <token>'"
            }
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        } catch (error) {
          return new Response('Error retrieving token info', { status: 500 });
        }
      }
      
      // Route all other requests to GitHubHandler
      return GitHubHandler.fetch(request, env, ctx);
    }
  },
  
  // OAuth endpoints
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});