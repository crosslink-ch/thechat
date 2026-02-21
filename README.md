# TheChat

## Development

### PostgreSQL

Create `packages/api/.env`:

```
DATABASE_URL=postgresql://user:password@localhost:5432/thechat
```

Start a fresh PostgreSQL container and push the schema:

```bash
./scripts/restart-db.sh
```

This removes any existing `thechat-postgres` container and volume, starts a new PostgreSQL 17 instance, and runs `pnpm db:push`.
