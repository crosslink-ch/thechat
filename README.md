# TheChat

## Development

### PostgreSQL

Start a PostgreSQL 17 instance with Docker:

```bash
docker run -d --name thechat-postgres -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password -e POSTGRES_DB=thechat -p 5432:5432 postgres:17
```

Then create `packages/api/.env`:

```
DATABASE_URL=postgresql://user:password@localhost:5432/thechat
```

Push the schema to the database:

```bash
pnpm db:push
```
