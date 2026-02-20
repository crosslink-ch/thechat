import { Elysia } from "elysia";
import { yoga } from "@elysiajs/graphql-yoga";
import { sql } from "drizzle-orm";
import { db } from "./db";

const app = new Elysia()
  .decorate("db", db)
  .use(
    yoga({
      typeDefs: /* GraphQL */ `
        type Query {
          hello: String!
        }
      `,
      resolvers: {
        Query: {
          hello: () => "Hello from TheChat API",
        },
      },
    })
  )
  .get("/", () => "TheChat API - visit /graphql for GraphQL playground")
  .get("/health", async ({ db }) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { status: "ok", db: "connected" };
    } catch (e) {
      return Response.json(
        { status: "error", db: "disconnected" },
        { status: 503 }
      );
    }
  })
  .listen(3000);

console.log(`TheChat API running at http://localhost:${app.server!.port}`);
console.log(`GraphQL playground at http://localhost:${app.server!.port}/graphql`);
