import { openMysqlConnection, } from './mysql-connection';
export class MysqlAdapter {
    connectionString;
    hyperdrive;
    partition;
    clientFactory;
    client = null;
    constructor(config) {
        if (!config.connectionString && !config.hyperdrive) {
            throw new Error('mysql_connection_config_required');
        }
        this.connectionString = config.connectionString;
        this.hyperdrive = config.hyperdrive;
        this.partition = config.partition ?? 'mysql';
        this.clientFactory = config.clientFactory;
    }
    async getClient() {
        if (this.client) {
            return this.client;
        }
        this.client = await openMysqlConnection({
            connectionString: this.connectionString,
            hyperdrive: this.hyperdrive,
        }, this.clientFactory);
        return this.client;
    }
    async query(sql, params, _options) {
        const client = await this.getClient();
        const result = await client.query(sql, params);
        return result.rows;
    }
    async queryOne(sql, params, _options) {
        const rows = await this.query(sql, params);
        return rows[0] ?? null;
    }
    async execute(sql, params) {
        const startTime = Date.now();
        const client = await this.getClient();
        const result = await client.execute(sql, params);
        return {
            rowsAffected: result.affectedRows ?? 0,
            lastInsertRowid: result.insertId,
            success: true,
            durationMs: Date.now() - startTime,
        };
    }
    async transaction(fn) {
        const client = await this.getClient();
        await client.beginTransaction();
        const txContext = {
            query: async (sql, params) => {
                const result = await client.query(sql, params);
                return result.rows;
            },
            queryOne: async (sql, params) => {
                const result = await client.query(sql, params);
                return result.rows[0] ?? null;
            },
            execute: async (sql, params) => {
                const result = await client.execute(sql, params);
                return {
                    rowsAffected: result.affectedRows ?? 0,
                    lastInsertRowid: result.insertId,
                    success: true,
                };
            },
        };
        try {
            const result = await fn(txContext);
            await client.commit();
            return result;
        }
        catch (error) {
            await client.rollback();
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
                type: 'mysql',
                partition: this.partition,
            };
        }
        catch (error) {
            return {
                healthy: false,
                latencyMs: Date.now() - startTime,
                type: 'mysql',
                partition: this.partition,
                error: String(error),
            };
        }
    }
    getType() {
        return 'mysql';
    }
    async close() {
        if (this.client) {
            await this.client.end();
            this.client = null;
        }
    }
}
export function createMysqlAdapter(config) {
    return new MysqlAdapter(config);
}
