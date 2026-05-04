function buildConfigFromConnectionString(connectionString) {
    const url = new URL(connectionString);
    const port = url.port ? Number(url.port) : 3306;
    if (!url.hostname || !url.username || !url.pathname || Number.isNaN(port)) {
        throw new Error('mysql_connection_string_invalid');
    }
    return {
        host: url.hostname,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.replace(/^\//, '')),
        port,
        disableEval: true,
    };
}
export function buildMysqlConnectionConfig(input) {
    if (input.hyperdrive) {
        return {
            host: input.hyperdrive.host,
            user: input.hyperdrive.user,
            password: input.hyperdrive.password,
            database: input.hyperdrive.database,
            port: input.hyperdrive.port,
            disableEval: true,
        };
    }
    if (input.connectionString) {
        return buildConfigFromConnectionString(input.connectionString);
    }
    throw new Error('mysql_connection_config_required');
}
export async function openMysqlConnection(input, factory) {
    const config = buildMysqlConnectionConfig(input);
    if (factory) {
        return factory(config);
    }
    const { createConnection } = await import('mysql2/promise');
    const rawConnection = await createConnection(config);
    return {
        query: async (sql, params) => {
            const [rows] = await rawConnection.query(sql, params);
            if (Array.isArray(rows)) {
                return { rows: rows };
            }
            return {
                rows: [],
                affectedRows: rows.affectedRows,
                insertId: rows.insertId,
            };
        },
        execute: async (sql, params) => {
            const [rows] = await rawConnection.execute(sql, params);
            if (Array.isArray(rows)) {
                return { rows: rows };
            }
            return {
                rows: [],
                affectedRows: rows.affectedRows,
                insertId: rows.insertId,
            };
        },
        beginTransaction: async () => {
            await rawConnection.beginTransaction();
        },
        commit: async () => {
            await rawConnection.commit();
        },
        rollback: async () => {
            await rawConnection.rollback();
        },
        end: async () => {
            await rawConnection.end();
        },
    };
}
