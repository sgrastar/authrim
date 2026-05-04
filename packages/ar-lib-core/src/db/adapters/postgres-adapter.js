function toPostgresSql(sql) {
    let index = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;
    let result = '';
    for (let i = 0; i < sql.length; i += 1) {
        const char = sql[i];
        const next = sql[i + 1];
        if (!inSingleQuote && !inDoubleQuote && !inBlockComment && char === '-' && next === '-') {
            inLineComment = true;
        }
        else if (inLineComment && char === '\n') {
            inLineComment = false;
        }
        else if (!inSingleQuote && !inDoubleQuote && !inLineComment && char === '/' && next === '*') {
            inBlockComment = true;
        }
        else if (inBlockComment && char === '*' && next === '/') {
            inBlockComment = false;
            result += '*/';
            i += 1;
            continue;
        }
        else if (!inLineComment && !inBlockComment && char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
        }
        else if (!inLineComment && !inBlockComment && char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
        }
        if (char === '?' &&
            !inSingleQuote &&
            !inDoubleQuote &&
            !inLineComment &&
            !inBlockComment) {
            index += 1;
            result += `$${index}`;
            continue;
        }
        result += char;
    }
    return result;
}
export class PostgresAdapter {
    connectionString;
    partition;
    clientFactory;
    client = null;
    constructor(config) {
        this.connectionString = config.connectionString ?? config.hyperdrive?.connectionString ?? '';
        if (!this.connectionString) {
            throw new Error('postgres_connection_string_required');
        }
        this.partition = config.partition ?? 'postgres';
        this.clientFactory = config.clientFactory;
    }
    async getClient() {
        if (this.client) {
            return this.client;
        }
        if (this.clientFactory) {
            this.client = await this.clientFactory(this.connectionString);
            return this.client;
        }
        const { Client } = await import('pg');
        const rawClient = new Client({
            connectionString: this.connectionString,
            application_name: 'authrim-postgres-adapter',
        });
        await rawClient.connect();
        this.client = {
            query: async (sql, params) => {
                const result = await rawClient.query(sql, params);
                return {
                    rows: result.rows,
                    rowCount: result.rowCount ?? result.rows.length,
                };
            },
            end: async () => {
                await rawClient.end();
            },
        };
        return this.client;
    }
    async query(sql, params, _options) {
        const client = await this.getClient();
        const result = await client.query(toPostgresSql(sql), params);
        return result.rows;
    }
    async queryOne(sql, params, _options) {
        const rows = await this.query(sql, params);
        return rows[0] ?? null;
    }
    async execute(sql, params) {
        const startTime = Date.now();
        const client = await this.getClient();
        const result = await client.query(toPostgresSql(sql), params);
        return {
            rowsAffected: result.rowCount,
            success: true,
            durationMs: Date.now() - startTime,
        };
    }
    async transaction(fn) {
        const client = await this.getClient();
        await client.query('BEGIN');
        const txContext = {
            query: async (sql, params) => {
                const result = await client.query(toPostgresSql(sql), params);
                return result.rows;
            },
            queryOne: async (sql, params) => {
                const result = await client.query(toPostgresSql(sql), params);
                return result.rows[0] ?? null;
            },
            execute: async (sql, params) => {
                const result = await client.query(toPostgresSql(sql), params);
                return {
                    rowsAffected: result.rowCount,
                    success: true,
                };
            },
        };
        try {
            const result = await fn(txContext);
            await client.query('COMMIT');
            return result;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    }
    async batch(statements) {
        return this.transaction(async (tx) => {
            const results = [];
            for (const statement of statements) {
                results.push(await tx.execute(statement.sql, statement.params));
            }
            return results;
        });
    }
    async isHealthy() {
        const startTime = Date.now();
        try {
            const client = await this.getClient();
            await client.query('SELECT 1');
            return {
                healthy: true,
                latencyMs: Date.now() - startTime,
                type: 'postgres',
                partition: this.partition,
            };
        }
        catch (error) {
            return {
                healthy: false,
                latencyMs: Date.now() - startTime,
                type: 'postgres',
                partition: this.partition,
                error: String(error),
            };
        }
    }
    getType() {
        return 'postgres';
    }
    async close() {
        if (this.client) {
            await this.client.end();
            this.client = null;
        }
    }
}
export function createPostgresAdapter(config) {
    return new PostgresAdapter(config);
}
