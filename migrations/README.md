# Hibana Database Migrations 🗄️

This directory contains SQL migration scripts for Hibana's Cloudflare D1 database.

## 📋 Migration Files

| File | Description | Status |
|------|-------------|--------|
| `001_initial_schema.sql` | Creates all 11 tables and indexes | ✅ Ready |
| `002_seed_default_data.sql` | Default roles, settings, and test data | ✅ Ready |

## 🚀 Quick Start

### 1. Create D1 Database

```bash
# Create production database
wrangler d1 create hibana-prod

# Create development database (recommended for testing)
wrangler d1 create hibana-dev
```

Update your `wrangler.toml` with the database binding:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hibana-dev"
database_id = "your-database-id-here"
```

### 2. Run Migrations

#### Apply All Migrations

```bash
# Development
wrangler d1 execute hibana-dev --file=migrations/001_initial_schema.sql
wrangler d1 execute hibana-dev --file=migrations/002_seed_default_data.sql

# Production (⚠️ IMPORTANT: Remove test data from 002 first!)
wrangler d1 execute hibana-prod --file=migrations/001_initial_schema.sql
wrangler d1 execute hibana-prod --file=migrations/002_seed_default_data.sql
```

#### Apply Single Migration

```bash
wrangler d1 execute hibana-dev --file=migrations/001_initial_schema.sql
```

### 3. Verify Migrations

```bash
# List all tables
wrangler d1 execute hibana-dev --command="SELECT name FROM sqlite_master WHERE type='table';"

# Check table structure
wrangler d1 execute hibana-dev --command="PRAGMA table_info(users);"

# Count records
wrangler d1 execute hibana-dev --command="SELECT COUNT(*) FROM users;"
```

## 📊 Database Schema

### Tables Created (11 total)

1. **users** - User accounts with OIDC standard claims
2. **user_custom_fields** - Searchable custom user attributes
3. **passkeys** - WebAuthn/Passkey credentials
4. **oauth_clients** - OAuth 2.0/OIDC clients (RFC 7591)
5. **sessions** - User sessions for ITP-compatible SSO
6. **roles** - RBAC role definitions
7. **user_roles** - User-to-role assignments (N:M)
8. **scope_mappings** - Custom scope-to-claim mappings
9. **branding_settings** - UI customization settings
10. **identity_providers** - External auth providers (SAML/LDAP)
11. **audit_log** - System audit trail

### Indexes Created (20 total)

Optimized for common queries:
- User lookup by email, creation date
- Session lookup by user, expiration
- Audit log filtering by user, action, resource
- Custom field search

Full schema documentation: [docs/architecture/database-schema.md](../docs/architecture/database-schema.md)

## 🔑 Default Data

### Roles (4)

| Role | Name | Permissions |
|------|------|-------------|
| Super Admin | `super_admin` | Full system access (`*`) |
| Admin | `admin` | Users, clients, sessions management |
| Viewer | `viewer` | Read-only access |
| Support | `support` | User support operations |

### Test Users (Development Only)

⚠️ **IMPORTANT**: Remove test users before production deployment!

| Email | Role | Purpose |
|-------|------|---------|
| `admin@test.hibana.dev` | Super Admin | Testing admin features |
| `user@test.hibana.dev` | None | Testing regular user flows |
| `support@test.hibana.dev` | Support | Testing support operations |

**Default password**: None (use Passkey or Magic Link)

### Test OAuth Clients (Development Only)

| Client ID | Type | Redirect URIs |
|-----------|------|---------------|
| `test_client_app` | Confidential | `http://localhost:3000/callback` |
| `test_spa_app` | Public (SPA) | `http://localhost:5173/callback` |

**Client Secret** (test_client_app): `test_secret` (change in production!)

## 🔄 Migration Best Practices

### Before Running Migrations

1. **Backup existing data** (if any)
   ```bash
   wrangler d1 backup create hibana-prod
   ```

2. **Test in development first**
   ```bash
   wrangler d1 execute hibana-dev --file=migrations/001_initial_schema.sql
   ```

3. **Review migration output** for errors

### Production Deployment

1. **Remove test data** from `002_seed_default_data.sql`
   - Delete all `INSERT` statements under "Test Data" section
   - Keep default roles, branding settings, and scope mappings

2. **Use secure secrets**
   - Generate strong client secrets
   - Use environment variables for sensitive data

3. **Run migrations during maintenance window**
   - Minimal traffic
   - Prepare rollback plan

### Adding New Migrations

1. Create new file: `003_your_migration_name.sql`
2. Document changes in this README
3. Test locally first
4. Apply to staging, then production

## 🛠️ Troubleshooting

### Migration Failed

```bash
# Check D1 status
wrangler d1 info hibana-dev

# View recent errors (if available)
wrangler d1 execute hibana-dev --command="SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 10;"
```

### Table Already Exists

```bash
# Drop all tables (⚠️ DESTRUCTIVE - Development only!)
wrangler d1 execute hibana-dev --command="DROP TABLE IF EXISTS users;"
wrangler d1 execute hibana-dev --command="DROP TABLE IF EXISTS user_custom_fields;"
# ... repeat for all tables

# Re-run migrations
wrangler d1 execute hibana-dev --file=migrations/001_initial_schema.sql
```

### Reset Development Database

```bash
# Delete and recreate
wrangler d1 delete hibana-dev
wrangler d1 create hibana-dev

# Re-run all migrations
wrangler d1 execute hibana-dev --file=migrations/001_initial_schema.sql
wrangler d1 execute hibana-dev --file=migrations/002_seed_default_data.sql
```

## 🔐 Security Considerations

### Sensitive Data

- **Client Secrets**: Always hash with bcrypt (cost factor 10+)
- **Personal Data**: Ensure GDPR compliance (cascade deletes configured)
- **Audit Logs**: Retain for 90 days, then archive or delete

### Access Control

- Migrations require Cloudflare account access
- Use Wrangler authentication
- Never commit database credentials to Git

### Data Privacy

- `users.custom_attributes_json`: Store non-searchable data
- `user_custom_fields`: Only for searchable fields
- Audit log anonymization on user deletion

## 📚 Related Documentation

- [Database Schema ER Diagram](../docs/architecture/database-schema.md)
- [API Specification](../docs/api/openapi.yaml)
- [Phase 5 Planning](../docs/project-management/PHASE5_PLANNING.md)

## 🔄 Version History

| Version | Date | Description |
|---------|------|-------------|
| 001 | 2025-11-13 | Initial schema (11 tables, 20 indexes) |
| 002 | 2025-11-13 | Default data (roles, settings, test data) |

---

**Need help?** See [DEVELOPMENT.md](../DEVELOPMENT.md) or [docs/architecture/database-schema.md](../docs/architecture/database-schema.md)
