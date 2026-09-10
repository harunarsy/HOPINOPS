export function assertProductionDatabaseUrl(value: string, expectedProjectRef?: string): string;
export function assertLocalDatabaseUrl(value?: string): string;
export function assertLocalSupabaseUrl(value?: string): string;
export function assertLocalRuntimeTarget(input: { runtime?: string; supabaseUrl?: string; databaseUrl?: string }): void;
export function parseDotEnv(value: string): Record<string, string>;
export function assertMigrationParity(remoteVersions: string[], localVersions: string[]): true;
export function createManifest(input: Record<string, unknown>): Record<string, unknown>;
