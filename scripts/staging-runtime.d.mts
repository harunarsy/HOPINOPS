export declare const PRODUCTION_PROJECT_REF: string;
export declare const STAGING_PROJECT_REF: string;
export declare const STAGING_HOST: string;
export declare const STAGING_URL: string;
export declare const DEFAULT_STAGING_PORT: number;
export declare const LOOPBACK_HOSTS: Set<string>;
export declare const STAGING_REF_PATTERN: RegExp;
export declare function parseDotEnv(text?: string): Record<string, string>;
export declare function readEnvFile(filePath?: string): Record<string, string>;
export declare function projectRefFromSupabaseUrl(value?: unknown): string | null;
export declare function assertStagingTarget(input?: {
  url?: string;
  projectRef?: string;
  databaseUrl?: string;
}): { url: string; projectRef: string };
export declare function assertStagingServiceRoleKey(value: string, expectedProjectRef?: string): true;
export declare function loadStagingEnv(
  overrides?: Record<string, string | undefined>,
  options?: { requireServiceRole?: boolean },
): Record<string, string>;
export declare function assertStagingDatabaseEnv(env: Record<string, string>): string;
export declare function assertLocalBaseUrl(value?: string): string;
export declare function assertPort(value?: string | number): number;
export declare function createRunId(value?: string): string;
export declare function secretFreeEnv(env: Record<string, unknown>): Record<string, unknown>;
export declare function stagingSummary(env: Record<string, unknown>): {
  runtime: unknown;
  projectRef: unknown;
  supabaseOrigin: string;
};
