import { Elysia } from "elysia";
import { yoga } from "@elysiajs/graphql-yoga";

const app = new Elysia()
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
  .listen(3000);

console.log(`TheChat API running at http://localhost:${app.server!.port}`);
console.log(`GraphQL playground at http://localhost:${app.server!.port}/graphql`);
